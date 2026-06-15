const router = require('express').Router()
const fs = require('fs')
const path = require('path')
const net = require('net')
const { execFileSync } = require('child_process')
const { HOME, CONFIG_PATH } = require('../lib/config')
const { readOpenclawConfig } = require('../lib/openclaw-config')
const {
  DEFAULT_MCP_URL,
  compareSoulContractToTools,
  getMcpTools,
  normalizeAccessMode,
  parseSoulContract,
} = require('../lib/mcp-tools')

const HEALTH_TTL_MS = 30_000
const EXTERNAL_TIMEOUT_MS = 1800
let healthCache = null

function nowIso() {
  return new Date().toISOString()
}

function durationSince(startedAt) {
  return Date.now() - startedAt
}

function statusRank(status) {
  if (status === 'fail') return 2
  if (status === 'warn') return 1
  return 0
}

function makeCheck(id, label, status, severity, summary, startedAt, extra = {}) {
  return {
    id,
    label,
    status,
    severity,
    summary,
    durationMs: durationSince(startedAt),
    ...extra,
  }
}

function sanitizeError(e) {
  return String(e?.message || e || 'unknown error')
    .replace(/bot[0-9]{6,}:[A-Za-z0-9_-]+/g, 'bot<redacted>')
    .replace(/sk-or-[A-Za-z0-9_-]+/g, 'sk-or-<redacted>')
    .slice(0, 240)
}

function redact(value) {
  if (Array.isArray(value)) return value.map(redact)
  if (!value || typeof value !== 'object') return value
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (/token|secret|key|authorization|password/i.test(key)) {
      out[key] = item ? '<redacted>' : item
    } else {
      out[key] = redact(item)
    }
  }
  return out
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function readTailLines(filePath, maxLines, maxBytes = 256 * 1024) {
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

function resolveHome(p) {
  return typeof p === 'string' ? p.replace(/^~/, HOME) : p
}

function getAgentMcp(config, agentId) {
  const servers = config.mcp?.servers || {}
  const server = servers[agentId] || servers[`sml-${agentId}`] || null
  if (!server) return null
  return {
    name: servers[agentId] ? agentId : `sml-${agentId}`,
    url: server.url || DEFAULT_MCP_URL,
    accessMode: normalizeAccessMode(server.headers?.['mcp-access-mode'] || server.env?.MCP_ACCESS_MODE || agentId || 'general'),
    legacyName: Boolean(servers[`sml-${agentId}`] && !servers[agentId]),
  }
}

async function fetchJson(url, { headers = {}, timeoutMs = EXTERNAL_TIMEOUT_MS } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { headers, signal: controller.signal })
    const text = await res.text()
    let json = null
    try { json = text ? JSON.parse(text) : null } catch {}
    return { ok: res.ok, status: res.status, json, text }
  } finally {
    clearTimeout(timer)
  }
}

function checkTcpPort(port, host = '127.0.0.1', timeoutMs = 700) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host, port })
    const timer = setTimeout(() => {
      socket.destroy()
      resolve(false)
    }, timeoutMs)
    socket.once('connect', () => {
      clearTimeout(timer)
      socket.end()
      resolve(true)
    })
    socket.once('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
  })
}

function hasAuthProfile(agentId) {
  const authPath = path.join(HOME, `.openclaw/agents/${agentId}/agent/auth-profiles.json`)
  try {
    const profile = readJsonFile(authPath)
    const text = JSON.stringify(profile)
    return { exists: true, ok: /sk-or-[A-Za-z0-9_-]+/.test(text), path: authPath }
  } catch {
    return { exists: false, ok: false, path: authPath }
  }
}

function soulStatus(agent, tools = []) {
  const workspace = resolveHome(agent.workspace)
  const soulPath = path.join(workspace, 'SOUL.md')
  try {
    const soul = fs.readFileSync(soulPath, 'utf8')
    const legacyPatterns = [
      { label: 'curl', re: /\bcurl\b/i },
      { label: '/call', re: /\/call\b/i },
      { label: 'exec tool', re: /exec\s+tool/i },
      { label: 'mcporter', re: /mcporter/i },
    ].filter(p => p.re.test(soul)).map(p => p.label)
    const contract = parseSoulContract(soul)
    const contractStatus = compareSoulContractToTools(contract, tools)
    const warnings = [...legacyPatterns.map(p => `legacy pattern: ${p}`), ...contractStatus.warnings]
    return {
      status: warnings.length ? 'warn' : 'ok',
      legacyPatterns,
      contract,
      contractWarnings: contractStatus.warnings,
      summary: warnings.length ? warnings.join('; ') : 'SOUL contract matches MCP tools',
    }
  } catch {
    return { status: 'fail', legacyPatterns: [], contractWarnings: [], summary: 'SOUL.md not found' }
  }
}

function telegramAccounts(config) {
  const tg = config.channels?.telegram || {}
  const accounts = []
  for (const [id, acc] of Object.entries(tg.accounts || {})) {
    if (acc?.botToken) accounts.push({ id, token: acc.botToken })
  }
  if (!accounts.some(a => a.id === 'default') && tg.botToken) {
    accounts.push({ id: 'default', token: tg.botToken })
  }
  return accounts
}

function recentToolLoopWarnings(config) {
  const warnings = []
  for (const agent of config.agents?.list || []) {
    const sessionsPath = path.join(HOME, `.openclaw/agents/${agent.id}/sessions/sessions.json`)
    let sessions = {}
    try { sessions = JSON.parse(fs.readFileSync(sessionsPath, 'utf8')) } catch { continue }

    for (const [sessionKey, info] of Object.entries(sessions).slice(-80)) {
      if (!info || sessionKey.includes(':main')) continue
      const sessionFile = info.sessionFile
        || (info.sessionId ? path.join(HOME, `.openclaw/agents/${agent.id}/sessions/${info.sessionId}.jsonl`) : null)
      if (!sessionFile || !fs.existsSync(sessionFile)) continue

      const counts = {}
      try {
        for (const line of readTailLines(sessionFile, 220)) {
          let entry = null
          try { entry = JSON.parse(line) } catch { continue }
          const msg = entry.message || entry
          if (msg.role !== 'toolResult') continue
          const content = Array.isArray(msg.content)
            ? msg.content.map(x => x?.text || '').join('\n')
            : String(msg.content || '')
          const match = content.match(/Tool\s+([A-Za-z0-9_.:-]+)\s+not found/i)
          if (match) counts[match[1]] = (counts[match[1]] || 0) + 1
        }
      } catch { continue }

      for (const [toolName, count] of Object.entries(counts)) {
        if (count >= 2) {
          warnings.push({ agentId: agent.id, sessionKey, toolName, count })
          if (warnings.length >= 20) return warnings
        }
      }
    }
  }
  return warnings
}

async function buildHealth() {
  const checks = []
  const agents = []
  let config = null

  const apiStart = Date.now()
  checks.push(makeCheck('api.self', 'OpenClaw API', 'ok', 'critical', 'Health route is responding', apiStart))

  const configStart = Date.now()
  try {
    config = readOpenclawConfig()
    checks.push(makeCheck(
      'config.openclaw',
      'openclaw.json',
      'ok',
      'critical',
      'Config parsed successfully',
      configStart
    ))
  } catch (e) {
    checks.push(makeCheck(
      'config.openclaw',
      'openclaw.json',
      'fail',
      'critical',
      sanitizeError(e),
      configStart,
      { remediation: `Validate JSON syntax in ${CONFIG_PATH} or rollback the latest backup` }
    ))
    return finishHealth(checks, agents)
  }

  const hooksPort = config.gateway?.hooksPort || 18789
  const gatewayStart = Date.now()
  try {
    execFileSync('pgrep', ['-f', 'openclaw.*gateway|openclaw-gateway'], { timeout: 700, stdio: 'ignore' })
    checks.push(makeCheck('gateway.process', 'Gateway process', 'ok', 'critical', 'OpenClaw gateway process is running', gatewayStart))
  } catch {
    const portOnline = await checkTcpPort(hooksPort)
    checks.push(makeCheck(
      'gateway.process',
      'Gateway process',
      portOnline ? 'ok' : 'fail',
      'critical',
      portOnline ? `Gateway hooks port ${hooksPort} is listening` : 'OpenClaw gateway process/port not found',
      gatewayStart,
      { remediation: portOnline ? undefined : 'Run openclaw gateway restart or restart the PM2 managed gateway' }
    ))
  }

  const hooksStart = Date.now()
  const hooksOk = Boolean(config.hooks?.enabled !== false && config.hooks?.allowRequestSessionKey !== false)
  checks.push(makeCheck(
    'hooks.config',
    'Hooks config',
    hooksOk ? 'ok' : 'warn',
    'critical',
    hooksOk ? `Hooks enabled on port ${hooksPort}` : 'Hooks config may block channel delivery',
    hooksStart,
    { remediation: hooksOk ? undefined : 'Enable hooks and allowRequestSessionKey in openclaw.json' }
  ))

  const hostsStart = Date.now()
  let hostsSummary = 'No Telegram hosts override found'
  let hostsStatus = 'info'
  try {
    const hosts = fs.readFileSync('/etc/hosts', 'utf8')
    if (/149\.154\.166\.110\s+api\.telegram\.org/.test(hosts)) {
      hostsStatus = 'ok'
      hostsSummary = 'api.telegram.org pinned to 149.154.166.110'
    } else if (/api\.telegram\.org/.test(hosts)) {
      hostsStatus = 'warn'
      hostsSummary = 'api.telegram.org is pinned to a different IP'
    }
  } catch {
    hostsStatus = 'warn'
    hostsSummary = 'Unable to read /etc/hosts'
  }
  checks.push(makeCheck(
    'telegram.hosts',
    'Telegram hosts',
    hostsStatus,
    'warn',
    hostsSummary,
    hostsStart,
    { remediation: hostsStatus === 'warn' ? 'Set api.telegram.org to 149.154.166.110 if Telegram timeout returns' : undefined }
  ))

  const list = config.agents?.list || []
  await Promise.all(list.map(async (agent) => {
    const mcp = getAgentMcp(config, agent.id)
    const auth = hasAuthProfile(agent.id)
    let toolCount = 0
    let mcpStatus = 'warn'
    let mcpSummary = 'No MCP server configured'
    let tools = []
    let toolSource = 'none'
    let mcpWarnings = []
    const mcpStart = Date.now()

    if (mcp?.url) {
      const result = await getMcpTools({
        mcpUrl: mcp.url,
        accessMode: mcp.accessMode,
        refresh: true,
        timeoutMs: EXTERNAL_TIMEOUT_MS,
      })
      tools = result.tools || []
      toolCount = tools.length
      toolSource = result.toolSource
      mcpWarnings = result.warnings || []
      mcpStatus = result.toolSource === 'live' ? 'ok' : 'fail'
      mcpSummary = result.toolSource === 'live'
        ? `${toolCount} tools available`
        : `MCP /tools unavailable, using fallback snapshot (${toolCount} tools)`
    }

    checks.push(makeCheck(
      `mcp.${agent.id}`,
      `MCP ${agent.id}`,
      mcpStatus,
      'critical',
      mcpSummary,
      mcpStart,
      {
        remediation: mcpStatus === 'ok' ? undefined : 'Register MCP through openclaw mcp add with the configured MCP URL',
        toolSource,
        warnings: mcpWarnings,
      }
    ))

    const soul = soulStatus(agent, tools)
    const soulCheckStart = Date.now()
    checks.push(makeCheck(
      `soul.${agent.id}`,
      `SOUL ${agent.id}`,
      soul.status,
      'warn',
      soul.summary,
      soulCheckStart,
      {
        remediation: soul.status === 'ok' ? undefined : 'Load the capability SOUL template, verify live MCP tools, then reset active sessions',
        legacyPatterns: soul.legacyPatterns,
        contractWarnings: soul.contractWarnings,
        allowedToolsHash: soul.contract?.allowedToolsHash,
      }
    ))

    const authStart = Date.now()
    checks.push(makeCheck(
      `auth.${agent.id}`,
      `Auth profile ${agent.id}`,
      auth.ok ? 'ok' : 'warn',
      'critical',
      auth.exists ? (auth.ok ? 'OpenRouter key present' : 'auth-profiles.json has no OpenRouter key') : 'auth-profiles.json missing',
      authStart,
      { remediation: auth.ok ? undefined : 'Rotate OpenRouter key into every agent auth-profiles.json' }
    ))

    agents.push({
      id: agent.id,
      accessMode: mcp?.accessMode || agent.id || 'general',
      mcpUrl: mcp?.url || DEFAULT_MCP_URL,
      toolCount,
      toolSource,
      soulStatus: soul.status,
      authStatus: auth.ok ? 'ok' : 'warn',
    })
  }))

  const tgAccounts = telegramAccounts(config)
  const tgStart = Date.now()
  if (tgAccounts.length === 0) {
    checks.push(makeCheck('telegram.api', 'Telegram API', 'info', 'warn', 'No Telegram bot token configured', tgStart))
  } else {
    const results = await Promise.all(tgAccounts.map(async account => {
      try {
        const result = await fetchJson(`https://api.telegram.org/bot${account.token}/getMe`, { timeoutMs: 2200 })
        return { ok: Boolean(result.json?.ok), status: result.status }
      } catch (e) {
        return { ok: false, error: sanitizeError(e) }
      }
    }))
    const okCount = results.filter(r => r.ok).length
    const failCount = results.length - okCount
    checks.push(makeCheck(
      'telegram.api',
      'Telegram API',
      failCount === 0 ? 'ok' : 'warn',
      'critical',
      `${okCount}/${results.length} bot account(s) reachable`,
      tgStart,
      { remediation: failCount ? 'Check bot tokens and the api.telegram.org hosts pin' : undefined }
    ))
  }

  return finishHealth(checks, agents)
}

function finishHealth(checks, agents) {
  const criticalFailed = checks.some(c => c.severity === 'critical' && c.status === 'fail')
  const maxRank = checks.reduce((rank, c) => Math.max(rank, statusRank(c.status)), 0)
  return {
    ok: !criticalFailed,
    generatedAt: nowIso(),
    cache: { hit: false, ttlSeconds: HEALTH_TTL_MS / 1000 },
    status: maxRank === 2 ? 'fail' : (maxRank === 1 ? 'warn' : 'ok'),
    checks: checks.map(redact),
    agents: agents.sort((a, b) => a.id.localeCompare(b.id)).map(redact),
  }
}

router.get('/health', async (req, res) => {
  try {
    const refresh = req.query.refresh === 'true'
    if (!refresh && healthCache && Date.now() - healthCache.createdAt < HEALTH_TTL_MS) {
      return res.json({
        ...healthCache.data,
        cache: { hit: true, ttlSeconds: Math.ceil((HEALTH_TTL_MS - (Date.now() - healthCache.createdAt)) / 1000) },
      })
    }
    const data = await buildHealth()
    healthCache = { createdAt: Date.now(), data }
    res.json(data)
  } catch (e) {
    res.status(200).json({
      ok: false,
      generatedAt: nowIso(),
      cache: { hit: false, ttlSeconds: HEALTH_TTL_MS / 1000 },
      status: 'fail',
      checks: [makeCheck('system.health', 'System health', 'fail', 'critical', sanitizeError(e), Date.now())],
      agents: [],
    })
  }
})

router.get('/support-bundle', async (req, res) => {
  const startedAt = Date.now()
  try {
    const health = healthCache && Date.now() - healthCache.createdAt < HEALTH_TTL_MS
      ? { ...healthCache.data, cache: { hit: true, ttlSeconds: Math.ceil((HEALTH_TTL_MS - (Date.now() - healthCache.createdAt)) / 1000) } }
      : await buildHealth()
    if (!healthCache || !health.cache.hit) healthCache = { createdAt: Date.now(), data: health }

    const repos = ['openclaw-api', 'openclaw-admin'].map(name => {
      const cwd = path.join(HOME, name)
      try {
        return {
          name,
          cwd,
          branch: execFileSync('git', ['branch', '--show-current'], { cwd, timeout: 1000 }).toString().trim(),
          status: execFileSync('git', ['status', '--short'], { cwd, timeout: 1000 }).toString().trim().split('\n').filter(Boolean).slice(0, 80),
          head: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd, timeout: 1000 }).toString().trim(),
        }
      } catch (e) {
        return { name, cwd, error: sanitizeError(e) }
      }
    })

    let processStatus = []
    try {
      processStatus = execFileSync('pm2', ['jlist'], { timeout: 1200 }).toString()
      processStatus = JSON.parse(processStatus).map(p => ({
        name: p.name,
        pid: p.pid,
        status: p.pm2_env?.status,
        restarts: p.pm2_env?.restart_time,
        uptime: p.pm2_env?.pm_uptime,
      }))
    } catch {}

    res.json(redact({
      generatedAt: nowIso(),
      durationMs: durationSince(startedAt),
      health,
      recentToolLoopWarnings: recentToolLoopWarnings(readOpenclawConfig()),
      repos,
      processStatus,
      runtime: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
      },
    }))
  } catch (e) {
    res.status(200).json({ ok: false, error: sanitizeError(e), generatedAt: nowIso() })
  }
})

module.exports = router
