const fs = require('fs')
const path = require('path')

const DEFAULT_LOG_DIR = '/tmp/openclaw'
const DEFAULT_MAX_LINES = 4000
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024
const DEFAULT_MINUTES = 60

function readTailLines(filePath, maxLines = DEFAULT_MAX_LINES, maxBytes = DEFAULT_MAX_BYTES) {
  const stat = fs.statSync(filePath)
  const start = Math.max(0, stat.size - maxBytes)
  const fd = fs.openSync(filePath, 'r')
  try {
    const buffer = Buffer.alloc(stat.size - start)
    fs.readSync(fd, buffer, 0, buffer.length, start)
    return buffer.toString('utf8').split('\n').filter(Boolean).slice(-maxLines)
  } finally {
    fs.closeSync(fd)
  }
}

function latestGatewayLogFile(logDir = DEFAULT_LOG_DIR) {
  if (!fs.existsSync(logDir)) return null
  const files = fs.readdirSync(logDir)
    .filter(name => name.endsWith('.log') || name.endsWith('.jsonl'))
    .map(name => {
      try {
        const fullPath = path.join(logDir, name)
        return { fullPath, mtime: fs.statSync(fullPath).mtimeMs }
      } catch {
        return null
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime)
  return files[0]?.fullPath || null
}

function redactChatId(chatId) {
  const value = String(chatId || '')
  if (!value) return undefined
  if (value.length <= 4) return '<redacted>'
  return `${value.slice(0, 2)}…${value.slice(-2)}`
}

function parseKeyValues(message) {
  const values = {}
  for (const match of String(message || '').matchAll(/([A-Za-z][A-Za-z0-9_]*)=([^\s]+)/g)) {
    values[match[1]] = match[2]
  }
  return values
}

function parseGatewayLogLine(line) {
  try {
    const obj = JSON.parse(line)
    const raw = obj['1'] ?? obj.message ?? obj.msg ?? obj['0'] ?? ''
    const message = typeof raw === 'object' ? JSON.stringify(raw) : String(raw)
    const timeRaw = obj.time || obj._meta?.date || obj.timestamp
    const timeMs = timeRaw ? new Date(timeRaw).getTime() : null
    return { timeRaw, timeMs, message }
  } catch {
    const timeMatch = String(line).match(/^(\d{4}-\d{2}-\d{2}T[^\s]+)/)
    return {
      timeRaw: timeMatch?.[1] || null,
      timeMs: timeMatch ? new Date(timeMatch[1]).getTime() : null,
      message: String(line),
    }
  }
}

function eventNameFromMessage(message) {
  const match = String(message || '').match(
    /\b(telegram_[a-z_]+|telegram (?:queue_coalesced|stale_reply_suppressed|reply_quality_warning))\b/
  )
  if (!match) return null
  return match[1].replace(/^telegram /, 'telegram_')
}

function numeric(value) {
  if (value === undefined || value === null) return null
  const n = Number(String(value).replace(/[^\d.-]/g, ''))
  return Number.isFinite(n) ? n : null
}

function ensureTurn(turns, turnId) {
  if (!turns.has(turnId)) {
    turns.set(turnId, {
      turnId,
      agentId: undefined,
      channel: 'telegram',
      startedAt: undefined,
      startedAtMs: null,
      chatIdRedacted: undefined,
      mediaCount: 0,
      ackMs: null,
      contextMs: null,
      modelMs: null,
      finalMs: null,
      toolCalls: [],
      events: [],
      status: 'pending',
      rootCause: 'unknown',
    })
  }
  return turns.get(turnId)
}

function applyLatencyEvent(turn, parsed) {
  const { event, kv, timeMs, timeRaw, message } = parsed
  turn.agentId = turn.agentId || kv.agent
  turn.chatIdRedacted = turn.chatIdRedacted || redactChatId(kv.chat)
  if (kv.media !== undefined) turn.mediaCount = numeric(kv.media) || 0
  if (!turn.startedAtMs || (timeMs && timeMs < turn.startedAtMs)) {
    turn.startedAtMs = timeMs || turn.startedAtMs
    turn.startedAt = timeRaw || turn.startedAt
  }
  turn.events.push({ event, at: timeRaw, elapsedMs: numeric(kv.elapsedMs), latencyMs: numeric(kv.latencyMs) })

  if (event === 'telegram_context_ready') turn.contextMs = numeric(kv.elapsedMs)
  if (event === 'telegram_ack_sent') turn.ackMs = numeric(kv.latencyMs)
  if (event === 'telegram_ack_scheduled') {
    turn.ackDelayMs = numeric(kv.delayMs)
    turn.ackTimeoutMs = numeric(kv.timeoutMs)
  }
  if (event === 'telegram_model_start') turn.modelMs = numeric(kv.elapsedMs)
  if (event === 'telegram_tool_call') {
    turn.toolCalls.push({ count: numeric(kv.count), elapsedMs: numeric(kv.elapsedMs) })
  }
  if (event === 'telegram_intent_routed') {
    turn.intent = kv.intent
    turn.accessMode = kv.accessMode
  }
  if (event === 'telegram_tool_path' || event === 'telegram_tool_path_used') {
    turn.deterministic = 'tool_path_used'
    turn.guardrail = 'generic_tool_router'
    turn.intent = kv.intent || turn.intent
    turn.toolPath = kv.tools ? String(kv.tools).split('->').filter(Boolean) : []
    turn.mcpSearchMs = numeric(kv.searchMs)
    turn.mcpBalanceMs = numeric(kv.balanceMs)
    if (turn.toolPath.length) {
      turn.toolCalls.push({ tools: turn.toolPath, searchMs: turn.mcpSearchMs, balanceMs: turn.mcpBalanceMs })
    }
  }
  if (event === 'telegram_tool_path_failed') {
    turn.deterministic = 'tool_path_failed'
    turn.guardrail = 'generic_tool_router'
    turn.failedTool = kv.tool
    turn.toolError = kv.error
    turn.toolCalls.push({ tool: kv.tool, status: 'failed', elapsedMs: numeric(kv.elapsedMs) })
  }
  if (event === 'telegram_capability_denied') {
    turn.deterministic = 'capability_denied'
    turn.guardrail = 'generic_tool_router'
    turn.intent = kv.intent || turn.intent
  }
  if (event === 'telegram_final_sent') {
    turn.finalMs = numeric(kv.elapsedMs)
    turn.ackSent = kv.ackSent === 'true'
  }
  if (event === 'telegram_ack_failed') turn.ackFailed = true
  if (event === 'telegram_ack_cancelled') turn.ackCancelled = true
  if (event === 'telegram_stale_reply_suppressed') turn.staleSuppressed = true
  if (event === 'telegram_stock_price_denied') {
    turn.deterministic = 'stock_price_denial'
    turn.guardrail = 'stock_price_denial'
    turn.stockIntent = kv.stockIntent === 'true'
    turn.ambiguousPrice = kv.ambiguousPrice === 'true'
  }
  if (event === 'telegram_native_command_fast_path') turn.deterministic = 'native_command'
  if (event === 'telegram_queue_coalesced') turn.deterministic = 'queue_coalesced'
  if (event === 'telegram_reply_quality_warning') turn.replyQualityWarning = true
  if (/timeout/i.test(message)) turn.timeoutHint = true
}

function classifyTurn(turn, nowMs = Date.now()) {
  if (turn.finalMs !== null) {
    const limit = turn.mediaCount > 0 ? 30000 : 10000
    turn.status = turn.finalMs > limit ? 'slow' : 'ok'
    if (turn.deterministic && turn.finalMs <= limit) {
      turn.rootCause = turn.deterministic
      return turn
    }
    if (turn.deterministic && turn.finalMs > limit) {
      turn.rootCause = turn.mcpSearchMs || turn.mcpBalanceMs ? 'tool_path_delivery_latency' : turn.deterministic
      return turn
    }
    turn.rootCause = turn.finalMs > limit
      ? (turn.toolCalls.length ? 'tool_or_mcp_latency' : 'model_latency')
      : 'completed'
    return turn
  }
  if (turn.deterministic === 'tool_path_failed') {
    turn.status = turn.modelMs !== null ? 'pending' : 'warn'
    turn.rootCause = turn.modelMs !== null ? 'tool_path_failed_model_running' : 'tool_path_failed'
    return turn
  }
  if (turn.deterministic) {
    turn.status = 'ok'
    turn.rootCause = turn.deterministic
    return turn
  }
  if (turn.staleSuppressed) {
    turn.status = 'suppressed'
    turn.rootCause = 'stale_reply_suppressed'
    return turn
  }
  if (turn.ackFailed) {
    turn.status = 'warn'
    turn.rootCause = 'ack_failed'
    return turn
  }
  const ageMs = turn.startedAtMs ? nowMs - turn.startedAtMs : 0
  if (ageMs > 30000) {
    turn.status = 'stuck'
    turn.rootCause = turn.modelMs !== null
      ? (turn.toolCalls.length ? 'tool_or_mcp_pending' : 'model_pending')
      : 'queue_or_context_pending'
    return turn
  }
  turn.status = 'pending'
  turn.rootCause = turn.modelMs !== null ? 'model_running' : 'queue_or_context_pending'
  return turn
}

function percentile(values, p) {
  const nums = values.filter(n => typeof n === 'number' && Number.isFinite(n)).sort((a, b) => a - b)
  if (!nums.length) return null
  const idx = Math.min(nums.length - 1, Math.ceil((p / 100) * nums.length) - 1)
  return nums[idx]
}

function summarizeLatencyTurns(turns) {
  const ack = turns.map(t => t.ackMs).filter(n => n !== null)
  const final = turns.map(t => t.finalMs).filter(n => n !== null)
  const byStatus = {}
  for (const turn of turns) byStatus[turn.status] = (byStatus[turn.status] || 0) + 1
  return {
    count: turns.length,
    ackP50Ms: percentile(ack, 50),
    ackP95Ms: percentile(ack, 95),
    finalP50Ms: percentile(final, 50),
    finalP95Ms: percentile(final, 95),
    byStatus,
    slo: {
      ackP95Ok: ack.length ? percentile(ack, 95) <= 1500 : null,
      finalTextP95Ok: final.length ? percentile(final, 95) <= 10000 : null,
    },
  }
}

function buildLatencyFromLines(lines, options = {}) {
  const minutes = Math.min(Math.max(Number(options.minutes || DEFAULT_MINUTES), 1), 1440)
  const sinceMs = Date.now() - minutes * 60 * 1000
  const turns = new Map()
  const warnings = []
  for (const line of lines) {
    const parsedLine = parseGatewayLogLine(line)
    if (parsedLine.timeMs && parsedLine.timeMs < sinceMs) continue
    const event = eventNameFromMessage(parsedLine.message)
    if (!event) continue
    const kv = parseKeyValues(parsedLine.message)
    if (options.agent && kv.agent !== options.agent) continue
    const turnId = kv.turnId
    if (!turnId) {
      warnings.push({ type: 'missing_turn_id', event, summary: `${event} has no turnId` })
      continue
    }
    const turn = ensureTurn(turns, turnId)
    applyLatencyEvent(turn, { event, kv, timeMs: parsedLine.timeMs, timeRaw: parsedLine.timeRaw, message: parsedLine.message })
  }
  const resultTurns = Array.from(turns.values())
    .map(turn => classifyTurn(turn))
    .sort((a, b) => (b.startedAtMs || 0) - (a.startedAtMs || 0))
  const slowest = [...resultTurns]
    .filter(t => t.finalMs !== null)
    .sort((a, b) => (b.finalMs || 0) - (a.finalMs || 0))
    .slice(0, 10)
  const guardrailWarnings = resultTurns
    .filter(t => t.rootCause === 'stock_price_denial' && t.stockIntent)
    .slice(0, 20)
    .map(t => ({
      type: 'stock_price_denial_stock_intent',
      guardrail: 'stock_price_denial',
      turnId: t.turnId,
      agentId: t.agentId,
      chatIdRedacted: t.chatIdRedacted,
      summary: 'Stock price denial fired while stock intent was detected',
    }))
  const toolPathWarnings = resultTurns
    .filter(t => t.deterministic === 'tool_path_failed')
    .slice(0, 20)
    .map(t => ({
      type: 'generic_tool_router_tool_path_failed',
      guardrail: 'generic_tool_router',
      turnId: t.turnId,
      agentId: t.agentId,
      chatIdRedacted: t.chatIdRedacted,
      tool: t.failedTool,
      summary: 'Generic tool router could not complete direct MCP tool path',
    }))
  return {
    generatedAt: new Date().toISOString(),
    windowMinutes: minutes,
    summary: summarizeLatencyTurns(resultTurns),
    turns: resultTurns.slice(0, 200).map(({ startedAtMs, events, ...turn }) => turn),
    slowest: slowest.map(({ startedAtMs, events, ...turn }) => turn),
    warnings: [...warnings, ...guardrailWarnings, ...toolPathWarnings].slice(0, 50),
  }
}

function buildLatencyFromGatewayLog(options = {}) {
  const logFile = options.logFile || latestGatewayLogFile(options.logDir)
  if (!logFile) {
    return {
      generatedAt: new Date().toISOString(),
      windowMinutes: Number(options.minutes || DEFAULT_MINUTES),
      summary: summarizeLatencyTurns([]),
      turns: [],
      slowest: [],
      warnings: [{ type: 'no_gateway_log', summary: 'No gateway log file found' }],
    }
  }
  const lines = readTailLines(logFile, options.maxLines || DEFAULT_MAX_LINES, options.maxBytes || DEFAULT_MAX_BYTES)
  const result = buildLatencyFromLines(lines, options)
  result.source = { logFile, maxLines: options.maxLines || DEFAULT_MAX_LINES, maxBytes: options.maxBytes || DEFAULT_MAX_BYTES }
  return result
}

module.exports = {
  buildLatencyFromGatewayLog,
  buildLatencyFromLines,
  parseGatewayLogLine,
  parseKeyValues,
  redactChatId,
  _internal: {
    classifyTurn,
    percentile,
    summarizeLatencyTurns,
  },
}
