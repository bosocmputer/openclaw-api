const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const { pgPool } = require('./pg')
const { HOME } = require('./config')
const { readOpenclawConfig } = require('./openclaw-config')
const { redactValue: baseRedactValue } = require('./memory-learning')

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
const MEMORY_STATUSES = new Set(['active', 'soft', 'suspended', 'blocked', 'deleted'])
const POLICY_MODES = new Set(['off', 'observe_only', 'safe_auto', 'manual_review'])
const LEGACY_MEMORY_MODES = new Set(['managed_only', 'full', 'disabled'])
const OBSERVATION_STATUSES = new Set(['observed', 'promoted', 'blocked', 'ignored'])
const CHANNELS = new Set(['line', 'telegram', 'webchat'])
const CHANNEL_AUDIENCES = new Set(['customer', 'staff', 'internal'])
const DEFAULT_SAFE_TYPES = ['terminology', 'preference', 'workflow_hint', 'faq_pattern', 'entity_alias']
const DEFAULT_MAX_CONTEXT_CHARS = 1200
const AGENT_BRAIN_CONTRACT_VERSION = 2
const AGENT_BRAIN_DECISION_VERSION = 'brain-v3.0'
const MAX_AGENT_BRAIN_REQUEST_BYTES = 64 * 1024
const MAX_AGENT_BRAIN_TOOL_EVENTS = 20
const MAX_AGENT_BRAIN_MEDIA_DESCRIPTIONS = 5
const MAX_RUNTIME_MEMORY_ITEMS = 12
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
const CHANNEL_IDENTIFIER_PATTERN = /^(?:U[0-9a-f]{20,}|C[0-9a-f]{20,}|R[0-9a-f]{20,}|-?\d{8,})$/i
const DATE_LIKE_PATTERN = /^(?:\d{4}[-/.]\d{1,2}(?:[-/.]\d{1,2})?|\d{1,2}[-/.]\d{1,2}(?:[-/.]\d{2,4})?|\d{2,4}-\d{2,4})$/
const VIN_PATTERN = /^[A-HJ-NPR-Z0-9]{17}$/i
const ABSOLUTE_PATH_PATTERN = /^(?:\/(?:root|home|Users|var|tmp)\/|[A-Z]:\\)/i
const ACTIVE_MEMORY_CACHE_TTL_MS = 30 * 1000
const ACTIVE_MEMORY_CACHE_MAX_ENTRIES = 500

let schemaReady = false
const activeMemoryIndexCache = new Map()

function invalidateActiveMemoryIndex(agentId = null) {
  if (!agentId) {
    activeMemoryIndexCache.clear()
    return
  }
  const prefix = `${String(agentId)}:`
  for (const key of activeMemoryIndexCache.keys()) {
    if (key.startsWith(prefix)) activeMemoryIndexCache.delete(key)
  }
}

function envFlag(name, fallback = true) {
  const value = String(process.env[name] ?? '').trim().toLowerCase()
  if (!value) return fallback
  return !['0', 'false', 'off', 'no'].includes(value)
}

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

function stripManagedAgentBrainContext(value) {
  if (value === null || value === undefined) return ''
  return String(value)
    .replace(/\s*##\s*Agent Knowledge Brain[\s\S]*$/i, '')
    .replace(/\s*Use the following admin-approved stable hints only as extra context\.[\s\S]*$/i, '')
    .trim()
}

function normalizeLearningText(value) {
  let text = stripManagedAgentBrainContext(value)
  text = text.replace(/^```[a-z0-9_-]*\s*\n?([\s\S]*?)\n?```$/i, '$1').trim()
  text = text.replace(/^`([^`]+)`$/s, '$1').trim()
  return text
}

function normalizeUserUtterance(value) {
  let text = normalizeLearningText(value)
  text = text.replace(/^\[(?:LINE|Telegram)[^\]\n]*\]\s*(?:\([^\n]*\):)?\s*/i, '')
  const userTextMatch = text.match(/\[(?:Image|Video|Audio|Document)\]\s*\nUser text:\s*\n([\s\S]*?)(?:\nDescription:\s*\n|$)/i)
  if (userTextMatch?.[1]?.trim()) text = userTextMatch[1]
  else text = text.split(/\n?\[(?:Image|Video|Audio|Document)\]\s*\nDescription:\s*\n/i)[0]
  text = text
    .replace(/<media:[^>]+>/gi, ' ')
    .replace(/\[User sent media[^\]]*\]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text
}

function isUnsafeEntityIdentifier(value) {
  const normalized = String(value || '').trim()
  if (!normalized) return true
  return CHANNEL_IDENTIFIER_PATTERN.test(normalized)
    || DATE_LIKE_PATTERN.test(normalized)
    || VIN_PATTERN.test(normalized)
    || ABSOLUTE_PATH_PATTERN.test(normalized)
}

function normalizeSubjectHash(value) {
  const normalized = String(value || '').trim().toLowerCase()
  return /^[a-f0-9]{32,128}$/.test(normalized) ? normalized : null
}

function parseJsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value
  if (typeof value !== 'string') return null
  const text = value.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim()
  if (!text.startsWith('{') && !text.startsWith('[')) return null
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function unwrapToolResult(value) {
  const parsed = parseJsonObject(value) || value
  if (!parsed || typeof parsed !== 'object') return null
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      const candidate = unwrapToolResult(item)
      if (candidate) return candidate
    }
    return null
  }
  const record = parsed
  const schema = record.schema_version || record.schemaVersion
  if (schema) return record
  if (Array.isArray(record.content)) {
    for (const item of record.content) {
      const candidate = unwrapToolResult(item?.text ?? item)
      if (candidate) return candidate
    }
  }
  for (const key of ['result', 'output', 'data', 'payload']) {
    const candidate = unwrapToolResult(record[key])
    if (candidate) return candidate
  }
  return null
}

function normalizeEntityCode(value) {
  const code = String(value || '').trim().toUpperCase()
  if (!code || code.length > 80 || isUnsafeEntityIdentifier(code)) return null
  return /^[A-Z0-9][A-Z0-9._/-]{1,78}[A-Z0-9]$/.test(code) ? code : null
}

function adaptSearchProductV2ToolEvent(event = {}) {
  const payload = unwrapToolResult(event.result ?? event.output ?? event.outputText)
  if (!payload || payload.schema_version !== 'search_product.v2') {
    return { verified: false, schemaVersion: null, status: 'unverified', entityCodes: [] }
  }
  const status = String(payload.status || (payload.error ? 'error' : 'unknown')).trim().toLowerCase()
  const selectedCode = normalizeEntityCode(payload.selected?.code)
  const candidateCodes = Array.isArray(payload.candidates)
    ? payload.candidates.map(item => normalizeEntityCode(item?.code)).filter(Boolean).slice(0, 20)
    : []
  const query = String(payload.keyword || payload.query?.normalized || '').trim()
  return {
    verified: event.status !== 'error' && !payload.error,
    schemaVersion: 'search_product.v2',
    status,
    query: truncateText(query, 300),
    selectedCode,
    entityCodes: Array.from(new Set([selectedCode, ...candidateCodes].filter(Boolean))),
    selected: status === 'resolved' && Boolean(selectedCode),
    needsRefine: status === 'ambiguous' || status === 'needs_refine',
    notFound: status === 'not_found',
  }
}

function normalizeToolEvents(value) {
  if (!Array.isArray(value)) return []
  return value.slice(0, MAX_AGENT_BRAIN_TOOL_EVENTS).map((raw, index) => {
    const event = raw && typeof raw === 'object' ? raw : { outputText: raw }
    const adapter = adaptSearchProductV2ToolEvent(event)
    return {
      toolCallId: truncateText(event.toolCallId || event.tool_call_id || `tool-${index + 1}`, 120),
      toolName: truncateText(event.toolName || event.tool_name || 'unknown', 160),
      status: event.status === 'error' || event.error ? 'error' : 'ok',
      durationMs: Number.isFinite(Number(event.durationMs)) ? Math.max(0, Number(event.durationMs)) : null,
      schemaVersion: adapter.schemaVersion,
      verification: adapter,
      input: redactValue(event.input || event.params || {}),
      result: redactValue(event.result ?? event.output ?? event.outputText ?? null),
    }
  })
}

function redactText(text, max = 1200) {
  return truncateText(stripManagedAgentBrainContext(text)
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,}]+/ig, '$1[redacted]')
    .replace(/(api[_-]?key\s*[:=]\s*)[^\s,}]+/ig, '$1[redacted]')
    .replace(/(botToken\s*[:=]\s*)[^\s,}]+/ig, '$1[redacted]')
    .replace(/(password\s*[:=]\s*)[^\s,}]+/ig, '$1[redacted]')
    .replace(/(token\s*[:=]\s*)[^\s,}]+/ig, '$1[redacted]'), max)
}

function redactValue(value, depth = 0) {
  if (depth > 8) return '[max-depth]'
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return redactText(value, 5000)
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
  const safeValue = typeof value === 'string' ? redactText(value, 5000) : baseRedactValue(redactValue(value))
  const text = typeof safeValue === 'string' ? safeValue : JSON.stringify(safeValue || '')
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

function normalizeLegacyMemoryMode(value) {
  return normalizeEnum(value, LEGACY_MEMORY_MODES, 'managed_only', 'legacyMemoryMode')
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
  const liveStatus = memory?.status === 'active' || memory?.status === 'soft'
  const ttlValid = !memory?.ttlExpiresAt || new Date(memory.ttlExpiresAt).getTime() > Date.now()
  return liveStatus
    && ttlValid
    && memory.type !== 'blocked_fact'
    && memory.type !== 'description_suggestion'
}

function hasSystemNoiseText(text) {
  const value = String(text || '').trim()
  if (/##\s*Agent Knowledge Brain/i.test(value)) return true
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
  if (observation?.type === 'search_hint' && observation?.verificationState === 'agent_verified') {
    return {
      decision: 'promotable',
      safeToPromote: true,
      blockedReason: null,
      decisionReason: 'คำช่วยค้นได้รับหลักฐาน MCP และผ่านเกณฑ์ agent scope แล้ว',
    }
  }
  if (observation?.type === 'search_hint' && observation?.verificationState === 'contact_verified') {
    return {
      decision: 'promotable',
      safeToPromote: true,
      blockedReason: null,
      decisionReason: 'คำช่วยค้นได้รับหลักฐาน MCP และใช้ได้เฉพาะ contact นี้',
    }
  }
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
  if (action === 'contact_soft_promote') {
    return {
      decision: 'promotable',
      safeToPromote: true,
      blockedReason: null,
      decisionReason: 'คำสอนจาก customer ใช้ได้เฉพาะ contact scope และมีวันหมดอายุ',
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
  const includedMemories = []
  const excludedMemoryIds = []
  let used = 0
  for (const memory of sortRuntimeMemories(memories).filter(memoryCanBeRuntimeContext).slice(0, MAX_RUNTIME_MEMORY_ITEMS)) {
    const line = memoryRuntimeLine(memory)
    const nextUsed = used + line.length + 1
    if (nextUsed > maxContextChars) {
      excludedMemoryIds.push(memory.id)
      continue
    }
    lines.push(line)
    includedMemoryIds.push(memory.id)
    includedMemories.push({ ...memory, _injectedChars: line.length })
    used = nextUsed
  }
  return { lines, chars: lines.join('\n').length, includedMemoryIds, excludedMemoryIds, includedMemories }
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
  return (policy?.mode === 'safe_auto' || policy?.mode === 'manual_review') && policy?.legacyMemoryMode !== 'disabled'
}

function legacyMemoryBaseContent(currentContent, policy) {
  if (policy?.legacyMemoryMode === 'managed_only') return '# Long-Term Memory'
  return currentContent
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
      legacy_memory_mode TEXT NOT NULL DEFAULT 'managed_only',
      allow_chat_teaching BOOLEAN NOT NULL DEFAULT false,
      retention_days INTEGER,
      updated_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
  await pgPool.query(`
    ALTER TABLE memory_policies
    ADD COLUMN IF NOT EXISTS legacy_memory_mode TEXT NOT NULL DEFAULT 'managed_only'
  `)
  await pgPool.query(`
    ALTER TABLE memory_policies
    ADD COLUMN IF NOT EXISTS policy_revision INTEGER NOT NULL DEFAULT 1
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
    ALTER TABLE agent_memories
      ADD COLUMN IF NOT EXISTS subject_hash TEXT,
      ADD COLUMN IF NOT EXISTS verification_state TEXT NOT NULL DEFAULT 'legacy',
      ADD COLUMN IF NOT EXISTS decision_version TEXT NOT NULL DEFAULT 'legacy',
      ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ
  `)
  await pgPool.query(`
    ALTER TABLE memory_observations
      ADD COLUMN IF NOT EXISTS contract_version INTEGER NOT NULL DEFAULT 1,
      ADD COLUMN IF NOT EXISTS decision_version TEXT NOT NULL DEFAULT 'legacy',
      ADD COLUMN IF NOT EXISTS verification_state TEXT NOT NULL DEFAULT 'unverified',
      ADD COLUMN IF NOT EXISTS verification_count INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS independent_subject_count INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS source_authority TEXT NOT NULL DEFAULT 'observation',
      ADD COLUMN IF NOT EXISTS subject_hash TEXT
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
    ALTER TABLE memory_usage_events
    ADD COLUMN IF NOT EXISTS lookup_id TEXT
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
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS brain_evidence_events (
      id BIGSERIAL PRIMARY KEY,
      agent_id TEXT NOT NULL,
      observation_id UUID REFERENCES memory_observations(id) ON DELETE SET NULL,
      turn_id TEXT,
      lookup_id TEXT,
      subject_hash TEXT,
      evidence_hash TEXT NOT NULL,
      source_authority TEXT NOT NULL DEFAULT 'runtime',
      contract_version INTEGER NOT NULL DEFAULT ${AGENT_BRAIN_CONTRACT_VERSION},
      schema_version TEXT,
      event_type TEXT NOT NULL,
      verification_state TEXT NOT NULL DEFAULT 'unverified',
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(agent_id, evidence_hash)
    )
  `)
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS brain_decision_events (
      id BIGSERIAL PRIMARY KEY,
      agent_id TEXT NOT NULL,
      observation_id UUID REFERENCES memory_observations(id) ON DELETE SET NULL,
      memory_id UUID REFERENCES agent_memories(id) ON DELETE SET NULL,
      turn_id TEXT,
      action TEXT NOT NULL,
      reason TEXT,
      decision_version TEXT NOT NULL DEFAULT '${AGENT_BRAIN_DECISION_VERSION}',
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_agent_memories_agent_status ON agent_memories(agent_id, status, updated_at DESC)')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_agent_memories_subject_scope ON agent_memories(agent_id, subject_hash, scope, status, updated_at DESC)')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_agent_memories_type_scope ON agent_memories(type, scope, updated_at DESC)')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_memory_observations_agent_status ON memory_observations(agent_id, status, updated_at DESC)')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_memory_observations_source_turn ON memory_observations(source_turn_id)')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_memory_observations_verification ON memory_observations(agent_id, verification_state, updated_at DESC)')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_memory_usage_turn ON memory_usage_events(turn_id)')
  await pgPool.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_usage_lookup_memory ON memory_usage_events(lookup_id, memory_id) WHERE lookup_id IS NOT NULL AND memory_id IS NOT NULL')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_memory_tombstones_agent_hash ON memory_tombstones(agent_id, content_hash)')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_agent_brain_channel_policy_channel ON agent_brain_channel_policies(channel, audience)')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_brain_evidence_observation ON brain_evidence_events(observation_id, created_at DESC)')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_brain_evidence_subject ON brain_evidence_events(agent_id, subject_hash, created_at DESC)')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_brain_decision_agent ON brain_decision_events(agent_id, created_at DESC)')
  schemaReady = true
}

function serializePolicy(row) {
  if (!row) return null
  return {
    agentId: row.agent_id,
    mode: row.mode,
    maxContextChars: row.max_context_chars,
    safeTypes: row.safe_types || DEFAULT_SAFE_TYPES,
    legacyMemoryMode: row.legacy_memory_mode || 'managed_only',
    allowChatTeaching: row.allow_chat_teaching === true,
    retentionDays: row.retention_days === null || row.retention_days === undefined ? null : Number(row.retention_days),
    policyRevision: Number(row.policy_revision || 1),
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
    content: redactText(row.content, 1500),
    sourceAuthority: row.source_authority,
    subjectHash: row.subject_hash || null,
    verificationState: row.verification_state || 'legacy',
    decisionVersion: row.decision_version || 'legacy',
    confidence: row.confidence === null || row.confidence === undefined ? null : Number(row.confidence),
    evidence: redactValue(row.evidence || {}),
    sourceTurnIds: row.source_turn_ids || [],
    ttlExpiresAt: row.ttl_expires_at || null,
    lastUsedAt: row.last_used_at || null,
    usageCount: row.usage_count || 0,
    createdBy: row.created_by || null,
    updatedBy: row.updated_by || null,
    deletedAt: row.deleted_at || null,
    suspendedAt: row.suspended_at || null,
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
    summary: redactText(row.summary, 1000),
    evidence: redactValue(row.evidence || {}),
    sourceTurnId: row.source_turn_id || null,
    risk: row.risk,
    recommendedAction: row.recommended_action,
    status: row.status,
    confidence: row.confidence === null || row.confidence === undefined ? null : Number(row.confidence),
    contractVersion: Number(row.contract_version || 1),
    decisionVersion: row.decision_version || 'legacy',
    verificationState: row.verification_state || 'unverified',
    verificationCount: Number(row.verification_count || 0),
    independentSubjectCount: Number(row.independent_subject_count || 0),
    sourceAuthority: row.source_authority || 'observation',
    subjectHash: row.subject_hash || null,
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
    lookupId: row.lookup_id || null,
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
    legacyMemoryMode: 'managed_only',
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
  const maxContextChars = Math.min(Math.max(Number.parseInt(String(body.maxContextChars ?? body.max_context_chars ?? DEFAULT_MAX_CONTEXT_CHARS), 10) || DEFAULT_MAX_CONTEXT_CHARS, 300), 1500)
  const legacyMemoryMode = normalizeLegacyMemoryMode(body.legacyMemoryMode || body.legacy_memory_mode || 'managed_only')
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
      , legacy_memory_mode
    ) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,now(),$8)
    ON CONFLICT (agent_id) DO UPDATE SET
      mode = EXCLUDED.mode,
      max_context_chars = EXCLUDED.max_context_chars,
      safe_types = EXCLUDED.safe_types,
      allow_chat_teaching = EXCLUDED.allow_chat_teaching,
      retention_days = EXCLUDED.retention_days,
      legacy_memory_mode = EXCLUDED.legacy_memory_mode,
      updated_by = EXCLUDED.updated_by,
      policy_revision = memory_policies.policy_revision + 1,
      updated_at = now()
    RETURNING *
  `, [safeAgent, mode, maxContextChars, JSON.stringify(safeTypes), allowChatTeaching, retentionDays, actor, legacyMemoryMode])
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

async function createMemory(input = {}, actor = null, client = pgPool) {
  await ensureSchema()
  const db = client || pgPool
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
  const subjectHash = normalizeSubjectHash(input.subjectHash || input.subject_hash)
  const verificationState = redactText(input.verificationState || input.verification_state || (sourceAuthority === 'admin_config' ? 'admin_verified' : 'unverified'), 40).trim()
  const decisionVersion = redactText(input.decisionVersion || input.decision_version || AGENT_BRAIN_DECISION_VERSION, 60).trim()
  const contentHash = normalizedContentHash(content)
  const blocked = await db.query(`
    SELECT 1 FROM memory_tombstones
    WHERE agent_id = $1 AND content_hash = $2 AND (expires_at IS NULL OR expires_at > now())
    LIMIT 1
  `, [agentId, contentHash])
  if (blocked.rows[0] && status !== 'blocked') {
    throw Object.assign(new Error('This memory matches a deleted/blocked memory tombstone'), { status: 409 })
  }
  if (status !== 'deleted') {
    const existing = await db.query(`
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
        const { rows: updatedRows } = await db.query(`
          UPDATE agent_memories
          SET status = 'blocked',
              type = 'blocked_fact',
              updated_by = $2,
              updated_at = now()
          WHERE id = $1
          RETURNING *
        `, [existing.rows[0].id, actor])
        if (db === pgPool) await syncAgentMemoryFile(agentId).catch(() => {})
        return serializeMemory(updatedRows[0])
      }
      if (status === 'active' && existing.rows[0].status === 'soft') {
        const { rows: updatedRows } = await db.query(`
          UPDATE agent_memories
          SET status = 'active',
              scope = $2,
              subject_hash = NULL,
              ttl_expires_at = NULL,
              verification_state = $3,
              decision_version = $4,
              updated_by = $5,
              updated_at = now()
          WHERE id = $1
          RETURNING *
        `, [existing.rows[0].id, scope, verificationState, decisionVersion, actor])
        if (db === pgPool) await syncAgentMemoryFile(agentId).catch(() => {})
        return serializeMemory(updatedRows[0])
      }
      return serializeMemory(existing.rows[0])
    }
  }
  const { rows } = await db.query(`
    INSERT INTO agent_memories (
      agent_id, status, type, scope, content, content_hash, source_authority,
      confidence, evidence, source_turn_ids, ttl_expires_at, created_by, updated_by,
      subject_hash, verification_state, decision_version
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$12,$13,$14,$15)
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
    subjectHash,
    verificationState,
    decisionVersion,
  ])
  const memory = serializeMemory(rows[0])
  if (db === pgPool) await syncAgentMemoryFile(agentId).catch(() => {})
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
  const subjectHash = input.subjectHash === undefined && input.subject_hash === undefined
    ? current.subjectHash
    : normalizeSubjectHash(input.subjectHash || input.subject_hash)
  const verificationState = redactText(input.verificationState || input.verification_state || current.verificationState || 'legacy', 40).trim()
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
        subject_hash = $9,
        verification_state = $10,
        decision_version = $11,
        updated_by = $12,
        updated_at = now(),
        deleted_at = CASE WHEN $4 = 'deleted' THEN COALESCE(deleted_at, now()) ELSE deleted_at END,
        suspended_at = CASE WHEN $4 = 'suspended' THEN COALESCE(suspended_at, now()) WHEN $4 = 'active' THEN NULL ELSE suspended_at END
    WHERE id = $1
    RETURNING *
  `, [id, type, scope, status, content, contentHash, safeConfidence, JSON.stringify(evidence), subjectHash, verificationState, AGENT_BRAIN_DECISION_VERSION, actor])
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
  await recordDecisionEvent({
    agentId: current.agentId,
    memoryId: id,
    action: 'deleted',
    reason: options.reason || 'Deleted by admin',
    metadata: { blockRelearn: shouldBlockRelearn },
    actor,
  })
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
  await recordDecisionEvent({
    agentId: memory.agentId,
    memoryId: id,
    action: 'blocked',
    reason: body.reason || 'Blocked by admin',
    actor,
  })
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

function legacyMemoryAnalysis(agentId) {
  const memoryPath = memoryPathForAgent(agentId)
  const current = readFileSafe(memoryPath)
  const parsed = extractMarkedBlock(current, AUTO_MEMORY_START, AUTO_MEMORY_END)
  const unmanaged = [parsed.before || '', parsed.after || ''].join('\n').replace(/^#\s*Long-Term Memory\s*/i, '').trim()
  const unmanagedChars = unmanaged.length
  const sizeChars = current.length
  const action = unmanagedChars > 0 || sizeChars > 18_000
    ? {
        memoryId: `legacy:${agentId}:MEMORY.md`,
        agentId,
        status: 'legacy',
        type: 'legacy_memory',
        action: 'rewrite_legacy_managed_only',
        reason: sizeChars > 18_000 ? 'legacy_memory_over_budget' : 'legacy_unmanaged_content',
        categories: ['legacy_memory'],
        tombstone: false,
        contentPreview: unmanaged.slice(0, 240),
        sizeChars,
        unmanagedChars,
      }
    : null
  return {
    memoryPath,
    exists: Boolean(memoryPath && fs.existsSync(memoryPath)),
    sizeChars,
    unmanagedChars,
    managedBlockExists: parsed.exists,
    action,
  }
}

async function cleanupLegacyMemory(safeAgent, options = {}, actor = null) {
  await ensureSchema()
  const dryRun = options.dryRun !== false && options.dry_run !== false && options.apply !== true
  const analysis = legacyMemoryAnalysis(safeAgent)
  const actions = analysis.action ? [analysis.action] : []
  const result = {
    ok: true,
    dryRun,
    agentId: safeAgent,
    mode: 'legacy',
    summary: {
      scanned: analysis.exists ? 1 : 0,
      keep: actions.length ? 0 : 1,
      delete: 0,
      block: 0,
      soften: 0,
      deleteDuplicate: 0,
      duplicateCount: 0,
      noiseCount: 0,
      dynamicFactCount: 0,
      vagueTeachingCount: 0,
      tombstoneCount: 0,
      legacyRewriteCount: actions.length,
      legacySizeChars: analysis.sizeChars,
      legacyUnmanagedChars: analysis.unmanagedChars,
    },
    examples: {
      legacy_memory: actions.map(action => ({
        memoryId: action.memoryId,
        action: action.action,
        reason: action.reason,
        contentPreview: action.contentPreview,
      })),
    },
    actions,
  }
  if (dryRun || actions.length === 0) return result

  const backup = backupMemoryFile(safeAgent, 'legacy-cleanup')
  await upsertPolicy(safeAgent, {
    ...(await getPolicy(safeAgent)),
    legacyMemoryMode: 'managed_only',
  }, actor)
  const syncResult = await syncAgentMemoryFile(safeAgent).catch(err => ({ ok: false, error: err.message }))
  return {
    ...result,
    dryRun: false,
    backup: safeBackupInfo(backup),
    applied: actions.map(action => ({ ...action, nextStatus: 'managed_only' })),
    errors: syncResult.ok === false ? [{ memoryId: actions[0].memoryId, action: actions[0].action, error: syncResult.error || 'sync failed' }] : [],
    syncResult,
    ok: syncResult.ok !== false,
  }
}

async function cleanupMemories(agentId, options = {}, actor = null) {
  await ensureSchema()
  const safeAgent = normalizeAgentId(agentId || options.agentId || options.agent_id)
  const mode = String(options.mode || 'structured').trim().toLowerCase()
  if (mode === 'legacy') return cleanupLegacyMemory(safeAgent, options, actor)
  if (mode === 'all') {
    const structured = await cleanupMemories(safeAgent, { ...options, mode: 'structured' }, actor)
    const legacy = await cleanupLegacyMemory(safeAgent, options, actor)
    const structuredSummary = structured.summary || {}
    const legacySummary = legacy.summary || {}
    return {
      ...structured,
      mode: 'all',
      ok: structured.ok !== false && legacy.ok !== false,
      summary: {
        ...structuredSummary,
        scanned: (structuredSummary.scanned || 0) + (legacySummary.scanned || 0),
        keep: (structuredSummary.keep || 0) + (legacySummary.keep || 0),
        legacyRewriteCount: legacySummary.legacyRewriteCount || 0,
        legacySizeChars: legacySummary.legacySizeChars || 0,
        legacyUnmanagedChars: legacySummary.legacyUnmanagedChars || 0,
      },
      actions: [...(structured.actions || []), ...(legacy.actions || [])],
      applied: [...(structured.applied || []), ...(legacy.applied || [])],
      errors: [...(structured.errors || []), ...(legacy.errors || [])],
      examples: { ...(structured.examples || {}), ...(legacy.examples || {}) },
      legacy,
    }
  }
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
  if (filters.sourceFrom) {
    params.push(new Date(filters.sourceFrom))
    where.push(`EXISTS (
      SELECT 1 FROM conversation_turns ct
      WHERE ct.turn_id = memory_observations.source_turn_id
        AND ct.started_at >= $${params.length}
    )`)
  }
  if (filters.sourceTo) {
    params.push(new Date(filters.sourceTo))
    where.push(`EXISTS (
      SELECT 1 FROM conversation_turns ct
      WHERE ct.turn_id = memory_observations.source_turn_id
        AND ct.started_at <= $${params.length}
    )`)
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
  const contractVersion = Math.max(1, Number.parseInt(String(input.contractVersion || input.contract_version || 1), 10) || 1)
  const decisionVersion = redactText(input.decisionVersion || input.decision_version || (contractVersion >= 2 ? AGENT_BRAIN_DECISION_VERSION : 'legacy'), 60).trim()
  const verificationState = redactText(input.verificationState || input.verification_state || 'unverified', 40).trim()
  const verificationCount = Math.max(0, Number.parseInt(String(input.verificationCount || input.verification_count || 0), 10) || 0)
  const independentSubjectCount = Math.max(0, Number.parseInt(String(input.independentSubjectCount || input.independent_subject_count || 0), 10) || 0)
  const sourceAuthority = redactText(input.sourceAuthority || input.source_authority || evidence.sourceAuthority || 'observation', 80).trim()
  const subjectHash = normalizeSubjectHash(input.subjectHash || input.subject_hash || evidence.subjectHash)
  const { rows } = await client.query(`
    INSERT INTO memory_observations (
      agent_id, type, scope, summary, evidence, source_turn_id, source_hash,
      risk, recommended_action, confidence, contract_version, decision_version,
      verification_state, verification_count, independent_subject_count,
      source_authority, subject_hash, updated_at
    ) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,now())
    ON CONFLICT (agent_id, source_hash) DO UPDATE SET
      summary = EXCLUDED.summary,
      evidence = EXCLUDED.evidence,
      risk = EXCLUDED.risk,
      recommended_action = EXCLUDED.recommended_action,
      confidence = EXCLUDED.confidence,
      contract_version = GREATEST(memory_observations.contract_version, EXCLUDED.contract_version),
      decision_version = EXCLUDED.decision_version,
      verification_state = EXCLUDED.verification_state,
      verification_count = GREATEST(memory_observations.verification_count, EXCLUDED.verification_count),
      independent_subject_count = GREATEST(memory_observations.independent_subject_count, EXCLUDED.independent_subject_count),
      source_authority = EXCLUDED.source_authority,
      subject_hash = COALESCE(EXCLUDED.subject_hash, memory_observations.subject_hash),
      updated_at = now()
    RETURNING *
  `, [
    agentId, type, scope, summary, JSON.stringify(evidence), sourceTurnId, sourceHash,
    risk, recommendedAction, safeConfidence, contractVersion, decisionVersion,
    verificationState, verificationCount, independentSubjectCount, sourceAuthority, subjectHash,
  ])
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
    summary: `${issue.label || tag}: ${truncateText(normalizeLearningText(issue.evidence?.userPreview || turn.userText || tag), 220)}`,
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
  const text = normalizeLearningText(turn.userText).trim()
  if (!/(จำไว้|ช่วยจำ|remember this|note this|keep in mind)/i.test(text)) return null
  return text.replace(/^(จำไว้ว่า?|ช่วยจำว่า?|remember this:?|note this:?|keep in mind:?)/i, '').trim() || text
}

function isProhibitedMemoryTruth(text) {
  return /(ราคา|ราคาพิเศษ|ต้นทุน|ทุนสินค้า|สต็อก|stock|คงเหลือ|มีสินค้า|ไม่มีสินค้า|สินค้าทดแทน|แทนได้|เครดิต|ยอดค้าง|availability|available|price|cost|special price|inventory|substitute)/i.test(String(text || ''))
}

function extractProductCodes(text) {
  return Array.from(new Set(String(text || '').match(PRODUCT_CODE_PATTERN) || []))
    .map(code => code.toUpperCase())
    .filter(code => code.length >= 4 && !isUnsafeEntityIdentifier(code))
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
  const stripped = redactText(normalizeUserUtterance(text), 900)
    .replace(new RegExp(DYNAMIC_FACT_PATTERN.source, 'gi'), ' ')
    .replace(PRODUCT_CODE_PATTERN, ' ')
  const tokens = stripped.match(THAI_TOKEN_PATTERN) || []
  const stop = new Set(['ครับ', 'ค่ะ', 'คะ', 'จำไว้', 'ช่วยจำ', 'ราคา', 'สต็อก', 'stock', 'cost', 'price', 'มีสินค้า', 'ไม่มีสินค้า'])
  const result = []
  for (const token of tokens) {
    const value = token.trim()
    if (value.length < 2 || stop.has(value.toLowerCase())) continue
    if (/^\d+$/.test(value)) continue
    if (isUnsafeEntityIdentifier(value)) continue
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
    scope: turn.sourceAuthority === 'customer' ? 'contact' : 'agent',
    summary: truncateText(taught, 800),
    evidence: {
      source: 'explicit_search_hint_teaching',
      turnId: turn.id,
      channel: turn.channel,
      userPreview: truncateText(normalizeLearningText(turn.userText || taught), 400),
      productCodes: codes,
      terms,
      subjectHash: turn.subjectHash || null,
      sourceAuthority: turn.sourceAuthority || 'customer',
    },
    sourceTurnId: turn.id,
    risk: 'medium',
    recommendedAction: 'search_hint_candidate',
    confidence: codes.length ? 0.7 : 0.55,
    sourceHash: sha256(stableStringify({
      agentId: turn.agentId || 'unknown',
      type: 'search_hint',
      taught: normalizeUserUtterance(taught).toLowerCase(),
      codes,
    })),
    contractVersion: turn.contractVersion || 1,
    decisionVersion: turn.decisionVersion || AGENT_BRAIN_DECISION_VERSION,
    verificationState: 'candidate',
    sourceAuthority: turn.sourceAuthority || 'customer',
    subjectHash: turn.subjectHash || null,
  }
}

function descriptionSuggestionObservation(turn) {
  const userText = normalizeUserUtterance(turn.userUtterance || turn.userText)
  const toolEvents = normalizeToolEvents(turn.toolEvents || [])
  const searchEvidence = toolEvents.map(event => event.verification).filter(item => item.schemaVersion === 'search_product.v2')
  const resolved = [...searchEvidence].reverse().find(item => item.verified && item.selected && item.selectedCode)
  const hadSearchFailure = searchEvidence.some(item => item.notFound || item.needsRefine)
    || turn.previousSearchFailure === true
  const terms = safeTermCandidates(userText, 10)
  if (!resolved || !hadSearchFailure || terms.length < 2) return null
  const code = resolved.selectedCode
  const summary = `ควรพิจารณาเติม description สำหรับรหัส ${code} ด้วยคำค้น: ${terms.slice(0, 8).join(', ')}`
  return {
    agentId: turn.agentId || 'unknown',
    type: 'description_suggestion',
    scope: 'agent',
    summary,
    evidence: {
      source: 'conversation_description_suggestion',
      turnId: turn.id,
      channel: turn.channel,
      productCodes: [code],
      suggestedTerms: terms.slice(0, 10),
      userPreview: truncateText(userText, 360),
      schemaVersion: resolved.schemaVersion,
      searchStatus: resolved.status,
      rule: 'verified_failed_query_then_selected_entity',
    },
    sourceTurnId: turn.id,
    risk: 'low',
    recommendedAction: 'description_suggestion',
    confidence: 0.6,
  }
}

function explicitTeachingObservation(turn) {
  const text = normalizeLearningText(turn.userText).trim()
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
  const customerScoped = turn.sourceAuthority === 'customer'
  return {
    agentId: turn.agentId || 'unknown',
    type: customerScoped ? 'preference' : 'staff_instruction',
    scope: customerScoped ? 'contact' : 'agent',
    summary: truncateText(taught, 800),
    evidence: {
      source: 'explicit_chat_teaching',
      turnId: turn.id,
      channel: turn.channel,
      userPreview: truncateText(text, 400),
      subjectHash: turn.subjectHash || null,
      sourceAuthority: turn.sourceAuthority || 'customer',
    },
    sourceTurnId: turn.id,
    risk: 'medium',
    recommendedAction: customerScoped ? 'contact_soft_promote' : 'policy_promote',
    confidence: customerScoped ? 0.65 : 0.8,
    contractVersion: turn.contractVersion || 1,
    decisionVersion: turn.decisionVersion || AGENT_BRAIN_DECISION_VERSION,
    verificationState: customerScoped ? 'contact_verified' : 'authority_verified',
    verificationCount: 1,
    independentSubjectCount: turn.subjectHash ? 1 : 0,
    sourceAuthority: turn.sourceAuthority || 'customer',
    subjectHash: turn.subjectHash || null,
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
      userPreview: truncateText(stripManagedAgentBrainContext(turn.userText), 300),
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
  const descriptionSuggestion = descriptionSuggestionObservation(turn)
  if (descriptionSuggestion) observations.push(descriptionSuggestion)
  for (const issue of Array.isArray(turn.issues) ? turn.issues : []) {
    const observation = issueToObservation(turn, issue)
    if (explicit?.type === 'blocked_fact' && observation.type === 'blocked_fact') continue
    observations.push(observation)
  }
  return observations.map(observation => ({
    ...observation,
    contractVersion: observation.contractVersion || turn.contractVersion || 1,
    decisionVersion: observation.decisionVersion || turn.decisionVersion || (turn.contractVersion >= 2 ? AGENT_BRAIN_DECISION_VERSION : 'legacy'),
    sourceAuthority: observation.sourceAuthority || turn.sourceAuthority || 'observation',
    subjectHash: observation.subjectHash || turn.subjectHash || null,
  }))
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

async function recordDecisionEvent(input = {}, client = pgPool) {
  const db = client || pgPool
  const metadata = redactValue(input.metadata || {})
  const { rows } = await db.query(`
    INSERT INTO brain_decision_events (
      agent_id, observation_id, memory_id, turn_id, action, reason,
      decision_version, metadata, created_by
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
    RETURNING *
  `, [
    normalizeAgentId(input.agentId),
    input.observationId || null,
    input.memoryId || null,
    input.turnId || null,
    redactText(input.action || 'observed', 80),
    redactText(input.reason || '', 500),
    AGENT_BRAIN_DECISION_VERSION,
    JSON.stringify(metadata),
    input.actor || null,
  ])
  return rows[0]
}

async function promoteObservation(id, input = {}, actor = null) {
  await ensureSchema()
  const client = await pgPool.connect()
  let observation
  let memory
  let observationStatus
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`agent-brain-observation:${id}`])
    const { rows } = await client.query('SELECT * FROM memory_observations WHERE id = $1 FOR UPDATE', [id])
    observation = serializeObservation(rows[0])
    if (!observation) throw Object.assign(new Error('Observation not found'), { status: 404 })
    const status = normalizeMemoryStatus(input.status || (observation.risk === 'high' ? 'blocked' : 'soft'))
    observationStatus = status === 'blocked' ? 'blocked' : 'promoted'
    memory = await createMemory({
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
      sourceAuthority: observation.sourceAuthority || 'observation_promoted',
      confidence: input.confidence ?? observation.confidence,
      subjectHash: input.subjectHash ?? observation.subjectHash,
      verificationState: input.verificationState || observation.verificationState,
      decisionVersion: AGENT_BRAIN_DECISION_VERSION,
      ttlExpiresAt: input.ttlExpiresAt || null,
    }, actor, client)
    await client.query(`
      UPDATE memory_observations
      SET status = $2, updated_at = now()
      WHERE id = $1
    `, [id, observationStatus])
    await recordDecisionEvent({
      agentId: observation.agentId,
      observationId: observation.id,
      memoryId: memory.id,
      turnId: observation.sourceTurnId,
      action: status,
      reason: input.reason || observation.decisionReason,
      metadata: { verificationState: input.verificationState || observation.verificationState },
      actor,
    }, client)
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
  await syncAgentMemoryFile(observation.agentId).catch(() => {})
  return { observation: { ...observation, status: observationStatus }, memory }
}

function observationIsHighRisk(observation) {
  return observation?.risk === 'high' || observation?.type === 'blocked_fact' || observation?.recommendedAction === 'block_truth'
}

function canAutoPromoteObservation(observation, policy) {
  if (!observation || observation.status !== 'observed') return false
  if (!policy || policy.mode !== 'safe_auto') return false
  if (!envFlag('AGENT_BRAIN_AUTO_PROMOTE_ENABLED', false)) return false
  if (observationIsHighRisk(observation)) return true
  if (observation.recommendedAction === 'contact_soft_promote') {
    return policy.allowChatTeaching === true
      && observation.scope === 'contact'
      && Boolean(observation.subjectHash)
      && observation.safeToPromote === true
  }
  if (observation.type === 'search_hint') {
    if (observation.verificationState === 'agent_verified') return true
    return observation.verificationState === 'contact_verified'
      && observation.scope === 'contact'
      && Boolean(observation.subjectHash)
  }
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
  const contactScoped = observation.scope === 'contact'
    || observation.recommendedAction === 'contact_soft_promote'
    || observation.verificationState === 'contact_verified'
  const result = await promoteObservation(observation.id, {
    status: contactScoped ? 'soft' : 'active',
    type: observation.type,
    scope: observation.scope,
    content: observation.summary,
    confidence: observation.confidence,
    subjectHash: contactScoped ? observation.subjectHash : null,
    verificationState: observation.verificationState,
    ttlExpiresAt: contactScoped ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() : null,
  }, actor)
  return { applied: true, action: contactScoped ? 'soft' : 'active', memoryId: result.memory.id }
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
      if (result.action === 'active' || result.action === 'soft') promoted += 1
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
  invalidateActiveMemoryIndex(safeAgent)
  const memoryPath = memoryPathForAgent(safeAgent)
  if (!memoryPath) return { ok: false, skipped: 'workspace_missing', agentId: safeAgent }
  const policy = await getPolicy(safeAgent)
  const maxContextChars = Math.min(Math.max(Number(policy.maxContextChars) || DEFAULT_MAX_CONTEXT_CHARS, 300), 1500)
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
  const next = policy.legacyMemoryMode === 'disabled'
    ? current
    : replaceAutoMemoryBlock(legacyMemoryBaseContent(current, policy), selection.lines)
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

async function recordRuntimeMemoryUsage({ lookupId, turnId, agentId, memories, injectedChars, policyRevision }) {
  if (!lookupId || !Array.isArray(memories) || memories.length === 0) return []
  const rows = []
  for (const memory of memories.slice(0, MAX_RUNTIME_MEMORY_ITEMS)) {
    const { rows: inserted } = await pgPool.query(`
      INSERT INTO memory_usage_events (
        lookup_id, turn_id, memory_id, agent_id, injected_chars,
        relevance_score, outcome, metadata
      ) VALUES ($1,$2,$3,$4,$5,$6,'context_injected',$7::jsonb)
      ON CONFLICT (lookup_id, memory_id) WHERE lookup_id IS NOT NULL AND memory_id IS NOT NULL
      DO UPDATE SET
        turn_id = EXCLUDED.turn_id,
        injected_chars = EXCLUDED.injected_chars,
        relevance_score = EXCLUDED.relevance_score,
        metadata = EXCLUDED.metadata
      RETURNING *, (xmax = 0) AS was_inserted
    `, [
      lookupId,
      turnId || null,
      memory.id,
      agentId,
      Math.max(0, Number(memory._injectedChars ?? injectedChars ?? 0)),
      Number(memory._relevanceScore || 0),
      JSON.stringify({ contractVersion: AGENT_BRAIN_CONTRACT_VERSION, policyRevision: Number(policyRevision || 1) }),
    ])
    if (inserted[0]?.was_inserted) {
      await pgPool.query(`
        UPDATE agent_memories
        SET usage_count = usage_count + 1, last_used_at = now()
        WHERE id = $1
      `, [memory.id])
    }
    if (inserted[0]) rows.push(serializeUsage(inserted[0]))
  }
  return rows
}

async function completeRuntimeMemoryUsage(lookupId, outcome = 'turn_completed', metadata = {}) {
  if (!lookupId) return 0
  const result = await pgPool.query(`
    UPDATE memory_usage_events
    SET outcome = $2,
        metadata = metadata || $3::jsonb
    WHERE lookup_id = $1
  `, [lookupId, redactText(outcome, 80), JSON.stringify(redactValue(metadata))])
  return result.rowCount || 0
}

function observationTerms(observation) {
  const terms = observation?.evidence?.terms
  return Array.isArray(terms)
    ? terms.map(term => String(term).trim().toLowerCase()).filter(term => term.length >= 2).slice(0, 20)
    : []
}

function verificationMatchesObservation(verification, observation, userUtterance = '') {
  const codes = Array.isArray(observation?.evidence?.productCodes)
    ? observation.evidence.productCodes.map(normalizeEntityCode).filter(Boolean)
    : []
  if (!verification?.verified || !verification.selectedCode || !codes.includes(verification.selectedCode)) return false
  if (observation.sourceAuthority === 'staff' || observation.sourceAuthority === 'internal') return true
  const queryTerms = safeTermCandidates(`${verification.query || ''} ${userUtterance}`, 20).map(term => term.toLowerCase())
  return observationTerms(observation).some(term => queryTerms.includes(term))
}

async function insertEvidenceEvent(input, client = pgPool) {
  const payload = redactValue(input.payload || {})
  const evidenceHash = input.evidenceHash || sha256(stableStringify({
    agentId: input.agentId,
    observationId: input.observationId || null,
    turnId: input.turnId || null,
    subjectHash: input.subjectHash || null,
    eventType: input.eventType,
    payload,
  }))
  const { rows } = await client.query(`
    INSERT INTO brain_evidence_events (
      agent_id, observation_id, turn_id, lookup_id, subject_hash,
      evidence_hash, source_authority, contract_version, schema_version,
      event_type, verification_state, payload
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
    ON CONFLICT (agent_id, evidence_hash) DO NOTHING
    RETURNING *
  `, [
    input.agentId,
    input.observationId || null,
    input.turnId || null,
    input.lookupId || null,
    input.subjectHash || null,
    evidenceHash,
    input.sourceAuthority || 'runtime',
    AGENT_BRAIN_CONTRACT_VERSION,
    input.schemaVersion || null,
    input.eventType || 'tool_result',
    input.verificationState || 'unverified',
    JSON.stringify(payload),
  ])
  return rows[0] || null
}

async function verifySearchHintObservations(params) {
  const verifiedSelections = params.toolEvents
    .map(event => event.verification)
    .filter(item => item.verified && item.selected && item.selectedCode)
  if (!verifiedSelections.length) return []
  const policy = await getPolicy(params.agentId)
  const results = []
  for (const verification of verifiedSelections) {
    const { rows } = await pgPool.query(`
      SELECT *
      FROM memory_observations
      WHERE agent_id = $1
        AND type = 'search_hint'
        AND status IN ('observed','promoted')
        AND created_at >= now() - interval '30 days'
        AND evidence @> $2::jsonb
      ORDER BY updated_at DESC
      LIMIT 50
    `, [params.agentId, JSON.stringify({ productCodes: [verification.selectedCode] })])
    for (const row of rows) {
      let observation = serializeObservation(row)
      if (!verificationMatchesObservation(verification, observation, params.userUtterance)) continue
      await insertEvidenceEvent({
        agentId: params.agentId,
        observationId: observation.id,
        turnId: params.turnId,
        lookupId: params.lookupId,
        subjectHash: params.subjectHash,
        sourceAuthority: params.sourceAuthority,
        schemaVersion: verification.schemaVersion,
        eventType: 'search_mapping_verified',
        verificationState: 'verified',
        payload: {
          selectedCode: verification.selectedCode,
          query: verification.query,
          status: verification.status,
          sessionHash: params.sessionHash || null,
        },
      })
      const counts = await pgPool.query(`
        SELECT COUNT(*)::int AS verification_count,
               COUNT(DISTINCT subject_hash)::int AS independent_subject_count
        FROM brain_evidence_events
        WHERE observation_id = $1 AND event_type = 'search_mapping_verified'
      `, [observation.id])
      const verificationCount = Number(counts.rows[0]?.verification_count || 0)
      const independentSubjectCount = Number(counts.rows[0]?.independent_subject_count || 0)
      const trustedAuthority = observation.sourceAuthority === 'staff' || observation.sourceAuthority === 'internal'
      const verificationState = trustedAuthority || independentSubjectCount >= 2
        ? 'agent_verified'
        : 'contact_verified'
      const scope = verificationState === 'agent_verified' ? 'agent' : 'contact'
      const updated = await pgPool.query(`
        UPDATE memory_observations
        SET verification_state = $2,
            verification_count = $3,
            independent_subject_count = $4,
            scope = $5,
            subject_hash = CASE WHEN $5 = 'agent' THEN NULL ELSE COALESCE(subject_hash, $6) END,
            decision_version = $7,
            updated_at = now()
        WHERE id = $1
        RETURNING *
      `, [
        observation.id,
        verificationState,
        verificationCount,
        independentSubjectCount,
        scope,
        params.subjectHash,
        AGENT_BRAIN_DECISION_VERSION,
      ])
      observation = serializeObservation(updated.rows[0])
      let applied = null
      if (policy.mode === 'safe_auto' && envFlag('AGENT_BRAIN_AUTO_PROMOTE_ENABLED', false)) {
        if (observation.status === 'observed') {
          applied = await autoApplyObservation(observation, policy, 'agent-brain-v2')
        } else if (observation.status === 'promoted' && verificationState === 'agent_verified') {
          applied = await promoteObservation(observation.id, {
            status: 'active',
            scope: 'agent',
            subjectHash: null,
            verificationState,
            reason: 'ได้รับหลักฐานจาก subject อิสระครบตาม policy',
          }, 'agent-brain-v2')
        }
      }
      results.push({ observation, applied })
    }
  }
  return results
}

function memoryEvidenceTerms(memory) {
  const evidence = memory?.evidence?.observationEvidence || memory?.evidence || {}
  return Array.isArray(evidence.terms)
    ? evidence.terms.map(term => String(term).trim().toLowerCase()).filter(Boolean)
    : []
}

function memoryEvidenceCodes(memory) {
  const evidence = memory?.evidence?.observationEvidence || memory?.evidence || {}
  return Array.isArray(evidence.productCodes)
    ? evidence.productCodes.map(normalizeEntityCode).filter(Boolean)
    : []
}

async function suspendConflictingSearchHints(params) {
  const selections = params.toolEvents
    .map(event => event.verification)
    .filter(item => item.verified && item.selected && item.selectedCode && item.query)
  if (!selections.length) return []
  const { rows } = await pgPool.query(`
    SELECT * FROM agent_memories
    WHERE agent_id = $1
      AND type = 'search_hint'
      AND status IN ('active','soft')
      AND (ttl_expires_at IS NULL OR ttl_expires_at > now())
    ORDER BY updated_at DESC
    LIMIT 500
  `, [params.agentId])
  const suspended = []
  for (const row of rows) {
    const memory = serializeMemory(row)
    const terms = memoryEvidenceTerms(memory)
    const expectedCodes = memoryEvidenceCodes(memory)
    if (!terms.length || !expectedCodes.length) continue
    for (const selection of selections) {
      const queryTerms = safeTermCandidates(selection.query, 20).map(term => term.toLowerCase())
      const exactTermMatch = terms.some(term => term.length >= 3 && queryTerms.includes(term))
      if (!exactTermMatch || expectedCodes.includes(selection.selectedCode)) continue
      const updated = await updateMemory(memory.id, {
        status: 'suspended',
        verificationState: 'conflicted',
        evidence: {
          ...memory.evidence,
          conflict: {
            turnId: params.turnId,
            expectedCodes,
            selectedCode: selection.selectedCode,
            query: selection.query,
            detectedAt: new Date().toISOString(),
          },
        },
      }, 'agent-brain-v2')
      await recordDecisionEvent({
        agentId: params.agentId,
        memoryId: memory.id,
        turnId: params.turnId,
        action: 'suspended',
        reason: 'MCP result contradicted a verified search hint',
        metadata: { expectedCodes, selectedCode: selection.selectedCode },
        actor: 'agent-brain-v2',
      })
      suspended.push(updated)
      break
    }
  }
  return suspended
}

async function recordToolEvidence(params) {
  const events = []
  for (const event of params.toolEvents) {
    const verification = event.verification || {}
    const inserted = await insertEvidenceEvent({
      agentId: params.agentId,
      turnId: params.turnId,
      lookupId: params.lookupId,
      subjectHash: params.subjectHash,
      sourceAuthority: params.sourceAuthority,
      schemaVersion: verification.schemaVersion,
      eventType: 'tool_result',
      verificationState: verification.verified ? 'verified' : 'unverified',
      payload: {
        toolName: event.toolName,
        status: event.status,
        durationMs: event.durationMs,
        verification,
        sessionHash: params.sessionHash || null,
      },
    })
    if (inserted) events.push(inserted)
  }
  return events
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

function pruneActiveMemoryIndexCache(now = Date.now()) {
  for (const [key, entry] of activeMemoryIndexCache.entries()) {
    if (entry.expiresAt <= now) activeMemoryIndexCache.delete(key)
  }
  while (activeMemoryIndexCache.size >= ACTIVE_MEMORY_CACHE_MAX_ENTRIES) {
    const oldestKey = activeMemoryIndexCache.keys().next().value
    if (!oldestKey) break
    activeMemoryIndexCache.delete(oldestKey)
  }
}

async function getRuntimeMemoryIndex(agentId, subjectHash, policyRevision) {
  const now = Date.now()
  const cacheKey = `${agentId}:${Number(policyRevision || 1)}:${subjectHash || '-'}`
  const cached = activeMemoryIndexCache.get(cacheKey)
  if (cached && cached.expiresAt > now) return cached.memories
  if (cached) activeMemoryIndexCache.delete(cacheKey)
  const { rows } = await pgPool.query(`
    SELECT *
    FROM agent_memories
    WHERE agent_id = $1
      AND (
        status = 'active'
        OR (status = 'soft' AND scope = 'contact' AND subject_hash = $2)
      )
      AND (ttl_expires_at IS NULL OR ttl_expires_at > now())
      AND type NOT IN ('blocked_fact','description_suggestion')
    ORDER BY updated_at DESC
    LIMIT 500
  `, [agentId, subjectHash])
  const memories = rows.map(serializeMemory)
  pruneActiveMemoryIndexCache(now)
  activeMemoryIndexCache.set(cacheKey, {
    memories,
    expiresAt: now + ACTIVE_MEMORY_CACHE_TTL_MS,
  })
  return memories
}

async function evaluateAgentBrainTurn(input = {}, actor = null) {
  if (!isAvailable()) {
    return { ok: false, status: 'pg_unavailable', safeMessage: 'Agent Brain ต้องใช้ PostgreSQL' }
  }
  if (Buffer.byteLength(JSON.stringify(input || {}), 'utf8') > MAX_AGENT_BRAIN_REQUEST_BYTES) {
    throw Object.assign(new Error('Agent Brain payload is too large'), { status: 413 })
  }
  await ensureSchema()
  const agentId = normalizeAgentId(input.agentId || input.agent_id)
  const channel = input.channel ? normalizeChannel(input.channel) : null
  const accountId = String(input.accountId || input.account_id || 'default').trim() || 'default'
  const contractVersion = Math.max(1, Number.parseInt(String(input.contractVersion || input.contract_version || 1), 10) || 1)
  const v2Enabled = contractVersion >= 2 && envFlag('AGENT_BRAIN_V2_ENABLED', true)
  const phase = v2Enabled && input.phase === 'post_turn' ? 'post_turn' : 'pre_turn'
  const userUtterance = normalizeUserUtterance(
    input.userUtterance || input.user_utterance || input.userText || input.user_text || input.prompt || '',
  )
  const subjectHash = normalizeSubjectHash(input.subjectHash || input.subject_hash)
  const sessionHash = normalizeSubjectHash(input.sessionHash || input.session_hash)
  const lookupId = truncateText(input.lookupId || input.lookup_id || crypto.randomUUID(), 120)
  const turnId = input.turnId || input.turn_id || `agent-brain:${agentId}:${sha256(`${Date.now()}:${userUtterance}`).slice(0, 16)}`
  const legacyToolEvidence = Array.isArray(input.toolEvidence || input.tool_evidence)
    ? (input.toolEvidence || input.tool_evidence).slice(0, 5).map(outputText => ({ outputText }))
    : []
  const toolEvents = normalizeToolEvents(input.toolEvents || input.tool_events || legacyToolEvidence)
  const assistantAnswer = redactText(input.assistantAnswer || input.assistant_answer || input.finalText || input.final_text || '', 1600)
  const mediaDescriptions = Array.isArray(input.mediaDescriptions || input.media_descriptions)
    ? (input.mediaDescriptions || input.media_descriptions)
      .slice(0, MAX_AGENT_BRAIN_MEDIA_DESCRIPTIONS)
      .map(item => redactText(typeof item === 'string' ? item : item?.description || '', 500))
      .filter(Boolean)
    : []
  const policy = await getPolicy(agentId)
  const channelPolicy = channel ? await getChannelPolicy(channel, accountId) : serializeChannelPolicy(null, { channel: null, accountId })
  const sourceAuthority = channelPolicy.audience === 'staff' || channelPolicy.audience === 'internal'
    ? channelPolicy.audience
    : 'customer'
  const turn = {
    id: String(turnId),
    agentId,
    channel,
    userText: userUtterance,
    userUtterance,
    finalText: assistantAnswer,
    assistantAnswer,
    issues: Array.isArray(input.issueSignals || input.issue_signals || input.issues)
      ? (input.issueSignals || input.issue_signals || input.issues).slice(0, 50)
      : [],
    toolEvents,
    mediaDescriptions,
    hasMedia: input.hasMedia === true || input.has_media === true,
    mediaCount: Number(input.mediaCount || input.media_count || 0),
    subjectHash,
    sessionHash,
    sourceAuthority,
    contractVersion: v2Enabled ? AGENT_BRAIN_CONTRACT_VERSION : 1,
    decisionVersion: v2Enabled ? AGENT_BRAIN_DECISION_VERSION : 'legacy',
  }
  let learningSignals = []
  let evidenceEvents = []
  let verificationResults = []
  let suspendedConflicts = []
  if (!v2Enabled || phase === 'post_turn') {
    try {
      learningSignals = await syncObservationsForTurn(turn)
      if (v2Enabled) {
        evidenceEvents = await recordToolEvidence({
          agentId,
          turnId: String(turnId),
          lookupId,
          subjectHash,
          sessionHash,
          sourceAuthority,
          userUtterance,
          toolEvents,
        })
        verificationResults = await verifySearchHintObservations({
          agentId,
          turnId: String(turnId),
          lookupId,
          subjectHash,
          sessionHash,
          sourceAuthority,
          userUtterance,
          toolEvents,
        })
        suspendedConflicts = await suspendConflictingSearchHints({
          agentId,
          turnId: String(turnId),
          userUtterance,
          toolEvents,
        })
        await completeRuntimeMemoryUsage(lookupId, 'turn_completed', {
          toolEventCount: toolEvents.length,
          verificationCount: verificationResults.length,
          conflictCount: suspendedConflicts.length,
          lookupDurationMs: Number(input.lookupDurationMs || input.lookup_duration_ms || 0),
        })
      }
    } catch {
      learningSignals = []
    }
  }

  const maxContextChars = Math.min(Math.max(Number(policy.maxContextChars) || DEFAULT_MAX_CONTEXT_CHARS, 300), 1500)
  const runtimeMemories = await getRuntimeMemoryIndex(agentId, subjectHash, policy.policyRevision)
  const selection = selectRelevantRuntimeMemories(runtimeMemories, userUtterance, maxContextChars)
  const injectionEnabled = envFlag('AGENT_BRAIN_INJECTION_ENABLED', false)
  const selectedMemories = selection.includedMemories || []
  const generalMemories = selectedMemories
    .filter(memory => memory.type !== 'search_hint')
    .map(memory => ({ id: memory.id, type: memory.type, content: memory.content, scope: memory.scope }))
  const verifiedSearchHints = selectedMemories
    .filter(memory => memory.type === 'search_hint' && ['agent_verified', 'contact_verified', 'admin_verified'].includes(memory.verificationState))
    .map(memory => ({ id: memory.id, content: memory.content, scope: memory.scope, evidence: memory.evidence }))
  const effectiveLines = injectionEnabled ? selection.lines : []
  if (v2Enabled && phase === 'pre_turn' && injectionEnabled && selectedMemories.length) {
    await recordRuntimeMemoryUsage({
      lookupId,
      turnId: String(turnId),
      agentId,
      memories: selectedMemories,
      injectedChars: selection.chars,
      policyRevision: policy.policyRevision,
    })
  }
  const showDescriptionSuggestions = channelPolicy.enabled !== false
    && channelPolicy.showDescriptionSuggestions === true
    && (channelPolicy.audience === 'staff' || channelPolicy.audience === 'internal')
  const assistantAddendum = phase === 'post_turn' && showDescriptionSuggestions
    ? descriptionSuggestionAddendum(learningSignals)
    : null
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
    contractVersion: v2Enabled ? AGENT_BRAIN_CONTRACT_VERSION : 1,
    decisionVersion: v2Enabled ? AGENT_BRAIN_DECISION_VERSION : 'legacy',
    phase,
    lookupId,
    injectionEnabled,
    shadowMode: !injectionEnabled,
    memoriesToInject: effectiveLines,
    generalMemories: injectionEnabled ? generalMemories : [],
    verifiedSearchHints: injectionEnabled ? verifiedSearchHints : [],
    wouldInject: injectionEnabled ? [] : selection.lines,
    injectedChars: injectionEnabled ? selection.chars : 0,
    includedMemoryIds: injectionEnabled ? selection.includedMemoryIds : [],
    excludedMemoryIds: selection.excludedMemoryIds,
    learningSignals,
    evidenceEventsRecorded: evidenceEvents.length,
    verificationResults,
    suspendedConflicts,
    searchHints,
    descriptionSuggestions,
    assistantAddendum,
    safeMessage: assistantAddendum
      ? 'Agent Brain พบคำแนะนำ description สำหรับ staff/internal channel'
      : phase === 'pre_turn' ? 'Agent Brain context evaluated' : 'Agent Brain evidence evaluated',
    actor,
  }
}

async function getAgentBrainHealth(filters = {}) {
  await ensureSchema()
  const params = []
  const memoryWhere = []
  const observationWhere = []
  const usageWhere = []
  if (filters.agentId) {
    params.push(normalizeAgentId(filters.agentId))
    const position = params.length
    memoryWhere.push(`agent_id = $${position}`)
    observationWhere.push(`agent_id = $${position}`)
    usageWhere.push(`agent_id = $${position}`)
  }
  const [memoryCounts, observationCounts, usageCounts, recentDecisions] = await Promise.all([
    pgPool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'active')::int AS active_count,
        COUNT(*) FILTER (WHERE status = 'soft')::int AS soft_count,
        COUNT(*) FILTER (WHERE status = 'suspended')::int AS suspended_count,
        COUNT(*) FILTER (WHERE status = 'blocked')::int AS blocked_count,
        COUNT(*) FILTER (WHERE status IN ('active','soft') AND usage_count > 0)::int AS active_used_count,
        COALESCE(SUM(length(content)) FILTER (WHERE status IN ('active','soft')), 0)::int AS usable_chars
      FROM agent_memories
      ${memoryWhere.length ? `WHERE ${memoryWhere.join(' AND ')}` : ''}
    `, params),
    pgPool.query(`
      SELECT
        COUNT(*)::int AS observation_count,
        COUNT(*) FILTER (WHERE verification_state = 'unverified')::int AS unverified_count,
        COUNT(*) FILTER (WHERE verification_state IN ('agent_verified','contact_verified','authority_verified'))::int AS verified_count,
        COUNT(*) FILTER (WHERE decision_version = 'legacy')::int AS legacy_count
      FROM memory_observations
      ${observationWhere.length ? `WHERE ${observationWhere.join(' AND ')}` : ''}
    `, params),
    pgPool.query(`
      SELECT
        COUNT(*)::int AS usage_count,
        COALESCE(SUM(injected_chars), 0)::int AS injected_chars,
        percentile_cont(0.95) WITHIN GROUP (
          ORDER BY NULLIF(metadata->>'lookupDurationMs','')::numeric
        ) FILTER (WHERE COALESCE(metadata->>'lookupDurationMs','') ~ '^[0-9]+(?:\\.[0-9]+)?$') AS lookup_p95_ms
      FROM memory_usage_events
      ${usageWhere.length ? `WHERE ${usageWhere.join(' AND ')}` : ''}
    `, params),
    pgPool.query(`
      SELECT action, COUNT(*)::int AS count
      FROM brain_decision_events
      ${filters.agentId ? 'WHERE agent_id = $1 AND created_at >= now() - interval \'7 days\'' : 'WHERE created_at >= now() - interval \'7 days\''}
      GROUP BY action
    `, params),
  ])
  const memory = memoryCounts.rows[0] || {}
  const observations = observationCounts.rows[0] || {}
  const usage = usageCounts.rows[0] || {}
  const decisionCounts = Object.fromEntries(recentDecisions.rows.map(row => [row.action, Number(row.count || 0)]))
  return {
    ok: true,
    contractVersion: AGENT_BRAIN_CONTRACT_VERSION,
    decisionVersion: AGENT_BRAIN_DECISION_VERSION,
    featureFlags: {
      v2: envFlag('AGENT_BRAIN_V2_ENABLED', true),
      injection: envFlag('AGENT_BRAIN_INJECTION_ENABLED', false),
      autoPromote: envFlag('AGENT_BRAIN_AUTO_PROMOTE_ENABLED', false),
    },
    memory: {
      activeCount: Number(memory.active_count || 0),
      softCount: Number(memory.soft_count || 0),
      suspendedCount: Number(memory.suspended_count || 0),
      blockedCount: Number(memory.blocked_count || 0),
      activeUsedCount: Number(memory.active_used_count || 0),
      usableChars: Number(memory.usable_chars || 0),
    },
    observations: {
      total: Number(observations.observation_count || 0),
      verifiedCount: Number(observations.verified_count || 0),
      unverifiedCount: Number(observations.unverified_count || 0),
      legacyCount: Number(observations.legacy_count || 0),
    },
    usage: {
      count: Number(usage.usage_count || 0),
      injectedChars: Number(usage.injected_chars || 0),
      lookupP95Ms: usage.lookup_p95_ms === null || usage.lookup_p95_ms === undefined ? null : Number(usage.lookup_p95_ms),
    },
    recentDecisions: decisionCounts,
    generatedAt: new Date().toISOString(),
  }
}

function reclassifyObservationAction(observation) {
  const source = observation.evidence?.source
  const codes = Array.isArray(observation.evidence?.productCodes) ? observation.evidence.productCodes : []
  if (source === 'media_turn' || hasSystemNoiseText(observation.summary)) {
    return { action: 'ignore', reason: 'system_or_media_noise' }
  }
  if (codes.some(isUnsafeEntityIdentifier)) {
    return { action: 'ignore', reason: 'unsafe_entity_identifier' }
  }
  if (observation.type === 'description_suggestion') {
    const validRule = observation.evidence?.rule === 'verified_failed_query_then_selected_entity'
    const validSchema = observation.evidence?.schemaVersion === 'search_product.v2'
    return validRule && validSchema
      ? { action: 'keep', reason: 'verified_description_suggestion' }
      : { action: 'ignore', reason: 'description_suggestion_without_verified_tool_evidence' }
  }
  if (isProhibitedMemoryTruth(observation.summary)) {
    return { action: 'block', reason: 'dynamic_business_fact' }
  }
  return { action: 'keep', reason: 'no_unsafe_signal' }
}

async function reclassifyAgentBrain(options = {}, actor = null) {
  await ensureSchema()
  const dryRun = options.dryRun !== false && options.dry_run !== false && options.apply !== true
  const agentId = options.agentId || options.agent_id ? normalizeAgentId(options.agentId || options.agent_id) : null
  const params = agentId ? [agentId] : []
  const observations = await pgPool.query(`
    SELECT * FROM memory_observations
    ${agentId ? 'WHERE agent_id = $1' : ''}
    ORDER BY updated_at DESC
    LIMIT 5000
  `, params)
  const memories = await pgPool.query(`
    SELECT * FROM agent_memories
    WHERE status IN ('active','soft')
      AND type = 'search_hint'
      AND verification_state NOT IN ('agent_verified','contact_verified','admin_verified')
      ${agentId ? 'AND agent_id = $1' : ''}
    ORDER BY updated_at DESC
    LIMIT 5000
  `, params)
  const observationActions = observations.rows.map(row => {
    const observation = serializeObservation(row)
    return { kind: 'observation', id: observation.id, agentId: observation.agentId, ...reclassifyObservationAction(observation) }
  }).filter(item => item.action !== 'keep' || item.reason !== 'no_unsafe_signal')
  const memoryActions = memories.rows.map(row => ({
    kind: 'memory',
    id: row.id,
    agentId: row.agent_id,
    action: 'suspend',
    reason: 'search_hint_without_v2_verification',
  }))
  const actions = [...observationActions, ...memoryActions]
  const summary = actions.reduce((out, item) => {
    out[item.action] = (out[item.action] || 0) + 1
    return out
  }, { scanned: observations.rows.length + memories.rows.length })
  if (dryRun) return { ok: true, dryRun: true, summary, actions: actions.slice(0, 500) }

  const affectedAgents = Array.from(new Set(actions.map(item => item.agentId).filter(Boolean)))
  const backups = affectedAgents.map(id => safeBackupInfo(backupMemoryFile(id, 'brain-v3-reclassify')))
  const client = await pgPool.connect()
  const applied = []
  const errors = []
  try {
    await client.query('BEGIN')
    for (const action of actions) {
      try {
        if (action.kind === 'observation') {
          const status = action.action === 'block' ? 'blocked' : 'ignored'
          await client.query(`
            UPDATE memory_observations
            SET status = $2,
                decision_version = $3,
                verification_state = CASE WHEN $2 = 'blocked' THEN 'blocked' ELSE 'invalid' END,
                updated_at = now()
            WHERE id = $1
          `, [action.id, status, AGENT_BRAIN_DECISION_VERSION])
        } else {
          await client.query(`
            UPDATE agent_memories
            SET status = 'suspended', verification_state = 'unverified',
                decision_version = $2, suspended_at = now(), updated_at = now()
            WHERE id = $1
          `, [action.id, AGENT_BRAIN_DECISION_VERSION])
        }
        await recordDecisionEvent({
          agentId: action.agentId,
          observationId: action.kind === 'observation' ? action.id : null,
          memoryId: action.kind === 'memory' ? action.id : null,
          action: action.action,
          reason: action.reason,
          actor,
        }, client)
        applied.push(action)
      } catch (err) {
        errors.push({ ...action, error: err.message })
      }
    }
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
  for (const id of affectedAgents) await syncAgentMemoryFile(id).catch(() => {})
  return { ok: errors.length === 0, dryRun: false, summary, backups, applied, errors }
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
  getAgentBrainHealth,
  reclassifyAgentBrain,
  summaryForAgents,
  syncObservationsForTurn,
  buildLearningDetail,
  observationsFromTurn,
  _internal: {
    normalizeMemoryType,
    normalizeMemoryScope,
    normalizeMemoryStatus,
    normalizePolicyMode,
    normalizeLegacyMemoryMode,
    normalizeChannel,
    normalizeAudience,
    stripManagedAgentBrainContext,
    normalizedContentHash,
    replaceAutoMemoryBlock,
    legacyMemoryBaseContent,
    canAutoPromoteObservation,
    classifyMemoryText,
    classifyMemoryForCleanup,
    legacyMemoryAnalysis,
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
    normalizeUserUtterance,
    isUnsafeEntityIdentifier,
    normalizeEntityCode,
    adaptSearchProductV2ToolEvent,
    normalizeToolEvents,
    verificationMatchesObservation,
    reclassifyObservationAction,
    issueToObservation,
    isProhibitedMemoryTruth,
  },
}
