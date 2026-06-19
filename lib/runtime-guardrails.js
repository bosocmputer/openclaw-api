const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { HOME } = require('./config')

const TELEGRAM_SMOKE_STATE_PATH = path.join(HOME, '.openclaw/telegram-regression-state.json')

function sanitizeError(e) {
  return String(e?.message || e || 'unknown error')
    .replace(/bot[0-9]{6,}:[A-Za-z0-9_-]+/g, 'bot<redacted>')
    .replace(/sk-or-[A-Za-z0-9_-]+/g, 'sk-or-<redacted>')
    .slice(0, 240)
}

function normalizeRuntimeRoot(value) {
  const raw = String(value || '').trim()
  if (!raw) return null
  if (raw.endsWith('/dist/index.js')) return path.dirname(path.dirname(raw))
  if (raw.endsWith('/index.js') && path.basename(path.dirname(raw)) === 'dist') return path.dirname(path.dirname(raw))
  if (raw.endsWith('/dist')) return path.dirname(raw)
  return raw
}

function addRuntimeCandidate(candidates, value, source) {
  const root = normalizeRuntimeRoot(value)
  if (!root) return
  if (candidates.some(candidate => candidate.root === root)) return
  candidates.push({ root, source })
}

function readGatewayProcessRuntime() {
  try {
    const raw = execFileSync('ps', ['-eo', 'pid,args'], { timeout: 1200 }).toString('utf8')
    const lines = raw.split('\n').filter(line => /openclaw.*gateway/.test(line) && !/grep/.test(line))
    for (const line of lines) {
      const match = line.match(/(\/\S*openclaw-runtime[^\s]*\/dist\/index\.js|\/\S*node_modules\/openclaw\/dist\/index\.js|\/\S*openclaw\/dist\/index\.js)/)
      if (match) return { root: normalizeRuntimeRoot(match[1]), command: line.trim() }
    }
  } catch {}
  return { root: null, command: null }
}

function runtimeRootCandidates() {
  const candidates = []
  addRuntimeCandidate(candidates, process.env.OPENCLAW_BIN, 'OPENCLAW_BIN')
  addRuntimeCandidate(candidates, process.env.OPENCLAW_RUNTIME_BIN, 'OPENCLAW_RUNTIME_BIN')

  const gateway = readGatewayProcessRuntime()
  addRuntimeCandidate(candidates, gateway.root, 'gateway_process')

  try {
    const npmRoot = execFileSync('npm', ['root', '-g'], { timeout: 800 }).toString('utf8').trim()
    addRuntimeCandidate(candidates, path.join(npmRoot, 'openclaw'), 'npm_root_global')
  } catch {}

  addRuntimeCandidate(candidates, '/usr/lib/node_modules/openclaw', 'default_global')
  addRuntimeCandidate(candidates, '/usr/local/lib/node_modules/openclaw', 'default_global')
  addRuntimeCandidate(candidates, '/opt/homebrew/lib/node_modules/openclaw', 'default_global')
  addRuntimeCandidate(candidates, path.join(HOME, '.npm-global/lib/node_modules/openclaw'), 'home_npm_global')

  return candidates.map(candidate => ({
    ...candidate,
    distDir: path.join(candidate.root, 'dist'),
    exists: fs.existsSync(path.join(candidate.root, 'dist')),
    gatewayCommand: candidate.source === 'gateway_process' ? gateway.command : undefined,
  }))
}

function chooseRuntimeRoot() {
  const candidates = runtimeRootCandidates()
  return candidates.find(candidate => candidate.exists) || candidates[0] || null
}

function readRuntimePackageVersion(root) {
  if (!root) return null
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
    if (pkg?.version) return String(pkg.version)
  } catch {}
  const match = String(root).match(/openclaw-runtime-(\d{4}\.\d+\.\d+)/)
  return match ? match[1] : null
}

function detectRuntimeGuardrails() {
  const selected = chooseRuntimeRoot()
  const markers = {
    telegramVisibleAck: false,
    productRouterV2: false,
    monitorToolDetail: false,
  }
  if (!selected?.exists) return { root: selected?.root || null, source: selected?.source || 'unknown', markers, candidates: runtimeRootCandidates() }

  let files = []
  try {
    files = fs.readdirSync(selected.distDir).filter(name => name.endsWith('.js')).slice(0, 120)
  } catch {
    return { root: selected.root, source: selected.source, markers, candidates: runtimeRootCandidates() }
  }
  for (const file of files) {
    let text = ''
    try { text = fs.readFileSync(path.join(selected.distDir, file), 'utf8').slice(0, 1_000_000) } catch { continue }
    if (text.includes('OPENCLAW_TELEGRAM_VISIBLE_ACK') || text.includes('telegram_ack_sent')) markers.telegramVisibleAck = true
    if (text.includes('OPENCLAW_TELEGRAM_PRODUCT_ROUTER_V2')) markers.productRouterV2 = true
    if (text.includes('telegram_monitor_tool')) markers.monitorToolDetail = true
    if (markers.telegramVisibleAck && markers.productRouterV2 && markers.monitorToolDetail) break
  }
  return { root: selected.root, source: selected.source, markers, candidates: runtimeRootCandidates() }
}

function readTelegramSmokeState() {
  try {
    const state = JSON.parse(fs.readFileSync(TELEGRAM_SMOKE_STATE_PATH, 'utf8'))
    if (!state || typeof state !== 'object') return null
    return {
      passedAt: state.passedAt || null,
      note: String(state.note || '').slice(0, 240),
      runtimeRoot: state.runtimeRoot || null,
      markerMissing: Array.isArray(state.markerMissing) ? state.markerMissing.slice(0, 10) : [],
    }
  } catch {
    return null
  }
}

function writeTelegramSmokeState({ note = '' } = {}) {
  const guardrails = detectRuntimeGuardrails()
  const markerMissing = Object.entries(guardrails.markers).filter(([, ok]) => !ok).map(([key]) => key)
  const state = {
    passedAt: new Date().toISOString(),
    note: String(note || '').slice(0, 240),
    runtimeRoot: guardrails.root,
    runtimeSource: guardrails.source,
    markerMissing,
  }
  fs.mkdirSync(path.dirname(TELEGRAM_SMOKE_STATE_PATH), { recursive: true })
  fs.writeFileSync(TELEGRAM_SMOKE_STATE_PATH, `${JSON.stringify(state, null, 2)}\n`)
  return state
}

function telegramSmokeIsFresh(state, maxAgeDays = 14) {
  if (!state?.passedAt) return false
  const ts = Date.parse(state.passedAt)
  if (!Number.isFinite(ts)) return false
  return Date.now() - ts <= maxAgeDays * 24 * 60 * 60 * 1000
}

module.exports = {
  TELEGRAM_SMOKE_STATE_PATH,
  detectRuntimeGuardrails,
  readTelegramSmokeState,
  readRuntimePackageVersion,
  sanitizeError,
  telegramSmokeIsFresh,
  writeTelegramSmokeState,
}
