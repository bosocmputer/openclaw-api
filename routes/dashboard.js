const router = require('express').Router()
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { HOME } = require('../lib/config')
const { pgPool } = require('../lib/pg')
const { readOpenclawConfig } = require('../lib/openclaw-config')
const { buildLatencyFromGatewayLog } = require('../lib/monitor-latency')
const runtimeGuardrailLib = require('../lib/runtime-guardrails')
const systemRoute = require('./system')
const monitorRoute = require('./monitor')

const OVERVIEW_TTL_MS = 30_000
const RELEASE_TTL_MS = 60 * 60_000
const TARGET_OPENCLAW_VERSION = '2026.6.8'
const MIN_NODE_VERSION = '22.19.0'
const MAX_RECENT_TURNS = 10
const MAX_TEXT = 360

let overviewCache = null
let releaseCache = null

const WHATS_NEW_ITEMS = [
  {
    id: 'telegram-rich-delivery',
    title: 'Telegram delivery richer และ brittle น้อยลง',
    summary: 'Runtime ใหม่รองรับ rich message, list/table formatting และ line break ที่นิ่งขึ้นในช่องทาง Telegram/WhatsApp',
    action: 'ตรวจ bot ที่ใช้ reply ยาวหรือรายการสินค้า แล้วดูใน Monitor ว่า output ยังอ่านง่ายบนมือถือ',
    status: 'operator-action',
  },
  {
    id: 'gateway-recovery',
    title: 'Agent/Gateway recovery ดีขึ้น',
    summary: 'ปรับ account-scoped delivery, reset fallback และ restart/shutdown handling เพื่อลด reply ค้างหรือส่งผิด context',
    action: 'หลัง deploy ให้ทดสอบ /reset, /new และ restart gateway พร้อมดู warning ใน /system',
    status: 'reliability',
  },
  {
    id: 'model-routing',
    title: 'Model routing และ fallback แข็งแรงขึ้น',
    summary: 'รองรับ provider/model normalization, SecretRef auth และ model catalog browsing แบบ bounded',
    action: 'ตั้ง fallback model ต่อ agent โดยเฉพาะ Telegram bot ที่ต้องตอบเร็ว',
    status: 'configuration',
  },
  {
    id: 'usage-footer',
    title: '/usage และ cost footer เสถียรขึ้น',
    summary: 'ปรับ footer renderer, decimal formatting และ credential-aware warnings ให้ตรวจ usage ได้ตรงขึ้น',
    action: 'เทียบตัวเลข cost ใน Dashboard กับ /monitor และ OpenRouter log เฉพาะ model call',
    status: 'cost-control',
  },
  {
    id: 'memory-state-diagnostics',
    title: 'Memory/state diagnostics กู้คืนง่ายขึ้น',
    summary: 'เพิ่มความทนทานของ state, memory และ diagnostics ระหว่าง reset/restart',
    action: 'เมื่อ agent ตอบแปลก ให้ดู /monitor expand และ /system support bundle ก่อนแก้ SOUL',
    status: 'diagnostics',
  },
  {
    id: 'hono-runtime-patch',
    title: 'Hono runtime patched',
    summary: 'อัปเดต Hono 4.12.25 ใน runtime reference เพื่อลด risk จาก dependency runtime',
    action: 'ตรวจ installed runtime version และ deploy metadata ก่อน rollout ลูกค้า',
    status: 'security',
  },
]

function nowIso() {
  return new Date().toISOString()
}

function safeSnippet(value, max = MAX_TEXT) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function safeExecFile(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      timeout: options.timeout || 1500,
      cwd: options.cwd,
      env: options.env || process.env,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString('utf8').trim()
  } catch {
    return null
  }
}

function parseOpenclawVersion(output) {
  const match = String(output || '').match(/(?:OpenClaw\s+)?(\d{4}\.\d+\.\d+)/i)
  return match ? match[1] : null
}

function normalizeVersionParts(version) {
  return String(version || '').split('.').map(part => Number.parseInt(part, 10)).map(n => Number.isFinite(n) ? n : 0)
}

function compareVersions(a, b) {
  const av = normalizeVersionParts(a)
  const bv = normalizeVersionParts(b)
  const max = Math.max(av.length, bv.length)
  for (let i = 0; i < max; i++) {
    const diff = (av[i] || 0) - (bv[i] || 0)
    if (diff !== 0) return diff > 0 ? 1 : -1
  }
  return 0
}

function nodeVersionOk(version = process.version) {
  return compareVersions(String(version).replace(/^v/, ''), MIN_NODE_VERSION) >= 0
}

function candidateRuntimeRoots(npmRoot = null) {
  const roots = new Set()
  if (npmRoot) roots.add(path.join(npmRoot, 'openclaw'))
  roots.add('/usr/lib/node_modules/openclaw')
  roots.add('/usr/local/lib/node_modules/openclaw')
  roots.add('/opt/homebrew/lib/node_modules/openclaw')
  roots.add(path.join(HOME, '.npm-global/lib/node_modules/openclaw'))
  return [...roots]
}

function findRuntimeRoot(npmRoot = null) {
  return candidateRuntimeRoots(npmRoot).find(root => {
    try {
      return fs.existsSync(root) && fs.existsSync(path.join(root, 'package.json'))
    } catch {
      return false
    }
  }) || null
}

function readPackageVersion(runtimeRoot) {
  if (!runtimeRoot) return null
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'package.json'), 'utf8'))
    return pkg.version || null
  } catch {
    return null
  }
}

function detectRuntimeMarkers(runtimeRoot) {
  const markers = {
    telegramVisibleAck: false,
    productRouterV2: false,
    monitorToolDetail: false,
  }
  const distDir = runtimeRoot ? path.join(runtimeRoot, 'dist') : null
  if (!distDir || !fs.existsSync(distDir)) return markers
  let files = []
  try {
    files = fs.readdirSync(distDir)
      .filter(name => name.endsWith('.js'))
      .slice(0, 80)
  } catch {
    return markers
  }
  for (const name of files) {
    let text = ''
    try {
      text = fs.readFileSync(path.join(distDir, name), 'utf8').slice(0, 1_000_000)
    } catch {
      continue
    }
    if (text.includes('OPENCLAW_TELEGRAM_VISIBLE_ACK') || text.includes('telegram_ack_sent')) markers.telegramVisibleAck = true
    if (text.includes('OPENCLAW_TELEGRAM_PRODUCT_ROUTER_V2')) markers.productRouterV2 = true
    if (text.includes('telegram_monitor_tool')) markers.monitorToolDetail = true
    if (markers.telegramVisibleAck && markers.productRouterV2 && markers.monitorToolDetail) break
  }
  return markers
}

function detectRelease(refresh = false) {
  if (!refresh && releaseCache && Date.now() - releaseCache.createdAt < RELEASE_TTL_MS) {
    return { ...releaseCache.data, cache: { hit: true, ttlSeconds: Math.ceil((RELEASE_TTL_MS - (Date.now() - releaseCache.createdAt)) / 1000) } }
  }

  const npmRoot = safeExecFile('npm', ['root', '-g'], { timeout: 500 })
  const runtimeRoot = findRuntimeRoot(npmRoot)
  const runtimeGuardrails = runtimeGuardrailLib.detectRuntimeGuardrails()
  const activeRuntimeVersion = runtimeGuardrailLib.readRuntimePackageVersion(runtimeGuardrails.root)
  const versionOutput = safeExecFile('openclaw', ['--version'], { timeout: 800 })
  const installedVersion = activeRuntimeVersion || parseOpenclawVersion(versionOutput) || readPackageVersion(runtimeRoot)
  const npmLatestRaw = safeExecFile('npm', ['view', 'openclaw', 'version'], { timeout: 500 })
  const latestVersion = parseOpenclawVersion(npmLatestRaw) || npmLatestRaw || TARGET_OPENCLAW_VERSION
  const targetVersion = TARGET_OPENCLAW_VERSION
  const nodeVersion = process.version
  const warnings = []
  let status = 'unknown'

  if (installedVersion) {
    const cmp = compareVersions(installedVersion, latestVersion)
    status = cmp < 0 ? 'behind' : (cmp === 0 ? 'current' : 'custom')
    if (cmp < 0) warnings.push(`Installed OpenClaw ${installedVersion} is behind ${latestVersion}`)
  } else {
    warnings.push('Unable to detect installed OpenClaw runtime version')
  }
  if (!nodeVersionOk(nodeVersion)) warnings.push(`Node ${nodeVersion} is below >=${MIN_NODE_VERSION}`)
  if (!runtimeRoot && !runtimeGuardrails.root) warnings.push('Global openclaw runtime path not found')
  if (!npmLatestRaw && (!installedVersion || compareVersions(installedVersion, targetVersion) < 0)) {
    warnings.push(`npm latest lookup unavailable; using target ${targetVersion}`)
  }

  let deployMetadata = null
  try {
    deployMetadata = JSON.parse(fs.readFileSync(path.join(HOME, '.openclaw/deploy-metadata.json'), 'utf8'))
  } catch {}
  if (!deployMetadata) warnings.push('No deploy metadata found for runtime checksums')

  const customMarkers = runtimeGuardrails.markers
  const expectsCustomMarkers = Boolean(deployMetadata?.customRuntime || deployMetadata?.customMarkersRequired)
  if (expectsCustomMarkers) {
    const missing = Object.entries(customMarkers).filter(([, ok]) => !ok).map(([name]) => name)
    const smoke = runtimeGuardrailLib.readTelegramSmokeState()
    if (missing.length && !runtimeGuardrailLib.telegramSmokeIsFresh(smoke)) {
      warnings.push(`Custom runtime markers missing: ${missing.join(', ')}`)
    }
  }

  const data = {
    installedVersion,
    latestVersion,
    targetVersion,
    nodeVersion,
    npmRoot,
    runtimeRoot: runtimeGuardrails.root || runtimeRoot,
    runtimeSource: runtimeGuardrails.source,
    status,
    warnings,
    deployMetadataPresent: Boolean(deployMetadata),
    customMarkers,
    runtimeCandidates: runtimeGuardrails.candidates?.slice(0, 8),
    generatedAt: nowIso(),
    cache: { hit: false, ttlSeconds: RELEASE_TTL_MS / 1000 },
  }
  releaseCache = { createdAt: Date.now(), data }
  return data
}

function summarizeHealth(health, releaseWarnings = []) {
  const checks = Array.isArray(health?.checks) ? health.checks : []
  const counts = checks.reduce((acc, check) => {
    acc[check.status] = (acc[check.status] || 0) + 1
    if (check.status === 'fail' && check.severity === 'critical') acc.criticalFail += 1
    return acc
  }, { ok: 0, warn: 0, fail: 0, info: 0, criticalFail: 0 })
  const warnings = checks
    .filter(check => check.status !== 'ok' && check.status !== 'info')
    .map(check => ({ id: check.id, label: check.label, status: check.status, summary: check.summary }))
    .slice(0, 12)
  for (const warning of releaseWarnings.slice(0, 6)) {
    warnings.push({ id: 'release.runtime', label: 'OpenClaw runtime', status: 'warn', summary: warning })
  }
  return {
    status: health?.status || (counts.criticalFail ? 'fail' : (counts.warn || releaseWarnings.length ? 'warn' : 'ok')),
    criticalFail: counts.criticalFail,
    warn: counts.warn + releaseWarnings.length,
    ok: counts.ok,
    fail: counts.fail,
    info: counts.info,
    total: checks.length,
    warnings,
  }
}

function countTelegramAccounts(config) {
  const tg = config.channels?.telegram || {}
  const accounts = Object.values(tg.accounts || {}).filter(acc => acc?.botToken).length
  return accounts + (tg.botToken && accounts === 0 ? 1 : 0)
}

function countLineAccounts(config) {
  const line = config.channels?.line || {}
  const accounts = Object.values(line.accounts || {}).filter(acc => acc?.channelAccessToken).length
  return accounts + (line.channelAccessToken && accounts === 0 ? 1 : 0)
}

function countBoundChannels(config, agentId) {
  const bindings = Array.isArray(config.bindings) ? config.bindings : []
  const counts = { telegram: 0, line: 0, webchat: 0 }
  for (const binding of bindings) {
    if (binding?.agentId !== agentId) continue
    const channel = binding.match?.channel
    if (counts[channel] != null) counts[channel] += 1
  }
  return counts
}

async function safeCount(query) {
  if (!pgPool) return null
  try {
    const { rows } = await pgPool.query(query)
    return Number(rows[0]?.count || 0)
  } catch {
    return null
  }
}

function settleSync(fn) {
  return Promise.resolve().then(fn)
}

function parseReachableTelegramCount(health, configured) {
  const check = (health?.checks || []).find(c => c.id === 'telegram.api')
  const match = String(check?.summary || '').match(/(\d+)\/(\d+)/)
  if (!match) return configured
  return Number(match[1])
}

function summarizeLatency(latency, conversations) {
  const byStatus = latency?.summary?.byStatus || {}
  const conversationRoutes = conversations?.summary?.byRoute || {}
  const latencyRoutes = {}
  for (const turn of latency?.turns || []) {
    const rootCause = String(turn.rootCause || '')
    const route = rootCause === 'tool_path_used'
      ? 'tool_path'
      : rootCause === 'stock_price_denial'
        ? 'capability_denied'
        : rootCause === 'native_command'
          ? 'native'
          : rootCause === 'queue_coalesced'
            ? 'queue_coalesced'
            : (rootCause === 'completed' || rootCause === 'model_latency')
              ? 'model_path'
              : (turn.guardrail || rootCause || 'unknown')
    latencyRoutes[route] = (latencyRoutes[route] || 0) + 1
  }
  const conversationRouteCount = Object.values(conversationRoutes).reduce((sum, count) => sum + Number(count || 0), 0)
  const routeBreakdown = (latency?.summary?.count || 0) > conversationRouteCount ? latencyRoutes : conversationRoutes
  const active = (byStatus.pending || 0) + (byStatus.slow || 0)
  return {
    windowMinutes: latency?.windowMinutes || 0,
    turns: latency?.summary?.count || 0,
    active,
    stuck: byStatus.stuck || 0,
    ackP50Ms: latency?.summary?.ackP50Ms ?? null,
    ackP95Ms: latency?.summary?.ackP95Ms ?? null,
    finalP50Ms: latency?.summary?.finalP50Ms ?? null,
    finalP95Ms: latency?.summary?.finalP95Ms ?? null,
    byStatus,
    routeBreakdown,
    slowest: (latency?.slowest || []).slice(0, 5),
  }
}

function summarizeCost(cost) {
  const days = Array.isArray(cost?.days) ? cost.days : []
  const byAgent = Object.entries(cost?.summary?.byAgent || {})
    .map(([agentId, value]) => ({ agentId, cost: Number(value) || 0 }))
    .sort((a, b) => b.cost - a.cost)
  let modelCalls = 0
  let inputTokens = 0
  let outputTokens = 0
  for (const day of days) {
    for (const agent of day.agents || []) {
      modelCalls += Number(agent.turns || 0)
      inputTokens += Number(agent.inputTokens || 0)
      outputTokens += Number(agent.outputTokens || 0)
    }
  }
  return {
    days: days.length,
    totalCost: Number(cost?.summary?.totalCost || 0),
    modelCalls,
    inputTokens,
    outputTokens,
    byAgent,
  }
}

function summarizeRecentTurns(conversations) {
  return (conversations?.turns || []).slice(0, MAX_RECENT_TURNS).map(turn => ({
    id: turn.id,
    startedAt: turn.startedAt,
    agentId: turn.agentId,
    channel: turn.channel,
    user: turn.user,
    userText: safeSnippet(turn.userText),
    finalText: safeSnippet(turn.finalText),
    route: turn.route,
    intent: turn.intent,
    status: turn.status,
    durationMs: turn.durationMs ?? null,
    toolChain: (turn.toolPath || []).map(tool => tool.name).slice(0, 6),
    warnings: (turn.warnings || []).map(w => safeSnippet(w.summary || w.type, 180)).slice(0, 4),
  }))
}

function buildAgentMatrix(health, config) {
  const healthAgents = new Map((health?.agents || []).map(agent => [agent.id, agent]))
  const agents = config.agents?.list || []
  return agents.map(agent => {
    const h = healthAgents.get(agent.id) || {}
    return {
      id: agent.id,
      accessMode: h.accessMode || agent.id || 'general',
      mcpUrl: h.mcpUrl || null,
      toolCount: h.toolCount || 0,
      toolSource: h.toolSource || 'unknown',
      soulStatus: h.soulStatus || 'unknown',
      authStatus: h.authStatus || 'unknown',
      fallbackModelCount: h.fallbackModelCount || 0,
      channels: countBoundChannels(config, agent.id),
    }
  })
}

async function buildDashboardOverview({ refresh = false } = {}) {
  const generatedAt = nowIso()
  let config = {}
  try { config = readOpenclawConfig() } catch {}

  const release = detectRelease(refresh)
  const minutesToday = Math.max(1, Math.min(1440, Math.ceil((Date.now() - new Date().setHours(0, 0, 0, 0)) / 60000)))

  const [healthResult, latencyResult, conversationsResult, costResult, membersCount, webchatRoomsCount] = await Promise.allSettled([
    systemRoute._internal.getHealth({ refresh }),
    settleSync(() => buildLatencyFromGatewayLog({ minutes: minutesToday, maxLines: 3000, maxBytes: 2 * 1024 * 1024 })),
    settleSync(() => ({
      generatedAt,
      summary: {},
      turns: monitorRoute._internal.buildConversationTurnsFromGatewayLog({
        minutes: 180,
        channel: 'telegram',
        limit: MAX_RECENT_TURNS,
      }),
    })),
    settleSync(() => monitorRoute._internal.buildMonitorCost(7)),
    safeCount('SELECT COUNT(*)::int AS count FROM admin_users WHERE is_active = true'),
    safeCount('SELECT COUNT(*)::int AS count FROM webchat_rooms'),
  ])

  const health = healthResult.status === 'fulfilled'
    ? healthResult.value
    : { status: 'fail', checks: [], agents: [] }
  const conversations = conversationsResult.status === 'fulfilled' ? conversationsResult.value : { turns: [], summary: {} }
  conversations.summary = {
    byRoute: (conversations.turns || []).reduce((acc, turn) => {
      acc[turn.route] = (acc[turn.route] || 0) + 1
      return acc
    }, {}),
  }
  const latency = latencyResult.status === 'fulfilled'
    ? latencyResult.value
    : { windowMinutes: minutesToday, summary: { count: 0, byStatus: {} }, slowest: [] }
  const cost = costResult.status === 'fulfilled'
    ? costResult.value
    : { days: [], summary: { totalCost: 0, byAgent: {} } }

  const telegramConfigured = countTelegramAccounts(config)
  const healthSummary = summarizeHealth(health, release.warnings)
  const costSummary = summarizeCost(cost)
  const latencySummary = summarizeLatency(latency, conversations)
  const toolOnlyTurns = Object.entries(latencySummary.routeBreakdown)
    .filter(([route]) => route !== 'model_path')
    .reduce((sum, [, count]) => sum + Number(count || 0), 0)
  const runtimeGuardrails = runtimeGuardrailLib.detectRuntimeGuardrails()
  const markerMissing = Object.entries(runtimeGuardrails.markers).filter(([, ok]) => !ok).map(([key]) => key)
  const telegramRegression = runtimeGuardrailLib.readTelegramSmokeState()
  const telegramRegressionFresh = runtimeGuardrailLib.telegramSmokeIsFresh(telegramRegression)

  return systemRoute._internal.redact({
    ok: healthSummary.criticalFail === 0,
    generatedAt,
    cache: { hit: false, ttlSeconds: OVERVIEW_TTL_MS / 1000 },
    release,
    health: healthSummary,
    operations: {
      gateway: (health.checks || []).find(c => c.id === 'gateway.process')?.status === 'ok' ? 'online' : 'offline',
      agents: config.agents?.list?.length || 0,
      telegramBotsConfigured: telegramConfigured,
      telegramBotsOnline: parseReachableTelegramCount(health, telegramConfigured),
      lineAccounts: countLineAccounts(config),
      webchatRooms: webchatRoomsCount.status === 'fulfilled' ? webchatRoomsCount.value : null,
      members: membersCount.status === 'fulfilled' ? membersCount.value : null,
      defaultModel: config.agents?.defaults?.model?.primary || null,
    },
    latency: latencySummary,
    cost: {
      ...costSummary,
      toolOnlyTurns,
    },
    agents: buildAgentMatrix(health, config),
    recentTurns: summarizeRecentTurns(conversations),
    runtimeGuardrails: {
      root: runtimeGuardrails.root,
      source: runtimeGuardrails.source,
      markers: runtimeGuardrails.markers,
      markerMissing,
      telegramRegression: telegramRegression ? {
        ...telegramRegression,
        fresh: telegramRegressionFresh,
      } : { passedAt: null, fresh: false },
    },
    whatsNew: {
      version: `v${TARGET_OPENCLAW_VERSION}`,
      items: WHATS_NEW_ITEMS,
    },
  })
}

router.get('/overview', async (req, res) => {
  try {
    const refresh = req.query.refresh === 'true'
    if (!refresh && overviewCache && Date.now() - overviewCache.createdAt < OVERVIEW_TTL_MS) {
      return res.json({
        ...overviewCache.data,
        cache: {
          hit: true,
          ttlSeconds: Math.ceil((OVERVIEW_TTL_MS - (Date.now() - overviewCache.createdAt)) / 1000),
        },
      })
    }

    const data = await buildDashboardOverview({ refresh })
    overviewCache = { createdAt: Date.now(), data }
    res.json(data)
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(200).json({
      ok: false,
      generatedAt: nowIso(),
      cache: { hit: false, ttlSeconds: OVERVIEW_TTL_MS / 1000 },
      release: { installedVersion: null, latestVersion: TARGET_OPENCLAW_VERSION, targetVersion: TARGET_OPENCLAW_VERSION, status: 'unknown', warnings: ['Dashboard overview failed'] },
      health: { status: 'fail', criticalFail: 1, warn: 0, ok: 0, fail: 1, info: 0, total: 1, warnings: [{ id: 'dashboard.overview', label: 'Dashboard overview', status: 'fail', summary: String(e?.message || e).slice(0, 240) }] },
      operations: {},
      latency: { turns: 0, active: 0, stuck: 0, routeBreakdown: {} },
      cost: { days: 0, totalCost: 0, byAgent: [], modelCalls: 0, toolOnlyTurns: 0 },
      agents: [],
      recentTurns: [],
      whatsNew: { version: `v${TARGET_OPENCLAW_VERSION}`, items: WHATS_NEW_ITEMS },
    })
  }
})

router.post('/telegram-regression/pass', async (req, res) => {
  try {
    const state = runtimeGuardrailLib.writeTelegramSmokeState({ note: req.body?.note || 'dashboard-confirmed' })
    overviewCache = null
    releaseCache = null
    await systemRoute._internal.getHealth({ refresh: true }).catch(() => null)
    res.json({ ok: true, state })
  } catch (e) {
    res.status(500).json({ ok: false, error: runtimeGuardrailLib.sanitizeError(e) })
  }
})

module.exports = router
module.exports._internal = {
  buildDashboardOverview,
  compareVersions,
  detectRelease,
  parseOpenclawVersion,
  summarizeCost,
  summarizeHealth,
  summarizeLatency,
}
