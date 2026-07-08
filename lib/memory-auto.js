const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const { pgPool } = require('./pg')
const { HOME } = require('./config')
const { readOpenclawConfig } = require('./openclaw-config')
const { redactValue } = require('./memory-learning')

const MEMORY_TYPES = new Set([
  'terminology',
  'preference',
  'workflow_hint',
  'search_hint',
  'description_suggestion',
  'faq_pattern',
  'entity_alias',
  'staff_instruction',
  'blocked_fact',
])
const MEMORY_SCOPES = new Set(['session', 'contact', 'agent', 'business', 'global'])
const MEMORY_STATUSES = new Set(['active', 'soft', 'blocked', 'deleted'])
const POLICY_MODES = new Set(['off', 'observe_only', 'safe_auto', 'manual_review'])
const OBSERVATION_STATUSES = new Set(['observed', 'promoted', 'blocked', 'ignored'])
const CHANNELS = new Set(['line', 'telegram', 'webchat'])
const CHANNEL_AUDIENCES = new Set(['customer', 'staff', 'internal'])
const DEFAULT_SAFE_TYPES = ['terminology', 'preference', 'workflow_hint', 'faq_pattern', 'entity_alias']
const DEFAULT_MAX_CONTEXT_CHARS = 1200
const AUTO_MEMORY_HEADING = '## Auto-Learned Business Memory'
const AUTO_MEMORY_START = '<!-- OPENCLAW_AUTO_LEARN_MEMORY_START -->'
const AUTO_MEMORY_END = '<!-- OPENCLAW_AUTO_LEARN_MEMORY_END -->'
const AUTO_MEMORY_MAX_LINES = 40
const MEMORY_TYPE_PRIORITY = {
  terminology: 100,
  entity_alias: 90,
  search_hint: 85,
  staff_instruction: 80,
  preference: 70,
  faq_pattern: 60,
  workflow_hint: 50,
  description_suggestion: 20,
}
const SYSTEM_NOISE_PATTERNS = [
  /\[User sent media without caption\]/i,
  /^(Needs user refine|Tool error|Slow turn|LINE delivery uncertain|Unverified price guess|Search no result|Search retry loop|Fallback used|Model timeout):/i,
]
const DYNAMIC_FACT_PATTERN = /(ราคา|ราคาพิเศษ|ต้นทุน|ทุนสินค้า|สต็อก|stock|คงเหลือ|มีสินค้า|ไม่มีสินค้า|หมดของ|สินค้าทดแทน|แทนได้|เครดิต|ยอดค้าง|availability|available|price|cost|special price|inventory|substitute)/i
const BARE_TEACHING_PATTERN = /^(จำไว้(?:ด้วย)?|ช่วยจำ(?:ด้วย)?|remember this|note this|keep in mind)$/i
const VAGUE_REFERENCE_PATTERN = /(ตัวนี้|อันนี้|รายการนี้|เบอร์นี้|รหัสนี้|สินค้านี้|this item|that item)/i
const PRODUCT_CODE_PATTERN = /\b(?=[A-Z0-9-]*\d)(?=[A-Z0-9-]*[A-Z-])[A-Z0-9][A-Z0-9-]{3,}[A-Z0-9]\b/gi
const THAI_TOKEN_PATTERN = /[\u0E00-\u0E7Fa-zA-Z0-9][\u0E00-\u0E7Fa-zA-Z0-9./+-]{1,}/g

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

function normalizeChannel(value) {
  return normalizeEnum(value, CHANNELS, 'line', 'channel')
}

function normalizeAudience(value) {
  return normalizeEnum(value, CHANNEL_AUDIENCES, 'customer', 'audience')
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

function memoryCanBeRuntimeContext(memory) {
  return memory?.status === 'active'
    && memory.type !== 'blocked_fact'
    && memory.type !== 'description_suggestion'
}

function hasSystemNoiseText(text) {
  const value = String(text || '').trim()
  return SYSTEM_NOISE_PATTERNS.some(pattern => pattern.test(value))
}

function hasVagueTeachingText(text) {
  const value = String(text || '').trim()
  if (!value) return true
  if (BARE_TEACHING_PATTERN.test(value)) return true
  return VAGUE_REFERENCE_PATTERN.test(value)
}

function classifyMemoryText(text, context = {}) {
  const value = String(text || '').trim()
  if (!value) {
    return {
      decision: 'blocked_noise',
      safeToPromote: false,
      blockedReason: 'empty_text',
      cleanupCategory: 'noise',
      decisionReason: 'ข้อความว่างหรือไม่มีสาระพอสำหรับ memory',
    }
  }
  if (hasSystemNoiseText(value)) {
    return {
      decision: 'blocked_noise',
      safeToPromote: false,
      blockedReason: 'system_or_log_text',
      cleanupCategory: 'noise',
      decisionReason: 'ข้อความนี้เป็น log/system marker ไม่ใช่ความจำของธุรกิจ',
    }
  }
  if (DYNAMIC_FACT_PATTERN.test(value)) {
    return {
      decision: 'blocked_dynamic_fact',
      safeToPromote: false,
      blockedReason: 'dynamic_business_fact',
      cleanupCategory: 'dynamic_fact',
      decisionReason: 'ข้อมูลราคา สต็อก ต้นทุน availability หรือสิทธิ์ราคา ต้องดึงสดจาก MCP/SML',
    }
  }
  if (context.source === 'explicit_chat_teaching' && hasVagueTeachingText(value)) {
    return {
      decision: 'manual_review',
      safeToPromote: false,
      blockedReason: 'vague_teaching',
      cleanupCategory: 'vague_teaching',
      decisionReason: 'คำสอนอ้างถึง “ตัวนี้/เบอร์นี้/จำไว้” โดยไม่มี entity ที่ชัดพอ',
    }
  }
  return {
    decision: context.promotable ? 'promotable' : 'observed_only',
    safeToPromote: Boolean(context.promotable),
    blockedReason: null,
    cleanupCategory: null,
    decisionReason: context.promotable
      ? 'เป็นคำสอนหรือ pattern ที่ปลอดภัยพอให้ policy promote ได้'
      : 'บันทึกเป็น observation ก่อน ยังไม่ใช้ตอบจริง',
  }
}

function observationDecision(observation) {
  const action = String(observation?.recommendedAction || '').trim().toLowerCase()
  const source = observation?.evidence?.source || null
  const sourceIsIssue = source === 'issue_tag' || Boolean(observation?.evidence?.issueTag)
  if (action === 'mcp_search_review') {
    return {
      decision: 'mcp_search_review',
      safeToPromote: false,
      blockedReason: null,
      decisionReason: 'สัญญาณนี้ควรไปปรับ MCP/Search ไม่ใช่ memory',
    }
  }
  if (action === 'search_hint_candidate') {
    return {
      decision: 'search_hint_candidate',
      safeToPromote: false,
      blockedReason: null,
      decisionReason: 'คำช่วยค้นนี้ต้อง verify ด้วย MCP/Search ก่อนใช้เป็นความรู้ active',
    }
  }
  if (action === 'description_suggestion') {
    return {
      decision: 'description_suggestion',
      safeToPromote: false,
      blockedReason: null,
      decisionReason: 'คำแนะนำนี้เหมาะสำหรับเติม description ใน SML ERP ไม่ใช่ runtime truth',
    }
  }
  if (action === 'soul_review') {
    return {
      decision: 'soul_review',
      safeToPromote: false,
      blockedReason: null,
      decisionReason: 'สัญญาณนี้ควรไปปรับ SOUL หรือรูปแบบการตอบ',
    }
  }
  if (action === 'runtime_review') {
    return {
      decision: 'observed_only',
      safeToPromote: false,
      blockedReason: null,
      decisionReason: 'สัญญาณนี้เป็น runtime/delivery/latency จึงไม่ควรเป็น memory',
    }
  }
  if (action === 'block_truth' || observationIsHighRisk(observation)) {
    const classified = classifyMemoryText(observation?.summary, { source })
    return {
      decision: classified.decision === 'blocked_noise' ? 'blocked_noise' : 'blocked_dynamic_fact',
      safeToPromote: false,
      blockedReason: classified.blockedReason || 'high_risk_truth',
      decisionReason: classified.decisionReason || 'ข้อมูลนี้เสี่ยงต่อการจำผิด จึงบันทึกเป็นเรื่องห้ามจำเท่านั้น',
    }
  }
  if (action === 'blocked_noise') {
    const classified = classifyMemoryText(observation?.summary, { source })
    return {
      decision: 'blocked_noise',
      safeToPromote: false,
      blockedReason: classified.blockedReason || 'noise',
      decisionReason: classified.decisionReason,
    }
  }
  if (action === 'manual_review' || sourceIsIssue) {
    return {
      decision: 'manual_review',
      safeToPromote: false,
      blockedReason: action === 'manual_review' ? 'needs_human_review' : null,
      decisionReason: sourceIsIssue
        ? 'สัญญาณนี้มาจาก issue/log จึงใช้เป็นหลักฐานเท่านั้น'
        : 'ต้องตรวจสอบก่อนใช้เป็น memory',
    }
  }
  if (action === 'policy_promote' && source === 'explicit_chat_teaching') {
    return classifyMemoryText(observation?.summary, { source, promotable: true })
  }
  return classifyMemoryText(observation?.summary, { source, promotable: false })
}

function getAgentWorkspace(agentId) {
  const config = readOpenclawConfig()
  const agent = config.agents?.list?.find(a => a.id === agentId)
  if (!agent?.workspace) return null
  return String(agent.workspace).replace(/^~(?=$|\/)/, HOME)
}

function memoryPathForAgent(agentId) {
  const workspace = getAgentWorkspace(agentId)
  return workspace ? path.join(workspace, 'MEMORY.md') : null
}

function readFileSafe(filePath) {
  return filePath && fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : ''
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

function extractMarkedBlock(content, startMarker, endMarker) {
  const start = content.indexOf(startMarker)
  const end = content.indexOf(endMarker)
  if (start === -1 || end === -1 || end < start) {
    return { exists: false, before: content.trimEnd(), after: '' }
  }
  return {
    exists: true,
    before: content.slice(0, start).trimEnd(),
    after: content.slice(end + endMarker.length).trimStart(),
  }
}

function memoryRuntimeLine(memory) {
  const type = typeShortLabel(memory.type)
  const confidence = memory.confidence === null || memory.confidence === undefined ? '' : ` (${Math.round(memory.confidence * 100)}%)`
  return `- [${type}] ${redactText(memory.content, 900)}${confidence}`
}

function memoryRuntimePriority(memory) {
  return MEMORY_TYPE_PRIORITY[memory?.type] || 0
}

function sortRuntimeMemories(memories = []) {
  return [...memories].sort((a, b) => {
    const priorityDiff = memoryRuntimePriority(b) - memoryRuntimePriority(a)
    if (priorityDiff) return priorityDiff
    const usageDiff = Number(b.usageCount || 0) - Number(a.usageCount || 0)
    if (usageDiff) return usageDiff
    const confidenceDiff = Number(b.confidence || 0) - Number(a.confidence || 0)
    if (confidenceDiff) return confidenceDiff
    return new Date(b.updatedAt || b.updated_at || 0).getTime() - new Date(a.updatedAt || a.updated_at || 0).getTime()
  })
}

function selectRuntimeMemoryLines(memories = [], maxContextChars = DEFAULT_MAX_CONTEXT_CHARS) {
  const lines = []
  const includedMemoryIds = []
  const excludedMemoryIds = []
  let used = 0
  for (const memory of sortRuntimeMemories(memories).filter(memoryCanBeRuntimeContext).slice(0, AUTO_MEMORY_MAX_LINES)) {
    const line = memoryRuntimeLine(memory)
    const nextUsed = used + line.length + 1
    if (nextUsed > maxContextChars) {
      excludedMemoryIds.push(memory.id)
      continue
    }
    lines.push(line)
    includedMemoryIds.push(memory.id)
    used = nextUsed
  }
  return { lines, chars: lines.join('\n').length, includedMemoryIds, excludedMemoryIds }
}

function queryTermsForRelevance(value) {
  return Array.from(new Set([
    ...extractProductCodes(value),
    ...safeTermCandidates(value, 16).map(term => term.toLowerCase()),
  ])).slice(0, 24)
}

function memoryRelevanceScore(memory, queryTerms = []) {
  if (!queryTerms.length) return memoryRuntimePriority(memory) / 1000
  const haystack = `${memory.content || ''}\n${stableStringify(memory.evidence || {})}`.toLowerCase()
  let score = 0
  for (const term of queryTerms) {
    if (haystack.includes(String(term).toLowerCase())) score += String(term).length >= 6 ? 2 : 1
  }
  if (memory.type === 'terminology' || memory.type === 'entity_alias') score += 0.25
  if (memory.type === 'search_hint') score += 0.2
  return score
}

function selectRelevantRuntimeMemories(memories = [], queryText = '', maxContextChars = DEFAULT_MAX_CONTEXT_CHARS) {
  const queryTerms = queryTermsForRelevance(queryText)
  const scored = memories
    .filter(memoryCanBeRuntimeContext)
    .map(memory => ({ ...memory, _relevanceScore: memoryRelevanceScore(memory, queryTerms) }))
    .filter(memory => !queryTerms.length || memory._relevanceScore > 0)
    .sort((a, b) => {
      const scoreDiff = Number(b._relevanceScore || 0) - Number(a._relevanceScore || 0)
      if (scoreDiff) return scoreDiff
      return memoryRuntimePriority(b) - memoryRuntimePriority(a)
    })
  return selectRuntimeMemoryLines(scored, maxContextChars)
}

function typeShortLabel(type) {
  if (type === 'terminology') return 'term'
  if (type === 'entity_alias') return 'alias'
  if (type === 'search_hint') return 'search'
  if (type === 'description_suggestion') return 'sml-desc'
  if (type === 'workflow_hint') return 'workflow'
  if (type === 'faq_pattern') return 'faq'
  if (type === 'preference') return 'preference'
  if (type === 'staff_instruction') return 'instruction'
  return type || 'memory'
}

function replaceAutoMemoryBlock(currentContent, lines) {
  const parsed = extractMarkedBlock(currentContent || '', AUTO_MEMORY_START, AUTO_MEMORY_END)
  const before = parsed.before || '# Long-Term Memory'
  const after = parsed.after || ''
  const block = lines.length
    ? `${AUTO_MEMORY_HEADING}\n${AUTO_MEMORY_START}\n${lines.join('\n')}\n${AUTO_MEMORY_END}`
    : ''
  return [before, block, after].filter(Boolean).join('\n\n').trimEnd() + '\n'
}

function safeMemoryFilePolicyMode(policy) {
  return policy?.mode === 'safe_auto' || policy?.mode === 'manual_review'
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
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS agent_brain_channel_policies (
      channel TEXT NOT NULL,
      account_id TEXT NOT NULL,
      audience TEXT NOT NULL DEFAULT 'customer',
      show_description_suggestions BOOLEAN NOT NULL DEFAULT false,
      enabled BOOLEAN NOT NULL DEFAULT true,
      updated_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY(channel, account_id)
    )
  `)
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_agent_memories_agent_status ON agent_memories(agent_id, status, updated_at DESC)')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_agent_memories_type_scope ON agent_memories(type, scope, updated_at DESC)')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_memory_observations_agent_status ON memory_observations(agent_id, status, updated_at DESC)')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_memory_observations_source_turn ON memory_observations(source_turn_id)')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_memory_usage_turn ON memory_usage_events(turn_id)')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_memory_tombstones_agent_hash ON memory_tombstones(agent_id, content_hash)')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_agent_brain_channel_policy_channel ON agent_brain_channel_policies(channel, audience)')
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
  const observation = {
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
  const decision = observationDecision(observation)
  return {
    ...observation,
    decision: decision.decision,
    decisionReason: decision.decisionReason,
    safeToPromote: decision.safeToPromote,
    blockedReason: decision.blockedReason,
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

function serializeChannelPolicy(row, fallback = {}) {
  const channel = row?.channel || fallback.channel || null
  const accountId = row?.account_id || fallback.accountId || fallback.account_id || null
  return {
    channel,
    accountId,
    audience: row?.audience || 'customer',
    showDescriptionSuggestions: row?.show_description_suggestions === true,
    enabled: row?.enabled !== false,
    updatedBy: row?.updated_by || null,
    createdAt: row?.created_at || null,
    updatedAt: row?.updated_at || null,
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

async function listChannelPolicies(filters = {}) {
  await ensureSchema()
  const where = []
  const params = []
  if (filters.channel) {
    params.push(normalizeChannel(filters.channel))
    where.push(`channel = $${params.length}`)
  }
  if (filters.accountId || filters.account_id) {
    params.push(String(filters.accountId || filters.account_id).trim())
    where.push(`account_id = $${params.length}`)
  }
  const { rows } = await pgPool.query(`
    SELECT *
    FROM agent_brain_channel_policies
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY channel ASC, account_id ASC
  `, params)
  return { policies: rows.map(row => serializeChannelPolicy(row)) }
}

async function getChannelPolicy(channel, accountId) {
  await ensureSchema()
  const safeChannel = normalizeChannel(channel)
  const safeAccountId = String(accountId || 'default').trim() || 'default'
  const { rows } = await pgPool.query(
    'SELECT * FROM agent_brain_channel_policies WHERE channel = $1 AND account_id = $2',
    [safeChannel, safeAccountId],
  )
  return serializeChannelPolicy(rows[0], { channel: safeChannel, accountId: safeAccountId })
}

async function upsertChannelPolicy(channel, accountId, body = {}, actor = null) {
  await ensureSchema()
  const safeChannel = normalizeChannel(channel || body.channel)
  const safeAccountId = String(accountId || body.accountId || body.account_id || 'default').trim() || 'default'
  const audience = normalizeAudience(body.audience || 'customer')
  const showDescriptionSuggestions = body.showDescriptionSuggestions === true || body.show_description_suggestions === true
  const enabled = body.enabled !== false && body.enabled !== 'false'
  if (audience === 'customer' && showDescriptionSuggestions) {
    throw Object.assign(new Error('Description suggestions can be shown only to staff/internal channels'), { status: 400 })
  }
  const { rows } = await pgPool.query(`
    INSERT INTO agent_brain_channel_policies (
      channel, account_id, audience, show_description_suggestions, enabled, updated_by, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,now())
    ON CONFLICT (channel, account_id) DO UPDATE SET
      audience = EXCLUDED.audience,
      show_description_suggestions = EXCLUDED.show_description_suggestions,
      enabled = EXCLUDED.enabled,
      updated_by = EXCLUDED.updated_by,
      updated_at = now()
    RETURNING *
  `, [safeChannel, safeAccountId, audience, showDescriptionSuggestions, enabled, actor])
  return serializeChannelPolicy(rows[0])
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
  const policy = serializePolicy(rows[0])
  if (policy.mode === 'safe_auto') {
    policy.autoApplyResult = await applyAutoLearnForAgent(safeAgent, { actor, limit: 100 }).catch(err => ({
      ok: false,
      error: err.message,
    }))
  } else {
    await syncAgentMemoryFile(safeAgent).catch(() => {})
  }
  return policy
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
  if (type === 'blocked_fact' && status !== 'blocked' && status !== 'deleted') {
    throw Object.assign(new Error('blocked_fact memories must use blocked or deleted status'), { status: 400 })
  }
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
  if (status !== 'deleted') {
    const existing = await pgPool.query(`
      SELECT *
      FROM agent_memories
      WHERE agent_id = $1
        AND content_hash = $2
        AND status <> 'deleted'
      ORDER BY
        CASE status WHEN 'active' THEN 0 WHEN 'soft' THEN 1 WHEN 'blocked' THEN 2 ELSE 3 END,
        usage_count DESC,
        updated_at DESC
      LIMIT 1
    `, [agentId, contentHash])
    if (existing.rows[0]) {
      if (status === 'blocked' && existing.rows[0].status !== 'blocked') {
        const { rows: updatedRows } = await pgPool.query(`
          UPDATE agent_memories
          SET status = 'blocked',
              type = 'blocked_fact',
              updated_by = $2,
              updated_at = now()
          WHERE id = $1
          RETURNING *
        `, [existing.rows[0].id, actor])
        await syncAgentMemoryFile(agentId).catch(() => {})
        return serializeMemory(updatedRows[0])
      }
      return serializeMemory(existing.rows[0])
    }
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
  const memory = serializeMemory(rows[0])
  await syncAgentMemoryFile(agentId).catch(() => {})
  return memory
}

async function updateMemory(id, input = {}, actor = null) {
  await ensureSchema()
  const current = await getMemory(id)
  if (!current) throw Object.assign(new Error('Memory not found'), { status: 404 })
  const type = input.type === undefined ? current.type : normalizeMemoryType(input.type)
  const scope = input.scope === undefined ? current.scope : normalizeMemoryScope(input.scope)
  const status = input.status === undefined ? current.status : normalizeMemoryStatus(input.status)
  if (type === 'blocked_fact' && status !== 'blocked' && status !== 'deleted') {
    throw Object.assign(new Error('blocked_fact memories must use blocked or deleted status'), { status: 400 })
  }
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
  const memory = serializeMemory(rows[0])
  await syncAgentMemoryFile(memory.agentId).catch(() => {})
  return memory
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

function backupId() {
  return new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)
}

function backupMemoryFile(agentId, reason = 'auto-cleanup') {
  const memoryPath = memoryPathForAgent(agentId)
  if (!memoryPath) return null
  const idPart = backupId()
  const backupPath = `${memoryPath}.bak-${reason}-${idPart}`
  fs.mkdirSync(path.dirname(memoryPath), { recursive: true })
  if (fs.existsSync(memoryPath)) {
    fs.copyFileSync(memoryPath, backupPath)
    return { backupId: idPart, backupPath, memoryPath, existed: true }
  }
  return { backupId: idPart, backupPath, memoryPath, existed: false }
}

function classifyMemoryForCleanup(memory, duplicateInfo = null) {
  const classified = classifyMemoryText(memory.content, {
    source: memory.evidence?.observationEvidence?.source || memory.evidence?.source || memory.sourceAuthority,
  })
  const categories = []
  let action = 'keep'
  let reason = 'safe'
  let tombstone = false
  if (classified.cleanupCategory === 'noise') {
    categories.push('noise')
    action = 'delete'
    reason = classified.blockedReason || 'noise'
    tombstone = true
  } else if (classified.cleanupCategory === 'dynamic_fact') {
    categories.push('dynamic_fact')
    action = 'block'
    reason = classified.blockedReason || 'dynamic_business_fact'
    tombstone = true
  } else if (classified.cleanupCategory === 'vague_teaching') {
    categories.push('vague_teaching')
    action = memory.status === 'active' ? 'soften' : 'keep'
    reason = classified.blockedReason || 'vague_teaching'
  }
  if (duplicateInfo?.isDuplicate && action === 'keep') {
    categories.push('duplicate')
    action = 'delete_duplicate'
    reason = 'duplicate_content'
    tombstone = false
  } else if (duplicateInfo?.isDuplicate) {
    categories.push('duplicate')
  }
  return {
    memoryId: memory.id,
    agentId: memory.agentId,
    status: memory.status,
    type: memory.type,
    contentHash: normalizedContentHash(memory.content),
    contentPreview: redactText(memory.content, 240),
    action,
    reason,
    categories,
    tombstone,
    safeToKeep: action === 'keep',
  }
}

function summarizeCleanupActions(actions = []) {
  const summary = {
    scanned: actions.length,
    keep: 0,
    delete: 0,
    block: 0,
    soften: 0,
    deleteDuplicate: 0,
    duplicateCount: 0,
    noiseCount: 0,
    dynamicFactCount: 0,
    vagueTeachingCount: 0,
    tombstoneCount: 0,
  }
  for (const action of actions) {
    if (action.action === 'keep') summary.keep += 1
    if (action.action === 'delete') summary.delete += 1
    if (action.action === 'block') summary.block += 1
    if (action.action === 'soften') summary.soften += 1
    if (action.action === 'delete_duplicate') summary.deleteDuplicate += 1
    if (action.categories.includes('duplicate')) summary.duplicateCount += 1
    if (action.categories.includes('noise')) summary.noiseCount += 1
    if (action.categories.includes('dynamic_fact')) summary.dynamicFactCount += 1
    if (action.categories.includes('vague_teaching')) summary.vagueTeachingCount += 1
    if (action.tombstone) summary.tombstoneCount += 1
  }
  return summary
}

function duplicateInfoForMemories(memories = []) {
  const groups = new Map()
  for (const memory of memories) {
    const hash = normalizedContentHash(memory.content)
    if (!groups.has(hash)) groups.set(hash, [])
    groups.get(hash).push(memory)
  }
  const result = new Map()
  for (const group of groups.values()) {
    if (group.length <= 1) continue
    const sorted = sortRuntimeMemories(group)
    const keepId = sorted[0]?.id
    for (const memory of group) {
      result.set(memory.id, { isDuplicate: memory.id !== keepId, keepId, groupSize: group.length })
    }
  }
  return result
}

function summarizeMemoryHealth(memories = [], maxContextChars = DEFAULT_MAX_CONTEXT_CHARS) {
  const runtimeCandidates = memories.filter(memory => memory.status === 'active' && memory.type !== 'blocked_fact')
  const selection = selectRuntimeMemoryLines(runtimeCandidates, maxContextChars)
  const duplicateInfo = duplicateInfoForMemories(memories.filter(memory => memory.status === 'active' || memory.status === 'soft'))
  const actions = memories.map(memory => classifyMemoryForCleanup(memory, duplicateInfo.get(memory.id)))
  const totalActiveChars = runtimeCandidates.reduce((sum, memory) => sum + String(memory.content || '').length, 0)
  const summary = summarizeCleanupActions(actions)
  return {
    noiseCount: summary.noiseCount,
    duplicateCount: summary.duplicateCount,
    dynamicFactCount: summary.dynamicFactCount,
    vagueTeachingCount: summary.vagueTeachingCount,
    overBudget: selection.excludedMemoryIds.length > 0,
    injectedChars: selection.chars,
    activeButNotInjectedCount: selection.excludedMemoryIds.length,
    totalActiveChars,
  }
}

function safeBackupInfo(backup) {
  if (!backup) return null
  return {
    backupId: backup.backupId,
    fileName: path.basename(backup.backupPath || backup.memoryPath || 'MEMORY.md.backup'),
    existed: backup.existed,
  }
}

async function cleanupMemories(agentId, options = {}, actor = null) {
  await ensureSchema()
  const safeAgent = normalizeAgentId(agentId || options.agentId || options.agent_id)
  const dryRun = options.dryRun !== false && options.dry_run !== false && options.apply !== true
  const { rows } = await pgPool.query(`
    SELECT *
    FROM agent_memories
    WHERE agent_id = $1
      AND status IN ('active','soft')
    ORDER BY updated_at DESC
    LIMIT 1000
  `, [safeAgent])
  const memories = rows.map(serializeMemory)
  const duplicateInfo = duplicateInfoForMemories(memories)
  const actions = memories.map(memory => classifyMemoryForCleanup(memory, duplicateInfo.get(memory.id)))
  const actionable = actions.filter(action => action.action !== 'keep')
  const examples = {}
  for (const category of ['noise', 'dynamic_fact', 'vague_teaching', 'duplicate']) {
    examples[category] = actions
      .filter(action => action.categories.includes(category))
      .slice(0, 8)
      .map(action => ({
        memoryId: action.memoryId,
        action: action.action,
        reason: action.reason,
        contentPreview: action.contentPreview,
      }))
  }
  const result = {
    ok: true,
    dryRun,
    agentId: safeAgent,
    summary: summarizeCleanupActions(actions),
    examples,
    actions: actionable.slice(0, 200),
  }
  if (dryRun) return result

  const backup = backupMemoryFile(safeAgent, 'auto-cleanup')
  const applied = []
  const errors = []
  for (const action of actionable) {
    try {
      if (action.action === 'block') {
        const { rows: updatedRows } = await pgPool.query(`
          UPDATE agent_memories
          SET status = 'blocked',
              type = 'blocked_fact',
              updated_by = $2,
              updated_at = now()
          WHERE id = $1
          RETURNING *
        `, [action.memoryId, actor])
        await createTombstone({
          agentId: safeAgent,
          contentHash: action.contentHash,
          reason: action.reason,
          sourceMemoryId: action.memoryId,
        }, actor)
        applied.push({ ...action, nextStatus: updatedRows[0]?.status || 'blocked' })
      } else if (action.action === 'soften') {
        const { rows: updatedRows } = await pgPool.query(`
          UPDATE agent_memories
          SET status = 'soft',
              updated_by = $2,
              updated_at = now()
          WHERE id = $1
          RETURNING *
        `, [action.memoryId, actor])
        applied.push({ ...action, nextStatus: updatedRows[0]?.status || 'soft' })
      } else {
        const { rows: updatedRows } = await pgPool.query(`
          UPDATE agent_memories
          SET status = 'deleted',
              deleted_at = COALESCE(deleted_at, now()),
              updated_by = $2,
              updated_at = now()
          WHERE id = $1
          RETURNING *
        `, [action.memoryId, actor])
        if (action.tombstone) {
          await createTombstone({
            agentId: safeAgent,
            contentHash: action.contentHash,
            reason: action.reason,
            sourceMemoryId: action.memoryId,
          }, actor)
        }
        applied.push({ ...action, nextStatus: updatedRows[0]?.status || 'deleted' })
      }
    } catch (err) {
      errors.push({ memoryId: action.memoryId, action: action.action, error: err.message })
    }
  }
  const syncResult = await syncAgentMemoryFile(safeAgent).catch(err => ({ ok: false, error: err.message }))
  return {
    ...result,
    dryRun: false,
    backup: safeBackupInfo(backup),
    applied,
    errors,
    syncResult,
    ok: errors.length === 0,
  }
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
  let recommendedAction = 'manual_review'
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
      source: 'issue_tag',
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

function extractProductCodes(text) {
  return Array.from(new Set(String(text || '').match(PRODUCT_CODE_PATTERN) || []))
    .map(code => code.toUpperCase())
    .filter(code => code.length >= 4)
    .slice(0, 12)
}

function hasSpecificCode(text) {
  return extractProductCodes(text).length > 0
}

function teachingLooksLikeSearchHint(text) {
  const value = String(text || '')
  if (!value.trim()) return false
  if (isProhibitedMemoryTruth(value)) return false
  return hasSpecificCode(value) || /(คำค้น|ค้นหา|search|keyword|เรียกว่า|สะกด|alias|เท่ากับ|แทนคำว่า|หมายถึง)/i.test(value)
}

function safeTermCandidates(text, max = 10) {
  const stripped = redactText(text, 900)
    .replace(DYNAMIC_FACT_PATTERN, ' ')
    .replace(PRODUCT_CODE_PATTERN, ' ')
  const tokens = stripped.match(THAI_TOKEN_PATTERN) || []
  const stop = new Set(['ครับ', 'ค่ะ', 'คะ', 'จำไว้', 'ช่วยจำ', 'ราคา', 'สต็อก', 'stock', 'cost', 'price', 'มีสินค้า', 'ไม่มีสินค้า'])
  const result = []
  for (const token of tokens) {
    const value = token.trim()
    if (value.length < 2 || stop.has(value.toLowerCase())) continue
    if (/^\d+$/.test(value)) continue
    if (!result.includes(value)) result.push(value)
    if (result.length >= max) break
  }
  return result
}

function searchHintObservation(turn, taught) {
  const codes = extractProductCodes(taught)
  const terms = safeTermCandidates(taught, 8)
  if (!codes.length && terms.length < 2) return null
  return {
    agentId: turn.agentId || 'unknown',
    type: 'search_hint',
    scope: 'agent',
    summary: truncateText(taught, 800),
    evidence: {
      source: 'explicit_search_hint_teaching',
      turnId: turn.id,
      channel: turn.channel,
      userPreview: truncateText(turn.userText || taught, 400),
      productCodes: codes,
      terms,
    },
    sourceTurnId: turn.id,
    risk: 'medium',
    recommendedAction: 'search_hint_candidate',
    confidence: codes.length ? 0.7 : 0.55,
  }
}

function descriptionSuggestionObservation(turn) {
  const userText = String(turn.userText || '')
  const finalText = String(turn.finalText || '')
  const codes = extractProductCodes(`${userText}\n${finalText}`)
  const terms = safeTermCandidates(`${userText}\n${finalText}`, 10)
  if (!codes.length || terms.length < 2) return null
  const summary = `ควรพิจารณาเติม description สำหรับรหัส ${codes[0]} ด้วยคำค้น: ${terms.slice(0, 8).join(', ')}`
  return {
    agentId: turn.agentId || 'unknown',
    type: 'description_suggestion',
    scope: 'agent',
    summary,
    evidence: {
      source: 'conversation_description_suggestion',
      turnId: turn.id,
      channel: turn.channel,
      productCodes: codes.slice(0, 5),
      suggestedTerms: terms.slice(0, 10),
      userPreview: truncateText(userText, 360),
      finalPreview: truncateText(finalText, 360),
      rule: 'generic_product_code_plus_terms',
    },
    sourceTurnId: turn.id,
    risk: 'low',
    recommendedAction: 'description_suggestion',
    confidence: 0.6,
  }
}

function explicitTeachingObservation(turn) {
  const text = String(turn.userText || '').trim()
  const taught = teachingText(turn)
  if (!taught) return null
  if (teachingLooksLikeSearchHint(taught)) {
    const searchHint = searchHintObservation(turn, taught)
    if (searchHint) return searchHint
  }
  const classified = classifyMemoryText(taught, { source: 'explicit_chat_teaching', promotable: true })
  if (classified.decision === 'blocked_noise' || classified.decision === 'manual_review') {
    return {
      agentId: turn.agentId || 'unknown',
      type: 'staff_instruction',
      scope: 'agent',
      summary: truncateText(taught, 800),
      evidence: {
        source: 'explicit_chat_teaching_rejected',
        reason: classified.decisionReason,
        blockedReason: classified.blockedReason,
        turnId: turn.id,
        channel: turn.channel,
        userPreview: truncateText(text, 400),
      },
      sourceTurnId: turn.id,
      risk: 'medium',
      recommendedAction: classified.decision === 'blocked_noise' ? 'blocked_noise' : 'manual_review',
      confidence: 0.35,
    }
  }
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
    recommendedAction: 'manual_review',
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
  const descriptionSuggestion = descriptionSuggestionObservation(turn)
  if (descriptionSuggestion) observations.push(descriptionSuggestion)
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
      const savedObservation = await upsertObservation(observation, db)
      saved.push(savedObservation)
    } catch {
      // Observation collection must never break conversation ingestion or reads.
    }
  }
  if (!client && saved.length) {
    try {
      const policy = await getPolicy(turn.agentId)
      for (const observation of saved) {
        await autoApplyObservation(observation, policy, 'auto-learn')
      }
    } catch {
      // Auto-apply must never break conversation reads.
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
  const observationStatus = status === 'blocked' ? 'blocked' : 'promoted'
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
    SET status = $2, updated_at = now()
    WHERE id = $1
  `, [id, observationStatus])
  await syncAgentMemoryFile(observation.agentId).catch(() => {})
  return { observation: { ...observation, status: observationStatus }, memory }
}

function observationIsHighRisk(observation) {
  return observation?.risk === 'high' || observation?.type === 'blocked_fact' || observation?.recommendedAction === 'block_truth'
}

function canAutoPromoteObservation(observation, policy) {
  if (!observation || observation.status !== 'observed') return false
  if (!policy || policy.mode !== 'safe_auto') return false
  if (observationIsHighRisk(observation)) return true
  const source = observation.evidence?.source
  const isExplicitTeaching = source === 'explicit_chat_teaching' && observation.recommendedAction === 'policy_promote'
  if (!policy.allowChatTeaching || !isExplicitTeaching) return false
  const safeTypes = Array.isArray(policy.safeTypes) ? policy.safeTypes : DEFAULT_SAFE_TYPES
  if (!safeTypes.includes(observation.type)) return false
  if (observation.risk !== 'low' && observation.risk !== 'medium') return false
  const decision = observationDecision(observation)
  return decision.safeToPromote === true
}

async function autoApplyObservation(observation, policy, actor = 'auto-learn') {
  if (!canAutoPromoteObservation(observation, policy)) return { applied: false, reason: 'policy_skip' }
  if (observationIsHighRisk(observation)) {
    const result = await promoteObservation(observation.id, {
      status: 'blocked',
      type: 'blocked_fact',
      scope: observation.scope,
      content: observation.summary,
      confidence: observation.confidence,
    }, actor)
    return { applied: true, action: 'blocked', memoryId: result.memory.id }
  }
  const result = await promoteObservation(observation.id, {
    status: 'active',
    type: observation.type,
    scope: observation.scope,
    content: observation.summary,
    confidence: observation.confidence,
  }, actor)
  return { applied: true, action: 'active', memoryId: result.memory.id }
}

async function applyAutoLearnForAgent(agentId, options = {}) {
  await ensureSchema()
  const safeAgent = normalizeAgentId(agentId)
  const policy = await getPolicy(safeAgent)
  if (policy.mode !== 'safe_auto') {
    await syncAgentMemoryFile(safeAgent).catch(() => {})
    return { ok: true, agentId: safeAgent, mode: policy.mode, scanned: 0, promoted: 0, blocked: 0, skipped: 0 }
  }
  const limit = Math.min(Math.max(Number.parseInt(String(options.limit || '100'), 10) || 100, 1), 500)
  const { rows } = await pgPool.query(`
    SELECT *
    FROM memory_observations
    WHERE agent_id = $1 AND status = 'observed'
    ORDER BY updated_at ASC
    LIMIT $2
  `, [safeAgent, limit])
  let promoted = 0
  let blocked = 0
  let skipped = 0
  for (const row of rows) {
    const observation = serializeObservation(row)
    try {
      const result = await autoApplyObservation(observation, policy, options.actor || 'auto-learn')
      if (result.action === 'active') promoted += 1
      else if (result.action === 'blocked') blocked += 1
      else skipped += 1
    } catch {
      skipped += 1
    }
  }
  await syncAgentMemoryFile(safeAgent).catch(() => {})
  return { ok: true, agentId: safeAgent, mode: policy.mode, scanned: rows.length, promoted, blocked, skipped }
}

async function applyAutoLearnForAgents(agentIds = [], options = {}) {
  const ids = Array.from(new Set(agentIds.filter(Boolean).map(String)))
  const results = []
  for (const agentId of ids) {
    results.push(await applyAutoLearnForAgent(agentId, options).catch(err => ({
      ok: false,
      agentId,
      error: err.message,
    })))
  }
  return { ok: results.every(result => result.ok !== false), results }
}

async function syncAgentMemoryFile(agentId) {
  if (!pgPool) return { ok: false, skipped: 'pg_unavailable' }
  await ensureSchema()
  const safeAgent = normalizeAgentId(agentId)
  const memoryPath = memoryPathForAgent(safeAgent)
  if (!memoryPath) return { ok: false, skipped: 'workspace_missing', agentId: safeAgent }
  const policy = await getPolicy(safeAgent)
  const maxContextChars = Math.min(Math.max(Number(policy.maxContextChars) || DEFAULT_MAX_CONTEXT_CHARS, 300), 4000)
  let selection = { lines: [], chars: 0, includedMemoryIds: [], excludedMemoryIds: [] }
  if (safeMemoryFilePolicyMode(policy)) {
    const { rows } = await pgPool.query(`
      SELECT *
      FROM agent_memories
      WHERE agent_id = $1
        AND status = 'active'
        AND type <> 'blocked_fact'
      ORDER BY updated_at DESC
      LIMIT 500
    `, [safeAgent])
    selection = selectRuntimeMemoryLines(rows.map(serializeMemory), maxContextChars)
  }
  const current = readFileSafe(memoryPath)
  const next = replaceAutoMemoryBlock(current, selection.lines)
  if (next === current) {
    return { ok: true, agentId: safeAgent, memoryPath, changed: false, lines: selection.lines.length, chars: selection.chars, activeButNotInjectedCount: selection.excludedMemoryIds.length }
  }
  writeFileAtomic(memoryPath, next)
  return { ok: true, agentId: safeAgent, memoryPath, changed: true, lines: selection.lines.length, chars: selection.chars, activeButNotInjectedCount: selection.excludedMemoryIds.length }
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
  const [counts, policies, memories] = await Promise.all([
    pgPool.query(`
      SELECT agent_id,
             COUNT(*) FILTER (WHERE status = 'active')::int AS active_count,
             COUNT(*) FILTER (WHERE status = 'soft')::int AS soft_count,
             COUNT(*) FILTER (WHERE status = 'blocked')::int AS blocked_count,
             COUNT(*) FILTER (WHERE status = 'deleted')::int AS deleted_count,
             COALESCE(SUM(length(content)) FILTER (WHERE status = 'active'), 0)::int AS total_active_chars
      FROM agent_memories
      WHERE agent_id = ANY($1::text[])
      GROUP BY agent_id
    `, [ids]),
    pgPool.query('SELECT * FROM memory_policies WHERE agent_id = ANY($1::text[])', [ids]),
    pgPool.query(`
      SELECT *
      FROM agent_memories
      WHERE agent_id = ANY($1::text[])
        AND status IN ('active','soft','blocked')
      ORDER BY updated_at DESC
      LIMIT 5000
    `, [ids]),
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
      memoryHealth: {
        noiseCount: 0,
        duplicateCount: 0,
        dynamicFactCount: 0,
        vagueTeachingCount: 0,
        overBudget: false,
        injectedChars: 0,
        activeButNotInjectedCount: 0,
        totalActiveChars: 0,
      },
    }
  }
  for (const row of counts.rows) {
    byAgent[row.agent_id] = {
      ...byAgent[row.agent_id],
      activeMemoryCount: row.active_count || 0,
      softMemoryCount: row.soft_count || 0,
      blockedCount: row.blocked_count || 0,
      deletedCount: row.deleted_count || 0,
      estimatedInjectedChars: 0,
      memoryHealth: {
        ...byAgent[row.agent_id].memoryHealth,
        totalActiveChars: row.total_active_chars || 0,
      },
    }
  }
  for (const row of policies.rows) {
    byAgent[row.agent_id] = {
      ...byAgent[row.agent_id],
      autoLearnMode: row.mode || 'observe_only',
      maxContextChars: row.max_context_chars || DEFAULT_MAX_CONTEXT_CHARS,
    }
  }
  const memoriesByAgent = new Map()
  for (const row of memories.rows) {
    const memory = serializeMemory(row)
    if (!memoriesByAgent.has(memory.agentId)) memoriesByAgent.set(memory.agentId, [])
    memoriesByAgent.get(memory.agentId).push(memory)
  }
  for (const id of ids) {
    const health = summarizeMemoryHealth(memoriesByAgent.get(id) || [], byAgent[id].maxContextChars)
    byAgent[id] = {
      ...byAgent[id],
      estimatedInjectedChars: health.injectedChars,
      memoryHealth: health,
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
    decision: signal.status === 'promoted' ? 'learned' : signal.decision,
    reason: signal.status === 'promoted'
      ? 'memory นี้ถูก promote แล้ว'
      : signal.decisionReason,
    safeToPromote: signal.safeToPromote,
    blockedReason: signal.blockedReason,
  }))
  return {
    learningSignals,
    memoryUsage: usage.usage,
    memoryDecisions: decisions,
  }
}

function descriptionSuggestionAddendum(observations = []) {
  const suggestions = observations
    .filter(item => item.type === 'description_suggestion' && item.recommendedAction === 'description_suggestion')
    .slice(0, 2)
  if (!suggestions.length) return null
  const lines = suggestions.map(item => {
    const codes = Array.isArray(item.evidence?.productCodes) ? item.evidence.productCodes.slice(0, 3).join(', ') : ''
    const terms = Array.isArray(item.evidence?.suggestedTerms) ? item.evidence.suggestedTerms.slice(0, 8).join(', ') : ''
    return `- ${codes ? `รหัส ${codes}: ` : ''}${terms || item.summary}`
  })
  return [
    'คำแนะนำสำหรับ staff: ถ้าผลค้นหายังยาก ควรพิจารณาเติมคำเหล่านี้ในช่อง description ของ SML ERP',
    ...lines,
  ].join('\n')
}

async function evaluateAgentBrainTurn(input = {}, actor = null) {
  if (!isAvailable()) {
    return { ok: false, status: 'pg_unavailable', safeMessage: 'Agent Brain ต้องใช้ PostgreSQL' }
  }
  await ensureSchema()
  const agentId = normalizeAgentId(input.agentId || input.agent_id)
  const channel = input.channel ? normalizeChannel(input.channel) : null
  const accountId = String(input.accountId || input.account_id || 'default').trim() || 'default'
  const userText = redactText(input.userText || input.user_text || input.prompt || '', 1600)
  const toolEvidence = Array.isArray(input.toolEvidence || input.tool_evidence)
    ? (input.toolEvidence || input.tool_evidence)
      .map(item => redactText(item, 500))
      .filter(Boolean)
      .slice(0, 5)
    : []
  const finalText = redactText([
    input.finalText || input.final_text || '',
    ...toolEvidence,
  ].filter(Boolean).join('\n'), 1600)
  const turnId = input.turnId || input.turn_id || `agent-brain:${agentId}:${sha256(`${Date.now()}:${userText}`).slice(0, 16)}`
  const policy = await getPolicy(agentId)
  const channelPolicy = channel ? await getChannelPolicy(channel, accountId) : serializeChannelPolicy(null, { channel: null, accountId })
  const turn = {
    id: String(turnId),
    agentId,
    channel,
    userText,
    finalText,
    issues: Array.isArray(input.issues) ? input.issues : [],
    toolEvidence,
    hasMedia: input.hasMedia === true || input.has_media === true,
    mediaCount: Number(input.mediaCount || input.media_count || 0),
  }
  let learningSignals = []
  try {
    learningSignals = await syncObservationsForTurn(turn)
  } catch {
    learningSignals = []
  }

  const maxContextChars = Math.min(Math.max(Number(policy.maxContextChars) || DEFAULT_MAX_CONTEXT_CHARS, 300), 4000)
  const { rows } = await pgPool.query(`
    SELECT *
    FROM agent_memories
    WHERE agent_id = $1
      AND status = 'active'
      AND type NOT IN ('blocked_fact','description_suggestion')
    ORDER BY updated_at DESC
    LIMIT 500
  `, [agentId])
  const selection = selectRelevantRuntimeMemories(rows.map(serializeMemory), userText, maxContextChars)
  const showDescriptionSuggestions = channelPolicy.enabled !== false
    && channelPolicy.showDescriptionSuggestions === true
    && (channelPolicy.audience === 'staff' || channelPolicy.audience === 'internal')
  const assistantAddendum = showDescriptionSuggestions ? descriptionSuggestionAddendum(learningSignals) : null
  const searchHints = learningSignals
    .filter(item => item.type === 'search_hint' || item.recommendedAction === 'search_hint_candidate')
    .map(item => ({
      id: item.id,
      summary: item.summary,
      evidence: item.evidence,
      decision: item.decision,
      safeToPromote: item.safeToPromote,
    }))
  const descriptionSuggestions = learningSignals
    .filter(item => item.type === 'description_suggestion')
    .map(item => ({
      id: item.id,
      summary: item.summary,
      evidence: item.evidence,
      decision: item.decision,
      safeToPromote: item.safeToPromote,
    }))
  return {
    ok: true,
    status: 'ok',
    agentId,
    channel,
    accountId,
    policy,
    channelPolicy,
    memoriesToInject: selection.lines,
    injectedChars: selection.chars,
    includedMemoryIds: selection.includedMemoryIds,
    excludedMemoryIds: selection.excludedMemoryIds,
    learningSignals,
    searchHints,
    descriptionSuggestions,
    assistantAddendum,
    safeMessage: assistantAddendum
      ? 'Agent Brain พบคำแนะนำ description สำหรับ staff/internal channel'
      : 'Agent Brain evaluation completed',
    actor,
  }
}

module.exports = {
  ensureSchema,
  isAvailable,
  listPolicies,
  getPolicy,
  upsertPolicy,
  listChannelPolicies,
  getChannelPolicy,
  upsertChannelPolicy,
  listMemories,
  getMemory,
  createMemory,
  updateMemory,
  deleteMemory,
  blockRelearn,
  cleanupMemories,
  listObservations,
  promoteObservation,
  applyAutoLearnForAgent,
  applyAutoLearnForAgents,
  syncAgentMemoryFile,
  listUsage,
  evaluateAgentBrainTurn,
  summaryForAgents,
  syncObservationsForTurn,
  buildLearningDetail,
  observationsFromTurn,
  _internal: {
    normalizeMemoryType,
    normalizeMemoryScope,
    normalizeMemoryStatus,
    normalizePolicyMode,
    normalizeChannel,
    normalizeAudience,
    normalizedContentHash,
    replaceAutoMemoryBlock,
    canAutoPromoteObservation,
    classifyMemoryText,
    classifyMemoryForCleanup,
    selectRuntimeMemoryLines,
    selectRelevantRuntimeMemories,
    summarizeMemoryHealth,
    observationIsHighRisk,
    observationsFromTurn,
    explicitTeachingObservation,
    searchHintObservation,
    descriptionSuggestionObservation,
    extractProductCodes,
    safeTermCandidates,
    issueToObservation,
    isProhibitedMemoryTruth,
  },
}
