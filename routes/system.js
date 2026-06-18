const router = require('express').Router()
const fs = require('fs')
const path = require('path')
const net = require('net')
const crypto = require('crypto')
const { execFileSync } = require('child_process')
const { HOME, CONFIG_PATH } = require('../lib/config')
const { readOpenclawConfig } = require('../lib/openclaw-config')
const { buildLatencyFromGatewayLog } = require('../lib/monitor-latency')
const { getModelReadinessForConfig } = require('../lib/model-readiness')
const {
  DEFAULT_MCP_URL,
  compareSoulContractToTools,
  getMcpTools,
  normalizeAccessMode,
  parseSoulContract,
} = require('../lib/mcp-tools')

const HEALTH_TTL_MS = 30_000
const EXTERNAL_TIMEOUT_MS = 1800
const TARGET_OPENCLAW_VERSION = '2026.6.8'
const MIN_NODE_VERSION = '22.19.0'
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

function isSecretKey(key) {
  const normalized = String(key || '').replace(/[^a-z0-9]/gi, '').toLowerCase()
  if (!normalized) return false
  if (['authorization', 'password', 'passwd', 'secret', 'token', 'key'].includes(normalized)) return true
  if (normalized.endsWith('secret')) return true
  if (normalized.endsWith('token') && !normalized.endsWith('tokens')) return true
  if (normalized.endsWith('apikey') || normalized.endsWith('privatekey')) return true
  return false
}

function redact(value) {
  if (Array.isArray(value)) return value.map(redact)
  if (!value || typeof value !== 'object') return value
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (isSecretKey(key)) {
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

function sha256File(filePath) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
  } catch {
    return null
  }
}

function parseOpenclawVersion(output) {
  const match = String(output || '').match(/(?:OpenClaw\s+)?(\d{4}\.\d+\.\d+)/i)
  return match ? match[1] : null
}

function compareVersions(a, b) {
  const av = String(a || '').split('.').map(part => Number.parseInt(part, 10)).map(n => Number.isFinite(n) ? n : 0)
  const bv = String(b || '').split('.').map(part => Number.parseInt(part, 10)).map(n => Number.isFinite(n) ? n : 0)
  const max = Math.max(av.length, bv.length)
  for (let i = 0; i < max; i++) {
    const diff = (av[i] || 0) - (bv[i] || 0)
    if (diff !== 0) return diff > 0 ? 1 : -1
  }
  return 0
}

function openclawRuntimeStatus() {
  const startedAt = Date.now()
  let installedVersion = null
  try {
    installedVersion = parseOpenclawVersion(execFileSync('openclaw', ['--version'], { timeout: 1000 }).toString())
  } catch {}
  if (!installedVersion) {
    return makeCheck(
      'runtime.openclaw',
      'OpenClaw runtime',
      'warn',
      'warn',
      `Unable to detect OpenClaw runtime version; target is ${TARGET_OPENCLAW_VERSION}`,
      startedAt,
      { remediation: 'Run openclaw --version on the server and verify the global npm runtime path' }
    )
  }
  const behind = compareVersions(installedVersion, TARGET_OPENCLAW_VERSION) < 0
  return makeCheck(
    'runtime.openclaw',
    'OpenClaw runtime',
    behind ? 'warn' : 'ok',
    'warn',
    behind
      ? `Installed ${installedVersion}; target ${TARGET_OPENCLAW_VERSION}`
      : `Installed ${installedVersion}`,
    startedAt,
    { remediation: behind ? `Update runtime to openclaw@${TARGET_OPENCLAW_VERSION} after source/build verification` : undefined }
  )
}

function nodeRuntimeStatus() {
  const startedAt = Date.now()
  const current = process.version.replace(/^v/, '')
  const tooOld = compareVersions(current, MIN_NODE_VERSION) < 0
  return makeCheck(
    'runtime.node',
    'Node.js runtime',
    tooOld ? 'warn' : 'ok',
    'warn',
    tooOld ? `Node ${process.version}; target >=${MIN_NODE_VERSION}` : `Node ${process.version}`,
    startedAt,
    { remediation: tooOld ? `Install Node >=${MIN_NODE_VERSION} before upgrading OpenClaw runtime` : undefined }
  )
}

function releaseState() {
  const distDirCandidates = [
    '/usr/lib/node_modules/openclaw/dist',
    path.join(HOME, '.npm-global/lib/node_modules/openclaw/dist'),
  ]
  const distDir = distDirCandidates.find(dir => {
    try { return fs.existsSync(dir) } catch { return false }
  }) || distDirCandidates[0]
  let distEntryNames = []
  try {
    distEntryNames = fs.readdirSync(distDir)
      .filter(name => /^bot-.*\.js$/.test(name) || /^openclaw-tools-.*\.js$/.test(name))
      .sort()
  } catch {}
  const distFiles = distEntryNames.map(name => {
    const filePath = path.join(distDir, name)
    try {
      const stat = fs.statSync(filePath)
      return { name, path: filePath, size: stat.size, mtime: stat.mtime.toISOString(), sha256: sha256File(filePath) }
    } catch {
      return { name, path: filePath, missing: true }
    }
  })
  return {
    generatedAt: nowIso(),
    metadataPath: path.join(HOME, '.openclaw/deploy-metadata.json'),
    config: {
      path: CONFIG_PATH,
      sha256: sha256File(CONFIG_PATH),
    },
    distFiles,
    apiUpdateScript: {
      path: path.join(HOME, 'openclaw-api/scripts/update-server.sh'),
      sha256: sha256File(path.join(HOME, 'openclaw-api/scripts/update-server.sh')),
    },
  }
}

function runtimeRootCandidates() {
  return [
    '/usr/lib/node_modules/openclaw',
    '/usr/local/lib/node_modules/openclaw',
    '/opt/homebrew/lib/node_modules/openclaw',
    path.join(HOME, '.npm-global/lib/node_modules/openclaw'),
  ]
}

function detectRuntimeGuardrails() {
  const root = runtimeRootCandidates().find(candidate => {
    try { return fs.existsSync(path.join(candidate, 'dist')) } catch { return false }
  })
  const markers = {
    telegramVisibleAck: false,
    productRouterV2: false,
    monitorToolDetail: false,
  }
  if (!root) return { root: null, markers }
  const distDir = path.join(root, 'dist')
  let files = []
  try {
    files = fs.readdirSync(distDir).filter(name => name.endsWith('.js')).slice(0, 80)
  } catch {
    return { root, markers }
  }
  for (const file of files) {
    let text = ''
    try { text = fs.readFileSync(path.join(distDir, file), 'utf8').slice(0, 1_000_000) } catch { continue }
    if (text.includes('OPENCLAW_TELEGRAM_VISIBLE_ACK') || text.includes('telegram_ack_sent')) markers.telegramVisibleAck = true
    if (text.includes('OPENCLAW_TELEGRAM_PRODUCT_ROUTER_V2')) markers.productRouterV2 = true
    if (text.includes('telegram_monitor_tool')) markers.monitorToolDetail = true
    if (markers.telegramVisibleAck && markers.productRouterV2 && markers.monitorToolDetail) break
  }
  return { root, markers }
}

function runtimeGuardrailStatus() {
  const startedAt = Date.now()
  const result = detectRuntimeGuardrails()
  const missing = Object.entries(result.markers).filter(([, ok]) => !ok).map(([key]) => key)
  return makeCheck(
    'runtime.guardrails',
    'Runtime ERP guardrails',
    missing.length ? 'warn' : 'ok',
    'warn',
    missing.length
      ? `Official/custom runtime markers not all present: ${missing.join(', ')}`
      : 'ERP Telegram guardrail markers present',
    startedAt,
    {
      runtimeRoot: result.root,
      markers: result.markers,
      remediation: missing.length
        ? 'Run Telegram regression after runtime updates; deploy custom runtime only if official runtime regresses required ERP chatbot behavior'
        : undefined,
    }
  )
}

function releaseMetadataStatus() {
  const startedAt = Date.now()
  const state = releaseState()
  try {
    const metadata = readJsonFile(state.metadataPath)
    const expected = metadata?.distFiles || {}
    const mismatches = []
    for (const file of state.distFiles) {
      if (file.missing) {
        mismatches.push(`${file.name}: missing`)
        continue
      }
      const expectedHash = expected[file.name]?.sha256 || expected[file.name]
      if (expectedHash && expectedHash !== file.sha256) mismatches.push(`${file.name}: checksum mismatch`)
    }
    return makeCheck(
      'release.metadata',
      'Release metadata',
      mismatches.length ? 'warn' : 'ok',
      'warn',
      mismatches.length ? mismatches.join('; ') : `Deployed artifact metadata present (${metadata.backupId || metadata.generatedAt || 'unknown build'})`,
      startedAt,
      { remediation: mismatches.length ? 'Redeploy from source artifact or rollback to the last matching backup id' : undefined }
    )
  } catch {
    return makeCheck(
      'release.metadata',
      'Release metadata',
      'warn',
      'warn',
      'No deploy metadata found for runtime dist checksums',
      startedAt,
      { remediation: 'Run update-server.sh --apply so deployed dist files get source/build trace metadata' }
    )
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

function resolveAgentModelFallbacks(config, agent) {
  const agentFallbacks = agent?.model?.fallbacks
  if (Array.isArray(agentFallbacks)) return agentFallbacks.filter(Boolean)
  const defaultFallbacks = config?.agents?.defaults?.model?.fallbacks
  if (Array.isArray(defaultFallbacks)) return defaultFallbacks.filter(Boolean)
  return []
}

function agentUsesImageTool(agent) {
  const allow = agent?.tools?.allow
  return Array.isArray(allow) && allow.includes('image')
}

function hasImageModelConfig(config, agent) {
  return Boolean(
    agent?.imageModel ||
    agent?.model?.imageModel ||
    config?.agents?.defaults?.imageModel ||
    config?.agents?.defaults?.mediaUnderstandingModel
  )
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
    const toolNames = new Set((tools || []).map(t => t.name))
    const isStockSoul = contract?.accessMode === 'stock' || /MCP_ACCESS_MODE=stock\b/.test(soul)
    const stockFlowMissing = isStockSoul &&
      toolNames.has('search_product') &&
      toolNames.has('get_stock_balance') &&
      !/workflowContract=stock-flow-v1\b/.test(soul)
    const workflowWarnings = stockFlowMissing
      ? ['SOUL missing stock-flow-v1 workflow contract']
      : []
    const warnings = [
      ...legacyPatterns.map(p => `legacy pattern: ${p}`),
      ...contractStatus.warnings,
      ...workflowWarnings,
    ]
    return {
      status: warnings.length ? 'warn' : 'ok',
      legacyPatterns,
      contract,
      contractWarnings: contractStatus.warnings,
      workflowWarnings,
      summary: warnings.length ? warnings.join('; ') : 'SOUL contract matches MCP tools',
    }
  } catch {
    return { status: 'fail', legacyPatterns: [], contractWarnings: [], workflowWarnings: [], summary: 'SOUL.md not found' }
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
  checks.push(releaseMetadataStatus())
  checks.push(openclawRuntimeStatus())
  checks.push(nodeRuntimeStatus())
  checks.push(runtimeGuardrailStatus())

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
  let modelReadiness = null
  let modelReadinessError = null
  const modelReadinessStart = Date.now()
  try {
    modelReadiness = await getModelReadinessForConfig(config, {
      refresh: false,
      timeoutMs: EXTERNAL_TIMEOUT_MS,
    })
    checks.push(makeCheck(
      'model.readiness',
      'Model readiness',
      modelReadiness.ok && !modelReadiness.runtimeVerificationIssues?.length ? 'ok' : 'warn',
      'warn',
      modelReadiness.ok && !modelReadiness.runtimeVerificationIssues?.length
        ? 'Primary, fallback, image, and runtime model checks are ready'
        : modelReadiness.blockingIssues.length
          ? `${modelReadiness.blockingIssues.length} model readiness issue(s) found`
          : `${modelReadiness.runtimeVerificationIssues.length} model(s) need runtime verification`,
      modelReadinessStart,
      {
        warnings: modelReadiness.warnings,
        remediation: modelReadiness.ok && !modelReadiness.runtimeVerificationIssues?.length
          ? undefined
          : 'Open /model, run runtime tests for selected models, validate settings, save, then restart gateway',
      }
    ))
  } catch (e) {
    modelReadinessError = sanitizeError(e)
    checks.push(makeCheck(
      'model.readiness',
      'Model readiness',
      'warn',
      'warn',
      `Unable to validate model readiness: ${modelReadinessError}`,
      modelReadinessStart,
      { remediation: 'Open /model after provider catalog connectivity is restored' }
    ))
  }
  const modelByAgent = new Map((modelReadiness?.agents || []).map(agent => [agent.id, agent]))

  await Promise.all(list.map(async (agent) => {
    const mcp = getAgentMcp(config, agent.id)
    const auth = hasAuthProfile(agent.id)
    const agentModelReadiness = modelByAgent.get(agent.id)
    const modelFallbacks = agentModelReadiness?.model?.fallbacks || resolveAgentModelFallbacks(config, agent)
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
        workflowWarnings: soul.workflowWarnings,
        allowedToolsHash: soul.contract?.allowedToolsHash,
      }
    ))

    const fallbackStart = Date.now()
    const fallbackIssues = (agentModelReadiness?.model?.fallbacks || [])
      .filter(item => item.status !== 'ready')
    checks.push(makeCheck(
      `model.fallback.${agent.id}`,
      `Model fallback ${agent.id}`,
      modelFallbacks.length && fallbackIssues.length === 0 ? 'ok' : 'warn',
      'warn',
      modelReadinessError
        ? `Model readiness unavailable: ${modelReadinessError}`
        : modelFallbacks.length
          ? fallbackIssues.length
            ? `${modelFallbacks.length} fallback model(s) configured; ${fallbackIssues.length} not ready`
            : `${modelFallbacks.length} fallback model(s) ready`
          : 'No fallback model configured; Telegram may surface model/provider timeouts',
      fallbackStart,
      {
        readiness: agentModelReadiness?.model,
        remediation: modelFallbacks.length && fallbackIssues.length === 0
          ? undefined
          : 'Open /model?section=fallbacks, validate fallback models, save, then restart gateway',
      }
    ))

    const imageModelStart = Date.now()
    const usesImageTool = agentModelReadiness?.usesImageTool ?? agentUsesImageTool(agent)
    const imageReadiness = agentModelReadiness?.imageModel
    const imageModelConfigured = imageReadiness?.configured ?? hasImageModelConfig(config, agent)
    const imageReady = Boolean(imageReadiness?.primary?.status === 'ready')
    checks.push(makeCheck(
      `model.image.${agent.id}`,
      `Image model ${agent.id}`,
      !usesImageTool || imageReady ? 'ok' : 'warn',
      'warn',
      !usesImageTool
        ? 'Agent does not use image tool'
        : modelReadinessError
          ? `Model readiness unavailable: ${modelReadinessError}`
          : imageModelConfigured
            ? (imageReadiness?.primary?.summary || 'Image model configured but not ready')
            : 'Image tool uses auto model resolution; invalid model overrides may add latency',
      imageModelStart,
      {
        readiness: imageReadiness,
        remediation: usesImageTool && !imageReady
          ? 'Open /model?section=image and set a known image-capable model'
          : undefined,
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
      fallbackModelCount: modelFallbacks.length,
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

  const telemetryStart = Date.now()
  try {
    const latency = buildLatencyFromGatewayLog({ minutes: 30, maxLines: 1500, maxBytes: 1024 * 1024 })
    const hasRecentMarkers = latency.summary.count > 0
    checks.push(makeCheck(
      'telemetry.telegram',
      'Telegram telemetry',
      hasRecentMarkers ? 'ok' : 'warn',
      'warn',
      hasRecentMarkers
        ? `${latency.summary.count} Telegram turn marker(s) found in the last 30 minutes`
        : 'No Telegram latency markers found in the recent gateway log window',
      telemetryStart,
      { remediation: hasRecentMarkers ? undefined : 'Send a Telegram test message after restart and verify gateway log markers' }
    ))
  } catch (e) {
    checks.push(makeCheck(
      'telemetry.telegram',
      'Telegram telemetry',
      'warn',
      'warn',
      sanitizeError(e),
      telemetryStart,
      { remediation: 'Check /tmp/openclaw gateway logs and runtime telemetry markers' }
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

async function getHealth({ refresh = false } = {}) {
  if (!refresh && healthCache && Date.now() - healthCache.createdAt < HEALTH_TTL_MS) {
    return {
      ...healthCache.data,
      cache: { hit: true, ttlSeconds: Math.ceil((HEALTH_TTL_MS - (Date.now() - healthCache.createdAt)) / 1000) },
    }
  }
  const data = await buildHealth()
  healthCache = { createdAt: Date.now(), data }
  return data
}

router.get('/health', async (req, res) => {
  try {
    const refresh = req.query.refresh === 'true'
    res.json(await getHealth({ refresh }))
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

    const latency = buildLatencyFromGatewayLog({ minutes: 60, maxLines: 2500, maxBytes: 1024 * 1024 })

    res.json(redact({
      generatedAt: nowIso(),
      durationMs: durationSince(startedAt),
      health,
      releaseState: releaseState(),
      recentToolLoopWarnings: recentToolLoopWarnings(readOpenclawConfig()),
      latencySummary: latency.summary,
      recentSlowTurns: latency.slowest.slice(0, 10),
      recentGuardrailWarnings: latency.warnings
        .filter(w => w.type === 'stock_price_denial_stock_intent')
        .slice(0, 10),
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
module.exports._internal = {
  buildHealth,
  getHealth,
  releaseState,
  releaseMetadataStatus,
  redact,
  sanitizeError,
  isSecretKey,
  compareVersions,
  parseOpenclawVersion,
}
