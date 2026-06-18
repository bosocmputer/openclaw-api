const router = require('express').Router()
const agentSessionsRouter = require('express').Router()
const fs = require('fs')
const path = require('path')
const { HOME } = require('../lib/config')
const { readUserNames } = require('../lib/files')
const { pgPool } = require('../lib/pg')
const { stripGatewayMetadata } = require('./webchat')
const { readOpenclawConfig } = require('../lib/openclaw-config')
const { buildLatencyFromGatewayLog } = require('../lib/monitor-latency')

const MAX_TAIL_BYTES = 1024 * 1024
const MAX_EVENTS_LINES = 80
const MAX_SESSION_LINES = 1200
const MAX_COST_LINES_PER_FILE = 2500
const MAX_COST_FILES_PER_AGENT = 200
const MAX_SESSIONS_PER_AGENT = 300
const MAX_CONVERSATION_LINES = 220
const MAX_CONVERSATION_SESSIONS_PER_AGENT = 120
const MAX_CONVERSATION_TEXT = 1200
const MAX_MONITOR_TOOL_TEXT = 5000
const MAX_GATEWAY_MONITOR_TURNS = 80
const DEFAULT_GATEWAY_LOG_DIR = '/tmp/openclaw'

function readTailLines(filePath, maxLines, maxBytes = MAX_TAIL_BYTES) {
  const stat = fs.statSync(filePath)
  const start = Math.max(0, stat.size - maxBytes)
  const fd = fs.openSync(filePath, 'r')
  try {
    const buffer = Buffer.alloc(stat.size - start)
    fs.readSync(fd, buffer, 0, buffer.length, start)
    return buffer.toString('utf8').split('\n').filter(l => l.trim()).slice(-maxLines)
  } finally {
    fs.closeSync(fd)
  }
}

function latestFiles(dir, predicate, limit) {
  return fs.readdirSync(dir)
    .filter(predicate)
    .map(name => {
      try {
        const fullPath = path.join(dir, name)
        return { name, mtime: fs.statSync(fullPath).mtimeMs }
      } catch { return null }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
    .map(f => f.name)
}

function parseGatewayKeyValues(message) {
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
    return {
      timeRaw,
      timeMs: timeRaw ? new Date(timeRaw).getTime() : null,
      message,
    }
  } catch {
    const timeMatch = String(line).match(/^(\d{4}-\d{2}-\d{2}T[^\s]+)/)
    return {
      timeRaw: timeMatch?.[1] || null,
      timeMs: timeMatch ? new Date(timeMatch[1]).getTime() : null,
      message: String(line),
    }
  }
}

function latestGatewayLogFile(logDir = DEFAULT_GATEWAY_LOG_DIR) {
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

function decodeMonitorText(value) {
  const raw = String(value || '')
  if (!raw || raw === '-') return ''
  try {
    const text = Buffer.from(raw, 'base64url').toString('utf8')
    return text.replace(/\s+/g, ' ').trim().slice(0, MAX_CONVERSATION_TEXT)
  } catch {
    return ''
  }
}

function decodeMonitorToolText(value) {
  const raw = String(value || '')
  if (!raw || raw === '-') return ''
  try {
    return Buffer.from(raw, 'base64url').toString('utf8').slice(0, MAX_MONITOR_TOOL_TEXT)
  } catch {
    return ''
  }
}

function parseTelegramNativeTarget(target) {
  const parts = String(target || '').split(':')
  const agentIdx = parts.findIndex(part => part === 'agent')
  const telegramIdx = parts.findIndex(part => part === 'telegram')
  if (agentIdx === -1 || telegramIdx === -1) return null
  return {
    agentId: parts[agentIdx + 1] || null,
    user: parts.slice(telegramIdx + 1).join(':') || 'telegram',
  }
}

function nativeCommandReply(command) {
  switch (String(command || '').toLowerCase()) {
    case '/reset':
      return '✅ Session reset.'
    case '/new':
      return '✅ New session started.'
    case '/compact':
      return '✅ Session compacted.'
    default:
      return 'Native command handled.'
  }
}

function safeSnippet(value, max = MAX_CONVERSATION_TEXT) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return undefined
}

function normalizeUsageMetrics(usage) {
  if (!usage || typeof usage !== 'object') return null
  const cost = usage.cost
  const input = firstFiniteNumber(
    usage.input,
    usage.input_tokens,
    usage.inputTokens,
    usage.prompt_tokens,
    usage.promptTokens,
  ) ?? 0
  const output = firstFiniteNumber(
    usage.output,
    usage.output_tokens,
    usage.outputTokens,
    usage.completion_tokens,
    usage.completionTokens,
  ) ?? 0
  const totalTokens = firstFiniteNumber(
    usage.total,
    usage.total_tokens,
    usage.totalTokens,
  ) ?? input + output
  const explicitCost = firstFiniteNumber(
    typeof cost === 'number' ? cost : undefined,
    cost && typeof cost === 'object' ? cost.total : undefined,
    usage.totalCost,
    usage.total_cost,
    usage.costUsd,
    usage.estimatedCostUsd,
  )
  const estimatedCost = input > 0 || output > 0
    ? ((input / 1000000) * 3 + (output / 1000000) * 15)
    : 0
  const totalCost = explicitCost ?? estimatedCost
  if (input === 0 && output === 0 && totalTokens === 0 && totalCost === 0) return null
  return { input, output, totalTokens, cost: totalCost }
}

function providerFromModelRef(ref) {
  const raw = String(ref || '')
  const slash = raw.indexOf('/')
  return slash > 0 ? raw.slice(0, slash) : null
}

function configuredModelForAgent(config, agent) {
  const value = agent?.model || config?.agents?.defaults?.model
  if (typeof value === 'string') return value || null
  if (value && typeof value === 'object') return value.primary || null
  return null
}

function messageModelMetadata(msg, configuredModelRef = null, usageMetrics = null) {
  const actualModel = String(msg?.model || '').trim()
  const actualProvider = String(msg?.provider || '').trim()
  if (actualModel) {
    return {
      model: actualModel,
      provider: actualProvider || providerFromModelRef(actualModel),
      modelSource: 'actual',
      finishReason: msg?.stopReason || msg?.finishReason || null,
    }
  }
  if (usageMetrics && configuredModelRef) {
    return {
      model: configuredModelRef,
      provider: providerFromModelRef(configuredModelRef),
      modelSource: 'configured',
      finishReason: msg?.stopReason || msg?.finishReason || null,
    }
  }
  return {
    model: null,
    provider: actualProvider || null,
    modelSource: null,
    finishReason: msg?.stopReason || msg?.finishReason || null,
  }
}

function resolveSessionArtifact(agentId, sessionId, explicitFile) {
  if (!sessionId && !explicitFile) return null
  const sessionFile = explicitFile
    || path.join(HOME, `.openclaw/agents/${agentId}/sessions/${sessionId}.jsonl`)
  if (sessionFile && fs.existsSync(sessionFile)) return { file: sessionFile, kind: 'session' }

  const trajectoryFile = sessionFile
    ? sessionFile.replace(/\.jsonl$/i, '.trajectory.jsonl')
    : path.join(HOME, `.openclaw/agents/${agentId}/sessions/${sessionId}.trajectory.jsonl`)
  if (trajectoryFile && fs.existsSync(trajectoryFile)) return { file: trajectoryFile, kind: 'trajectory' }
  return null
}

function resolveMonitorSessionSource(agentId, sessionInfo) {
  const primary = resolveSessionArtifact(agentId, sessionInfo?.sessionId, sessionInfo?.sessionFile)
  if (primary) return primary
  const familyIds = Array.isArray(sessionInfo?.usageFamilySessionIds)
    ? sessionInfo.usageFamilySessionIds
    : []
  for (const sessionId of familyIds.slice().reverse()) {
    if (!sessionId || sessionId === sessionInfo?.sessionId) continue
    const candidate = resolveSessionArtifact(agentId, sessionId)
    if (candidate) return candidate
  }
  return null
}

function normalizeTrajectoryEntries(entries) {
  const snapshots = entries
    .filter(entry => (entry?.type === 'model.completed' || entry?.type === 'trace.artifacts') && Array.isArray(entry?.data?.messagesSnapshot))
  const latest = snapshots.at(-1)
  if (!latest) return []
  return latest.data.messagesSnapshot.map(msg => {
    const timestamp = typeof msg.timestamp === 'number'
      ? new Date(msg.timestamp < 1000000000000 ? msg.timestamp * 1000 : msg.timestamp).toISOString()
      : msg.timestamp
    return { ...msg, timestamp }
  })
}

function readSessionText(msg) {
  return safeSnippet(stripGatewayMetadata(extractMessageText(msg)))
}

function parseSessionChannelUser(key) {
  if (key.includes('hook:webchat')) {
    const parts = key.split(':')
    return { channel: 'webchat', user: parts[parts.length - 1] || 'webchat' }
  }
  if (key.includes('telegram')) {
    const parts = key.split(':')
    const telegramIdx = parts.findIndex(p => p === 'telegram')
    return { channel: 'telegram', user: parts.slice(telegramIdx + 1).join(':') || 'telegram' }
  }
  if (key.includes(':line:')) {
    const parts = key.split(':')
    const lineIdx = parts.findIndex(p => p === 'line')
    return { channel: 'line', user: parts.slice(lineIdx + 1).join(':') || 'line' }
  }
  return null
}

function buildConversationTurnsFromGatewayLog({ minutes, agent, channel, limit, logFile }) {
  if (channel && channel !== 'telegram') return []
  const latestLog = logFile || latestGatewayLogFile()
  if (!latestLog) return []
  const cutoffMs = Date.now() - minutes * 60 * 1000
  const turns = []
  let lines = []
  try {
    lines = readTailLines(latestLog, 3000, 2 * 1024 * 1024)
  } catch {
    return []
  }
  const toolDetailsByTurn = new Map()
  for (const line of lines) {
    const parsed = parseGatewayLogLine(line)
    if (parsed.timeMs && parsed.timeMs < cutoffMs) continue
    if (parsed.message.includes('telegram_monitor_tool')) {
      const kv = parseGatewayKeyValues(parsed.message)
      if (agent && kv.agent !== agent) continue
      if (!kv.turnId || !kv.tool) continue
      const detail = {
        name: kv.tool,
        status: kv.status || 'ok',
        durationMs: Number(kv.durationMs || 0) || null,
        toolInput: decodeMonitorToolText(kv.inputB64),
        toolResult: decodeMonitorToolText(kv.resultB64),
        cleanKeyword: decodeMonitorToolText(kv.cleanKeywordB64),
        warning: kv.warning && kv.warning !== '-' ? kv.warning : null,
      }
      if (!toolDetailsByTurn.has(kv.turnId)) toolDetailsByTurn.set(kv.turnId, [])
      toolDetailsByTurn.get(kv.turnId).push(detail)
      continue
    }
    if (parsed.message.includes('telegram native_command_fast_path')) {
      const kv = parseGatewayKeyValues(parsed.message)
      const target = parseTelegramNativeTarget(kv.target)
      if (!target?.agentId) continue
      if (agent && target.agentId !== agent) continue
      turns.push({
        id: `native:${parsed.timeRaw || turns.length}:${kv.command || 'command'}`,
        source: 'gateway',
        startedAt: parsed.timeRaw || new Date().toISOString(),
        agentId: target.agentId,
        channel: 'telegram',
        user: target.user,
        userText: kv.command || '/command',
        finalText: nativeCommandReply(kv.command),
        route: 'native',
        intent: 'native',
        status: 'ok',
        rootCause: 'native_command',
        durationMs: null,
        ackMs: null,
        modelMs: null,
        toolPath: [],
        warnings: [],
      })
      continue
    }
    if (!parsed.message.includes('telegram_monitor_turn')) continue
    const kv = parseGatewayKeyValues(parsed.message)
    if (agent && kv.agent !== agent) continue
    const tools = kv.tools && kv.tools !== '-' ? String(kv.tools).split('->').filter(Boolean) : []
    const toolDetails = kv.turnId ? (toolDetailsByTurn.get(kv.turnId) || []) : []
    const usedToolDetails = new Set()
    turns.push({
      id: kv.turnId || `gateway:${parsed.timeRaw || turns.length}`,
      source: 'gateway',
      startedAt: parsed.timeRaw || new Date().toISOString(),
      agentId: kv.agent || null,
      channel: 'telegram',
      user: 'telegram',
      userText: decodeMonitorText(kv.userTextB64),
      finalText: decodeMonitorText(kv.finalTextB64),
      route: kv.route || 'tool_path',
      intent: kv.intent || 'unknown',
      status: kv.status === 'sent' ? 'ok' : (kv.status || 'warn'),
      rootCause: kv.route || null,
      durationMs: Number(kv.durationMs || 0) || null,
      ackMs: null,
      modelMs: null,
      toolPath: tools.map(name => {
        const detailIndex = toolDetails.findIndex((detail, index) => !usedToolDetails.has(index) && detail.name === name)
        const detail = detailIndex >= 0 ? toolDetails[detailIndex] : null
        if (detailIndex >= 0) usedToolDetails.add(detailIndex)
        return {
          name,
          status: detail?.status || 'ok',
          durationMs: detail?.durationMs ?? (name.includes('search') ? Number(kv.searchMs || 0) || null : name.includes('balance') ? Number(kv.balanceMs || 0) || null : null),
          toolInput: detail?.toolInput || undefined,
          toolResult: detail?.toolResult || undefined,
          cleanKeyword: detail?.cleanKeyword || undefined,
          warning: detail?.warning || undefined,
        }
      }),
      warnings: [],
    })
  }
  return turns.slice(-limit)
}

function timePartFromMs(ms) {
  if (!Number.isFinite(ms)) return null
  return new Date(ms).toISOString().slice(11, 19)
}

function monitorEventTime(ms) {
  if (!Number.isFinite(ms)) {
    return { ts: null, timestamp: null, timeMs: null }
  }
  return {
    ts: timePartFromMs(ms),
    timestamp: new Date(ms).toISOString(),
    timeMs: ms,
  }
}

function monitorEventTimeMs(event) {
  if (!event || typeof event !== 'object') return 0
  if (typeof event.timeMs === 'number' && Number.isFinite(event.timeMs)) return event.timeMs
  if (typeof event.timestamp === 'string') {
    const parsed = new Date(event.timestamp).getTime()
    if (Number.isFinite(parsed)) return parsed
  }
  if (typeof event.startedAt === 'string') {
    const parsed = new Date(event.startedAt).getTime()
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

function sortMonitorEventsDesc(events) {
  return events.sort((a, b) => {
    const byTime = monitorEventTimeMs(b) - monitorEventTimeMs(a)
    if (byTime !== 0) return byTime
    return String(b.ts || '').localeCompare(String(a.ts || ''))
  })
}

function buildGatewayMonitorSessions({ seenModelTexts } = {}) {
  const turns = buildConversationTurnsFromGatewayLog({
    minutes: 180,
    channel: 'telegram',
    limit: MAX_GATEWAY_MONITOR_TURNS,
  })
  const byAgent = new Map()
  const globalEvents = []
  const stats = {
    messages: 0,
    responseTimes: [],
    errors: 0,
  }
  const today = new Date().toISOString().slice(0, 10)

  for (const turn of turns) {
    if (!turn.agentId) continue
    const userText = safeSnippet(turn.userText, 600)
    const finalText = safeSnippet(turn.finalText, 600)
    if (turn.route === 'model_path' && userText && seenModelTexts?.has(`${turn.agentId}|${userText}`)) {
      continue
    }
    const endMs = new Date(turn.startedAt).getTime()
    const durationMs = Number(turn.durationMs || 0)
    const startMs = Number.isFinite(endMs) && durationMs > 0 ? endMs - durationMs : endMs
    const startMeta = monitorEventTime(startMs)
    const endMeta = monitorEventTime(endMs)
    const startTs = startMeta.ts || endMeta.ts
    const endTs = endMeta.ts || startTs
    const latencySec = durationMs > 0 ? Math.round(durationMs / 100) / 10 : undefined
    const events = []
    if (userText) {
      events.push({ ...startMeta, ts: startTs, type: 'message', text: userText })
      if (Number.isFinite(startMs) && new Date(startMs).toISOString().slice(0, 10) === today) {
        stats.messages += 1
      }
    }
    for (const tool of turn.toolPath || []) {
      const toolDurationSec = tool.durationMs != null ? Math.round(tool.durationMs / 100) / 10 : undefined
      events.push({
        ...endMeta,
        ts: endTs,
        type: 'tool',
        text: `${tool.name}${tool.durationMs != null ? ` ${tool.durationMs}ms` : ''}`,
        toolName: tool.name,
        toolInput: tool.toolInput,
        toolResult: tool.toolResult,
        cleanKeyword: tool.cleanKeyword,
        intent: turn.intent,
        route: turn.route,
        ...(toolDurationSec != null ? { latency: toolDurationSec } : {}),
      })
    }
    if (finalText) {
      events.push({
        ...endMeta,
        ts: endTs,
        type: turn.status === 'ok' ? 'reply' : 'error',
        text: finalText,
        ...(latencySec != null ? { latency: latencySec } : {}),
      })
    }
    if (events.length === 0) continue
    if (latencySec != null) stats.responseTimes.push(latencySec)
    if (turn.status !== 'ok') stats.errors += 1
    const session = {
      sessionKey: `gateway:${turn.id}`,
      user: turn.user || 'telegram',
      state: turn.status === 'ok' ? 'replied' : 'error',
      lastMessageAt: Number.isFinite(endMs) ? new Date(endMs).toISOString() : turn.startedAt,
      lastUserText: userText || null,
      lastReplyText: finalText || null,
      elapsed: Number.isFinite(endMs) ? Math.max(0, Math.floor((Date.now() - endMs) / 1000)) : 0,
      cost: 0,
      inputTokens: 0,
      outputTokens: 0,
      warnings: turn.warnings || [],
      toolChain: (turn.toolPath || []).map(tool => tool.name),
      events,
    }
    if (!byAgent.has(turn.agentId)) byAgent.set(turn.agentId, [])
    byAgent.get(turn.agentId).push(session)
    for (const ev of events) {
      globalEvents.push({
        ts: ev.ts,
        timestamp: ev.timestamp,
        timeMs: ev.timeMs,
        agentId: turn.agentId,
        channel: 'telegram',
        user: session.user,
        type: ev.type,
        text: ev.text,
        toolName: ev.toolName,
        toolInput: ev.toolInput,
        toolResult: ev.toolResult,
        cleanKeyword: ev.cleanKeyword,
        intent: ev.intent,
        route: ev.route,
      })
    }
  }
  return { byAgent, globalEvents, stats }
}

function buildConversationTurnsFromSession(params) {
  const { agentId, sessionKey, user, channel, sessionFile, minutes } = params
  let lines = []
  try {
    lines = readTailLines(sessionFile, MAX_CONVERSATION_LINES)
  } catch {
    return []
  }
  const cutoffMs = Date.now() - minutes * 60 * 1000
  const turns = []
  let current = null
  let lastTool = null

  function isUserVisibleFailureText(text) {
    return /something went wrong|ระบบประมวลผลไม่สำเร็จ|เกิดข้อผิดพลาด|ลองใหม่อีกครั้ง|try again/i.test(String(text || ''))
  }

  function markFinalText(text, tsMs) {
    current.finalText = text
    if (current.status === 'error' && /^model_/.test(String(current.rootCause || '')) && !isUserVisibleFailureText(text)) {
      current.rootCause = `${current.rootCause}_recovered`
      current.status = 'ok'
      if (!current.warnings.some(w => w.type === 'model_fallback_recovered')) {
        current.warnings.push({
          type: 'model_fallback_recovered',
          summary: 'Model/provider failed first, but fallback produced a final reply',
        })
      }
    } else {
      current.status = current.status === 'error' ? 'error' : 'ok'
    }
    if (tsMs && current.startedAtMs) current.durationMs = tsMs - current.startedAtMs
    for (const warning of detectReplyQualityWarnings(text)) current.warnings.push(warning)
  }

  function pushCurrent() {
    if (!current) return
    if (current.startedAtMs && current.startedAtMs < cutoffMs) {
      current = null
      lastTool = null
      return
    }
    const { startedAtMs, ...publicTurn } = current
    turns.push(publicTurn)
    current = null
    lastTool = null
  }

  for (const line of lines) {
    let entry
    try { entry = JSON.parse(line) } catch { continue }
    const msg = normalizeSessionEntry(entry)
    if (!shouldIncludeMonitorMessage(msg)) continue
    const ts = msg.timestamp || msg.ts || entry.timestamp || null
    const tsMs = ts ? new Date(ts).getTime() : null

    if (msg.role === 'user') {
      pushCurrent()
      current = {
        id: `${sessionKey}:${ts || turns.length}`,
        source: 'session',
        sessionKey,
        startedAt: ts || new Date().toISOString(),
        startedAtMs: tsMs,
        agentId,
        channel,
        user,
        userText: readSessionText(msg),
        finalText: '',
        route: 'model_path',
        intent: 'unknown',
        status: 'pending',
        rootCause: null,
        durationMs: null,
        ackMs: null,
        modelMs: null,
        toolPath: [],
        warnings: [],
      }
      continue
    }

    if (!current && msg.role !== 'toolResult') {
      continue
    }

    if (msg.role === 'assistant') {
      const modelError = detectModelError(msg)
      if (modelError && current) {
        current.status = 'error'
        current.rootCause = modelError.type
        current.warnings.push(modelError)
      }
      const c = msg.content
      if (Array.isArray(c) && current) {
        for (const item of c) {
          if (item.type === 'tool_use' || item.type === 'toolCall') {
            const tool = {
              name: item.name || 'tool',
              status: 'pending',
              argsPreview: item.input ? safeSnippet(JSON.stringify(item.input), 500) : '',
              resultSummary: '',
              durationMs: null,
            }
            current.toolPath.push(tool)
            lastTool = tool
          } else if (item.type === 'text' && item.text) {
            const text = safeSnippet(item.text)
            markFinalText(text, tsMs)
          }
        }
      } else if (typeof c === 'string' && current) {
        const text = safeSnippet(c)
        markFinalText(text, tsMs)
      }
    } else if (msg.role === 'toolResult' && current) {
      const text = safeSnippet(extractToolResultText(msg), 800)
      if (lastTool) {
        lastTool.status = 'ok'
        lastTool.resultSummary = text
      }
      const missingTool = parseToolNotFound(text)
      if (missingTool) {
        current.warnings.push({
          type: 'tool_not_found',
          toolName: missingTool,
          summary: `Tool ${missingTool} not found`,
        })
      }
    }
  }
  pushCurrent()
  return turns
}

function isDeliveryMirrorMessage(msg) {
  return msg?.role === 'assistant' && String(msg.model || '').toLowerCase() === 'delivery-mirror'
}

function normalizeSessionEntry(entry) {
  if (!entry) return null
  if (entry.message && entry.message.role) {
    // wrapped format: {type, id, timestamp, message:{role,content,usage}}
    return {
      role: entry.message.role,
      content: entry.message.content,
      timestamp: entry.timestamp,
      usage: entry.message.usage ?? entry.usage,
      api: entry.message.api,
      provider: entry.message.provider,
      model: entry.message.model,
      stopReason: entry.message.stopReason,
      errorMessage: entry.message.errorMessage ?? entry.errorMessage,
    }
  }
  // flat format: {role, content, timestamp}
  return entry
}

function shouldIncludeMonitorMessage(msg) {
  if (!msg) return false
  if (isDeliveryMirrorMessage(msg)) return false

  const content = msg.content
  if (Array.isArray(content)) {
    return !content.some(c => typeof c === 'object' && c.type === 'tool_result' &&
      Array.isArray(c.content) && c.content.some(x => typeof x.text === 'string' && x.text.includes('HEARTBEAT_OK')))
  }
  if (typeof content === 'string' && content.includes('HEARTBEAT_OK')) return false
  return true
}

function extractToolResultText(msg) {
  const c = msg?.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) {
    return c.map(item => {
      if (typeof item === 'string') return item
      if (typeof item?.text === 'string') return item.text
      return ''
    }).join('\n').trim()
  }
  return ''
}

function parseToolNotFound(text) {
  const value = String(text || '')
  const match = value.match(/Tool\s+([A-Za-z0-9_.:-]+)\s+not found/i)
  if (!match) return null
  return match[1]
}

function extractMessageText(msg) {
  const c = msg?.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) {
    return c.map(item => {
      if (typeof item === 'string') return item
      if (item?.type === 'text' && typeof item.text === 'string') return item.text
      if (typeof item?.text === 'string') return item.text
      return ''
    }).filter(Boolean).join('\n').trim()
  }
  return ''
}

function detectModelError(msg) {
  if (!msg || msg.role !== 'assistant') return null
  const text = [msg.errorMessage, extractMessageText(msg)]
    .filter(Boolean)
    .join('\n')
  const stopReason = String(msg.stopReason || '').toLowerCase()
  if (stopReason !== 'error' && !text) return null
  if (/timed out|timeout|finish_reason:\s*error|provider finish_reason:\s*error/i.test(text)) {
    return {
      type: 'model_timeout',
      summary: 'Model/provider timeout or finish_reason error',
      detail: text.slice(0, 500),
    }
  }
  if (stopReason === 'error' || /llm|model|provider|openrouter/i.test(text)) {
    return {
      type: 'model_error',
      summary: 'Model/provider returned an error',
      detail: text.slice(0, 500),
    }
  }
  return null
}

function detectReplyQualityWarnings(text) {
  const value = String(text || '')
  const warnings = []
  if (/\{\{\s*[^}\n]{1,80}\s*\}\}/.test(value)) {
    warnings.push({
      type: 'reply_quality_warning',
      issue: 'placeholder_artifact',
      summary: 'Assistant reply contains placeholder artifact like {{1}}',
    })
  }
  if (/What would you like to do next|Check stock for another product|Search for a different product/i.test(value)) {
    warnings.push({
      type: 'reply_quality_warning',
      issue: 'english_followup',
      summary: 'Assistant reply contains English follow-up menu',
    })
  }
  if (/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/u.test(value)) {
    warnings.push({
      type: 'reply_quality_warning',
      issue: 'cjk_text',
      summary: 'Assistant reply contains unexpected CJK text',
    })
  }
  if (/\b(?:khác|khong|không|xin|vui\s+lòng|cảm\s+ơn|hay|hãy)\b/iu.test(value)) {
    warnings.push({
      type: 'reply_quality_warning',
      issue: 'foreign_text',
      summary: 'Assistant reply contains unexpected foreign-language fragment',
    })
  }
  if (/คุณต้องการดำเนินการต่ออย่างไรครับ[\s\S]*•/.test(value)) {
    warnings.push({
      type: 'reply_quality_warning',
      issue: 'unsolicited_followup_list',
      summary: 'Assistant reply contains unsolicited follow-up bullet list',
    })
  }
  const normalizedLines = value
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(line => line.length >= 18)
  const seen = new Set()
  for (const line of normalizedLines) {
    if (seen.has(line)) {
      warnings.push({
        type: 'reply_quality_warning',
        issue: 'duplicate_block',
        summary: 'Assistant reply contains duplicated text',
      })
      break
    }
    seen.add(line)
  }
  return warnings
}

function summarizeToolLoopWarnings(toolNotFoundCounts) {
  return Object.entries(toolNotFoundCounts)
    .filter(([, count]) => count >= 2)
    .map(([toolName, count]) => ({
      type: 'tool_not_found_loop',
      toolName,
      count,
      summary: `Tool ${toolName} not found repeated ${count} times`,
    }))
}

// GET /api/monitor/latency — bounded Telegram latency timeline from gateway logs
router.get('/latency', (req, res) => {
  try {
    const minutes = Math.min(Math.max(parseInt(req.query.minutes || '60', 10), 1), 1440)
    const agent = req.query.agent ? String(req.query.agent) : undefined
    const channel = req.query.channel ? String(req.query.channel) : 'telegram'
    if (channel !== 'telegram') {
      return res.json({
        generatedAt: new Date().toISOString(),
        windowMinutes: minutes,
        summary: { count: 0, ackP50Ms: null, ackP95Ms: null, finalP50Ms: null, finalP95Ms: null, byStatus: {}, slo: { ackP95Ok: null, finalTextP95Ok: null } },
        turns: [],
        slowest: [],
        warnings: [{ type: 'unsupported_channel', summary: 'Latency timeline currently supports Telegram gateway markers only' }],
      })
    }
    res.json(buildLatencyFromGatewayLog({ minutes, agent }))
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/monitor/conversations — operator-first turn feed across model and deterministic paths
router.get('/conversations', async (req, res) => {
  try {
    const minutes = Math.min(Math.max(parseInt(req.query.minutes || '180', 10), 1), 1440)
    const limit = Math.min(Math.max(parseInt(req.query.limit || '100', 10), 1), 300)
    const agentFilter = req.query.agent ? String(req.query.agent) : undefined
    const channelFilter = req.query.channel ? String(req.query.channel) : undefined

    let config = {}
    try { config = readOpenclawConfig() } catch { config = {} }
    const agentList = config.agents?.list || []
    const turns = []

    for (const agent of agentList) {
      const agentId = agent.id
      if (agentFilter && agentFilter !== agentId) continue
      const sessionsPath = path.join(HOME, `.openclaw/agents/${agentId}/sessions/sessions.json`)
      let sessionsMap = {}
      try { sessionsMap = JSON.parse(fs.readFileSync(sessionsPath, 'utf8')) } catch { continue }

      const sessionEntries = Object.entries(sessionsMap)
        .filter(([key, info]) => info && !key.includes(':main'))
        .sort((a, b) => Number(b[1]?.updatedAt || 0) - Number(a[1]?.updatedAt || 0))
        .slice(0, MAX_CONVERSATION_SESSIONS_PER_AGENT)

      for (const [sessionKey, sessionInfo] of sessionEntries) {
        const parsed = parseSessionChannelUser(sessionKey)
        if (!parsed) continue
        if (channelFilter && parsed.channel !== channelFilter) continue
        const sessionFile = sessionInfo.sessionFile
          || (sessionInfo.sessionId ? path.join(HOME, `.openclaw/agents/${agentId}/sessions/${sessionInfo.sessionId}.jsonl`) : null)
        if (!sessionFile || !fs.existsSync(sessionFile)) continue
        turns.push(...buildConversationTurnsFromSession({
          agentId,
          sessionKey,
          user: parsed.user,
          channel: parsed.channel,
          sessionFile,
          minutes,
        }))
      }
    }

    turns.push(...buildConversationTurnsFromGatewayLog({
      minutes,
      agent: agentFilter,
      channel: channelFilter,
      limit,
    }))

    turns.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
    const limitedTurns = turns.slice(0, limit)
    const statusCounts = limitedTurns.reduce((acc, turn) => {
      acc[turn.status] = (acc[turn.status] || 0) + 1
      return acc
    }, {})
    const routeCounts = limitedTurns.reduce((acc, turn) => {
      acc[turn.route] = (acc[turn.route] || 0) + 1
      return acc
    }, {})
    const completedDurations = limitedTurns
      .map(turn => Number(turn.durationMs || 0))
      .filter(value => value > 0)
    const avgDurationMs = completedDurations.length
      ? Math.round(completedDurations.reduce((sum, value) => sum + value, 0) / completedDurations.length)
      : null

    res.json({
      generatedAt: new Date().toISOString(),
      windowMinutes: minutes,
      summary: {
        count: limitedTurns.length,
        byStatus: statusCounts,
        byRoute: routeCounts,
        avgDurationMs,
      },
      turns: limitedTurns,
      warnings: [],
    })
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/monitor/events — real-time session state across all agents and channels
router.get('/events', async (req, res) => {
  try {
    // Read agents from openclaw.json
    let config = {}
    try { config = readOpenclawConfig() } catch { config = {} }
    const agentList = (config.agents && config.agents.list) ? config.agents.list : []

    // Load existing webchat rooms from DB grouped by agent_id
    // Key: agentId → Set of usernames that still have active rooms
    const webchatRoomsByAgent = {}
    let webchatDbAvailable = false
    if (pgPool) {
      try {
        const r = await pgPool.query('SELECT agent_id FROM webchat_rooms')
        webchatDbAvailable = true
        for (const row of r.rows) {
          if (!webchatRoomsByAgent[row.agent_id]) webchatRoomsByAgent[row.agent_id] = true
        }
      } catch { /* DB unavailable — skip filter */ }
    }

    const today = new Date().toISOString().slice(0, 10)
    let totalMessages = 0
    let totalCostToday = 0
    let activeNow = 0
    let errors = 0
    let responseTimes = []
    const globalEvents = []
    const seenModelTexts = new Set()

    const agentsResult = []

    for (const agent of agentList) {
      const agentId = agent.id
      const configuredModelRef = configuredModelForAgent(config, agent)
      const sessionsPath = path.join(HOME, `.openclaw/agents/${agentId}/sessions/sessions.json`)

      let sessionsMap = {}
      try { sessionsMap = JSON.parse(fs.readFileSync(sessionsPath, 'utf8')) } catch { continue }

      const channels = {}

      for (const [key, sessionInfo] of Object.entries(sessionsMap).slice(-MAX_SESSIONS_PER_AGENT)) {
        // Skip heartbeat sessions
        if (key.includes(':main')) continue

        let channel = null
        let user = null

        if (key.includes('hook:webchat')) {
          channel = 'webchat'
          const parts = key.split(':')
          user = parts[parts.length - 1]
          // Skip if no webchat rooms exist for this agent in DB
          if (webchatDbAvailable && !webchatRoomsByAgent[agentId]) continue
        } else if (key.includes('telegram')) {
          channel = 'telegram'
          // key format e.g. agent:sale:telegram:botname:userId
          const parts = key.split(':')
          const telegramIdx = parts.findIndex(p => p === 'telegram')
          user = parts.slice(telegramIdx + 1).join(':')
        } else if (key.includes(':line:')) {
          channel = 'line'
          // key format: agent:sale:line:direct:uXXXX
          const parts = key.split(':')
          const lineIdx = parts.findIndex(p => p === 'line')
          user = parts.slice(lineIdx + 1).join(':')
        } else {
          continue
        }

        if (!sessionInfo) continue
        // sessionFile may be absent after native resets; fall back to the latest
        // usage-family session or trajectory so model token/cost remains visible in Monitor.
        const sessionSource = resolveMonitorSessionSource(agentId, sessionInfo)
        if (!sessionSource) continue
        if (!channels[channel]) channels[channel] = []

        // Read a bounded tail window of the .jsonl file.
        let lines = []
        try {
          const maxLines = sessionSource.kind === 'trajectory'
            ? Math.max(MAX_EVENTS_LINES, MAX_CONVERSATION_LINES)
            : MAX_EVENTS_LINES
          lines = readTailLines(sessionSource.file, maxLines)
        } catch { continue }

        // Parse JSONL events
        const parsedLines = []
        for (const line of lines) {
          try { parsedLines.push(JSON.parse(line)) } catch { /* skip */ }
        }

        // Normalize: jsonl entries may be regular session messages or trajectory snapshots.
        const normalized = sessionSource.kind === 'trajectory'
          ? normalizeTrajectoryEntries(parsedLines)
          : parsedLines.map(normalizeSessionEntry).filter(Boolean)

        // Filter out heartbeat noise and delivery receipts mirrored after Telegram sends.
        const filtered = normalized.filter(shouldIncludeMonitorMessage)

        let lastUserMsg = null
        let lastAssistantMsg = null
        for (const msg of filtered) {
          if (msg.role === 'user') lastUserMsg = msg
          if (msg.role === 'assistant') lastAssistantMsg = msg
        }

        const lastMsg = filtered.length ? filtered[filtered.length - 1] : null
        const lastMsgRole = lastMsg ? lastMsg.role : null
        const lastMsgTs = lastMsg ? (lastMsg.timestamp || lastMsg.ts || null) : null
        const lastMsgTime = lastMsgTs ? new Date(lastMsgTs) : null
        const nowMs = Date.now()
        const elapsedSec = lastMsgTime ? Math.floor((nowMs - lastMsgTime.getTime()) / 1000) : null

        // Determine state
        let state = 'idle'
        if (lastMsgRole === 'user' && elapsedSec !== null && elapsedSec < 300) {
          state = 'thinking'
        } else if (lastMsgRole === 'assistant' && elapsedSec !== null && elapsedSec < 120) {
          // Check for error in last assistant message
          const hasError = (() => {
            if (!lastMsg) return false
            if (detectModelError(lastMsg)) return true
            const c = lastMsg.content
            if (Array.isArray(c)) return c.some(x => x.type === 'error' || (typeof x.text === 'string' && x.text.toLowerCase().includes('error')))
            if (typeof c === 'string') return c.toLowerCase().includes('error')
            return false
          })()
          state = hasError ? 'error' : 'replied'
        } else if (lastMsgRole === 'assistant') {
          const hasError = (() => {
            if (!lastMsg) return false
            if (detectModelError(lastMsg)) return true
            const c = lastMsg.content
            if (Array.isArray(c)) return c.some(x => x.type === 'error')
            return false
          })()
          if (hasError) state = 'error'
        }

        if (state === 'thinking' || state === 'replied') activeNow++
        if (state === 'error') errors++

        // Extract last user text
        let lastUserText = null
        if (lastUserMsg) {
          const c = lastUserMsg.content
          if (typeof c === 'string') lastUserText = stripGatewayMetadata(c).slice(0, 300)
          else if (Array.isArray(c)) {
            const textItem = c.find(x => x.type === 'text')
            if (textItem) lastUserText = stripGatewayMetadata(textItem.text).slice(0, 300)
          }
        }

        // Extract last reply text
        let lastReplyText = null
        if (lastAssistantMsg) {
          const c = lastAssistantMsg.content
          if (typeof c === 'string') lastReplyText = c.slice(0, 300)
          else if (Array.isArray(c)) {
            const textItem = c.find(x => x.type === 'text')
            if (textItem) lastReplyText = textItem.text.slice(0, 300)
          }
        }

        // Count cost and today messages
        let sessionCost = 0
        let sessionInputTokens = 0
        let sessionOutputTokens = 0
        for (const msg of filtered) {
          const usageMetrics = normalizeUsageMetrics(msg.usage)
          if (usageMetrics) {
            sessionInputTokens += usageMetrics.input
            sessionOutputTokens += usageMetrics.output
            sessionCost += usageMetrics.cost
          }
          // Count today's messages
          const ts = msg.timestamp || msg.ts
          if (ts && ts.slice(0, 10) === today) {
            totalMessages++
          }
        }
        totalCostToday += sessionCost

        // Calculate response time (time between last user msg and last assistant msg)
        if (lastUserMsg && lastAssistantMsg) {
          const userTs = lastUserMsg.timestamp || lastUserMsg.ts
          const assistantTs = lastAssistantMsg.timestamp || lastAssistantMsg.ts
          if (userTs && assistantTs) {
            const diff = (new Date(assistantTs).getTime() - new Date(userTs).getTime()) / 1000
            if (diff > 0 && diff < 3600) responseTimes.push(diff)
          }
        }

        // Build events array from messages (with latency, token usage, and tool result pairing)
        const events = []
        const toolNotFoundCounts = {}
        const modelWarnings = []
        const replyQualityWarnings = []
        const toolChain = []
        let lastUserTsMs = null
        for (const msg of filtered) {
          const msgTs = msg.timestamp || msg.ts
          const msgTimeMs = msgTs ? new Date(msgTs).getTime() : null
          const msgTime = monitorEventTime(msgTimeMs)
          const tsFormatted = msgTime.ts
          const usage = msg.usage
          if (msg.role === 'user') {
            lastUserTsMs = msgTime.timeMs
            const c = msg.content
            let text = ''
            if (typeof c === 'string') text = stripGatewayMetadata(c)
            else if (Array.isArray(c)) {
              const t = c.find(x => x.type === 'text')
              if (t) text = stripGatewayMetadata(t.text)
            }
            if (text) events.push({ ...msgTime, ts: tsFormatted, type: 'message', text })
            if (channel === 'telegram' && text) {
              seenModelTexts.add(`${agentId}|${safeSnippet(text, 600)}`)
            }
          } else if (msg.role === 'assistant') {
            const usageMetricsForMessage = normalizeUsageMetrics(usage)
            const modelMetaForMessage = messageModelMetadata(msg, configuredModelRef, usageMetricsForMessage)
            const modelError = detectModelError(msg)
            if (modelError) {
              modelWarnings.push(modelError)
              events.push({
                ...msgTime,
                ts: tsFormatted,
                type: 'error',
                category: modelError.type,
                text: modelError.summary,
                detail: modelError.detail,
                model: modelMetaForMessage.model,
                provider: modelMetaForMessage.provider,
                modelSource: modelMetaForMessage.modelSource,
                finishReason: modelMetaForMessage.finishReason,
              })
            }
            let usageAttachedToMessage = false
            const attachUsageToEvent = (ev) => {
              if (modelMetaForMessage.model) {
                ev.model = modelMetaForMessage.model
                ev.provider = modelMetaForMessage.provider
                ev.modelSource = modelMetaForMessage.modelSource
              }
              if (modelMetaForMessage.finishReason) ev.finishReason = modelMetaForMessage.finishReason
              if (!usageMetricsForMessage || usageAttachedToMessage) return ev
              ev.inputTokens = usageMetricsForMessage.input
              ev.outputTokens = usageMetricsForMessage.output
              ev.cost = usageMetricsForMessage.cost
              usageAttachedToMessage = true
              return ev
            }
            const c = msg.content
            if (Array.isArray(c)) {
              for (const item of c) {
                if (item.type === 'thinking') {
                  events.push(attachUsageToEvent({ ...msgTime, ts: tsFormatted, type: 'thinking', text: (item.thinking || '') }))
                } else if (item.type === 'tool_use' || item.type === 'toolCall') {
                  const toolName = item.name || ''
                  if (toolName) toolChain.push(toolName)
                  const toolText = toolName + (item.input ? ': ' + JSON.stringify(item.input, null, 2) : '')
                  events.push(attachUsageToEvent({ ...msgTime, ts: tsFormatted, type: 'tool', text: toolText, toolName }))
                } else if (item.type === 'text' && item.text) {
                  const lower = item.text.toLowerCase()
                  if (lower.includes('bash') || lower.includes('exec')) {
                    events.push(attachUsageToEvent({ ...msgTime, ts: tsFormatted, type: 'tool', text: item.text }))
                  } else {
                    const quality = detectReplyQualityWarnings(item.text)
                    for (const warning of quality) {
                      replyQualityWarnings.push(warning)
                      events.push({
                        ...msgTime,
                        ts: tsFormatted,
                        type: 'warning',
                        category: warning.type,
                        issue: warning.issue,
                        text: warning.summary,
                      })
                    }
                    const ev = { ...msgTime, ts: tsFormatted, type: 'reply', text: item.text }
                    if (lastUserTsMs && msgTime.timeMs) {
                      const diff = (msgTime.timeMs - lastUserTsMs) / 1000
                      if (diff > 0 && diff < 3600) ev.latency = Math.round(diff * 10) / 10
                    }
                    attachUsageToEvent(ev)
                    events.push(ev)
                    lastUserTsMs = null
                  }
                } else if (item.type === 'error') {
                  events.push({ ...msgTime, ts: tsFormatted, type: 'error', text: (item.text || JSON.stringify(item, null, 2)).slice(0, 5000) })
                }
              }
            } else if (typeof c === 'string') {
              const quality = detectReplyQualityWarnings(c)
              for (const warning of quality) {
                replyQualityWarnings.push(warning)
                events.push({
                  ...msgTime,
                  ts: tsFormatted,
                  type: 'warning',
                  category: warning.type,
                  issue: warning.issue,
                  text: warning.summary,
                })
              }
              const ev = { ...msgTime, ts: tsFormatted, type: 'reply', text: c }
              if (lastUserTsMs && msgTime.timeMs) {
                const diff = (msgTime.timeMs - lastUserTsMs) / 1000
                if (diff > 0 && diff < 3600) ev.latency = Math.round(diff * 10) / 10
              }
              attachUsageToEvent(ev)
              events.push(ev)
              lastUserTsMs = null
            }
          } else if (msg.role === 'toolResult') {
            // Pair tool result with last unmatched tool event
            const text = extractToolResultText(msg)
            const missingTool = parseToolNotFound(text)
            if (missingTool) {
              toolNotFoundCounts[missingTool] = (toolNotFoundCounts[missingTool] || 0) + 1
            }
            if (text) {
              let paired = false
              for (let i = events.length - 1; i >= 0; i--) {
                if (events[i].type === 'tool' && events[i].toolResult === undefined) {
                  events[i].toolResult = text.slice(0, 3000)
                  paired = true
                  break
                }
              }
              if (missingTool && !paired) {
                events.push({ ...msgTime, ts: tsFormatted, type: 'warning', text: `Tool ${missingTool} not found`, toolName: missingTool, toolResult: text.slice(0, 3000) })
              }
            }
          }
        }

        const toolWarnings = summarizeToolLoopWarnings(toolNotFoundCounts)
        for (const warning of toolWarnings) {
          const lastEvent = events.at(-1) || {}
          events.push({
            ts: lastEvent.ts || null,
            timestamp: lastEvent.timestamp || null,
            timeMs: lastEvent.timeMs ?? null,
            type: 'warning',
            text: warning.summary,
            toolName: warning.toolName,
          })
        }

        // Skip stale sessions (no activity in last 3 days)
        if (lastMsgTs) {
          const age = (Date.now() - new Date(lastMsgTs).getTime()) / 1000
          if (age > 259200) continue
        }

        if (!channels[channel]) channels[channel] = []

        const sessionEntry = {
          sessionKey: key,
          user,
          state,
          lastMessageAt: lastMsgTs || null,
          lastUserText,
          lastReplyText,
          elapsed: elapsedSec,
          cost: Math.round(sessionCost * 100000) / 100000,
          inputTokens: sessionInputTokens,
          outputTokens: sessionOutputTokens,
          warnings: [...modelWarnings, ...replyQualityWarnings, ...toolWarnings],
          toolChain,
          events
        }
        channels[channel].push(sessionEntry)

        // Add to globalEvents
        for (const ev of events) {
          globalEvents.push({
            ts: ev.ts,
            timestamp: ev.timestamp,
            timeMs: ev.timeMs,
            agentId,
            channel,
            user,
            type: ev.type,
            text: ev.text,
            toolName: ev.toolName,
            toolInput: ev.toolInput,
            toolResult: ev.toolResult,
            cleanKeyword: ev.cleanKeyword,
            intent: ev.intent,
            route: ev.route,
            model: ev.model,
            provider: ev.provider,
            modelSource: ev.modelSource,
            finishReason: ev.finishReason,
            inputTokens: ev.inputTokens,
            outputTokens: ev.outputTokens,
            cost: ev.cost,
          })
        }
      }

      agentsResult.push({ id: agentId, channels })
    }

    const gatewayMonitor = buildGatewayMonitorSessions({ seenModelTexts })
    for (const agent of agentsResult) {
      const sessions = gatewayMonitor.byAgent.get(agent.id)
      if (!sessions?.length) continue
      if (!agent.channels.telegram) agent.channels.telegram = []
      agent.channels.telegram.push(...sessions)
    }
    globalEvents.push(...gatewayMonitor.globalEvents)
    totalMessages += gatewayMonitor.stats.messages
    errors += gatewayMonitor.stats.errors
    responseTimes.push(...gatewayMonitor.stats.responseTimes)

    // Sort by full timestamp, not only HH:mm:ss, so cross-day logs stay in order.
    sortMonitorEventsDesc(globalEvents)
    const limitedGlobalEvents = globalEvents.slice(0, 50)

    // Read gateway log from /tmp/openclaw/ — latest file, last 100 lines
    const gatewayEvents = []
    try {
      const logDir = '/tmp/openclaw'
      const logFiles = fs.readdirSync(logDir)
        .filter(f => f.endsWith('.log') || f.endsWith('.jsonl'))
        .map(f => ({ name: f, mtime: fs.statSync(path.join(logDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)

      if (logFiles.length > 0) {
        const latestLog = path.join(logDir, logFiles[0].name)
        const logLines = readTailLines(latestLog, 100, 512 * 1024)
        for (const line of logLines) {
          try {
            const obj = JSON.parse(line)
            const subsystem = typeof obj['0'] === 'string' ? (() => { try { return JSON.parse(obj['0']) } catch { return obj['0'] } })() : obj['0']
            const message = obj['1'] || obj.message || ''
            const timeMs = obj.time ? new Date(obj.time).getTime() : null
            gatewayEvents.push({ ...monitorEventTime(timeMs), subsystem, message })
          } catch { /* skip */ }
        }
        sortMonitorEventsDesc(gatewayEvents)
      }
    } catch { /* skip if /tmp/openclaw doesn't exist */ }

    const avgResponseTime = responseTimes.length
      ? Math.round((responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length) * 10) / 10
      : 0

    res.json({
      agents: agentsResult,
      globalEvents: limitedGlobalEvents,
      gatewayEvents,
      stats: {
        totalAgents: agentList.length,
        activeNow,
        todayMessages: totalMessages,
        avgResponseTime,
        totalCostToday: Math.round(totalCostToday * 100000) / 100000,
        errors
      }
    })
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/agents/:id/sessions — list sessions with token metadata
agentSessionsRouter.get('/:id/sessions', (req, res) => {
  try {
    const config = readOpenclawConfig()
    const agent = config.agents?.list?.find(a => a.id === req.params.id)
    if (!agent) return res.status(404).json({ error: 'Agent not found' })

    const sessionsPath = path.join(HOME, `.openclaw/agents/${req.params.id}/sessions/sessions.json`)
    if (!fs.existsSync(sessionsPath)) return res.json([])

    const sessionsMap = JSON.parse(fs.readFileSync(sessionsPath, 'utf8'))
    const userNames = readUserNames()
    const result = []

    for (const [key, info] of Object.entries(sessionsMap).slice(-MAX_SESSIONS_PER_AGENT)) {
      if (!info || !info.sessionId || key.includes(':main')) continue
      const sessionFile = info.sessionFile
        || path.join(HOME, `.openclaw/agents/${req.params.id}/sessions/${info.sessionId}.jsonl`)
      if (!fs.existsSync(sessionFile)) continue

      let inputTokens = 0, outputTokens = 0
      try {
        const lines = readTailLines(sessionFile, MAX_SESSION_LINES)
        for (const line of lines) {
          try {
            const entry = JSON.parse(line)
            if (isDeliveryMirrorMessage(entry.message)) continue
            const usageMetrics = normalizeUsageMetrics(entry.message?.usage ?? entry.usage)
            if (usageMetrics) {
              inputTokens += usageMetrics.input
              outputTokens += usageMetrics.output
            }
          } catch {}
        }
      } catch {}

      let userLabel = key.replace(/^agent:[^:]+:/, '')
      let userFrom = 'unknown'
      if (key.includes('telegram')) userFrom = 'telegram'
      else if (key.includes(':line:')) userFrom = 'line'
      else if (key.includes('hook:webchat')) userFrom = 'webchat'

      const peerId = info.deliveryContext?.to || info.lastTo
      if (peerId && userNames[peerId]) userLabel = userNames[peerId]

      result.push({
        sessionId: info.sessionId,
        sessionKey: key,
        userLabel,
        userFrom,
        updatedAt: info.updatedAt || 0,
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
      })
    }

    result.sort((a, b) => b.updatedAt - a.updatedAt)
    res.json(result)
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/agents/:id/sessions/:sessionKey(*) — full session replay
// :sessionKey can be a UUID filename OR a sessions.json key like "agent:sale:telegram:direct:123"
agentSessionsRouter.get('/:id/sessions/:sessionKey(*)', (req, res) => {
  try {
    const { id, sessionKey } = req.params

    // Try to resolve sessionKey → actual .jsonl file path
    let sessionFile = path.join(HOME, `.openclaw/agents/${id}/sessions/${sessionKey}.jsonl`)
    if (!fs.existsSync(sessionFile)) {
      // Look up in sessions.json for sessionFile field
      const sessionsJsonPath = path.join(HOME, `.openclaw/agents/${id}/sessions/sessions.json`)
      if (fs.existsSync(sessionsJsonPath)) {
        try {
          const sessionsData = JSON.parse(fs.readFileSync(sessionsJsonPath, 'utf8'))
          const entry = sessionsData[sessionKey]
          if (entry?.sessionFile) {
            sessionFile = entry.sessionFile
          } else if (entry?.sessionId) {
            sessionFile = path.join(HOME, `.openclaw/agents/${id}/sessions/${entry.sessionId}.jsonl`)
          }
        } catch {}
      }
    }
    if (!fs.existsSync(sessionFile)) return res.status(404).json({ error: 'Session not found' })

    const requestedLimit = Number.parseInt(String(req.query.limit || ''), 10)
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, MAX_SESSION_LINES)
      : MAX_SESSION_LINES
    const lines = readTailLines(sessionFile, limit)
    const messages = []
    const toolNotFoundCounts = {}
    let totalInput = 0, totalOutput = 0, totalCost = 0
    let lastUserTsMs = null
    const latencies = []

    for (const line of lines) {
      try {
        const entry = JSON.parse(line)
        if (entry.type !== 'message' || !entry.message) continue
        const msg = entry.message
        if (isDeliveryMirrorMessage(msg)) continue
        const usageMetrics = normalizeUsageMetrics(msg.usage ?? entry.usage)
        const ts = entry.timestamp

        if (msg.role === 'user') {
          lastUserTsMs = ts ? new Date(ts).getTime() : null
          const c = msg.content
          let text = ''
          if (typeof c === 'string') text = stripGatewayMetadata(c)
          else if (Array.isArray(c)) text = stripGatewayMetadata(c.find(x => x.type === 'text')?.text || '')
          messages.push({ role: 'user', timestamp: ts, text })
        } else if (msg.role === 'assistant') {
          const c = msg.content || []
          const thinking = Array.isArray(c) ? (c.find(x => x.type === 'thinking')?.thinking || null) : null
          const textParts = Array.isArray(c) ? c.filter(x => x.type === 'text').map(x => x.text) : (typeof c === 'string' ? [c] : [])
          const toolCalls = Array.isArray(c) ? c.filter(x => x.type === 'toolCall' || x.type === 'tool_use').map(x => ({ name: x.name, input: x.input })) : []

          let latency = null
          if (lastUserTsMs && ts) {
            const diff = (new Date(ts).getTime() - lastUserTsMs) / 1000
            if (diff > 0 && diff < 3600) { latency = Math.round(diff * 10) / 10; latencies.push(latency) }
          }

          if (usageMetrics) {
            totalInput += usageMetrics.input
            totalOutput += usageMetrics.output
            totalCost += usageMetrics.cost
          }

          if (textParts.length > 0 || toolCalls.length > 0 || thinking) {
            messages.push({
              role: 'assistant',
              timestamp: ts,
              thinking,
              text: textParts.join('\n'),
              toolCalls,
              model: msg.model,
              provider: msg.provider || providerFromModelRef(msg.model),
              modelSource: msg.model ? 'actual' : null,
              stopReason: msg.stopReason,
              usage: usageMetrics ? {
                input: usageMetrics.input,
                output: usageMetrics.output,
                cost: usageMetrics.cost,
              } : null,
              latency,
            })
            if (textParts.length > 0) lastUserTsMs = null
          }
        } else if (msg.role === 'toolResult') {
          const text = extractToolResultText(msg)
          const missingTool = parseToolNotFound(text)
          if (missingTool) {
            toolNotFoundCounts[missingTool] = (toolNotFoundCounts[missingTool] || 0) + 1
          }
          for (let i = messages.length - 1; i >= 0; i--) {
            const prev = messages[i]
            if (prev.role === 'assistant' && prev.toolCalls?.length > 0) {
              const lastTool = prev.toolCalls[prev.toolCalls.length - 1]
              if (lastTool.result === undefined) { lastTool.result = text.slice(0, 3000); break }
            }
          }
        }
      } catch {}
    }

    const avgLatency = latencies.length
      ? Math.round((latencies.reduce((a, b) => a + b, 0) / latencies.length) * 10) / 10 : 0

    res.json({
      sessionId: sessionKey,
      agentId: id,
      messages,
      warnings: summarizeToolLoopWarnings(toolNotFoundCounts),
      stats: {
        turns: messages.filter(m => m.role === 'user').length,
        inputTokens: totalInput,
        outputTokens: totalOutput,
        totalCost: Math.round(totalCost * 100000) / 100000,
        avgLatency,
      },
    })
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

function buildMonitorCost(days = 30) {
  const config = readOpenclawConfig()
  const agentList = config.agents?.list || []
  const boundedDays = Math.min(Math.max(parseInt(days || '30'), 1), 90)
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - boundedDays)

  // dayData[date][agentId] = { cost, inputTokens, outputTokens, turns }
  const dayData = {}

  for (const agent of agentList) {
    const sessionsDir = path.join(HOME, `.openclaw/agents/${agent.id}/sessions`)
    if (!fs.existsSync(sessionsDir)) continue

    const files = latestFiles(
      sessionsDir,
      f => f.endsWith('.jsonl') && !f.includes('.reset.'),
      MAX_COST_FILES_PER_AGENT
    )

    for (const file of files) {
      try {
        const lines = readTailLines(path.join(sessionsDir, file), MAX_COST_LINES_PER_FILE, 2 * 1024 * 1024)
        for (const line of lines) {
          try {
            const entry = JSON.parse(line)
            if (entry.message?.role !== 'assistant') continue
            if (isDeliveryMirrorMessage(entry.message)) continue
            const usageMetrics = normalizeUsageMetrics(entry.message?.usage ?? entry.usage)
            if (!usageMetrics) continue
            const ts = entry.timestamp
            if (!ts || new Date(ts) < cutoff) continue

            const date = ts.slice(0, 10)
            if (!dayData[date]) dayData[date] = {}
            if (!dayData[date][agent.id]) dayData[date][agent.id] = { cost: 0, inputTokens: 0, outputTokens: 0, turns: 0 }

            dayData[date][agent.id].cost += usageMetrics.cost
            dayData[date][agent.id].inputTokens += usageMetrics.input
            dayData[date][agent.id].outputTokens += usageMetrics.output
            dayData[date][agent.id].turns++
          } catch {}
        }
      } catch {}
    }
  }

  const sortedDates = Object.keys(dayData).sort()
  const resultDays = sortedDates.map(date => {
    const agents = Object.entries(dayData[date]).map(([agentId, s]) => ({
      agentId,
      cost: Math.round(s.cost * 100000) / 100000,
      inputTokens: s.inputTokens,
      outputTokens: s.outputTokens,
      turns: s.turns,
    })).sort((a, b) => b.cost - a.cost)
    const total = agents.reduce((s, a) => s + a.cost, 0)
    return { date, agents, total: Math.round(total * 100000) / 100000 }
  })

  const summaryByAgent = {}
  for (const day of resultDays) {
    for (const a of day.agents) {
      summaryByAgent[a.agentId] = Math.round(((summaryByAgent[a.agentId] || 0) + a.cost) * 100000) / 100000
    }
  }

  return {
    days: resultDays,
    summary: {
      totalCost: Math.round(Object.values(summaryByAgent).reduce((a, b) => a + b, 0) * 100000) / 100000,
      byAgent: summaryByAgent,
    },
  }
}

// GET /api/monitor/cost — aggregate cost per agent per day (last N days)
router.get('/cost', (req, res) => {
  try {
    res.json(buildMonitorCost(req.query.days || '30'))
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = {
  router,
  agentSessionsRouter,
  _internal: {
    detectModelError,
    detectReplyQualityWarnings,
    extractMessageText,
    isDeliveryMirrorMessage,
    normalizeSessionEntry,
    shouldIncludeMonitorMessage,
    extractToolResultText,
    messageModelMetadata,
    normalizeUsageMetrics,
    normalizeTrajectoryEntries,
    buildConversationTurnsFromSession,
    buildConversationTurnsFromGatewayLog,
    buildMonitorCost,
    parseToolNotFound,
    resolveMonitorSessionSource,
    monitorEventTime,
    monitorEventTimeMs,
    sortMonitorEventsDesc,
    summarizeToolLoopWarnings,
  },
}
