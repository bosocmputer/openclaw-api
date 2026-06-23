const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const { pgPool } = require('./pg')
const { HOME } = require('./config')
const { readOpenclawConfig } = require('./openclaw-config')

const TARGET_TYPES = new Set(['memory', 'business_profile', 'soul', 'mcp_search'])
const CANDIDATE_STATUSES = new Set(['pending', 'approved', 'applied', 'rejected'])
const MANAGED_HEADING = '## Admin-Approved Business Memory'
const MANAGED_START = '<!-- OPENCLAW_ADMIN_APPROVED_MEMORY_START -->'
const MANAGED_END = '<!-- OPENCLAW_ADMIN_APPROVED_MEMORY_END -->'
const MANAGED_BLOCK_MAX_CHARS = 5000
const MEMORY_WARN_CHARS = 12000
const MEMORY_BLOCK_CHARS = 18000

function isEnabled() {
  return process.env.MEMORY_LEARNING_REVIEW_ENABLED === '1'
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex')
}

function stableStringify(value) {
  if (value === null || value === undefined) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function truncateText(value, max = 5000) {
  if (value === null || value === undefined) return ''
  const text = String(value)
  return text.length > max ? `${text.slice(0, max)}…[truncated ${text.length - max} chars]` : text
}

function redactText(text, max = 5000) {
  return truncateText(String(text || '')
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,}]+/ig, '$1[redacted]')
    .replace(/(api[_-]?key\s*[:=]\s*)[^\s,}]+/ig, '$1[redacted]')
    .replace(/(botToken\s*[:=]\s*)[^\s,}]+/ig, '$1[redacted]')
    .replace(/(password\s*[:=]\s*)[^\s,}]+/ig, '$1[redacted]')
    .replace(/(token\s*[:=]\s*)[^\s,}]+/ig, '$1[redacted]'), max)
}

function redactValue(value, depth = 0) {
  if (depth > 8) return '[max-depth]'
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return redactText(value)
  if (typeof value !== 'object') return value
  if (Array.isArray(value)) return value.slice(0, 50).map(item => redactValue(item, depth + 1))
  const out = {}
  for (const [key, raw] of Object.entries(value)) {
    if (/token|api[_-]?key|authorization|password|secret|botToken|channelAccessToken|refreshToken|accessToken|cookie/i.test(key)) {
      out[key] = '[redacted]'
    } else {
      out[key] = redactValue(raw, depth + 1)
    }
  }
  return out
}

function assertNoSecretText(value, fieldName = 'value') {
  const text = typeof value === 'string' ? value : JSON.stringify(value || '')
  if (/(authorization\s*[:=]\s*bearer\s+[^\s,}]+|api[_-]?key\s*[:=]\s*[^\s,}]+|botToken\s*[:=]\s*[^\s,}]+|password\s*[:=]\s*[^\s,}]+|sk-[a-z0-9_-]{12,})/i.test(text)) {
    throw Object.assign(new Error(`${fieldName} contains secret-like content`), { status: 400 })
  }
}

function normalizeTargetType(value) {
  const type = String(value || 'memory').trim().toLowerCase().replace(/[-\s]/g, '_')
  if (!TARGET_TYPES.has(type)) throw Object.assign(new Error('targetType is invalid'), { status: 400 })
  return type
}

function normalizeStatus(value, fallback = 'pending') {
  const status = String(value || fallback).trim().toLowerCase()
  if (!CANDIDATE_STATUSES.has(status)) throw Object.assign(new Error('status is invalid'), { status: 400 })
  return status
}

function normalizeCandidateInput(input = {}) {
  const agentId = String(input.agentId || input.agent_id || '').trim()
  if (!agentId) throw Object.assign(new Error('agentId is required'), { status: 400 })
  const targetType = normalizeTargetType(input.targetType || input.target_type || 'memory')
  const summary = redactText(input.summary || '', 1200).trim()
  if (!summary) throw Object.assign(new Error('summary is required'), { status: 400 })
  assertNoSecretText(summary, 'summary')

  const evidence = Array.isArray(input.evidence) ? input.evidence.slice(0, 20) : []
  const safeEvidence = redactValue(evidence)
  assertNoSecretText(safeEvidence, 'evidence')

  const sourceTurnIds = Array.isArray(input.sourceTurnIds || input.source_turn_ids)
    ? (input.sourceTurnIds || input.source_turn_ids).map(id => String(id).trim()).filter(Boolean).slice(0, 50)
    : []
  const confidence = Number(input.confidence)
  const safeConfidence = Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : null
  const sourceHash = sha256(stableStringify({
    agentId,
    targetType,
    summary,
    evidence: safeEvidence,
    sourceTurnIds,
  }))

  return { agentId, targetType, summary, evidence: safeEvidence, sourceTurnIds, confidence: safeConfidence, sourceHash }
}

function serializeCandidate(row, extras = {}) {
  if (!row) return null
  return {
    id: row.id,
    agentId: row.agent_id,
    targetType: row.target_type,
    summary: row.summary,
    evidence: row.evidence || [],
    sourceTurnIds: row.source_turn_ids || [],
    status: row.status,
    confidence: row.confidence === null || row.confidence === undefined ? null : Number(row.confidence),
    sourceHash: row.source_hash,
    createdBy: row.created_by || null,
    updatedBy: row.updated_by || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    approvedAt: row.approved_at || null,
    appliedAt: row.applied_at || null,
    rejectedAt: row.rejected_at || null,
    appliedResult: row.applied_result || null,
    ...extras,
  }
}

async function ensureSchema() {
  if (!pgPool) throw Object.assign(new Error('Database not configured'), { status: 503 })
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS memory_learning_candidates (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_id TEXT NOT NULL,
      target_type TEXT NOT NULL,
      summary TEXT NOT NULL,
      evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
      source_turn_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      source_hash TEXT NOT NULL,
      confidence NUMERIC,
      status TEXT NOT NULL DEFAULT 'pending',
      created_by TEXT,
      updated_by TEXT,
      applied_result JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      approved_at TIMESTAMPTZ,
      applied_at TIMESTAMPTZ,
      rejected_at TIMESTAMPTZ,
      UNIQUE(agent_id, target_type, source_hash)
    )
  `)
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS memory_learning_audit (
      id BIGSERIAL PRIMARY KEY,
      candidate_id UUID,
      agent_id TEXT,
      action TEXT NOT NULL,
      actor TEXT,
      detail JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_memory_learning_candidates_agent_status ON memory_learning_candidates(agent_id, status, updated_at DESC)')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_memory_learning_candidates_target ON memory_learning_candidates(target_type, updated_at DESC)')
}

async function audit(action, detail = {}, candidate = null, actor = null) {
  if (!pgPool) return null
  try {
    await ensureSchema()
    await pgPool.query(`
      INSERT INTO memory_learning_audit (candidate_id, agent_id, action, actor, detail)
      VALUES ($1,$2,$3,$4,$5::jsonb)
    `, [
      candidate?.id || candidate?.candidate_id || null,
      candidate?.agentId || candidate?.agent_id || detail.agentId || null,
      action,
      actor || null,
      JSON.stringify(redactValue(detail)),
    ])
  } catch {}
  return null
}

async function createCandidate(input, actor = null) {
  if (!isEnabled()) throw Object.assign(new Error('Memory learning review is disabled'), { status: 404 })
  await ensureSchema()
  const normalized = normalizeCandidateInput(input)
  const existing = await pgPool.query(`
    SELECT * FROM memory_learning_candidates
    WHERE agent_id = $1 AND target_type = $2 AND source_hash = $3
    LIMIT 1
  `, [normalized.agentId, normalized.targetType, normalized.sourceHash])
  if (existing.rows[0]) {
    await audit('dedupe', { sourceHash: normalized.sourceHash }, existing.rows[0], actor)
    return serializeCandidate(existing.rows[0], { deduped: true })
  }

  const { rows } = await pgPool.query(`
    INSERT INTO memory_learning_candidates (
      agent_id, target_type, summary, evidence, source_turn_ids, source_hash,
      confidence, created_by, updated_by
    )
    VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$8)
    RETURNING *
  `, [
    normalized.agentId,
    normalized.targetType,
    normalized.summary,
    JSON.stringify(normalized.evidence),
    JSON.stringify(normalized.sourceTurnIds),
    normalized.sourceHash,
    normalized.confidence,
    actor,
  ])
  const candidate = serializeCandidate(rows[0], { deduped: false })
  await audit('create', { sourceHash: normalized.sourceHash }, candidate, actor)
  return candidate
}

async function listCandidates(filters = {}) {
  if (!isEnabled()) return { enabled: false, candidates: [] }
  await ensureSchema()
  const where = []
  const params = []
  if (filters.agentId) {
    params.push(String(filters.agentId))
    where.push(`agent_id = $${params.length}`)
  }
  if (filters.status) {
    params.push(normalizeStatus(filters.status))
    where.push(`status = $${params.length}`)
  }
  if (filters.targetType) {
    params.push(normalizeTargetType(filters.targetType))
    where.push(`target_type = $${params.length}`)
  }
  const limit = Math.min(Math.max(Number.parseInt(String(filters.limit || '100'), 10) || 100, 1), 500)
  params.push(limit)
  const { rows } = await pgPool.query(`
    SELECT *
    FROM memory_learning_candidates
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY updated_at DESC
    LIMIT $${params.length}
  `, params)
  return { enabled: true, candidates: rows.map(row => serializeCandidate(row)) }
}

async function getCandidate(id) {
  await ensureSchema()
  const { rows } = await pgPool.query('SELECT * FROM memory_learning_candidates WHERE id = $1', [id])
  return serializeCandidate(rows[0])
}

async function setCandidateStatus(id, status, actor = null) {
  if (!isEnabled()) throw Object.assign(new Error('Memory learning review is disabled'), { status: 404 })
  await ensureSchema()
  const nextStatus = normalizeStatus(status)
  const stampColumn = nextStatus === 'approved' ? 'approved_at' : null
  const { rows } = await pgPool.query(`
    UPDATE memory_learning_candidates
    SET status = $2,
        updated_by = $3,
        updated_at = now(),
        ${stampColumn ? `${stampColumn} = now(),` : ''}
        rejected_at = CASE WHEN $2 = 'rejected' THEN now() ELSE rejected_at END
    WHERE id = $1
    RETURNING *
  `, [id, nextStatus, actor])
  if (!rows[0]) throw Object.assign(new Error('Candidate not found'), { status: 404 })
  const candidate = serializeCandidate(rows[0])
  await audit(nextStatus, {}, candidate, actor)
  return candidate
}

function getAgentWorkspace(agentId) {
  const config = readOpenclawConfig()
  const agent = config.agents?.list?.find(a => a.id === agentId)
  if (!agent) throw Object.assign(new Error('Agent not found'), { status: 404 })
  if (!agent.workspace) throw Object.assign(new Error('Agent workspace is missing'), { status: 400 })
  return String(agent.workspace).replace(/^~(?=$|\/)/, HOME)
}

function memoryPathForAgent(agentId) {
  return path.join(getAgentWorkspace(agentId), 'MEMORY.md')
}

function backupId() {
  return new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)
}

function readFileSafe(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : ''
}

function writeFileAtomic(filePath, content, mode = 0o600) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`
  const fd = fs.openSync(tmpPath, 'w', mode)
  try {
    fs.writeFileSync(fd, content)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmpPath, filePath)
}

function extractManagedBlock(content) {
  const start = content.indexOf(MANAGED_START)
  const end = content.indexOf(MANAGED_END)
  if (start === -1 || end === -1 || end < start) {
    return { exists: false, before: content.trimEnd(), managed: '', after: '' }
  }
  const managedStart = start + MANAGED_START.length
  return {
    exists: true,
    before: content.slice(0, start).trimEnd(),
    managed: content.slice(managedStart, end).trim(),
    after: content.slice(end + MANAGED_END.length).trimStart(),
  }
}

function buildMemoryLine(candidate) {
  const source = Array.isArray(candidate.sourceTurnIds) && candidate.sourceTurnIds.length
    ? ` Source turns: ${candidate.sourceTurnIds.slice(0, 5).join(', ')}${candidate.sourceTurnIds.length > 5 ? ', …' : ''}.`
    : ''
  const confidence = candidate.confidence === null || candidate.confidence === undefined ? '' : ` Confidence: ${Math.round(candidate.confidence * 100)}%.`
  return `- ${redactText(candidate.summary, 900)}${source}${confidence}`
}

function buildManagedMemoryContent(currentContent, candidate) {
  const parsed = extractManagedBlock(currentContent)
  const existingLines = parsed.managed ? parsed.managed.split('\n').map(line => line.trim()).filter(Boolean) : []
  const nextLine = buildMemoryLine(candidate)
  const lines = existingLines.includes(nextLine) ? existingLines : [...existingLines, nextLine]
  const managed = lines.join('\n')
  if (managed.length > MANAGED_BLOCK_MAX_CHARS) {
    throw Object.assign(new Error(`Managed memory block would exceed ${MANAGED_BLOCK_MAX_CHARS} chars`), { status: 400 })
  }
  const block = `${MANAGED_HEADING}\n${MANAGED_START}\n${managed}\n${MANAGED_END}`
  const sections = [parsed.before || '# Long-Term Memory', block, parsed.after].filter(Boolean)
  return `${sections.join('\n\n').trimEnd()}\n`
}

function memorySizeWarning(chars) {
  if (chars >= MEMORY_BLOCK_CHARS) return 'block'
  if (chars >= MEMORY_WARN_CHARS) return 'warn'
  return 'ok'
}

async function applyCandidate(id, options = {}, actor = null) {
  if (!isEnabled()) throw Object.assign(new Error('Memory learning review is disabled'), { status: 404 })
  const candidate = await getCandidate(id)
  if (!candidate) throw Object.assign(new Error('Candidate not found'), { status: 404 })
  if (candidate.targetType !== 'memory') {
    throw Object.assign(new Error('Only MEMORY.md candidates can be applied automatically in v1'), { status: 409 })
  }
  if (candidate.status !== 'approved') {
    throw Object.assign(new Error('Candidate must be approved before apply'), { status: 409 })
  }

  const memoryPath = memoryPathForAgent(candidate.agentId)
  const current = readFileSafe(memoryPath)
  const next = buildManagedMemoryContent(current, candidate)
  const sizeWarning = memorySizeWarning(next.length)
  if (sizeWarning === 'block' && !options.force) {
    throw Object.assign(new Error(`MEMORY.md would exceed ${MEMORY_BLOCK_CHARS} chars; force confirmation is required`), { status: 409 })
  }
  const idPart = backupId()
  const backupPath = `${memoryPath}.bak-learning-${idPart}`
  fs.mkdirSync(path.dirname(memoryPath), { recursive: true })
  if (fs.existsSync(memoryPath)) fs.copyFileSync(memoryPath, backupPath)
  writeFileAtomic(memoryPath, next)
  const result = {
    ok: true,
    backupId: idPart,
    backupPath,
    memoryPath,
    previousChars: current.length,
    nextChars: next.length,
    sizeWarning,
  }
  const { rows } = await pgPool.query(`
    UPDATE memory_learning_candidates
    SET status = 'applied',
        applied_at = now(),
        updated_at = now(),
        updated_by = $2,
        applied_result = $3::jsonb
    WHERE id = $1
    RETURNING *
  `, [id, actor, JSON.stringify(redactValue(result))])
  const updated = serializeCandidate(rows[0])
  await audit('apply', result, updated, actor)
  return { candidate: updated, result: redactValue(result) }
}

function listBackups(agentId) {
  const memoryPath = memoryPathForAgent(agentId)
  const dir = path.dirname(memoryPath)
  const base = path.basename(memoryPath)
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .filter(name => name.startsWith(`${base}.bak-learning-`))
    .map(name => {
      const fullPath = path.join(dir, name)
      const stat = fs.statSync(fullPath)
      return {
        backupId: name.replace(`${base}.bak-learning-`, ''),
        fileName: name,
        sizeBytes: stat.size,
        createdAt: stat.mtime.toISOString(),
      }
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

async function rollbackMemory(agentId, backupIdValue, actor = null) {
  const safeBackupId = String(backupIdValue || '').trim()
  if (!/^(?:rollback-)?\d{14}$/.test(safeBackupId)) {
    throw Object.assign(new Error('backupId is invalid'), { status: 400 })
  }
  const memoryPath = memoryPathForAgent(agentId)
  const backupPath = `${memoryPath}.bak-learning-${safeBackupId}`
  if (!fs.existsSync(backupPath)) throw Object.assign(new Error('Backup not found'), { status: 404 })
  const rollbackBackupId = `rollback-${backupId()}`
  const rollbackBackupPath = `${memoryPath}.bak-learning-${rollbackBackupId}`
  if (fs.existsSync(memoryPath)) fs.copyFileSync(memoryPath, rollbackBackupPath)
  fs.copyFileSync(backupPath, memoryPath)
  const result = { ok: true, agentId, backupId: safeBackupId, rollbackBackupId, restoredBytes: fs.statSync(memoryPath).size }
  await audit('rollback', result, { agentId }, actor)
  return result
}

module.exports = {
  isEnabled,
  ensureSchema,
  createCandidate,
  listCandidates,
  getCandidate,
  setCandidateStatus,
  applyCandidate,
  listBackups,
  rollbackMemory,
  buildManagedMemoryContent,
  memorySizeWarning,
  redactValue,
  _internal: {
    normalizeCandidateInput,
    extractManagedBlock,
    buildManagedMemoryContent,
    buildMemoryLine,
    redactText,
    redactValue,
    stableStringify,
    sha256,
    MANAGED_BLOCK_MAX_CHARS,
    MEMORY_WARN_CHARS,
    MEMORY_BLOCK_CHARS,
  },
}
