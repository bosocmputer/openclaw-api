const crypto = require('crypto')

const { pgPool } = require('./pg')
const { redactValue } = require('./memory-learning')

const MEMORY_TYPES = new Set(['terminology', 'preference', 'workflow_hint', 'faq_pattern', 'entity_alias', 'staff_instruction', 'blocked_fact'])
const MEMORY_SCOPES = new Set(['session', 'contact', 'agent', 'business', 'global'])
const MEMORY_STATUSES = new Set(['active', 'soft', 'blocked', 'deleted'])
const POLICY_MODES = new Set(['off', 'observe_only', 'safe_auto', 'manual_review'])
const OBSERVATION_STATUSES = new Set(['observed', 'promoted', 'blocked', 'ignored'])
const DEFAULT_SAFE_TYPES = ['terminology', 'preference', 'workflow_hint', 'faq_pattern', 'entity_alias']
const DEFAULT_MAX_CONTEXT_CHARS = 1200

let schemaReady = false

function isAvailable() {
  return Boolean(pgPool)
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

function truncateText(value, max = 1200) {
  if (value === null || value === undefined) return ''
  const text = String(value)
  return text.length > max ? `${text.slice(0, max)}…[truncated ${text.length - max} chars]` : text
}

function redactText(text, max = 1200) {
  return truncateText(String(text || '')
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,}]+/ig, '$1[redacted]')
    .replace(/(api[_-]?key\s*[:=]\s*)[^\s,}]+/ig, '$1[redacted]')
    .replace(/(botToken\s*[:=]\s*)[^\s,}]+/ig, '$1[redacted]')
    .replace(/(password\s*[:=]\s*)[^\s,}]+/ig, '$1[redacted]')
    .replace(/(token\s*[:=]\s*)[^\s,}]+/ig, '$1[redacted]'), max)
}

function assertNoSecretText(value, fieldName = 'value') {
  const text = typeof value === 'string' ? value : JSON.stringify(value || '')
  if (/(authorization\s*[:=]\s*bearer\s+[^\s,}]+|api[_-]?key\s*[:=]\s*[^\s,}]+|botToken\s*[:=]\s*[^\s,}]+|password\s*[:=]\s*[^\s,}]+|sk-[a-z0-9_-]{12,})/i.test(text)) {
    throw Object.assign(new Error(`${fieldName} contains secret-like content`), { status: 400 })
  }
}

function normalizeEnum(value, allowed, fallback, fieldName) {
  const normalized = String(value || fallback || '').trim().toLowerCase()
  if (!allowed.has(normalized)) throw Object.assign(new Error(`${fieldName} is invalid`), { status: 400 })
  return normalized
}

function normalizeMemoryType(value) {
  return normalizeEnum(value, MEMORY_TYPES, 'workflow_hint', 'type')
}

function normalizeMemoryScope(value) {
  return normalizeEnum(value, MEMORY_SCOPES, 'agent', 'scope')
}

function normalizeMemoryStatus(value) {
  return normalizeEnum(value, MEMORY_STATUSES, 'active', 'status')
}

function normalizePolicyMode(value) {
  return normalizeEnum(value, POLICY_MODES, 'observe_only', 'mode')
}

function normalizeObservationStatus(value) {
  return normalizeEnum(value, OBSERVATION_STATUSES, 'observed', 'status')
}

function normalizeAgentId(value) {
  const agentId = String(value || '').trim()
  if (!agentId) throw Object.assign(new Error('agentId is required'), { status: 400 })
  return agentId
}

function normalizeContent(value, max = 1200) {
  const content = redactText(value, max).trim()
  if (!content) throw Object.assign(new Error('content is required'), { status: 400 })
  assertNoSecretText(content, 'content')
  return content
}

function normalizedContentHash(content) {
  return sha256(String(content || '').toLowerCase().replace(/\s+/g, ' ').trim())
}

async function ensureSchema() {
  if (schemaReady) return
  if (!pgPool) throw Object.assign(new Error('Database not configured'), { status: 503 })

  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS memory_policies (
      agent_id TEXT PRIMARY KEY,
      mode TEXT NOT NULL DEFAULT 'observe_only',
      max_context_chars INTEGER NOT NULL DEFAULT ${DEFAULT_MAX_CONTEXT_CHARS},
      safe_types JSONB NOT NULL DEFAULT '["terminology","preference","workflow_hint","faq_pattern","entity_alias"]'::jsonb,
      allow_chat_teaching BOOLEAN NOT NULL DEFAULT false,
      retention_days INTEGER,
      updated_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS agent_memories (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      type TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'agent',
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      source_authority TEXT NOT NULL DEFAULT 'admin_config',
      confidence NUMERIC,
      evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
      source_turn_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      ttl_expires_at TIMESTAMPTZ,
      last_used_at TIMESTAMPTZ,
      usage_count INTEGER NOT NULL DEFAULT 0,
      created_by TEXT,
      updated_by TEXT,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS memory_observations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_id TEXT NOT NULL,
      type TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'agent',
      summary TEXT NOT NULL,
      evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
      source_turn_id TEXT,
      source_hash TEXT NOT NULL,
      risk TEXT NOT NULL DEFAULT 'low',
      recommended_action TEXT NOT NULL DEFAULT 'observe',
      status TEXT NOT NULL DEFAULT 'observed',
      confidence NUMERIC,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(agent_id, source_hash)
    )
  `)
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS memory_usage_events (
      id BIGSERIAL PRIMARY KEY,
      turn_id TEXT,
      memory_id UUID REFERENCES agent_memories(id) ON DELETE SET NULL,
      agent_id TEXT,
      injected_chars INTEGER,
      relevance_score NUMERIC,
      outcome TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS memory_tombstones (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      reason TEXT,
      source_memory_id UUID,
      created_by TEXT,
      expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(agent_id, content_hash)
    )
  `)
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_agent_memories_agent_status ON agent_memories(agent_id, status, updated_at DESC)')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_agent_memories_type_scope ON agent_memories(type, scope, updated_at DESC)')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_memory_observations_agent_status ON memory_observations(agent_id, status, updated_at DESC)')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_memory_observations_source_turn ON memory_observations(source_turn_id)')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_memory_usage_turn ON memory_usage_events(turn_id)')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_memory_tombstones_agent_hash ON memory_tombstones(agent_id, content_hash)')
  schemaReady = true
}

function serializePolicy(row) {
  if (!row) return null
  return {
    agentId: row.agent_id,
    mode: row.mode,
    maxContextChars: row.max_context_chars,
    safeTypes: row.safe_types || DEFAULT_SAFE_TYPES,
    allowChatTeaching: row.allow_chat_teaching === true,
    retentionDays: row.retention_days === null || row.retention_days === undefined ? null : Number(row.retention_days),
    updatedBy: row.updated_by || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function serializeMemory(row) {
  if (!row) return null
  return {
    id: row.id,
    agentId: row.agent_id,
    status: row.status,
    type: row.type,
    scope: row.scope,
    content: row.content,
    sourceAuthority: row.source_authority,
    confidence: row.confidence === null || row.confidence === undefined ? null : Number(row.confidence),
    evidence: row.evidence || {},
    sourceTurnIds: row.source_turn_ids || [],
    ttlExpiresAt: row.ttl_expires_at || null,
    lastUsedAt: row.last_used_at || null,
    usageCount: row.usage_count || 0,
    createdBy: row.created_by || null,
    updatedBy: row.updated_by || null,
    deletedAt: row.deleted_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function serializeObservation(row) {
  if (!row) return null
  return {
    id: row.id,
    agentId: row.agent_id,
    type: row.type,
    scope: row.scope,
    summary: row.summary,
    evidence: row.evidence || {},
    sourceTurnId: row.source_turn_id || null,
    risk: row.risk,
    recommendedAction: row.recommended_action,
    status: row.status,
    confidence: row.confidence === null || row.confidence === undefined ? null : Number(row.confidence),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function serializeUsage(row) {
  if (!row) return null
  return {
    id: row.id,
    turnId: row.turn_id || null,
    memoryId: row.memory_id || null,
    agentId: row.agent_id || null,
    injectedChars: row.injected_chars || 0,
    relevanceScore: row.relevance_score === null || row.relevance_score === undefined ? null : Number(row.relevance_score),
    outcome: row.outcome || null,
    metadata: row.metadata || {},
    createdAt: row.created_at,
  }
}

async function getPolicy(agentId) {
  await ensureSchema()
  const safeAgent = normalizeAgentId(agentId)
  const { rows } = await pgPool.query('SELECT * FROM memory_policies WHERE agent_id = $1', [safeAgent])
  return serializePolicy(rows[0]) || {
    agentId: safeAgent,
    mode: 'observe_only',
    maxContextChars: DEFAULT_MAX_CONTEXT_CHARS,
    safeTypes: DEFAULT_SAFE_TYPES,
    allowChatTeaching: false,
    retentionDays: null,
    updatedBy: null,
    createdAt: null,
    updatedAt: null,
  }
}

async function listPolicies() {
  await ensureSchema()
  const { rows } = await pgPool.query('SELECT * FROM memory_policies ORDER BY agent_id ASC')
  return { policies: rows.map(serializePolicy) }
}

async function upsertPolicy(agentId, body = {}, actor = null) {
  await ensureSchema()
  const safeAgent = normalizeAgentId(agentId)
  const mode = normalizePolicyMode(body.mode || 'observe_only')
  const maxContextChars = Math.min(Math.max(Number.parseInt(String(body.maxContextChars ?? body.max_context_chars ?? DEFAULT_MAX_CONTEXT_CHARS), 10) || DEFAULT_MAX_CONTEXT_CHARS, 300), 4000)
  const rawSafeTypes = Array.isArray(body.safeTypes || body.safe_types) ? (body.safeTypes || body.safe_types) : DEFAULT_SAFE_TYPES
  const safeTypes = rawSafeTypes.map(normalizeMemoryType).filter((value, index, arr) => arr.indexOf(value) === index)
  const allowChatTeaching = body.allowChatTeaching === true || body.allow_chat_teaching === true
  const retentionDaysRaw = body.retentionDays ?? body.retention_days
  const retentionDays = retentionDaysRaw === null || retentionDaysRaw === '' || retentionDaysRaw === undefined
    ? null
    : Math.min(Math.max(Number.parseInt(String(retentionDaysRaw), 10) || 180, 1), 3650)
  const { rows } = await pgPool.query(`
    INSERT INTO memory_policies (
      agent_id, mode, max_context_chars, safe_types, allow_chat_teaching, retention_days, updated_by, updated_at
    ) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,now())
    ON CONFLICT (agent_id) DO UPDATE SET
      mode = EXCLUDED.mode,
      max_context_chars = EXCLUDED.max_context_chars,
      safe_types = EXCLUDED.safe_types,
      allow_chat_teaching = EXCLUDED.allow_chat_teaching,
      retention_days = EXCLUDED.retention_days,
      updated_by = EXCLUDED.updated_by,
      updated_at = now()
    RETURNING *
  `, [safeAgent, mode, maxContextChars, JSON.stringify(safeTypes), allowChatTeaching, retentionDays, actor])
  return serializePolicy(rows[0])
}

function whereParamsForList(filters = {}, alias = 'm') {
  const where = []
  const params = []
  if (filters.agentId) {
    params.push(String(filters.agentId))
    where.push(`${alias}.agent_id = $${params.length}`)
  }
  if (filters.status) {
    params.push(normalizeMemoryStatus(filters.status))
    where.push(`${alias}.status = $${params.length}`)
  }
  if (filters.type) {
    params.push(normalizeMemoryType(filters.type))
    where.push(`${alias}.type = $${params.length}`)
  }
  if (filters.scope) {
    params.push(normalizeMemoryScope(filters.scope))
    where.push(`${alias}.scope = $${params.length}`)
  }
  if (filters.q) {
    const q = `%${String(filters.q).trim().replace(/[%_]/g, ch => `\\${ch}`)}%`
    params.push(q)
    where.push(`(${alias}.content ILIKE $${params.length} ESCAPE '\\' OR ${alias}.source_authority ILIKE $${params.length} ESCAPE '\\')`)
  }
  return { where, params }
}

async function listMemories(filters = {}) {
  await ensureSchema()
  const { where, params } = whereParamsForList(filters, 'm')
  const limit = Math.min(Math.max(Number.parseInt(String(filters.limit || '100'), 10) || 100, 1), 500)
  params.push(limit)
  const { rows } = await pgPool.query(`
    SELECT *
    FROM agent_memories m
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY updated_at DESC
    LIMIT $${params.length}
  `, params)
  return { memories: rows.map(serializeMemory) }
}

async function getMemory(id) {
  await ensureSchema()
  const { rows } = await pgPool.query('SELECT * FROM agent_memories WHERE id = $1', [id])
  return serializeMemory(rows[0])
}

async function createMemory(input = {}, actor = null) {
  await ensureSchema()
  const agentId = normalizeAgentId(input.agentId || input.agent_id)
  const type = normalizeMemoryType(input.type)
  const scope = normalizeMemoryScope(input.scope)
  const status = normalizeMemoryStatus(input.status || 'active')
  const content = normalizeContent(input.content, 1500)
  const evidence = redactValue(input.evidence || {})
  assertNoSecretText(evidence, 'evidence')
  const sourceTurnIds = Array.isArray(input.sourceTurnIds || input.source_turn_ids)
    ? (input.sourceTurnIds || input.source_turn_ids).map(id => String(id).trim()).filter(Boolean).slice(0, 50)
    : []
  const confidence = Number(input.confidence)
  const safeConfidence = Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : null
  const sourceAuthority = redactText(input.sourceAuthority || input.source_authority || 'admin_config', 80).trim() || 'admin_config'
  const contentHash = normalizedContentHash(content)
  const blocked = await pgPool.query(`
    SELECT 1 FROM memory_tombstones
    WHERE agent_id = $1 AND content_hash = $2 AND (expires_at IS NULL OR expires_at > now())
    LIMIT 1
  `, [agentId, contentHash])
  if (blocked.rows[0] && status !== 'blocked') {
    throw Object.assign(new Error('This memory matches a deleted/blocked memory tombstone'), { status: 409 })
  }
  const { rows } = await pgPool.query(`
    INSERT INTO agent_memories (
      agent_id, status, type, scope, content, content_hash, source_authority,
      confidence, evidence, source_turn_ids, ttl_expires_at, created_by, updated_by
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$12)
    RETURNING *
  `, [
    agentId,
    status,
    type,
    scope,
    content,
    contentHash,
    sourceAuthority,
    safeConfidence,
    JSON.stringify(evidence),
    JSON.stringify(sourceTurnIds),
    input.ttlExpiresAt || input.ttl_expires_at || null,
    actor,
  ])
  return serializeMemory(rows[0])
}

async function updateMemory(id, input = {}, actor = null) {
  await ensureSchema()
  const current = await getMemory(id)
  if (!current) throw Object.assign(new Error('Memory not found'), { status: 404 })
  const type = input.type === undefined ? current.type : normalizeMemoryType(input.type)
  const scope = input.scope === undefined ? current.scope : normalizeMemoryScope(input.scope)
  const status = input.status === undefined ? current.status : normalizeMemoryStatus(input.status)
  const content = input.content === undefined ? current.content : normalizeContent(input.content, 1500)
  const contentHash = normalizedContentHash(content)
  const confidence = input.confidence === undefined ? current.confidence : Number(input.confidence)
  const safeConfidence = Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : null
  const evidence = input.evidence === undefined ? current.evidence : redactValue(input.evidence || {})
  assertNoSecretText(evidence, 'evidence')
  const { rows } = await pgPool.query(`
    UPDATE agent_memories
    SET type = $2,
        scope = $3,
        status = $4,
        content = $5,
        content_hash = $6,
        confidence = $7,
        evidence = $8::jsonb,
        updated_by = $9,
        updated_at = now(),
        deleted_at = CASE WHEN $4 = 'deleted' THEN COALESCE(deleted_at, now()) ELSE deleted_at END
    WHERE id = $1
    RETURNING *
  `, [id, type, scope, status, content, contentHash, safeConfidence, JSON.stringify(evidence), actor])
  return serializeMemory(rows[0])
}

async function createTombstone({ agentId, content, contentHash, reason, sourceMemoryId }, actor = null) {
  await ensureSchema()
  const safeAgent = normalizeAgentId(agentId)
  const hash = contentHash || normalizedContentHash(content)
  const safeReason = redactText(reason || 'Admin blocked relearning', 500)
  await pgPool.query(`
    INSERT INTO memory_tombstones (agent_id, content_hash, reason, source_memory_id, created_by)
    VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (agent_id, content_hash) DO UPDATE SET
      reason = EXCLUDED.reason,
      source_memory_id = COALESCE(EXCLUDED.source_memory_id, memory_tombstones.source_memory_id),
      created_by = EXCLUDED.created_by,
      created_at = now()
  `, [safeAgent, hash, safeReason, sourceMemoryId || null, actor])
  return { ok: true, agentId: safeAgent, contentHash: hash, reason: safeReason }
}

async function deleteMemory(id, options = {}, actor = null) {
  await ensureSchema()
  const current = await getMemory(id)
  if (!current) throw Object.assign(new Error('Memory not found'), { status: 404 })
  const updated = await updateMemory(id, { status: 'deleted' }, actor)
  let tombstone = null
  const shouldBlockRelearn = !(
    options.blockRelearn === false ||
    options.blockRelearn === 'false' ||
    options.block_relearn === false ||
    options.block_relearn === 'false'
  )
  if (shouldBlockRelearn) {
    tombstone = await createTombstone({
      agentId: current.agentId,
      content: current.content,
      reason: options.reason || 'Deleted by admin',
      sourceMemoryId: id,
    }, actor)
  }
  return { memory: updated, tombstone }
}

async function blockRelearn(id, body = {}, actor = null) {
  const memory = await getMemory(id)
  if (!memory) throw Object.assign(new Error('Memory not found'), { status: 404 })
  const tombstone = await createTombstone({
    agentId: memory.agentId,
    content: memory.content,
    reason: body.reason || 'Blocked by admin',
    sourceMemoryId: id,
  }, actor)
  const updated = memory.status === 'deleted' ? memory : await updateMemory(id, { status: 'blocked' }, actor)
  return { memory: updated, tombstone }
}

async function listObservations(filters = {}) {
  await ensureSchema()
  const where = []
  const params = []
  if (filters.agentId) {
    params.push(String(filters.agentId))
    where.push(`agent_id = $${params.length}`)
  }
  if (filters.status) {
    params.push(normalizeObservationStatus(filters.status))
    where.push(`status = $${params.length}`)
  }
  if (filters.type) {
    params.push(normalizeMemoryType(filters.type))
    where.push(`type = $${params.length}`)
  }
  if (filters.sourceTurnId) {
    params.push(String(filters.sourceTurnId))
    where.push(`source_turn_id = $${params.length}`)
  }
  if (filters.q) {
    const q = `%${String(filters.q).trim().replace(/[%_]/g, ch => `\\${ch}`)}%`
    params.push(q)
    where.push(`summary ILIKE $${params.length} ESCAPE '\\'`)
  }
  const limit = Math.min(Math.max(Number.parseInt(String(filters.limit || '100'), 10) || 100, 1), 500)
  params.push(limit)
  const { rows } = await pgPool.query(`
    SELECT *
    FROM memory_observations
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY updated_at DESC
    LIMIT $${params.length}
  `, params)
  return { observations: rows.map(serializeObservation) }
}

async function upsertObservation(input = {}, client = pgPool) {
  const agentId = normalizeAgentId(input.agentId || input.agent_id)
  const type = normalizeMemoryType(input.type)
  const scope = normalizeMemoryScope(input.scope)
  const summary = normalizeContent(input.summary, 1000)
  const evidence = redactValue(input.evidence || {})
  assertNoSecretText(evidence, 'evidence')
  const sourceTurnId = input.sourceTurnId || input.source_turn_id || null
  const sourceHash = input.sourceHash || input.source_hash || sha256(stableStringify({ agentId, type, scope, summary, evidence, sourceTurnId }))
  const risk = String(input.risk || 'low').trim().toLowerCase()
  const recommendedAction = String(input.recommendedAction || input.recommended_action || 'observe').trim().toLowerCase()
  const confidence = Number(input.confidence)
  const safeConfidence = Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : null
  const { rows } = await client.query(`
    INSERT INTO memory_observations (
      agent_id, type, scope, summary, evidence, source_turn_id, source_hash,
      risk, recommended_action, confidence, updated_at
    ) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,now())
    ON CONFLICT (agent_id, source_hash) DO UPDATE SET
      summary = EXCLUDED.summary,
      evidence = EXCLUDED.evidence,
      risk = EXCLUDED.risk,
      recommended_action = EXCLUDED.recommended_action,
      confidence = EXCLUDED.confidence,
      updated_at = now()
    RETURNING *
  `, [agentId, type, scope, summary, JSON.stringify(evidence), sourceTurnId, sourceHash, risk, recommendedAction, safeConfidence])
  return serializeObservation(rows[0])
}

function issueToObservation(turn, issue) {
  const tag = String(issue.tag || '')
  let type = 'workflow_hint'
  let risk = 'low'
  let recommendedAction = 'observe'
  if (/search|candidate|selection/i.test(tag)) {
    type = 'entity_alias'
    recommendedAction = 'mcp_search_review'
  } else if (/price|stock|cost|availability|unsupported|capability/i.test(tag)) {
    type = 'blocked_fact'
    risk = 'high'
    recommendedAction = 'block_truth'
  } else if (/reply|language|duplicate/i.test(tag)) {
    type = 'workflow_hint'
    recommendedAction = 'soul_review'
  } else if (/slow|timeout|fallback|delivery|stalled/i.test(tag)) {
    type = 'workflow_hint'
    recommendedAction = 'runtime_review'
  }
  return {
    agentId: turn.agentId || 'unknown',
    type,
    scope: 'agent',
    summary: `${issue.label || tag}: ${truncateText(issue.evidence?.userPreview || turn.userText || tag, 220)}`,
    evidence: {
      issueTag: tag,
      issueLabel: issue.label,
      reviewTarget: issue.reviewTarget,
      severity: issue.severity,
      evidence: issue.evidence || {},
      turnId: turn.id,
      channel: turn.channel,
    },
    sourceTurnId: turn.id,
    risk,
    recommendedAction,
    confidence: risk === 'high' ? 0.2 : 0.65,
  }
}

function teachingText(turn) {
  const text = String(turn.userText || '').trim()
  if (!/(จำไว้|ช่วยจำ|remember this|note this|keep in mind)/i.test(text)) return null
  return text.replace(/^(จำไว้ว่า?|ช่วยจำว่า?|remember this:?|note this:?|keep in mind:?)/i, '').trim() || text
}

function isProhibitedMemoryTruth(text) {
  return /(ราคา|ราคาพิเศษ|ต้นทุน|ทุนสินค้า|สต็อก|stock|คงเหลือ|มีสินค้า|ไม่มีสินค้า|สินค้าทดแทน|แทนได้|เครดิต|ยอดค้าง|availability|available|price|cost|special price|inventory|substitute)/i.test(String(text || ''))
}

function explicitTeachingObservation(turn) {
  const text = String(turn.userText || '').trim()
  const taught = teachingText(turn)
  if (!taught) return null
  if (isProhibitedMemoryTruth(taught)) {
    return {
      agentId: turn.agentId || 'unknown',
      type: 'blocked_fact',
      scope: 'agent',
      summary: `ห้ามจำเป็นข้อมูลถาวร: ${truncateText(taught, 760)}`,
      evidence: {
        source: 'explicit_chat_teaching_blocked',
        reason: 'ERP/SML values must be fetched live from MCP/tools',
        turnId: turn.id,
        channel: turn.channel,
        userPreview: truncateText(text, 400),
      },
      sourceTurnId: turn.id,
      risk: 'high',
      recommendedAction: 'block_truth',
      confidence: 0.95,
    }
  }
  return {
    agentId: turn.agentId || 'unknown',
    type: 'staff_instruction',
    scope: 'agent',
    summary: truncateText(taught, 800),
    evidence: {
      source: 'explicit_chat_teaching',
      turnId: turn.id,
      channel: turn.channel,
      userPreview: truncateText(text, 400),
    },
    sourceTurnId: turn.id,
    risk: 'medium',
    recommendedAction: 'policy_promote',
    confidence: 0.75,
  }
}

function mediaWorkflowObservation(turn) {
  if (!turn.hasMedia && !turn.mediaCount) return null
  return {
    agentId: turn.agentId || 'unknown',
    type: 'workflow_hint',
    scope: 'agent',
    summary: `ลูกค้าส่งรูป ${turn.mediaCount || 1} ไฟล์ใน ${turn.channel}; ใช้เป็นบริบทประกอบคำถาม ไม่ใช่ข้อมูลราคา/สต็อก`,
    evidence: {
      source: 'media_turn',
      turnId: turn.id,
      channel: turn.channel,
      mediaCount: turn.mediaCount || 1,
      userPreview: truncateText(turn.userText || '', 300),
    },
    sourceTurnId: turn.id,
    risk: 'low',
    recommendedAction: 'observe',
    confidence: 0.6,
  }
}

function observationsFromTurn(turn) {
  if (!turn?.agentId) return []
  const observations = []
  const explicit = explicitTeachingObservation(turn)
  if (explicit) observations.push(explicit)
  const media = mediaWorkflowObservation(turn)
  if (media) observations.push(media)
  for (const issue of Array.isArray(turn.issues) ? turn.issues : []) {
    const observation = issueToObservation(turn, issue)
    if (explicit?.type === 'blocked_fact' && observation.type === 'blocked_fact') continue
    observations.push(observation)
  }
  return observations
}

async function syncObservationsForTurn(turn, client = null) {
  if (!turn?.agentId || !isAvailable()) return []
  await ensureSchema()
  const db = client || pgPool
  const observations = observationsFromTurn(turn)
  const saved = []
  for (const observation of observations) {
    try {
      saved.push(await upsertObservation(observation, db))
    } catch {
      // Observation collection must never break conversation ingestion or reads.
    }
  }
  return saved
}

async function promoteObservation(id, input = {}, actor = null) {
  await ensureSchema()
  const { rows } = await pgPool.query('SELECT * FROM memory_observations WHERE id = $1', [id])
  const observation = serializeObservation(rows[0])
  if (!observation) throw Object.assign(new Error('Observation not found'), { status: 404 })
  const status = normalizeMemoryStatus(input.status || (observation.risk === 'high' ? 'blocked' : 'soft'))
  const memory = await createMemory({
    agentId: observation.agentId,
    type: input.type || observation.type,
    scope: input.scope || observation.scope,
    status,
    content: input.content || observation.summary,
    evidence: {
      observationId: observation.id,
      observationEvidence: observation.evidence,
    },
    sourceTurnIds: observation.sourceTurnId ? [observation.sourceTurnId] : [],
    sourceAuthority: 'observation_promoted',
    confidence: input.confidence ?? observation.confidence,
  }, actor)
  await pgPool.query(`
    UPDATE memory_observations
    SET status = 'promoted', updated_at = now()
    WHERE id = $1
  `, [id])
  return { observation: { ...observation, status: 'promoted' }, memory }
}

async function listUsage(filters = {}) {
  await ensureSchema()
  const where = []
  const params = []
  if (filters.turnId) {
    params.push(String(filters.turnId))
    where.push(`u.turn_id = $${params.length}`)
  }
  if (filters.agentId) {
    params.push(String(filters.agentId))
    where.push(`u.agent_id = $${params.length}`)
  }
  const limit = Math.min(Math.max(Number.parseInt(String(filters.limit || '100'), 10) || 100, 1), 500)
  params.push(limit)
  const { rows } = await pgPool.query(`
    SELECT u.*
    FROM memory_usage_events u
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY created_at DESC
    LIMIT $${params.length}
  `, params)
  return { usage: rows.map(serializeUsage) }
}

async function summaryForAgents(agentIds = []) {
  await ensureSchema()
  const ids = Array.from(new Set(agentIds.filter(Boolean)))
  if (!ids.length) return {}
  const [counts, policies] = await Promise.all([
    pgPool.query(`
      SELECT agent_id,
             COUNT(*) FILTER (WHERE status = 'active')::int AS active_count,
             COUNT(*) FILTER (WHERE status = 'soft')::int AS soft_count,
             COUNT(*) FILTER (WHERE status = 'blocked')::int AS blocked_count,
             COUNT(*) FILTER (WHERE status = 'deleted')::int AS deleted_count,
             COALESCE(SUM(length(content)) FILTER (WHERE status IN ('active','soft')), 0)::int AS estimated_injected_chars
      FROM agent_memories
      WHERE agent_id = ANY($1::text[])
      GROUP BY agent_id
    `, [ids]),
    pgPool.query('SELECT * FROM memory_policies WHERE agent_id = ANY($1::text[])', [ids]),
  ])
  const byAgent = {}
  for (const id of ids) {
    byAgent[id] = {
      autoLearnMode: 'observe_only',
      activeMemoryCount: 0,
      softMemoryCount: 0,
      blockedCount: 0,
      deletedCount: 0,
      estimatedInjectedChars: 0,
      maxContextChars: DEFAULT_MAX_CONTEXT_CHARS,
    }
  }
  for (const row of counts.rows) {
    byAgent[row.agent_id] = {
      ...byAgent[row.agent_id],
      activeMemoryCount: row.active_count || 0,
      softMemoryCount: row.soft_count || 0,
      blockedCount: row.blocked_count || 0,
      deletedCount: row.deleted_count || 0,
      estimatedInjectedChars: row.estimated_injected_chars || 0,
    }
  }
  for (const row of policies.rows) {
    byAgent[row.agent_id] = {
      ...byAgent[row.agent_id],
      autoLearnMode: row.mode || 'observe_only',
      maxContextChars: row.max_context_chars || DEFAULT_MAX_CONTEXT_CHARS,
    }
  }
  return byAgent
}

async function buildLearningDetail(turn) {
  if (!turn?.agentId || !isAvailable()) return { learningSignals: [], memoryUsage: [], memoryDecisions: [] }
  const learningSignals = await syncObservationsForTurn(turn)
  const usage = await listUsage({ turnId: turn.id, limit: 50 })
  const decisions = learningSignals.map(signal => ({
    observationId: signal.id,
    type: signal.type,
    risk: signal.risk,
    decision: signal.status === 'promoted' ? 'learned' : signal.risk === 'high' ? 'blocked' : 'observed',
    reason: signal.risk === 'high'
      ? 'ข้อมูลนี้เสี่ยงต่อการจำผิด จึงยังไม่ใช้ตอบจริง'
      : 'ระบบบันทึกเป็นข้อมูลที่สังเกตเห็น ยังไม่ inject จนกว่า policy อนุญาต',
  }))
  return {
    learningSignals,
    memoryUsage: usage.usage,
    memoryDecisions: decisions,
  }
}

module.exports = {
  ensureSchema,
  isAvailable,
  listPolicies,
  getPolicy,
  upsertPolicy,
  listMemories,
  getMemory,
  createMemory,
  updateMemory,
  deleteMemory,
  blockRelearn,
  listObservations,
  promoteObservation,
  listUsage,
  summaryForAgents,
  syncObservationsForTurn,
  buildLearningDetail,
  observationsFromTurn,
  _internal: {
    normalizeMemoryType,
    normalizeMemoryScope,
    normalizeMemoryStatus,
    normalizePolicyMode,
    normalizedContentHash,
    observationsFromTurn,
    explicitTeachingObservation,
    issueToObservation,
    isProhibitedMemoryTruth,
  },
}
