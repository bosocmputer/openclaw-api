const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execFileSync } = require('child_process')

const { HOME } = require('./config')
const { readOpenclawConfig } = require('./openclaw-config')
const { pgPool } = require('./pg')
const memoryAuto = require('./memory-auto')
const runtimeGuardrails = require('./runtime-guardrails')

const TARGET_RUNTIME_VERSION = process.env.OPENCLAW_TARGET_VERSION || '2026.6.11'
const TARGET_RUNTIME_BRANCH = process.env.OPENCLAW_TARGET_RUNTIME_BRANCH || 'codex/openclaw-2026.6.11-erp-line-burst'
const OBSERVABILITY_TTL_MS = 30_000
let observabilityCache = null

function nowIso() {
  return new Date().toISOString()
}

function sanitizeError(error) {
  return String(error?.message || error || 'unknown error')
    .replace(/bot[0-9]{6,}:[A-Za-z0-9_-]+/g, 'bot<redacted>')
    .replace(/sk-or-[A-Za-z0-9_-]+/g, 'sk-or-<redacted>')
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,}]+/ig, '$1<redacted>')
    .replace(/(token|api[_-]?key|password|secret)\s*[:=]\s*[^\s,}]+/ig, '$1=<redacted>')
    .slice(0, 260)
}

function safeExec(command, args = [], options = {}) {
  try {
    return {
      ok: true,
      stdout: execFileSync(command, args, { timeout: options.timeout || 1200, cwd: options.cwd }).toString('utf8').trim(),
    }
  } catch (error) {
    return { ok: false, error: sanitizeError(error) }
  }
}

function readGitCommit(repoPath) {
  const result = safeExec('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoPath, timeout: 1000 })
  return result.ok ? result.stdout : null
}

function readGitStatus(repoPath) {
  const result = safeExec('git', ['status', '--short'], { cwd: repoPath, timeout: 1000 })
  return result.ok ? result.stdout.split('\n').filter(Boolean).slice(0, 80) : []
}

function sha256File(filePath) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
  } catch {
    return null
  }
}

function normalizeRuntimeRoot(value) {
  const raw = String(value || '').trim()
  if (!raw) return null
  if (raw.endsWith('/dist/index.js')) return path.dirname(path.dirname(raw))
  if (raw.endsWith('/index.js') && path.basename(path.dirname(raw)) === 'dist') return path.dirname(path.dirname(raw))
  if (raw.endsWith('/dist')) return path.dirname(raw)
  return raw
}

function parseOpenclawVersion(output) {
  const text = String(output || '')
  const version = text.match(/OpenClaw\s+(\d{4}\.\d+\.\d+)/i)?.[1] || text.match(/(\d{4}\.\d+\.\d+)/)?.[1] || null
  const commit = text.match(/\(([a-f0-9]{7,12})\)/i)?.[1] || null
  return { raw: text.trim() || null, version, commit }
}

function compareVersions(a, b) {
  const av = String(a || '').split('.').map(part => Number.parseInt(part, 10)).map(n => Number.isFinite(n) ? n : 0)
  const bv = String(b || '').split('.').map(part => Number.parseInt(part, 10)).map(n => Number.isFinite(n) ? n : 0)
  const max = Math.max(av.length, bv.length)
  for (let i = 0; i < max; i += 1) {
    const diff = (av[i] || 0) - (bv[i] || 0)
    if (diff !== 0) return diff > 0 ? 1 : -1
  }
  return 0
}

function readRuntimeIdentity() {
  const guardrails = runtimeGuardrails.detectRuntimeGuardrails()
  const root = guardrails.root || normalizeRuntimeRoot(process.env.OPENCLAW_BIN) || null
  const bin = root ? path.join(root, 'dist/index.js') : process.env.OPENCLAW_BIN || null
  const versionResult = bin && fs.existsSync(bin)
    ? safeExec(process.execPath, [bin, '--version'], { timeout: 2500 })
    : { ok: false, error: 'runtime binary not found' }
  const parsedVersion = parseOpenclawVersion(versionResult.stdout)
  const packageVersion = runtimeGuardrails.readRuntimePackageVersion(root)
  const distIndexSha = bin && fs.existsSync(bin) ? sha256File(bin) : null
  return {
    targetVersion: TARGET_RUNTIME_VERSION,
    root,
    bin,
    source: guardrails.source || null,
    version: parsedVersion.version || packageVersion || null,
    rawVersion: parsedVersion.raw,
    commit: parsedVersion.commit,
    distIndexSha,
    markers: guardrails.markers || {},
    markerMissing: Object.entries(guardrails.markers || {}).filter(([, ok]) => !ok).map(([key]) => key),
    candidates: (guardrails.candidates || []).slice(0, 8).map(candidate => ({
      root: candidate.root,
      source: candidate.source,
      exists: candidate.exists,
    })),
    ok: Boolean((parsedVersion.version || packageVersion) && compareVersions(parsedVersion.version || packageVersion, TARGET_RUNTIME_VERSION) >= 0),
    error: versionResult.ok ? null : versionResult.error,
  }
}

function readProcessStatus() {
  const result = safeExec('pm2', ['jlist'], { timeout: 1500 })
  if (!result.ok) return { manager: 'pm2', ok: false, error: result.error, processes: [] }
  try {
	    const processes = JSON.parse(result.stdout).map(item => ({
	      name: item.name,
	      pid: item.pid,
	      status: item.pm2_env?.status,
	      restarts: item.pm2_env?.restart_time,
	      uptime: item.pm2_env?.pm_uptime,
	      execPath: item.pm2_env?.pm_exec_path,
	      args: Array.isArray(item.pm2_env?.args) ? item.pm2_env.args.join(' ') : item.pm2_env?.args,
	      cwd: item.pm2_env?.pm_cwd,
	    }))
    return { manager: 'pm2', ok: true, processes }
  } catch (error) {
    return { manager: 'pm2', ok: false, error: sanitizeError(error), processes: [] }
  }
}

function processUsesRuntime(processInfo, targetVersion = TARGET_RUNTIME_VERSION) {
  if (!processInfo) return false
  return [
    processInfo.execPath,
    processInfo.args,
    processInfo.cwd,
  ].filter(Boolean).join(' ').includes(`openclaw-runtime-${targetVersion}-erp`)
}

function summarizeChannelConfig(config) {
  const routes = (config.bindings || [])
    .filter(binding => binding?.type === 'route')
    .map(binding => ({
      channel: binding.match?.channel || null,
      accountId: binding.match?.accountId || 'default',
      agentId: binding.agentId || null,
    }))
  return {
    lineAccounts: Object.keys(config.channels?.line?.accounts || {}).length + (config.channels?.line?.channelAccessToken ? 1 : 0),
    telegramAccounts: Object.keys(config.channels?.telegram?.accounts || {}).length + (config.channels?.telegram?.botToken ? 1 : 0),
    routes: routes.slice(0, 80),
  }
}

async function summarizeMemory(config) {
  const agentIds = (config.agents?.list || []).map(agent => agent.id).filter(Boolean)
  const summaryByAgent = memoryAuto.isAvailable()
    ? await memoryAuto.summaryForAgents(agentIds).catch(error => ({ error: sanitizeError(error) }))
    : { error: 'Database not configured' }
  const legacy = []
  for (const agent of config.agents?.list || []) {
    if (!agent.id || !agent.workspace) continue
    const memoryPath = path.join(String(agent.workspace).replace(/^~/, HOME), 'MEMORY.md')
    let sizeChars = 0
    try {
      sizeChars = fs.existsSync(memoryPath) ? fs.statSync(memoryPath).size : 0
    } catch {}
    legacy.push({
      agentId: agent.id,
      exists: sizeChars > 0,
      sizeChars,
      estimatedTokens: Math.ceil(sizeChars / 4),
      state: sizeChars > 18_000 ? 'block' : sizeChars > 12_000 ? 'warn' : 'ok',
    })
  }
  return { summaryByAgent, legacy }
}

function statusRank(status) {
  if (status === 'fail') return 3
  if (status === 'warn') return 2
  if (status === 'info') return 1
  return 0
}

function makeGateCheck(id, label, status, safeMessage, remediation, evidence = {}) {
  return { id, label, status, safeMessage, remediation, evidence }
}

async function buildObservabilitySnapshot({ includeHealth = false } = {}) {
  const startedAt = Date.now()
  const config = readOpenclawConfig()
  const runtime = readRuntimeIdentity()
  const processStatus = readProcessStatus()
  const memory = await summarizeMemory(config)
  const repos = {
    api: {
      path: process.cwd(),
      commit: readGitCommit(process.cwd()),
      dirty: readGitStatus(process.cwd()),
    },
    admin: {
      path: process.env.OPENCLAW_ADMIN_ROOT || path.join(HOME, 'openclaw-admin'),
      commit: readGitCommit(process.env.OPENCLAW_ADMIN_ROOT || path.join(HOME, 'openclaw-admin')),
      dirty: readGitStatus(process.env.OPENCLAW_ADMIN_ROOT || path.join(HOME, 'openclaw-admin')),
    },
  }
  return {
    ok: true,
    generatedAt: nowIso(),
    durationMs: Date.now() - startedAt,
    targetRuntimeVersion: TARGET_RUNTIME_VERSION,
    versions: {
      apiCommit: repos.api.commit,
      adminCommit: repos.admin.commit,
      runtimeVersion: runtime.rawVersion || runtime.version,
      nodeVersion: process.version,
    },
    repos,
    runtime,
    services: {
      api: { ok: true, pid: process.pid, uptimeSeconds: Math.round(process.uptime()) },
      pm2: processStatus,
      postgres: { ok: Boolean(pgPool), configured: Boolean(process.env.DATABASE_URL) },
    },
    channels: summarizeChannelConfig(config),
    memory,
    healthIncluded: includeHealth,
    privacy: {
      redaction: 'Secrets, API keys, auth headers, local media paths, and channel user ids are not included.',
      sideEffects: 'This snapshot is read-only and does not call model providers.',
    },
  }
}

async function getObservability({ refresh = false } = {}) {
  if (!refresh && observabilityCache && Date.now() - observabilityCache.createdAt < OBSERVABILITY_TTL_MS) {
    return {
      ...observabilityCache.data,
      cache: {
        hit: true,
        ttlSeconds: Math.ceil((OBSERVABILITY_TTL_MS - (Date.now() - observabilityCache.createdAt)) / 1000),
      },
    }
  }
  const data = await buildObservabilitySnapshot()
  const cached = { ...data, cache: { hit: false, ttlSeconds: OBSERVABILITY_TTL_MS / 1000 } }
  observabilityCache = { createdAt: Date.now(), data: cached }
  return cached
}

async function runReleaseGate() {
  const startedAt = Date.now()
  const snapshot = await buildObservabilitySnapshot()
  const checks = []
  checks.push(makeGateCheck(
    'runtime.version',
    'Runtime version',
    snapshot.runtime.ok ? 'ok' : 'fail',
    snapshot.runtime.ok
      ? `Runtime ${snapshot.runtime.rawVersion || snapshot.runtime.version} matches target ${TARGET_RUNTIME_VERSION}`
      : `Runtime is ${snapshot.runtime.rawVersion || snapshot.runtime.version || 'unknown'}; target is ${TARGET_RUNTIME_VERSION}`,
    `Install/use /root/openclaw-runtime-${TARGET_RUNTIME_VERSION}-erp and set OPENCLAW_BIN to its dist/index.js`,
    { bin: snapshot.runtime.bin, source: snapshot.runtime.source },
  ))
  const expectedBinSuffix = `/openclaw-runtime-${TARGET_RUNTIME_VERSION}-erp/dist/index.js`
  const binMatches = String(process.env.OPENCLAW_BIN || '').endsWith(expectedBinSuffix)
  checks.push(makeGateCheck(
    'runtime.openclaw_bin',
    'OPENCLAW_BIN',
    binMatches ? 'ok' : 'warn',
    binMatches ? 'OPENCLAW_BIN points to the target runtime' : 'OPENCLAW_BIN is missing or not pointing to the target runtime',
    `Set OPENCLAW_BIN=/root/openclaw-runtime-${TARGET_RUNTIME_VERSION}-erp/dist/index.js in openclaw-api .env`,
    { OPENCLAW_BIN: process.env.OPENCLAW_BIN ? process.env.OPENCLAW_BIN.replace(HOME, '~') : null },
  ))
  const gatewayProcess = snapshot.services.pm2.processes.find(process => process.name === 'openclaw-gateway')
  const gatewayOnline = gatewayProcess?.status === 'online'
  const gatewayRuntimeMatches = processUsesRuntime(gatewayProcess)
  checks.push(makeGateCheck(
    'service.gateway',
    'Gateway process',
    gatewayOnline && gatewayRuntimeMatches ? 'ok' : 'warn',
    gatewayProcess
      ? gatewayRuntimeMatches
        ? `Gateway is ${gatewayProcess.status} on target runtime`
        : `Gateway is ${gatewayProcess.status}, but PM2 may not point to runtime ${TARGET_RUNTIME_VERSION}`
      : 'Gateway process was not found in PM2',
    'Start or restart openclaw-gateway and verify the process path',
    { process: gatewayProcess || null },
  ))
  const apiProcess = snapshot.services.pm2.processes.find(process => process.name === 'openclaw-api')
  checks.push(makeGateCheck(
    'service.api',
    'OpenClaw API process',
    apiProcess?.status === 'online' || !snapshot.services.pm2.ok ? 'ok' : 'warn',
    apiProcess ? `API is ${apiProcess.status}` : 'API is serving this request; PM2 entry was not found',
    'Restart openclaw-api if PM2 reports a failed process',
    { process: apiProcess || null },
  ))
  checks.push(makeGateCheck(
    'service.postgres',
    'PostgreSQL',
    snapshot.services.postgres.ok ? 'ok' : 'warn',
    snapshot.services.postgres.ok ? 'PostgreSQL pool is configured' : 'PostgreSQL is not configured for durable admin data',
    'Set DATABASE_URL and restart API before using Conversation Analysis or Agent Brain',
  ))
  const legacyBlockAgents = snapshot.memory.legacy.filter(item => item.state === 'block')
  const legacyWarnAgents = snapshot.memory.legacy.filter(item => item.state === 'warn')
  checks.push(makeGateCheck(
    'memory.legacy',
    'Legacy MEMORY.md',
    legacyBlockAgents.length ? 'warn' : 'ok',
    legacyBlockAgents.length
      ? `${legacyBlockAgents.length} agent(s) have oversized legacy MEMORY.md`
      : legacyWarnAgents.length
        ? `${legacyWarnAgents.length} agent(s) are near legacy memory warning size`
        : 'Legacy memory sizes are within safe bounds',
    'Open /memory, preview legacy cleanup, then switch compatible agents to managed_only',
    { blockAgents: legacyBlockAgents.slice(0, 20), warnAgents: legacyWarnAgents.slice(0, 20) },
  ))
  const maxRank = checks.reduce((rank, check) => Math.max(rank, statusRank(check.status)), 0)
  return {
    ok: maxRank < 3,
    status: maxRank >= 3 ? 'fail' : maxRank === 2 ? 'warn' : 'ok',
    generatedAt: nowIso(),
    durationMs: Date.now() - startedAt,
    targetRuntimeVersion: TARGET_RUNTIME_VERSION,
    checks,
    safeMessage: maxRank >= 3
      ? 'Release gate has blocking failures'
      : maxRank === 2
        ? 'Release gate passed with warnings that should be reviewed'
        : 'Release gate passed',
    snapshot,
  }
}

function buildCustomerUpdateCommand() {
  const runtimeDir = `/root/openclaw-runtime-${TARGET_RUNTIME_VERSION}-erp`
  const newRuntimeDir = `${runtimeDir}.new`
  const runtimeBin = `${runtimeDir}/dist/index.js`
  return {
    generatedAt: nowIso(),
    targetRuntimeVersion: TARGET_RUNTIME_VERSION,
    command: [
      'set -euo pipefail',
      `TARGET_RUNTIME_VERSION=${TARGET_RUNTIME_VERSION}`,
      `TARGET_RUNTIME_BRANCH=${TARGET_RUNTIME_BRANCH}`,
      `RUNTIME=${runtimeDir}`,
      `NEW_RUNTIME=${newRuntimeDir}`,
      'BACKUP="/root/openclaw-runtime-${TARGET_RUNTIME_VERSION}-erp.bak-$(date +%Y%m%d-%H%M%S)"',
      '',
      'cd /root/openclaw-api',
      'git fetch origin main',
      'git pull --ff-only origin main',
      'npm install',
      `grep -q '^OPENCLAW_BIN=' .env && sed -i 's#^OPENCLAW_BIN=.*#OPENCLAW_BIN=${runtimeBin}#' .env || echo 'OPENCLAW_BIN=${runtimeBin}' >> .env`,
      '',
      'cd /root/openclaw-admin',
      'git fetch origin main',
      'git pull --ff-only origin main',
      'docker compose up -d --build openclaw-admin',
      '',
      'if [ ! -f "$RUNTIME/dist/index.js" ] || ! node "$RUNTIME/dist/index.js" --version | grep -q "OpenClaw ${TARGET_RUNTIME_VERSION}"; then',
      '  echo "Installing OpenClaw runtime ${TARGET_RUNTIME_VERSION} from ${TARGET_RUNTIME_BRANCH}"',
      '  rm -rf "$NEW_RUNTIME"',
      '  git clone --depth 1 --branch "$TARGET_RUNTIME_BRANCH" https://github.com/bosocmputer/openclaw.git "$NEW_RUNTIME"',
      '  cd "$NEW_RUNTIME"',
      '  corepack enable',
      '  corepack prepare pnpm@11.2.2 --activate',
      '  pnpm install --frozen-lockfile',
      '  pnpm build:docker',
      '  node "$NEW_RUNTIME/dist/index.js" --version | grep "OpenClaw ${TARGET_RUNTIME_VERSION}"',
      '  pm2 stop openclaw-gateway || true',
      '  if [ -d "$RUNTIME" ]; then mv "$RUNTIME" "$BACKUP"; fi',
      '  mv "$NEW_RUNTIME" "$RUNTIME"',
      'else',
      '  echo "Runtime ${TARGET_RUNTIME_VERSION} already installed at $RUNTIME"',
      'fi',
      '',
      'cat > /root/start-openclaw-gateway.sh <<\'SH\'',
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'export HOME=/root',
      'export PATH=/root/.npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      '',
      'set -a',
      '[ -f /root/openclaw-api/.env ] && . /root/openclaw-api/.env',
      'set +a',
      '',
      `exec /usr/bin/node ${runtimeBin} gateway --port 18789`,
      'SH',
      'chmod +x /root/start-openclaw-gateway.sh',
      '',
      `node ${runtimeBin} --version`,
      'pm2 restart openclaw-api --update-env',
      'pm2 delete openclaw-gateway || true',
      'pm2 start /root/start-openclaw-gateway.sh --name openclaw-gateway --cwd /root',
      'pm2 save',
      '',
      'cd /root/openclaw-api',
      'TOKEN=$(grep -E "^API_TOKEN=" .env | cut -d= -f2-)',
      'curl -fsS -X POST -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:4000/api/system/release-gate/run" | python3 -m json.tool',
    ].join('\n'),
    notes: [
      'The command installs or refreshes the target runtime when it is missing or not the expected version.',
      'The gateway PM2 entry is recreated so it uses /root/start-openclaw-gateway.sh and sources openclaw-api .env keys.',
      'Run model runtime tests from /model after the gate if provider/model changed.',
      'Run LINE/Telegram smoke tests after gateway restart.',
    ],
  }
}

module.exports = {
  TARGET_RUNTIME_VERSION,
  buildCustomerUpdateCommand,
  buildObservabilitySnapshot,
  getObservability,
  runReleaseGate,
  _internal: {
    compareVersions,
    parseOpenclawVersion,
    processUsesRuntime,
    readRuntimeIdentity,
    sanitizeError,
  },
}
