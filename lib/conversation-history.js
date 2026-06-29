const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const { pgPool } = require('./pg')
const { HOME } = require('./config')
const { readOpenclawConfig } = require('./openclaw-config')
const monitorRoute = require('../routes/monitor')
const memoryAuto = require('./memory-auto')
const businessProfiles = require('./business-profiles')
const { getOpenclawVersion } = require('./model-runtime-test')

const monitor = monitorRoute._internal

const DEFAULT_RETENTION_DAYS = 180
const DEFAULT_QUERY_LIMIT = 100
const MAX_QUERY_LIMIT = 500
const MAX_EXPORT_DAYS = 31
const MAX_EXPORT_TURNS = 50000
const MAX_BACKFILL_DAYS = 31
const DEFAULT_INGEST_MINUTES = 180
const MAX_INGEST_TURNS_PER_RUN = 2000
const DEFAULT_SLOW_TURN_MS = 10000
const DEFAULT_ANALYSIS_SCAN_LIMIT = 5000

const REVIEW_TARGETS = {
  SOUL: 'SOUL',
  MCP_SEARCH: 'MCP/search',
  MODEL_RUNTIME: 'model/runtime',
  USER_AMBIGUITY: 'user ambiguity',
  BUSINESS_CAPABILITY: 'business capability',
}

const ISSUE_DEFINITIONS = {
  search_no_result: { label: 'Search no result', target: REVIEW_TARGETS.MCP_SEARCH },
  low_confidence_search: { label: 'Low confidence search', target: REVIEW_TARGETS.MCP_SEARCH },
  wrong_product_candidates: { label: 'Wrong product candidates', target: REVIEW_TARGETS.MCP_SEARCH },
  selection_not_resolved: { label: 'Selection not resolved', target: REVIEW_TARGETS.SOUL },
  tool_error: { label: 'Tool error', target: REVIEW_TARGETS.MCP_SEARCH },
  model_timeout: { label: 'Model timeout', target: REVIEW_TARGETS.MODEL_RUNTIME },
  fallback_used: { label: 'Fallback used', target: REVIEW_TARGETS.MODEL_RUNTIME },
  slow_turn: { label: 'Slow turn', target: REVIEW_TARGETS.MODEL_RUNTIME },
  price_denied: { label: 'Price denied', target: REVIEW_TARGETS.BUSINESS_CAPABILITY },
  unsupported_capability: { label: 'Unsupported capability', target: REVIEW_TARGETS.BUSINESS_CAPABILITY },
  language_quality: { label: 'Language quality', target: REVIEW_TARGETS.SOUL },
  duplicate_reply: { label: 'Duplicate reply', target: REVIEW_TARGETS.SOUL },
  needs_user_refine: { label: 'Needs user refine', target: REVIEW_TARGETS.USER_AMBIGUITY },
  unverified_price_guess: { label: 'Unverified price guess', target: REVIEW_TARGETS.SOUL },
  reply_repetition: { label: 'Reply repetition', target: REVIEW_TARGETS.SOUL },
  multi_item_slow: { label: 'Multi-item slow turn', target: REVIEW_TARGETS.MODEL_RUNTIME },
  search_retry_loop: { label: 'Search retry loop', target: REVIEW_TARGETS.MCP_SEARCH },
  wrong_agent_or_capability: { label: 'Wrong agent or capability', target: REVIEW_TARGETS.BUSINESS_CAPABILITY },
  media_no_visible_reply: { label: 'Media without visible reply', target: REVIEW_TARGETS.MODEL_RUNTIME },
  stalled_after_media: { label: 'Stalled after media', target: REVIEW_TARGETS.MODEL_RUNTIME },
  line_delivery_uncertain: { label: 'LINE delivery uncertain', target: REVIEW_TARGETS.MODEL_RUNTIME },
  line_burst_coalesced: { label: 'LINE burst coalesced', target: REVIEW_TARGETS.MODEL_RUNTIME },
}

const ISSUE_TAGS = Object.keys(ISSUE_DEFINITIONS)

let schemaReady = false
let workerTimer = null
let workerRunning = false

function isEnabled() {
  return process.env.CONVERSATION_ANALYSIS_ENABLED !== '0'
}

function retentionDays() {
  const parsed = Number.parseInt(process.env.CONVERSATION_RETENTION_DAYS || '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 3650) : DEFAULT_RETENTION_DAYS
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex')
}

function safeDate(value, fallback) {
  if (!value) return fallback
  const d = new Date(value)
  return Number.isFinite(d.getTime()) ? d : fallback
}

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(Math.max(parsed, min), max)
}

function truncateText(value, max = 12000) {
  if (value === null || value === undefined) return null
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  if (text.length <= max) return text
  return `${text.slice(0, max)}…[truncated ${text.length - max} chars]`
}

function redactValue(value, depth = 0) {
  if (depth > 8) return '[max-depth]'
  if (value === null || value === undefined) return value
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        return JSON.stringify(redactValue(JSON.parse(trimmed), depth + 1))
      } catch {
        // Fall through to text redaction.
      }
    }
    return redactText(value, 5000)
  }
  if (typeof value !== 'object') return value
  if (Array.isArray(value)) return value.slice(0, 80).map(item => redactValue(item, depth + 1))

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

function redactText(text, max = 12000) {
  if (!text) return ''
  return truncateText(String(text)
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,}]+/ig, '$1[redacted]')
    .replace(/(botToken|apiKey|api_key|accessToken|refreshToken|password|secret)(["'\s:=]+)[^"',\s}]+/ig, '$1$2[redacted]'), max) || ''
}

function providerFromModel(model) {
  const ref = String(model || '')
  return ref.includes('/') ? ref.split('/')[0] : null
}

function stableHashPayload(value, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return value
  if (Array.isArray(value)) return value.map(item => stableHashPayload(item, depth + 1))
  if (typeof value !== 'object') return value
  const looksLikeMedia = value.mimeType || value.mime_type || value.kind || value.fileName || value.file_name || value.hasPreview
  const out = {}
  for (const [key, raw] of Object.entries(value)) {
    if (looksLikeMedia && /^(id|previewUrl|hasPreview)$/i.test(key)) continue
    out[key] = stableHashPayload(raw, depth + 1)
  }
  return out
}

function eventHash(turnId, type, index, body, payload) {
  return sha256(JSON.stringify({ turnId, type, index, body, payload: stableHashPayload(redactValue(payload)) }))
}

function safeMediaRef(value) {
  const raw = String(value || '').trim()
  if (!/^media:\/\/inbound\/[^/]+\.(png|jpe?g|webp|gif)$/i.test(raw)) return null
  return raw
}

function stripInternalMediaRefs(value, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return value
  if (Array.isArray(value)) return value.map(item => stripInternalMediaRefs(item, depth + 1))
  if (typeof value !== 'object') return value
  const out = {}
  for (const [key, raw] of Object.entries(value)) {
    if (/^_?mediaRef$/i.test(key) || /^storageRef$/i.test(key) || /^sourcePath$/i.test(key)) continue
    out[key] = stripInternalMediaRefs(raw, depth + 1)
  }
  return out
}

function normalizeConversationMedia(media, options = {}) {
  if (!media || typeof media !== 'object') return null
  const mediaRef = safeMediaRef(media.mediaRef || media._mediaRef || media.storageRef || media.ref)
  const rawPreviewUrl = media.previewUrl == null ? null : String(media.previewUrl)
  const mimeType = String(media.mimeType || media.mime_type || media.contentType || media.content_type || 'application/octet-stream').slice(0, 120)
  const kind = String(media.kind || media.type || (mimeType.startsWith('image/') ? 'image' : 'file')).slice(0, 40)
  const sizeBytes = Number(media.sizeBytes ?? media.size_bytes ?? media.fileSize ?? media.file_size)
  const fileName = media.fileName || media.file_name || media.filename || media.name
    ? path.basename(String(media.fileName || media.file_name || media.filename || media.name)).slice(0, 160)
    : undefined
  const caption = media.caption || media.text || media.alt ? redactText(String(media.caption || media.text || media.alt), 500) : undefined
  let rawId = media.id == null ? null : String(media.id)
  let id = !mediaRef && rawId && /^[a-f0-9]{32,64}$/i.test(rawId) ? rawId : null
  if (mediaRef) {
    const previewPath = monitor.resolveMediaRefToPath?.(mediaRef)
    const refreshedId = previewPath ? monitor.registerPreviewMedia({
      filePath: previewPath,
      mimeType,
      fileName,
      caption,
    }) : null
    if (refreshedId) id = refreshedId
  }
  const previewUrl = id
    ? `/api/monitor/media/${id}`
    : rawPreviewUrl && /^\/api\/monitor\/media\/[a-f0-9]{32,64}$/i.test(rawPreviewUrl)
      ? rawPreviewUrl
      : undefined
  return {
    id,
    kind,
    mimeType,
    fileName,
    sizeBytes: Number.isFinite(sizeBytes) && sizeBytes > 0 ? Math.round(sizeBytes) : undefined,
    caption,
    hasPreview: Boolean(id || (media.hasPreview && previewUrl)),
    previewUrl,
    ...(options.includeMediaRef && mediaRef ? { mediaRef } : {}),
  }
}

function normalizeConversationMediaList(mediaList, options = {}) {
  if (!Array.isArray(mediaList)) return []
  const seen = new Set()
  const out = []
  for (const raw of mediaList.slice(0, 20)) {
    const item = normalizeConversationMedia(raw, options)
    if (!item) continue
    const key = item.id || `${item.mimeType}:${item.fileName || ''}:${item.caption || ''}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out.slice(0, 8)
}

function turnToEvents(turn) {
  const events = []
  const startedAt = turn.startedAt || new Date().toISOString()
  const media = normalizeConversationMediaList(turn.media, { includeMediaRef: true })
  events.push({
    type: 'user',
    occurredAt: startedAt,
    title: 'User message',
    body: redactText(turn.userText, 16000),
    payload: {
      channel: turn.channel,
      user: turn.user,
      media,
      mediaCount: Number.isFinite(Number(turn.mediaCount)) ? Math.max(0, Number(turn.mediaCount)) : media.length,
    },
  })

  if (Array.isArray(turn.toolPath)) {
    for (const tool of turn.toolPath) {
      events.push({
        type: 'tool',
        occurredAt: startedAt,
        title: tool.name || 'tool',
        body: redactText(tool.toolResult || tool.resultSummary || tool.warning || '', 12000),
        payload: {
          name: tool.name,
          status: tool.status,
          durationMs: tool.durationMs,
          input: tool.toolInput || tool.argsPreview,
          result: tool.toolResult || tool.resultSummary,
          cleanKeyword: tool.cleanKeyword,
          warning: tool.warning,
        },
      })
    }
  }

  for (const warning of Array.isArray(turn.warnings) ? turn.warnings : []) {
    events.push({
      type: 'warning',
      occurredAt: startedAt,
      title: warning.type || warning.issue || 'warning',
      body: redactText(warning.summary || warning.detail || warning.issue || '', 8000),
      payload: warning,
    })
  }

  if (turn.finalText) {
    events.push({
      type: 'assistant',
      occurredAt: startedAt,
      title: 'Assistant reply',
      body: redactText(turn.finalText, 16000),
      payload: {
        route: turn.route,
        intent: turn.intent,
        status: turn.status,
        rootCause: turn.rootCause,
      },
    })
  }

  return events.map((event, index) => ({
    ...event,
    index,
    payload: redactValue(event.payload || {}),
    hash: eventHash(turn.id, event.type, index, event.body, event.payload || {}),
  }))
}

function normalizeTurn(turn) {
  const toolPath = Array.isArray(turn.toolPath) ? turn.toolPath : []
  const warnings = Array.isArray(turn.warnings) ? turn.warnings : []
  const model = turn.model || null
  return {
    turnId: String(turn.id || sha256(JSON.stringify(turn))),
    source: turn.source || 'unknown',
    sessionKey: turn.sessionKey || null,
    startedAt: safeDate(turn.startedAt, new Date()).toISOString(),
    agentId: turn.agentId || null,
    channel: turn.channel || 'unknown',
    chatUser: turn.user || 'unknown',
    userText: redactText(turn.userText, 20000),
    finalText: redactText(turn.finalText, 20000),
    route: turn.route || 'unknown',
    intent: turn.intent || 'unknown',
    status: turn.status || 'unknown',
    rootCause: turn.rootCause || null,
    durationMs: Number.isFinite(Number(turn.durationMs)) ? Math.max(0, Math.round(Number(turn.durationMs))) : null,
    ackMs: Number.isFinite(Number(turn.ackMs)) ? Math.max(0, Math.round(Number(turn.ackMs))) : null,
    modelMs: Number.isFinite(Number(turn.modelMs)) ? Math.max(0, Math.round(Number(turn.modelMs))) : null,
    model,
    provider: turn.provider || providerFromModel(model),
    inputTokens: Number.isFinite(Number(turn.inputTokens)) ? Math.max(0, Math.round(Number(turn.inputTokens))) : null,
    outputTokens: Number.isFinite(Number(turn.outputTokens)) ? Math.max(0, Math.round(Number(turn.outputTokens))) : null,
    cost: Number.isFinite(Number(turn.cost)) ? Number(turn.cost) : null,
    toolCount: toolPath.length,
    warningCount: warnings.length,
    events: turnToEvents(turn),
  }
}

async function ensureSchema() {
  if (schemaReady) return
  if (!pgPool) throw new Error('Database not configured')

  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS conversation_turns (
      turn_id TEXT PRIMARY KEY,
      source TEXT NOT NULL DEFAULT 'unknown',
      session_key TEXT,
      started_at TIMESTAMPTZ NOT NULL,
      agent_id TEXT,
      channel TEXT NOT NULL DEFAULT 'unknown',
      chat_user TEXT NOT NULL DEFAULT 'unknown',
      user_text TEXT NOT NULL DEFAULT '',
      final_text TEXT NOT NULL DEFAULT '',
      route TEXT NOT NULL DEFAULT 'unknown',
      intent TEXT NOT NULL DEFAULT 'unknown',
      status TEXT NOT NULL DEFAULT 'unknown',
      root_cause TEXT,
      duration_ms INTEGER,
      ack_ms INTEGER,
      model_ms INTEGER,
      model TEXT,
      provider TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cost NUMERIC(14,8),
      tool_count INTEGER NOT NULL DEFAULT 0,
      warning_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS conversation_events (
      id BIGSERIAL PRIMARY KEY,
      turn_id TEXT NOT NULL REFERENCES conversation_turns(turn_id) ON DELETE CASCADE,
      event_hash TEXT NOT NULL,
      event_index INTEGER NOT NULL DEFAULT 0,
      event_type TEXT NOT NULL,
      occurred_at TIMESTAMPTZ,
      title TEXT,
      body TEXT,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(turn_id, event_hash)
    )
  `)
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS conversation_ingest_checkpoints (
      source_key TEXT PRIMARY KEY,
      source_path TEXT,
      source_kind TEXT,
      inode TEXT,
      mtime_ms NUMERIC,
      offset_bytes NUMERIC,
      last_imported_at TIMESTAMPTZ,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS conversation_exports (
      id BIGSERIAL PRIMARY KEY,
      actor TEXT,
      format TEXT NOT NULL,
      filters JSONB NOT NULL DEFAULT '{}'::jsonb,
      row_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_conversation_turns_started_at ON conversation_turns(started_at DESC)')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_conversation_turns_agent_started ON conversation_turns(agent_id, started_at DESC)')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_conversation_turns_channel_started ON conversation_turns(channel, started_at DESC)')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_conversation_turns_status_started ON conversation_turns(status, started_at DESC)')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_conversation_turns_chat_started ON conversation_turns(chat_user, started_at DESC)')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_conversation_events_turn ON conversation_events(turn_id, event_index ASC)')
  schemaReady = true
}

async function withAdvisoryLock(lockName, fn) {
  const key = Math.abs(Number.parseInt(sha256(lockName).slice(0, 14), 16))
  const { rows } = await pgPool.query('SELECT pg_try_advisory_lock($1) AS locked', [key])
  if (!rows[0]?.locked) return { skipped: true, reason: 'lock_busy' }
  try {
    return await fn()
  } finally {
    await pgPool.query('SELECT pg_advisory_unlock($1)', [key]).catch(() => {})
  }
}

function listSessionTurns(minutes, channelFilter, agentFilter) {
  let config = {}
  try { config = readOpenclawConfig() } catch { config = {} }
  const agentList = config.agents?.list || []
  const turns = []
  const fs = require('fs')
  for (const agent of agentList) {
    const agentId = agent.id
    if (!agentId || (agentFilter && agentFilter !== agentId)) continue
    const sessionsPath = path.join(HOME, `.openclaw/agents/${agentId}/sessions/sessions.json`)
    let sessionsMap = {}
    try { sessionsMap = JSON.parse(fs.readFileSync(sessionsPath, 'utf8')) } catch { continue }

    for (const [sessionKey, sessionInfo] of Object.entries(sessionsMap)) {
      if (!sessionInfo || sessionKey.includes(':main')) continue
      const parsed = parseSessionChannelUser(sessionKey)
      if (!parsed) continue
      if (channelFilter && parsed.channel !== channelFilter) continue
      const sessionFile = sessionInfo.sessionFile
        || (sessionInfo.sessionId ? path.join(HOME, `.openclaw/agents/${agentId}/sessions/${sessionInfo.sessionId}.jsonl`) : null)
      if (!sessionFile || !fs.existsSync(sessionFile)) continue
      turns.push(...monitor.buildConversationTurnsFromSession({
        agentId,
        sessionKey,
        user: parsed.user,
        channel: parsed.channel,
        sessionFile,
        minutes,
      }))
      if (turns.length > MAX_INGEST_TURNS_PER_RUN) return turns
    }
  }
  return turns
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

function collectTurns({ minutes = DEFAULT_INGEST_MINUTES, agent, channel, limit = MAX_INGEST_TURNS_PER_RUN }) {
  const turns = [
    ...listSessionTurns(minutes, channel, agent),
    ...monitor.buildConversationTurnsFromGatewayLog({ minutes, agent, channel, limit }),
  ]
  const byId = new Map()
  for (const turn of turns) {
    if (!turn?.id) continue
    byId.set(String(turn.id), turn)
  }
  return Array.from(byId.values())
    .sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime())
    .slice(-limit)
}

async function upsertTurn(client, turn) {
  const normalized = normalizeTurn(turn)
  await client.query(`
    INSERT INTO conversation_turns (
      turn_id, source, session_key, started_at, agent_id, channel, chat_user,
      user_text, final_text, route, intent, status, root_cause, duration_ms, ack_ms, model_ms,
      model, provider, input_tokens, output_tokens, cost, tool_count, warning_count, updated_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,now()
    )
    ON CONFLICT (turn_id) DO UPDATE SET
      source = EXCLUDED.source,
      session_key = COALESCE(EXCLUDED.session_key, conversation_turns.session_key),
      started_at = EXCLUDED.started_at,
      agent_id = EXCLUDED.agent_id,
      channel = EXCLUDED.channel,
      chat_user = EXCLUDED.chat_user,
      user_text = EXCLUDED.user_text,
      final_text = EXCLUDED.final_text,
      route = EXCLUDED.route,
      intent = EXCLUDED.intent,
      status = EXCLUDED.status,
      root_cause = EXCLUDED.root_cause,
      duration_ms = EXCLUDED.duration_ms,
      ack_ms = EXCLUDED.ack_ms,
      model_ms = EXCLUDED.model_ms,
      model = COALESCE(EXCLUDED.model, conversation_turns.model),
      provider = COALESCE(EXCLUDED.provider, conversation_turns.provider),
      input_tokens = COALESCE(EXCLUDED.input_tokens, conversation_turns.input_tokens),
      output_tokens = COALESCE(EXCLUDED.output_tokens, conversation_turns.output_tokens),
      cost = COALESCE(EXCLUDED.cost, conversation_turns.cost),
      tool_count = EXCLUDED.tool_count,
      warning_count = EXCLUDED.warning_count,
      updated_at = now()
  `, [
    normalized.turnId,
    normalized.source,
    normalized.sessionKey,
    normalized.startedAt,
    normalized.agentId,
    normalized.channel,
    normalized.chatUser,
    normalized.userText,
    normalized.finalText,
    normalized.route,
    normalized.intent,
    normalized.status,
    normalized.rootCause,
    normalized.durationMs,
    normalized.ackMs,
    normalized.modelMs,
    normalized.model,
    normalized.provider,
    normalized.inputTokens,
    normalized.outputTokens,
    normalized.cost,
    normalized.toolCount,
    normalized.warningCount,
  ])

  await client.query('DELETE FROM conversation_events WHERE turn_id = $1', [normalized.turnId])

  for (const event of normalized.events) {
    await client.query(`
      INSERT INTO conversation_events (
        turn_id, event_hash, event_index, event_type, occurred_at, title, body, payload
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
      ON CONFLICT (turn_id, event_hash) DO NOTHING
    `, [
      normalized.turnId,
      event.hash,
      event.index,
      event.type,
      event.occurredAt || normalized.startedAt,
      event.title,
      event.body,
      JSON.stringify(event.payload || {}),
    ])
  }
  try {
    if (memoryAuto.isAvailable()) {
      const rowLike = {
        turn_id: normalized.turnId,
        source: normalized.source,
        session_key: normalized.sessionKey,
        started_at: normalized.startedAt,
        agent_id: normalized.agentId,
        channel: normalized.channel,
        chat_user: normalized.chatUser,
        user_text: normalized.userText,
        final_text: normalized.finalText,
        route: normalized.route,
        intent: normalized.intent,
        status: normalized.status,
        root_cause: normalized.rootCause,
        duration_ms: normalized.durationMs,
        ack_ms: normalized.ackMs,
        model_ms: normalized.modelMs,
        model: normalized.model,
        provider: normalized.provider,
        input_tokens: normalized.inputTokens,
        output_tokens: normalized.outputTokens,
        cost: normalized.cost,
        tool_count: normalized.toolCount,
        warning_count: normalized.warningCount,
      }
      const events = normalized.events.map(event => ({
        type: event.type,
        occurredAt: event.occurredAt,
        title: event.title,
        body: event.body,
        payload: event.payload || {},
      }))
      const issues = deriveIssues(rowLike, events)
      await memoryAuto.syncObservationsForTurn(rowToTurn(rowLike, issues, events), client)
    }
  } catch {
    // Learning observations must never break historical ingestion.
  }
  return normalized
}

async function ingestRecent(options = {}) {
  if (!isEnabled()) return { ok: false, disabled: true, imported: 0, skipped: 0 }
  await ensureSchema()
  const minutes = clampInt(options.minutes, 1, MAX_BACKFILL_DAYS * 24 * 60, DEFAULT_INGEST_MINUTES)
  const dryRun = Boolean(options.dryRun)
  const turns = collectTurns({ minutes, agent: options.agent, channel: options.channel, limit: options.limit || MAX_INGEST_TURNS_PER_RUN })
    .filter(turn => {
      const ts = new Date(turn.startedAt).getTime()
      if (!Number.isFinite(ts)) return false
      if (options.from && ts < new Date(options.from).getTime()) return false
      if (options.to && ts > new Date(options.to).getTime()) return false
      return true
    })

  if (dryRun) {
    return { ok: true, dryRun: true, imported: 0, skipped: 0, discovered: turns.length }
  }

  return withAdvisoryLock('conversation-analysis-ingest', async () => {
    const client = await pgPool.connect()
    let imported = 0
    const importedAgents = new Set()
    try {
      await client.query('BEGIN')
      for (const turn of turns) {
        const normalized = await upsertTurn(client, turn)
        if (normalized.agentId) importedAgents.add(normalized.agentId)
        imported += 1
      }
      await client.query(`
        INSERT INTO conversation_ingest_checkpoints (
          source_key, source_path, source_kind, last_imported_at, metadata, updated_at
        ) VALUES ($1,$2,$3,now(),$4::jsonb,now())
        ON CONFLICT (source_key) DO UPDATE SET
          last_imported_at = now(),
          metadata = EXCLUDED.metadata,
          updated_at = now()
      `, [
        `monitor-window:${options.agent || '*'}:${options.channel || '*'}`,
        HOME,
        'monitor-window',
        JSON.stringify({ minutes, count: turns.length, from: options.from || null, to: options.to || null }),
      ])
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
    if (importedAgents.size && memoryAuto.isAvailable()) {
      await memoryAuto.applyAutoLearnForAgents([...importedAgents], { actor: 'conversation-ingest', limit: 100 }).catch(() => {})
    }
    return { ok: true, imported, skipped: turns.length - imported, discovered: turns.length }
  })
}

async function cleanupRetention() {
  if (!isEnabled() || !pgPool) return
  await ensureSchema()
  const days = retentionDays()
  await pgPool.query("DELETE FROM conversation_turns WHERE started_at < now() - ($1::int * interval '1 day')", [days])
}

function parseQueryFilters(query = {}) {
  const now = new Date()
  const defaultFrom = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  const from = safeDate(query.from, defaultFrom)
  const to = safeDate(query.to, now)
  const limit = clampInt(query.limit, 1, MAX_QUERY_LIMIT, DEFAULT_QUERY_LIMIT)
  return {
    from,
    to,
    limit,
    cursor: query.cursor ? String(query.cursor) : null,
    agent: query.agent ? String(query.agent) : null,
    channel: query.channel ? String(query.channel) : null,
    user: query.user ? String(query.user) : null,
    intent: query.intent ? String(query.intent) : null,
    route: query.route ? String(query.route) : null,
    status: query.status ? String(query.status) : null,
    model: query.model ? String(query.model) : null,
    q: query.q ? String(query.q).trim() : null,
    issueTag: query.issueTag ? String(query.issueTag) : null,
    reviewTarget: query.reviewTarget ? String(query.reviewTarget) : null,
    hasToolError: query.hasToolError === '1' || query.hasToolError === 'true' || query.hasToolError === true,
    slowOnly: query.slowOnly === '1' || query.slowOnly === 'true' || query.slowOnly === true,
    hasMedia: query.hasMedia === '1' || query.hasMedia === 'true' || query.hasMedia === true || query.issueTag === 'has_media',
  }
}

function slowTurnMs() {
  return clampInt(process.env.CONVERSATION_SLOW_TURN_MS, 1000, 120000, DEFAULT_SLOW_TURN_MS)
}

function analysisScanLimit() {
  return clampInt(process.env.CONVERSATION_ANALYSIS_SCAN_LIMIT, 500, MAX_EXPORT_TURNS, DEFAULT_ANALYSIS_SCAN_LIMIT)
}

function hasDerivedFilters(filters) {
  return Boolean(filters.issueTag || filters.reviewTarget || filters.hasToolError || filters.slowOnly || filters.hasMedia)
}

function safeJson(value) {
  if (value === null || value === undefined) return value
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (!trimmed) return value
  if (!((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']')))) return value
  try {
    return JSON.parse(trimmed)
  } catch {
    return value
  }
}

function normalizeEvent(row) {
  return {
    type: row.event_type || row.type || 'unknown',
    occurredAt: row.occurred_at || row.occurredAt || null,
    title: row.title || '',
    body: row.body || '',
    payload: safeJson(row.payload || {}) || {},
  }
}

function objectText(value, max = 5000) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  try {
    return truncateText(JSON.stringify(value), max) || ''
  } catch {
    return String(value)
  }
}

function eventSearchText(event) {
  return [event.type, event.title, event.body, objectText(event.payload, 4000)].filter(Boolean).join('\n')
}

function collectValues(value, keyRegex, depth = 0, out = []) {
  if (depth > 8 || value === null || value === undefined) return out
  const parsed = safeJson(value)
  if (parsed !== value) return collectValues(parsed, keyRegex, depth + 1, out)
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 80)) collectValues(item, keyRegex, depth + 1, out)
    return out
  }
  if (typeof value !== 'object') return out
  for (const [key, raw] of Object.entries(value)) {
    if (keyRegex.test(key)) out.push(raw)
    collectValues(raw, keyRegex, depth + 1, out)
  }
  return out
}

function collectArrays(value, keyRegex, depth = 0, out = []) {
  if (depth > 8 || value === null || value === undefined) return out
  const parsed = safeJson(value)
  if (parsed !== value) return collectArrays(parsed, keyRegex, depth + 1, out)
  if (Array.isArray(value)) {
    out.push(value)
    for (const item of value.slice(0, 40)) collectArrays(item, keyRegex, depth + 1, out)
    return out
  }
  if (typeof value !== 'object') return out
  for (const [key, raw] of Object.entries(value)) {
    if (keyRegex.test(key) && Array.isArray(raw)) out.push(raw)
    collectArrays(raw, keyRegex, depth + 1, out)
  }
  return out
}

function firstStringValue(value, keyRegex) {
  const found = collectValues(value, keyRegex)
  for (const item of found) {
    if (typeof item === 'string' && item.trim()) return item.trim()
    if (item && typeof item !== 'object') return String(item)
  }
  return null
}

function extractKeyword(event) {
  const payload = safeJson(event.payload) || {}
  return firstStringValue(payload, /^(cleanKeyword|keyword|query|q|searchText|search)$/i)
    || firstStringValue(safeJson(event.body), /^(cleanKeyword|keyword|query|q|searchText|search)$/i)
}

function extractCandidates(event) {
  const payload = safeJson(event.payload) || {}
  const candidates = []
  const arrays = [
    ...collectArrays(payload, /^(candidates|items|products|results|rows|data)$/i),
    ...collectArrays(safeJson(event.body), /^(candidates|items|products|results|rows|data)$/i),
  ]
  for (const arr of arrays) {
    for (const item of arr.slice(0, 50)) {
      if (item && typeof item === 'object') candidates.push(item)
    }
  }
  return candidates.slice(0, 50)
}

function extractConfidenceScores(value) {
  const scores = []
  for (const raw of collectValues(value, /confidence|score|similarity|rank_score/i)) {
    const parsed = Number(raw)
    if (Number.isFinite(parsed)) scores.push(parsed > 1 ? parsed / 100 : parsed)
  }
  return scores
}

function meaningfulTokens(text) {
  const stopWords = new Set([
    'มี', 'ไหม', 'อะไร', 'บ้าง', 'รุ่น', 'ในระบบ', 'เหลือ', 'เช็ค', 'ตรวจ', 'ยอด', 'คงเหลือ',
    'สินค้า', 'หา', 'ค้นหา', 'ขอ', 'หน่อย', 'ครับ', 'ค่ะ', 'stock', 'available', 'find', 'search',
  ])
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}./-]+/gu, ' ')
    .split(/\s+/)
    .map(token => token.trim())
    .filter(token => token.length >= 2 && !stopWords.has(token))
    .slice(0, 12)
}

function candidateText(candidate) {
  return [
    candidate.code,
    candidate.item_code,
    candidate.sku,
    candidate.name,
    candidate.item_name,
    candidate.description,
  ].filter(Boolean).join(' ').toLowerCase()
}

function hasCandidateOverlap(keyword, candidates) {
  const tokens = meaningfulTokens(keyword)
  if (!tokens.length || !candidates.length) return true
  return candidates.some(candidate => {
    const text = candidateText(candidate)
    return tokens.some(token => text.includes(token))
  })
}

function preview(value, max = 280) {
  return redactText(objectText(value, max), max)
}

function duplicateFinalText(text) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim()
  if (normalized.length < 40) return false
  const half = Math.floor(normalized.length / 2)
  const a = normalized.slice(0, half).trim()
  const b = normalized.slice(half).trim()
  return a.length > 20 && b.includes(a.slice(0, Math.min(80, a.length)))
}

function replyHasRepetition(text) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim()
  if (!normalized) return false
  if (/(ครับ|ค่ะ|คะ|นะครับ|นะคะ){2,}/i.test(normalized)) return true
  if (/([\p{L}\p{N}])\1{5,}/u.test(normalized)) return true
  return false
}

function hasUnverifiedPricePhrase(text) {
  return /ราคา\s*(โดย)?ประมาณ|ราคาตลาด|ฐานข้อมูลทั่วไป|ปกติ\s*ราคา|โดยปกติ.*ราคา/i.test(String(text || ''))
}

function hasPriceEvidence(events) {
  return events.some(event => {
    const payload = safeJson(event.payload) || {}
    const bodyJson = safeJson(event.body)
    const text = eventSearchText(event)
    const toolName = firstStringValue(payload, /^name$/i) || event.title || ''
    const looksLikePriceTool = /price|ราคา|get_product_price/i.test(`${toolName}\n${event.title}`)
    const hasFailure = /(error|failed|fail|timeout|timed out|no[_ -]?result|not[_ -]?found|ไม่พบ)/i.test(text)
    if (looksLikePriceTool && !hasFailure) return true
    const priceValues = collectValues(payload, /price|unitPrice|unit_price|amount|ราคา/i)
      .concat(collectValues(bodyJson, /price|unitPrice|unit_price|amount|ราคา/i))
    return priceValues.some(value => {
      if (value === null || value === undefined) return false
      if (typeof value === 'number') return Number.isFinite(value)
      return /\d/.test(String(value))
    })
  })
}

function eventHasMedia(event) {
  const payload = safeJson(event.payload) || {}
  const mediaCount = Number(firstStringValue(payload, /^mediaCount$/i) || payload.mediaCount || 0)
  if (Number.isFinite(mediaCount) && mediaCount > 0) return true
  if (Array.isArray(payload.media) && payload.media.length > 0) return true
  return /\[user sent media|media without caption|image received|รูปภาพ|ส่งรูป/i.test(eventSearchText(event))
}

function hasLineDeliveryConfirmation(events) {
  return events.some(event => /line.*(send|reply|delivery).*(ok|success|sent)|delivery.*line.*(ok|success|sent)/i.test(eventSearchText(event)))
}

function estimateRequestedItemCount(text) {
  const raw = String(text || '').trim()
  if (!raw) return 0
  const lines = raw.split(/\n+/).map(line => line.trim()).filter(line => meaningfulTokens(line).length)
  if (lines.length >= 2) return Math.min(lines.length, 20)
  const numbered = raw.match(/(?:^|\s)(?:\d+[\).]|[•\-])\s*\S/gu)
  if (numbered?.length >= 2) return Math.min(numbered.length, 20)
  const parts = raw.split(/\s*(?:,|;|และ|กับ|\+)\s*/u)
    .map(part => part.trim())
    .filter(part => meaningfulTokens(part).length >= 1)
  return parts.length >= 2 ? Math.min(parts.length, 20) : 1
}

function deriveIssues(turnLike, rawEvents = []) {
  const turn = turnLike.turn_id ? rowToTurn(turnLike) : turnLike
  const events = rawEvents.map(normalizeEvent)
  const issues = []
  const seen = new Set()
  const finalText = turn.finalText || ''
  const userText = turn.userText || ''
  const combined = [userText, finalText, turn.rootCause, turn.status, turn.route, turn.intent].filter(Boolean).join('\n')
  const slowMs = slowTurnMs()
  const requestedItemCount = estimateRequestedItemCount(userText)
  const searchEvents = events.filter(event => {
    const payload = safeJson(event.payload) || {}
    const toolName = firstStringValue(payload, /^name$/i) || event.title || ''
    return /search_product|search/i.test(`${toolName}\n${event.title}`)
  })
  const hasMedia = events.some(eventHasMedia)

  function add(tag, evidence = {}, overrides = {}) {
    if (!ISSUE_DEFINITIONS[tag] || seen.has(tag)) return
    seen.add(tag)
    const definition = ISSUE_DEFINITIONS[tag]
    issues.push({
      tag,
      label: definition.label,
      reviewTarget: overrides.reviewTarget || definition.target,
      severity: overrides.severity || (tag === 'slow_turn' || tag === 'needs_user_refine' ? 'warn' : 'issue'),
      evidence: redactValue({
        ...evidence,
        userPreview: evidence.userPreview || preview(userText, 220),
        finalPreview: evidence.finalPreview || preview(finalText, 220),
      }),
    })
  }

  if (Number.isFinite(Number(turn.durationMs)) && Number(turn.durationMs) >= slowMs) {
    add('slow_turn', { durationMs: Number(turn.durationMs), thresholdMs: slowMs })
  }

  if (/model\/provider timeout|provider timeout|finish_reason error|all models failed|model chain failed/i.test(combined)) {
    add('model_timeout', { rootCause: turn.rootCause || null, durationMs: turn.durationMs })
  }

  if (hasMedia && (!finalText || /ไม่สามารถ.*(รูป|ภาพ)|ไม่รองรับ.*(รูป|ภาพ)|cannot.*(image|media)|unsupported.*(image|media)/i.test(finalText))) {
    add('media_no_visible_reply', {
      channel: turn.channel,
      status: turn.status,
      rootCause: turn.rootCause || null,
    })
  }

  if (hasMedia && /stalled session|stalled_agent_run|active_work_without_progress|queueDepth=\d+/i.test(combined.concat('\n', events.map(eventSearchText).join('\n')))) {
    add('stalled_after_media', {
      channel: turn.channel,
      status: turn.status,
      rootCause: turn.rootCause || null,
    })
  }

  if (hasMedia && turn.channel === 'line' && finalText && !hasLineDeliveryConfirmation(events)) {
    add('line_delivery_uncertain', {
      reason: 'assistant final text exists but no LINE delivery confirmation was captured in the analysis events',
      finalPreview: preview(finalText, 220),
    }, { severity: 'warn' })
  }

  if (turn.channel === 'line' && events.some(e => /line_burst_flush/i.test(eventSearchText(e)))) {
    add('line_burst_coalesced', {
      reason: 'LINE runtime grouped multiple nearby inbound events before dispatch',
    }, { severity: 'info' })
  }

  if (/model fallback|fallback selected|fallback_used|model_fallback_decision/i.test(combined) || events.some(e => /model fallback|fallback selected|fallback_used|model_fallback_decision/i.test(eventSearchText(e)))) {
    add('fallback_used', { model: turn.model || null })
  }

  if (/assistant reply contains duplicated text/i.test(combined) || finalText.includes('"])') || duplicateFinalText(finalText)) {
    add('duplicate_reply', { reason: 'duplicate marker or repeated final reply' })
  }
  if (replyHasRepetition(finalText)) {
    add('reply_repetition', { reason: 'repeated polite suffix or repeated characters' })
  }

  if (/something went wrong|current thinking|i will now perform|initiating cognitive/i.test(finalText) || finalText.includes('"])')) {
    add('language_quality', { reason: 'technical or low-quality text surfaced to user' })
  }
  if (hasUnverifiedPricePhrase(finalText) && !hasPriceEvidence(events)) {
    add('unverified_price_guess', { reason: 'price-like phrasing without price tool evidence' })
  }
  if (requestedItemCount >= 2 && (Number(turn.durationMs) >= slowMs || searchEvents.length >= 3)) {
    add('multi_item_slow', {
      requestedItemCount,
      searchToolCalls: searchEvents.length,
      durationMs: Number(turn.durationMs) || null,
      thresholdMs: slowMs,
    })
  }
  if (searchEvents.length >= 3) {
    const keywords = Array.from(new Set(searchEvents.map(extractKeyword).filter(Boolean))).slice(0, 10)
    add('search_retry_loop', {
      searchToolCalls: searchEvents.length,
      keywords,
    })
  }
  if (turn.channel === 'telegram' && turn.agentId === 'admin' && searchEvents.length > 0) {
    add('wrong_agent_or_capability', {
      reason: 'Telegram commerce/search turn routed through broad admin agent; confirm binding is intentional',
      agentId: turn.agentId,
      searchToolCalls: searchEvents.length,
    }, { severity: 'warn' })
  }

  const priceAsked = /ราคา|price/i.test(`${userText}\n${turn.intent || ''}`)
  const denied = /ไม่มีสิทธิ์|ไม่สามารถ|not authorized|permission|unsupported|ไม่รองรับ/i.test(finalText)
  if (priceAsked && denied) add('price_denied', { intent: turn.intent, route: turn.route })
  else if (denied) add('unsupported_capability', { intent: turn.intent, route: turn.route })

  for (const event of events) {
    const eventText = eventSearchText(event)
    const payload = safeJson(event.payload) || {}
    const toolName = firstStringValue(payload, /^name$/i) || event.title || ''
    const isTool = event.type === 'tool' || toolName
    const isSearch = /search_product|search/i.test(`${toolName}\n${event.title}`)
    const statusValues = collectValues(payload, /status|state|error|reason/i)
      .concat(collectValues(safeJson(event.body), /status|state|error|reason/i))
      .map(String)
    const statusText = statusValues.join(' ')
    const lower = `${eventText}\n${statusText}`.toLowerCase()

    if (isTool && /(error|failed|fail|exception|enoent|permission denied|timeout|timed out)/i.test(lower)) {
      add('tool_error', {
        tool: toolName || event.title || 'tool',
        status: statusText || null,
        eventPreview: preview(event.body || payload, 260),
      }, { reviewTarget: isSearch ? REVIEW_TARGETS.MCP_SEARCH : REVIEW_TARGETS.MODEL_RUNTIME })
    }

    if (!isSearch) continue

    const keyword = extractKeyword(event)
    const candidates = extractCandidates(event)
    const scores = extractConfidenceScores(payload).concat(extractConfidenceScores(safeJson(event.body)))
    const maxConfidence = scores.length ? Math.max(...scores) : null
    const explicitNoResult = statusValues.some(value => /^(no[_ -]?result|no[_ -]?results|not[_ -]?found|empty)$/i.test(value.trim()))
      || /ไม่พบสินค้า|ไม่พบข้อมูล|ไม่พบรายการ|search yielded no results|couldn.?t find any listings|no matching/i.test(`${event.body || ''}\n${finalText}`)
    const noResult = explicitNoResult && !statusValues.some(value => /needs[_ -]?refine|ambiguous|resolved/i.test(value))
    const needsRefine = statusValues.some(value => /needs[_ -]?refine|ambiguous/i.test(value))
      || /needs[_ -]?refine|ambiguous|refine keyword|ระบุ.*เพิ่ม|คำค้น.*เพิ่ม|กรุณาระบุ|กรุณาเลือก/i.test(`${event.body || ''}\n${finalText}`)
    const hasSelected = collectValues(payload, /^selected$|^resolved$|^found$/i).some(Boolean)

    if (noResult) {
      add('search_no_result', { tool: toolName, keyword, status: statusText || null, eventPreview: preview(event.body || payload, 260) })
    }
    if (maxConfidence !== null && maxConfidence < 0.45) {
      add('low_confidence_search', { tool: toolName, keyword, maxConfidence, candidatesShown: candidates.length })
    }
    if (candidates.length > 0 && keyword && !hasCandidateOverlap(keyword, candidates)) {
      add('wrong_product_candidates', { tool: toolName, keyword, candidatesShown: candidates.length, sampleCandidate: preview(candidates[0], 220) })
    }
    if (needsRefine) {
      add('needs_user_refine', { tool: toolName, keyword, candidatesShown: candidates.length, status: statusText || null })
    }
    if (!hasSelected && (/^\s*(รายการ|ข้อ)?\s*\d+\s*$/i.test(userText) || /กรุณาเลือกรหัสสินค้า|กรุณาระบุชื่อหรือรหัสสินค้า|เลือกไม่ได้/i.test(finalText))) {
      add('selection_not_resolved', { tool: toolName, keyword, candidatesShown: candidates.length }, {
        reviewTarget: /^\s*(รายการ|ข้อ)?\s*\d+\s*$/i.test(userText) ? REVIEW_TARGETS.SOUL : REVIEW_TARGETS.USER_AMBIGUITY,
      })
    }
  }

  if (/กรุณาระบุ.*(ยี่ห้อ|รุ่น|ขนาด|รหัส|คำค้น)|ระบุ.*ให้ชัด|please specify|refine/i.test(finalText)) {
    add('needs_user_refine', { reason: 'assistant asked user to refine input' })
  }

  return issues
}

function decodeCursor(cursor) {
  if (!cursor) return null
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    return null
  }
}

function encodeCursor(turn) {
  if (!turn) return null
  return Buffer.from(JSON.stringify({ startedAt: turn.started_at, turnId: turn.turn_id })).toString('base64url')
}

function encodeCursorFromTurn(turn) {
  if (!turn) return null
  return Buffer.from(JSON.stringify({ startedAt: turn.startedAt, turnId: turn.id })).toString('base64url')
}

function buildWhere(filters, params, alias = 't') {
  const clauses = [`${alias}.started_at >= $${params.push(filters.from.toISOString())}`, `${alias}.started_at <= $${params.push(filters.to.toISOString())}`]
  for (const [field, column] of [
    ['agent', 'agent_id'],
    ['channel', 'channel'],
    ['user', 'chat_user'],
    ['intent', 'intent'],
    ['route', 'route'],
    ['status', 'status'],
    ['model', 'model'],
  ]) {
    if (filters[field]) clauses.push(`${alias}.${column} = $${params.push(filters[field])}`)
  }
  if (filters.q) {
    const pattern = `%${filters.q.replace(/[%_]/g, ch => `\\${ch}`)}%`
    const idx = params.push(pattern)
    clauses.push(`(${alias}.turn_id ILIKE $${idx} ESCAPE '\\' OR ${alias}.user_text ILIKE $${idx} ESCAPE '\\' OR ${alias}.final_text ILIKE $${idx} ESCAPE '\\' OR EXISTS (
      SELECT 1 FROM conversation_events e WHERE e.turn_id = ${alias}.turn_id AND (e.title ILIKE $${idx} ESCAPE '\\' OR e.body ILIKE $${idx} ESCAPE '\\')
    ))`)
  }
  const decodedCursor = decodeCursor(filters.cursor)
  if (decodedCursor?.startedAt && decodedCursor?.turnId) {
    clauses.push(`(${alias}.started_at, ${alias}.turn_id) < ($${params.push(decodedCursor.startedAt)}::timestamptz, $${params.push(decodedCursor.turnId)})`)
  }
  return clauses.join(' AND ')
}

async function fetchTurnRows(filters, options = {}) {
  const params = []
  const where = buildWhere(options.includeCursor === false ? { ...filters, cursor: null } : filters, params)
  const limit = options.limit ? Math.min(Math.max(Number(options.limit), 1), MAX_EXPORT_TURNS + 1) : filters.limit + 1
  const limitParam = params.push(limit)
  const direction = options.order === 'asc' ? 'ASC' : 'DESC'
  const { rows } = await pgPool.query(`
    SELECT turn_id, source, session_key, started_at, agent_id, channel, chat_user, user_text, final_text,
           route, intent, status, root_cause, duration_ms, ack_ms, model_ms, model, provider,
           input_tokens, output_tokens, cost, tool_count, warning_count
    FROM conversation_turns t
    WHERE ${where}
    ORDER BY started_at ${direction}, turn_id ${direction}
    LIMIT $${limitParam}
  `, params)
  return rows
}

async function loadEventsByTurnId(turnIds) {
  const ids = Array.from(new Set(turnIds.filter(Boolean)))
  if (!ids.length) return new Map()
  const { rows } = await pgPool.query(`
    SELECT turn_id, event_type, occurred_at, title, body, payload
    FROM conversation_events
    WHERE turn_id = ANY($1::text[])
    ORDER BY turn_id ASC, event_index ASC, id ASC
  `, [ids])
  const map = new Map()
  for (const row of rows) {
    const event = normalizeEvent(row)
    const list = map.get(row.turn_id) || []
    list.push(event)
    map.set(row.turn_id, list)
  }
  return map
}

async function enrichRowsWithIssues(rows) {
  const eventsByTurnId = await loadEventsByTurnId(rows.map(row => row.turn_id))
  return rows.map(row => {
    const events = eventsByTurnId.get(row.turn_id) || []
    const issues = deriveIssues(row, events)
    return rowToTurn(row, issues, events)
  })
}

function applyDerivedFilters(turns, filters) {
  return turns.filter(turn => {
    if (filters.issueTag && filters.issueTag !== 'has_media' && !turn.issueTags.includes(filters.issueTag)) return false
    if (filters.reviewTarget && !turn.reviewTargets.includes(filters.reviewTarget)) return false
    if (filters.hasToolError && !turn.issueTags.includes('tool_error')) return false
    if (filters.slowOnly && !turn.issueTags.includes('slow_turn')) return false
    if (filters.hasMedia && !turn.hasMedia) return false
    return true
  })
}

function summaryFromTurns(turns) {
  const byStatus = {}
  const byRoute = {}
  const byIntent = {}
  const durations = []
  let totalCost = 0
  let inputTokens = 0
  let outputTokens = 0
  let modelTurns = 0
  let toolOnlyTurns = 0
  const users = new Set()
  let issueCount = 0
  for (const turn of turns) {
    byStatus[turn.status || 'unknown'] = (byStatus[turn.status || 'unknown'] || 0) + 1
    byRoute[turn.route || 'unknown'] = (byRoute[turn.route || 'unknown'] || 0) + 1
    byIntent[turn.intent || 'unknown'] = (byIntent[turn.intent || 'unknown'] || 0) + 1
    if (turn.user) users.add(turn.user)
    if (turn.issueTags?.length || ['warn', 'error'].includes(turn.status)) issueCount += 1
    if (Number.isFinite(Number(turn.durationMs))) durations.push(Number(turn.durationMs))
    if (Number.isFinite(Number(turn.cost))) totalCost += Number(turn.cost)
    if (Number.isFinite(Number(turn.inputTokens))) inputTokens += Number(turn.inputTokens)
    if (Number.isFinite(Number(turn.outputTokens))) outputTokens += Number(turn.outputTokens)
    if (turn.route === 'model_path') modelTurns += 1
    else toolOnlyTurns += 1
  }
  durations.sort((a, b) => a - b)
  const percentile = p => {
    if (!durations.length) return null
    const index = Math.min(durations.length - 1, Math.ceil(durations.length * p) - 1)
    return durations[index]
  }
  return {
    count: turns.length,
    uniqueUsers: users.size,
    issueCount,
    modelTurns,
    toolOnlyTurns,
    totalCost,
    inputTokens,
    outputTokens,
    avgDurationMs: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : null,
    p50DurationMs: percentile(0.5),
    p95DurationMs: percentile(0.95),
    byStatus,
    byRoute,
    byIntent,
  }
}

async function queryConversations(rawFilters = {}) {
  await ensureSchema()
  const filters = parseQueryFilters(rawFilters)
  const derived = hasDerivedFilters(filters)
  const scanLimit = derived ? analysisScanLimit() : filters.limit + 1
  const rows = await fetchTurnRows(filters, { limit: scanLimit + (derived ? 1 : 0), order: 'desc' })
  const enriched = await enrichRowsWithIssues(rows.slice(0, scanLimit))
  const filteredTurns = derived ? applyDerivedFilters(enriched, filters) : enriched
  const pageTurns = filteredTurns.slice(0, filters.limit)
  const hasMore = pageTurns.length > 0 && (derived
    ? filteredTurns.length > filters.limit || rows.length > scanLimit
    : rows.length > filters.limit)
  const nextCursor = hasMore ? encodeCursorFromTurn(pageTurns[pageTurns.length - 1]) : null
  const summary = derived ? summaryFromTurns(filteredTurns) : await querySummary(filters)
  return {
    generatedAt: new Date().toISOString(),
    filters: serializeFilters(filters),
    summary,
    turns: pageTurns,
    hasMore,
    nextCursor,
    warnings: derived && rows.length > scanLimit
      ? [{ type: 'scan_truncated', summary: `Issue filter scanned ${scanLimit} recent turns. Narrow the date range for complete results.` }]
      : [],
  }
}

function serializeFilters(filters) {
  return {
    ...filters,
    from: filters.from.toISOString(),
    to: filters.to.toISOString(),
  }
}

function mediaSummaryFromEvents(events = [], row = {}) {
  let mediaCount = 0
  const media = []
  for (const event of events) {
    const payload = safeJson(event.payload || {}) || {}
    const direct = Array.isArray(payload.media) ? payload.media : []
    const nested = Array.isArray(payload.user?.media) ? payload.user.media : []
    const found = [...direct, ...nested].filter(Boolean)
    if (found.length) media.push(...found)
    const payloadCount = Number(payload.mediaCount ?? payload.user?.mediaCount)
    if (Number.isFinite(payloadCount) && payloadCount > mediaCount) mediaCount = payloadCount
  }
  if (media.length > mediaCount) mediaCount = media.length
  if (!mediaCount && /\[user sent media|media without caption|<media:/i.test(String(row.user_text || ''))) mediaCount = 1
  const normalizedMedia = normalizeConversationMediaList(media)
  return {
    mediaCount,
    hasMedia: mediaCount > 0,
    media: normalizedMedia,
  }
}

function rowToTurn(row, issues = [], events = []) {
  const issueTags = issues.map(issue => issue.tag)
  const reviewTargets = Array.from(new Set(issues.map(issue => issue.reviewTarget).filter(Boolean)))
  const mediaSummary = mediaSummaryFromEvents(events, row)
  return {
    id: row.turn_id,
    source: row.source,
    sessionKey: row.session_key,
    startedAt: row.started_at instanceof Date ? row.started_at.toISOString() : row.started_at,
    agentId: row.agent_id,
    channel: row.channel,
    user: row.chat_user,
    userText: row.user_text,
    finalText: row.final_text,
    route: row.route,
    intent: row.intent,
    status: row.status,
    rootCause: row.root_cause,
    durationMs: row.duration_ms,
    ackMs: row.ack_ms,
    modelMs: row.model_ms,
    model: row.model,
    provider: row.provider,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cost: row.cost === null ? null : Number(row.cost),
    toolCount: row.tool_count,
    warningCount: row.warning_count,
    issues,
    issueTags,
    reviewTargets,
    primaryIssueTag: issueTags[0] || null,
    primaryReviewTarget: reviewTargets[0] || null,
    mediaCount: mediaSummary.mediaCount,
    hasMedia: mediaSummary.hasMedia,
    media: mediaSummary.media,
  }
}

async function querySummary(filters) {
  const params = []
  const where = buildWhere({ ...filters, cursor: null }, params)
  const [agg, status, route, intent] = await Promise.all([
    pgPool.query(`
      SELECT COUNT(*)::int AS count,
             COUNT(DISTINCT chat_user)::int AS unique_users,
             COUNT(*) FILTER (WHERE status IN ('warn','error'))::int AS issue_count,
             COUNT(*) FILTER (WHERE route = 'model_path')::int AS model_turns,
             COUNT(*) FILTER (WHERE route <> 'model_path')::int AS tool_only_turns,
             COALESCE(SUM(cost), 0)::float AS total_cost,
             COALESCE(SUM(input_tokens), 0)::int AS input_tokens,
             COALESCE(SUM(output_tokens), 0)::int AS output_tokens,
             ROUND(AVG(duration_ms))::int AS avg_duration_ms,
             (percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE duration_ms IS NOT NULL))::int AS p50_duration_ms,
             (percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE duration_ms IS NOT NULL))::int AS p95_duration_ms
      FROM conversation_turns t
      WHERE ${where}
    `, params),
    groupSummary(filters, 'status'),
    groupSummary(filters, 'route'),
    groupSummary(filters, 'intent'),
  ])
  return {
    count: agg.rows[0]?.count || 0,
    uniqueUsers: agg.rows[0]?.unique_users || 0,
    issueCount: agg.rows[0]?.issue_count || 0,
    modelTurns: agg.rows[0]?.model_turns || 0,
    toolOnlyTurns: agg.rows[0]?.tool_only_turns || 0,
    totalCost: Number(agg.rows[0]?.total_cost || 0),
    inputTokens: agg.rows[0]?.input_tokens || 0,
    outputTokens: agg.rows[0]?.output_tokens || 0,
    avgDurationMs: agg.rows[0]?.avg_duration_ms || null,
    p50DurationMs: agg.rows[0]?.p50_duration_ms || null,
    p95DurationMs: agg.rows[0]?.p95_duration_ms || null,
    byStatus: status,
    byRoute: route,
    byIntent: intent,
  }
}

async function groupSummary(filters, column) {
  const allowed = new Set(['status', 'route', 'intent'])
  if (!allowed.has(column)) return {}
  const params = []
  const where = buildWhere({ ...filters, cursor: null }, params)
  const { rows } = await pgPool.query(`
    SELECT ${column} AS key, COUNT(*)::int AS count
    FROM conversation_turns t
    WHERE ${where}
    GROUP BY ${column}
    ORDER BY count DESC
    LIMIT 12
  `, params)
  return Object.fromEntries(rows.map(row => [row.key || 'unknown', row.count]))
}

function increment(map, key, amount = 1) {
  if (!key) return
  map.set(key, (map.get(key) || 0) + amount)
}

function topEntries(map, limit = 12) {
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .slice(0, limit)
    .map(([key, count]) => ({ key, count }))
}

async function loadAnalyzedTurns(rawFilters = {}, options = {}) {
  const filters = parseQueryFilters({ ...rawFilters, cursor: options.includeCursor === true ? rawFilters.cursor : null })
  const limit = options.limit || MAX_EXPORT_TURNS + 1
  const rows = await fetchTurnRows(filters, { limit, order: options.order || 'desc', includeCursor: options.includeCursor === true })
  const turns = await enrichRowsWithIssues(rows)
  return {
    filters,
    turns: applyDerivedFilters(turns, filters),
    scanned: rows.length,
  }
}

async function queryInsights(rawFilters = {}) {
  await ensureSchema()
  const { filters, turns, scanned } = await loadAnalyzedTurns(rawFilters, { limit: Math.min(MAX_EXPORT_TURNS + 1, analysisScanLimit() * 4), order: 'desc' })
  const tagCounts = new Map()
  const keywordCounts = new Map()
  const agentCounts = new Map()
  const reviewTargetCounts = new Map()
  const toolFailureCounts = new Map()
  let issueTurns = 0
  let slowTurns = 0
  let noResultTurns = 0
  let toolErrorTurns = 0
  const durations = []
  const examples = []

  for (const turn of turns) {
    if (Number.isFinite(Number(turn.durationMs))) durations.push(Number(turn.durationMs))
    if (!turn.issueTags.length) continue
    issueTurns += 1
    if (turn.issueTags.includes('slow_turn')) slowTurns += 1
    if (turn.issueTags.includes('search_no_result')) noResultTurns += 1
    if (turn.issueTags.includes('tool_error')) toolErrorTurns += 1
    increment(agentCounts, turn.agentId || 'unknown')
    for (const target of turn.reviewTargets) increment(reviewTargetCounts, target)
    for (const issue of turn.issues) {
      increment(tagCounts, issue.tag)
      const keyword = issue.evidence?.keyword
      if (keyword) increment(keywordCounts, String(keyword).slice(0, 120))
      const tool = issue.evidence?.tool
      if (issue.tag === 'tool_error' && tool) increment(toolFailureCounts, String(tool).slice(0, 120))
    }
    if (examples.length < 20) {
      examples.push({
        id: turn.id,
        startedAt: turn.startedAt,
        agentId: turn.agentId,
        channel: turn.channel,
        userText: preview(turn.userText, 240),
        finalText: preview(turn.finalText, 240),
        issueTags: turn.issueTags,
        reviewTargets: turn.reviewTargets,
        durationMs: turn.durationMs,
      })
    }
  }

  durations.sort((a, b) => a - b)
  const p95 = durations.length ? durations[Math.min(durations.length - 1, Math.ceil(durations.length * 0.95) - 1)] : null

  return {
    generatedAt: new Date().toISOString(),
    filters: serializeFilters(filters),
    scanned,
    summary: {
      totalTurns: turns.length,
      issueTurns,
      issueRate: turns.length ? issueTurns / turns.length : 0,
      slowTurns,
      slowP95Ms: p95,
      noResultTurns,
      toolErrorTurns,
      agentsNeedingReview: agentCounts.size,
    },
    topIssueTags: topEntries(tagCounts, 12).map(item => ({
      ...item,
      label: ISSUE_DEFINITIONS[item.key]?.label || item.key,
      reviewTarget: ISSUE_DEFINITIONS[item.key]?.target || null,
    })),
    topFailedKeywords: topEntries(keywordCounts, 12),
    toolFailures: topEntries(toolFailureCounts, 12),
    agentBreakdown: topEntries(agentCounts, 12),
    reviewTargets: topEntries(reviewTargetCounts, 8),
    examples,
    warnings: scanned > MAX_EXPORT_TURNS
      ? [{ type: 'scan_truncated', summary: `Insights are capped at ${MAX_EXPORT_TURNS} turns. Narrow the date range for complete analysis.` }]
      : [],
  }
}

async function getConversationDetail(turnId) {
  await ensureSchema()
  const turnRes = await pgPool.query('SELECT * FROM conversation_turns WHERE turn_id = $1', [turnId])
  if (!turnRes.rows.length) return null
  const eventsRes = await pgPool.query(`
    SELECT event_type, occurred_at, title, body, payload
    FROM conversation_events
    WHERE turn_id = $1
    ORDER BY event_index ASC, id ASC
  `, [turnId])
  const events = eventsRes.rows.map(normalizeEvent)
  const issues = deriveIssues(turnRes.rows[0], events)
  const turn = rowToTurn(turnRes.rows[0], issues, events)
  const learning = await memoryAuto.buildLearningDetail(turn).catch(() => ({
    learningSignals: [],
    memoryUsage: [],
    memoryDecisions: [],
  }))
  return {
    turn,
    events: events.map(event => ({
      type: event.type,
      occurredAt: event.occurredAt instanceof Date ? event.occurredAt.toISOString() : event.occurredAt,
      title: event.title,
      body: event.body,
      payload: stripInternalMediaRefs(event.payload || {}),
    })),
    ...learning,
  }
}

function daysBetween(from, to) {
  return Math.max(0, (to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000))
}

async function exportConversations(rawFilters, format, actor) {
  await ensureSchema()
  const filters = parseQueryFilters({ ...rawFilters, limit: MAX_QUERY_LIMIT })
  const mode = String(rawFilters.mode || 'raw').toLowerCase()
  if (daysBetween(filters.from, filters.to) > MAX_EXPORT_DAYS) {
    const err = new Error(`Export range is limited to ${MAX_EXPORT_DAYS} days`)
    err.statusCode = 400
    throw err
  }

  const rows = await fetchTurnRows(filters, { limit: MAX_EXPORT_TURNS + 1, order: 'asc', includeCursor: false })
  if (rows.length > MAX_EXPORT_TURNS) {
    const err = new Error(`Export is limited to ${MAX_EXPORT_TURNS} turns. Narrow the date range or filters.`)
    err.statusCode = 400
    throw err
  }

  const enriched = await enrichRowsWithIssues(rows)
  const turns = mode === 'raw' ? enriched : applyDerivedFilters(enriched, filters)
  const eventsByTurnId = mode === 'raw' && format !== 'jsonl' ? new Map() : await loadEventsByTurnId(turns.map(turn => turn.id))

  await pgPool.query(
    'INSERT INTO conversation_exports (actor, format, filters, row_count) VALUES ($1,$2,$3::jsonb,$4)',
    [actor || null, mode === 'raw' ? format : mode, JSON.stringify({ ...serializeFilters(filters), mode }), turns.length]
  )

  if (mode === 'codex_review_pack') {
    return {
      contentType: 'text/markdown; charset=utf-8',
      filename: 'conversation-codex-review-pack.md',
      body: await toCodexReviewPack(turns, filters, eventsByTurnId),
    }
  }
  if (mode === 'issues_csv') {
    return { contentType: 'text/csv; charset=utf-8', filename: 'conversation-issues.csv', body: toIssuesCsv(turns) }
  }
  if (mode === 'events_jsonl') {
    return { contentType: 'application/x-ndjson; charset=utf-8', filename: 'conversation-events.jsonl', body: toEventsJsonl(turns, eventsByTurnId) }
  }
  if (mode === 'learning_review_pack') {
    return {
      contentType: 'text/markdown; charset=utf-8',
      filename: 'conversation-learning-review-pack.md',
      body: toLearningReviewPack(turns, filters, eventsByTurnId),
    }
  }

  if (format === 'csv') return { contentType: 'text/csv; charset=utf-8', filename: 'conversation-history.csv', body: toCsv(turns) }
  if (format === 'jsonl') return { contentType: 'application/x-ndjson; charset=utf-8', filename: 'conversation-history.jsonl', body: turns.map(turn => JSON.stringify(turn)).join('\n') + '\n' }
  if (format === 'markdown') return { contentType: 'text/markdown; charset=utf-8', filename: 'conversation-history.md', body: toMarkdown(turns) }
  const err = new Error('Unsupported export format')
  err.statusCode = 400
  throw err
}

function csvEscape(value) {
  const text = value === null || value === undefined ? '' : String(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function toCsv(rows) {
  const cols = ['started_at', 'agent_id', 'channel', 'chat_user', 'status', 'route', 'intent', 'model', 'duration_ms', 'cost', 'media_count', 'user_text', 'final_text']
  const lines = [cols.join(',')]
  for (const row of rows) {
    const turn = row.turn_id ? rowToTurn(row) : row
    const values = {
      started_at: turn.startedAt,
      agent_id: turn.agentId,
      channel: turn.channel,
      chat_user: turn.user,
      status: turn.status,
      route: turn.route,
      intent: turn.intent,
      model: turn.model,
      duration_ms: turn.durationMs,
      cost: turn.cost,
      media_count: turn.mediaCount || 0,
      user_text: turn.userText,
      final_text: turn.finalText,
    }
    lines.push(cols.map(col => csvEscape(values[col])).join(','))
  }
  return lines.join('\n') + '\n'
}

function toMarkdown(rows) {
  const lines = ['# Conversation History', '']
  for (const row of rows) {
    const turn = row.turn_id ? rowToTurn(row) : row
    lines.push(`## ${turn.startedAt} · ${turn.agentId || 'unknown'} · ${turn.channel}`)
    lines.push('')
    lines.push(`- Status: ${turn.status}`)
    lines.push(`- Route: ${turn.route}`)
    lines.push(`- Intent: ${turn.intent}`)
    if (turn.model) lines.push(`- Model: ${turn.model}`)
    if (turn.mediaCount) lines.push(`- Media: ${turn.mediaCount} attachment(s), metadata only`)
    lines.push('')
    lines.push('**User**')
    lines.push('')
    lines.push(turn.userText || '(empty)')
    lines.push('')
    lines.push('**Assistant**')
    lines.push('')
    lines.push(turn.finalText || '(no final reply)')
    lines.push('')
  }
  return lines.join('\n')
}

function toolChainFromEvents(events = []) {
  return events
    .filter(event => event.type === 'tool')
    .map(event => {
      const payload = safeJson(event.payload || {}) || {}
      const name = firstStringValue(payload, /^name$/i) || event.title || 'tool'
      const status = firstStringValue(payload, /^status$/i) || ''
      const duration = firstStringValue(payload, /^durationMs$/i) || ''
      return [name, status, duration ? `${duration}ms` : null].filter(Boolean).join(' ')
    })
    .slice(0, 8)
}

function toIssuesCsv(turns) {
  const cols = [
    'started_at', 'agent_id', 'channel', 'chat_user', 'status', 'route', 'intent',
    'review_targets', 'issue_tags', 'evidence', 'keyword', 'model', 'duration_ms', 'media_count',
    'user_text', 'final_text',
  ]
  const lines = [cols.join(',')]
  for (const turn of turns) {
    const evidence = turn.issues.map(issue => `${issue.tag}: ${preview(issue.evidence, 360)}`).join(' | ')
    const keyword = turn.issues.map(issue => issue.evidence?.keyword).filter(Boolean).join(' | ')
    const values = {
      started_at: turn.startedAt,
      agent_id: turn.agentId,
      channel: turn.channel,
      chat_user: turn.user,
      status: turn.status,
      route: turn.route,
      intent: turn.intent,
      review_targets: turn.reviewTargets.join('|'),
      issue_tags: turn.issueTags.join('|'),
      evidence,
      keyword,
      model: turn.model,
      duration_ms: turn.durationMs,
      media_count: turn.mediaCount || 0,
      user_text: turn.userText,
      final_text: turn.finalText,
    }
    lines.push(cols.map(col => csvEscape(values[col])).join(','))
  }
  return lines.join('\n') + '\n'
}

function toEventsJsonl(turns, eventsByTurnId) {
  return turns.map(turn => JSON.stringify({
    turn,
    issues: turn.issues,
    events: (eventsByTurnId.get(turn.id) || []).map(event => ({
      ...event,
      body: redactText(event.body, 5000),
      payload: stripInternalMediaRefs(redactValue(event.payload || {})),
    })),
  })).join('\n') + '\n'
}

function issueSummaryForTurns(turns) {
  const counts = new Map()
  for (const turn of turns) for (const tag of turn.issueTags) increment(counts, tag)
  return topEntries(counts, ISSUE_TAGS.length)
}

function readGitCommit(repoPath) {
  try {
    const gitDir = path.join(repoPath, '.git')
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim()
    if (head.startsWith('ref:')) {
      const ref = head.slice(5).trim()
      return fs.readFileSync(path.join(gitDir, ref), 'utf8').trim().slice(0, 12)
    }
    return head.slice(0, 12)
  } catch {
    return null
  }
}

function normalizeModelSummary(value) {
  if (!value) return null
  if (typeof value === 'string') return { primary: value, fallbacks: [] }
  if (typeof value !== 'object' || Array.isArray(value)) return null
  return {
    primary: String(value.primary || ''),
    fallbacks: Array.isArray(value.fallbacks) ? value.fallbacks.map(String).slice(0, 8) : [],
    timeoutMs: value.timeoutMs || undefined,
  }
}

function summarizeConfig(config) {
  const agents = Array.isArray(config?.agents?.list) ? config.agents.list : []
  const routeBindings = Array.isArray(config?.bindings) ? config.bindings : []
  return {
    model: {
      defaults: normalizeModelSummary(config?.agents?.defaults?.model),
      imageModel: normalizeModelSummary(config?.agents?.defaults?.imageModel),
    },
    agents: agents.map(agent => ({
      id: agent.id,
      model: normalizeModelSummary(agent.model),
      imageModel: normalizeModelSummary(agent.imageModel),
      toolsAllow: Array.isArray(agent.tools?.allow) ? agent.tools.allow.slice(0, 40) : [],
    })).slice(0, 80),
    channelBindings: routeBindings
      .filter(binding => binding?.type === 'route' && ['line', 'telegram', 'webchat'].includes(binding.match?.channel))
      .map(binding => ({
        channel: binding.match?.channel || null,
        accountId: binding.match?.accountId || 'default',
        agentId: binding.agentId || null,
        peerKind: binding.match?.peer?.kind || null,
        hasPeerScope: Boolean(binding.match?.peer?.id),
      }))
      .slice(0, 120),
    channels: {
      lineAccounts: Object.keys(config?.channels?.line?.accounts || {}).sort(),
      telegramAccounts: Object.keys(config?.channels?.telegram?.accounts || {}).sort(),
      hasLineDefault: Boolean(config?.channels?.line?.channelAccessToken),
      hasTelegramDefault: Boolean(config?.channels?.telegram?.botToken),
    },
  }
}

function shortMemory(memory) {
  return {
    id: memory.id,
    agentId: memory.agentId,
    status: memory.status,
    type: memory.type,
    scope: memory.scope,
    confidence: memory.confidence,
    sourceAuthority: memory.sourceAuthority,
    usageCount: memory.usageCount,
    lastUsedAt: memory.lastUsedAt,
    content: redactText(memory.content || '', 360),
  }
}

function profileSummary(profile) {
  return {
    id: profile.id,
    name: profile.name,
    nameTh: profile.nameTh,
    businessType: profile.businessType,
    agentIds: Array.isArray(profile.agentIds) ? profile.agentIds : [],
    summary: redactText(profile.summary || '', 360),
    soulBlockHash: profile.soulBlockHash || null,
    soulBlockChars: String(profile.soulBlock || '').length,
  }
}

async function buildCodexContextSnapshot(turns) {
  const warnings = []
  let config = null
  try {
    config = readOpenclawConfig()
  } catch (err) {
    warnings.push(`OpenClaw config unavailable: ${err.message}`)
  }

  const configSummary = config ? summarizeConfig(config) : null
  const agentIds = Array.from(new Set([
    ...turns.map(turn => turn.agentId).filter(Boolean),
    ...(configSummary?.channelBindings || []).map(binding => binding.agentId).filter(Boolean),
  ])).slice(0, 40)

  let memorySummary = {}
  let policies = []
  let activeMemories = []
  let blockedMemories = []
  let recentObservations = []
  try {
    memorySummary = await memoryAuto.summaryForAgents(agentIds)
    policies = (await memoryAuto.listPolicies()).policies
      .filter(policy => !agentIds.length || agentIds.includes(policy.agentId))
      .map(policy => ({
        agentId: policy.agentId,
        mode: policy.mode,
        maxContextChars: policy.maxContextChars,
        safeTypes: policy.safeTypes,
        allowChatTeaching: policy.allowChatTeaching,
        updatedAt: policy.updatedAt,
      }))
    const memories = await Promise.all(agentIds.map(agentId => memoryAuto.listMemories({ agentId, limit: 60 }).then(result => result.memories)))
    const flattened = memories.flat()
    activeMemories = flattened.filter(memory => memory.status === 'active').slice(0, 80).map(shortMemory)
    blockedMemories = flattened.filter(memory => memory.status === 'blocked').slice(0, 80).map(shortMemory)
    const observations = await Promise.all(agentIds.map(agentId => memoryAuto.listObservations({ agentId, limit: 40 }).then(result => result.observations)))
    recentObservations = observations.flat().slice(0, 120).map(observation => ({
      id: observation.id,
      agentId: observation.agentId,
      status: observation.status,
      type: observation.type,
      scope: observation.scope,
      risk: observation.risk,
      confidence: observation.confidence,
      recommendedAction: observation.recommendedAction,
      sourceTurnId: observation.sourceTurnId,
      summary: redactText(observation.summary || '', 360),
    }))
  } catch (err) {
    warnings.push(`Memory snapshot unavailable: ${err.message}`)
  }

  let profiles = []
  try {
    profiles = (await businessProfiles.listProfiles()).map(profileSummary)
  } catch (err) {
    warnings.push(`Business Profile snapshot unavailable: ${err.message}`)
  }

  let runtimeVersion = null
  try {
    runtimeVersion = await getOpenclawVersion()
  } catch (err) {
    warnings.push(`Runtime version unavailable: ${err.message}`)
  }

  return {
    generatedAt: new Date().toISOString(),
    warnings,
    versions: {
      openclawApiCommit: readGitCommit(path.resolve(__dirname, '..')),
      openclawAdminCommit: readGitCommit(process.env.OPENCLAW_ADMIN_ROOT || path.join(HOME, 'openclaw-admin')),
      runtimeVersion,
      nodeVersion: process.version,
    },
    config: configSummary,
    memory: {
      agentIds,
      summaryByAgent: memorySummary,
      policies,
      activeMemories,
      blockedMemories,
      recentObservations,
    },
    businessProfiles: profiles,
    privacy: {
      note: 'Secrets, API keys, channel tokens, authorization headers, local media refs, and long payloads are redacted/truncated. Image/file binaries are not exported.',
      mediaPolicy: 'Media is represented as metadata only.',
    },
  }
}

function pushJsonBlock(lines, value) {
  lines.push('```json')
  lines.push(JSON.stringify(redactValue(value), null, 2))
  lines.push('```')
}

function appendCodexContextSnapshot(lines, snapshot) {
  lines.push('## System Context Snapshot', '')
  lines.push('This snapshot is included so Codex can analyze conversations without AnyDesk, terminal access, or screenshots.')
  lines.push('')
  if (snapshot.warnings.length) {
    lines.push('### Snapshot Warnings', '')
    for (const warning of snapshot.warnings) lines.push(`- ${warning}`)
    lines.push('')
  }
  lines.push('### Versions', '')
  pushJsonBlock(lines, snapshot.versions)
  lines.push('')
  lines.push('### Channel And Model Config', '')
  pushJsonBlock(lines, snapshot.config || {})
  lines.push('')
  lines.push('### Memory Policy And State', '')
  pushJsonBlock(lines, snapshot.memory)
  lines.push('')
  lines.push('### Business Profiles', '')
  pushJsonBlock(lines, snapshot.businessProfiles)
  lines.push('')
  lines.push('### Privacy Notes', '')
  pushJsonBlock(lines, snapshot.privacy)
  lines.push('')
}

async function toCodexReviewPack(turns, filters, eventsByTurnId) {
  const contextSnapshot = await buildCodexContextSnapshot(turns)
  const issueSummary = issueSummaryForTurns(turns)
  const lines = [
    '# Conversation Review Pack For SOUL/MCP Tuning',
    '',
    `Generated: ${new Date().toISOString()}`,
    `Date range: ${filters.from.toISOString()} to ${filters.to.toISOString()}`,
    `Filters: agent=${filters.agent || '*'}, channel=${filters.channel || '*'}, issue=${filters.issueTag || '*'}, reviewTarget=${filters.reviewTarget || '*'}`,
    `Total turns: ${turns.length}`,
    '',
  ]
  appendCodexContextSnapshot(lines, contextSnapshot)
  lines.push('## Issue Summary', '')
  if (!issueSummary.length) lines.push('- No deterministic issues were flagged in this export.')
  for (const item of issueSummary) {
    const def = ISSUE_DEFINITIONS[item.key]
    lines.push(`- ${item.key}: ${item.count} turns${def?.target ? ` · target ${def.target}` : ''}`)
  }
  lines.push('', '## Candidate SOUL/MCP Questions', '')
  lines.push('- Did the agent ask for confirmation even when the tool returned a selected product?')
  lines.push('- Does search_product frequently return no result or low-confidence candidates for real user wording?')
  lines.push('- Are unsupported capability denials clear enough for the user to recover?')
  lines.push('- Are slow turns caused by model/runtime latency, MCP/search, or user ambiguity?')
  lines.push('- Which repeated user questions should become SOUL guidance versus MCP/search normalization?')
  lines.push('')

  for (const tag of ISSUE_TAGS) {
    const examples = turns.filter(turn => turn.issueTags.includes(tag)).slice(0, 20)
    if (!examples.length) continue
    const def = ISSUE_DEFINITIONS[tag]
    lines.push(`## ${tag} (${def?.target || 'review'})`, '')
    for (const turn of examples) {
      const events = eventsByTurnId.get(turn.id) || []
      const toolChain = toolChainFromEvents(events)
      const matching = turn.issues.filter(issue => issue.tag === tag)
      lines.push(`### ${turn.startedAt} · ${turn.agentId || 'unknown'} · ${turn.channel} · ${turn.id}`)
      lines.push('')
      lines.push(`- Review target: ${turn.reviewTargets.join(', ') || def?.target || 'unknown'}`)
      lines.push(`- Route / intent / status: ${turn.route} / ${turn.intent} / ${turn.status}`)
      lines.push(`- Model: ${turn.model || 'none'} · Latency: ${turn.durationMs ?? 'n/a'}ms · Cost: ${turn.cost ?? 0}`)
      if (turn.mediaCount) lines.push(`- Media: ${turn.mediaCount} attachment(s), metadata only`)
      lines.push(`- Tool chain: ${toolChain.length ? toolChain.join(' -> ') : 'none recorded'}`)
      for (const issue of matching) {
        const keyword = issue.evidence?.keyword ? ` · keyword: ${issue.evidence.keyword}` : ''
        lines.push(`- Evidence: ${preview(issue.evidence, 700)}${keyword}`)
      }
      lines.push('')
      lines.push('User:')
      lines.push('')
      lines.push(`> ${redactText(turn.userText || '(empty)', 1200).replace(/\n/g, '\n> ')}`)
      lines.push('')
      lines.push('Assistant:')
      lines.push('')
      lines.push(`> ${redactText(turn.finalText || '(no final reply)', 1200).replace(/\n/g, '\n> ')}`)
      lines.push('')
    }
  }
  return lines.join('\n')
}

function toLearningReviewPack(turns, filters, eventsByTurnId) {
  const lines = [
    '# Conversation Learning Evidence Pack',
    '',
    `Generated: ${new Date().toISOString()}`,
    `Date range: ${filters.from.toISOString()} to ${filters.to.toISOString()}`,
    `Filters: agent=${filters.agent || '*'}, channel=${filters.channel || '*'}, issue=${filters.issueTag || '*'}, reviewTarget=${filters.reviewTarget || '*'}`,
    `Total turns: ${turns.length}`,
    '',
    '## Auto-Learn Policy Notes',
    '',
    '- Low-risk terminology, preference, workflow hint, FAQ pattern, and entity alias can become memory when agent policy allows it.',
    '- Price, stock, cost, availability, substitutes, secrets, and PII must not become active memory from chat text.',
    '- Business Profile, SOUL, MCP/Search, and runtime changes remain separate review targets.',
    '',
    '## Turns With Learning Evidence',
    '',
  ]
  const selected = turns.filter(turn => turn.issueTags.length || /จำไว้|ช่วยจำ|remember this|note this/i.test(turn.userText || '') || turn.hasMedia)
  if (!selected.length) lines.push('- No learning signals were found in this export.')
  for (const turn of selected.slice(0, 200)) {
    const events = eventsByTurnId.get(turn.id) || []
    const toolChain = toolChainFromEvents(events)
    const explicitTeaching = /จำไว้|ช่วยจำ|remember this|note this/i.test(turn.userText || '')
    const blockedTruth = turn.issueTags.some(tag => /price|stock|cost|availability|unsupported|capability/i.test(tag))
    lines.push(`### ${turn.startedAt} · ${turn.agentId || 'unknown'} · ${turn.channel} · ${turn.id}`)
    lines.push('')
    lines.push(`- Signals: ${[
      explicitTeaching ? 'explicit_teaching' : null,
      turn.hasMedia ? 'media_context' : null,
      ...turn.issueTags,
    ].filter(Boolean).join(', ') || 'none'}`)
    lines.push(`- Suggested memory decision: ${blockedTruth ? 'blocked/review only' : explicitTeaching ? 'policy-promote if staff/admin' : 'observe first'}`)
    lines.push(`- Recommended target: ${turn.reviewTargets.join(', ') || 'Memory'}`)
    lines.push(`- Tool chain: ${toolChain.length ? toolChain.join(' -> ') : 'none recorded'}`)
    lines.push(`- Latency: ${turn.durationMs ?? 'n/a'}ms · Cost: ${turn.cost ?? 0}`)
    if (turn.mediaCount) lines.push(`- Media: ${turn.mediaCount} attachment(s), metadata only`)
    if (turn.issues.length) {
      lines.push(`- Evidence: ${turn.issues.map(issue => `${issue.tag}: ${preview(issue.evidence, 240)}`).join(' | ')}`)
    }
    lines.push('')
    lines.push('User:')
    lines.push('')
    lines.push(`> ${redactText(turn.userText || '(empty)', 900).replace(/\n/g, '\n> ')}`)
    lines.push('')
    lines.push('Assistant:')
    lines.push('')
    lines.push(`> ${redactText(turn.finalText || '(no final reply)', 900).replace(/\n/g, '\n> ')}`)
    lines.push('')
  }
  return lines.join('\n')
}

async function ingestStatus() {
  await ensureSchema()
  const [turns, checkpoints, exports] = await Promise.all([
    pgPool.query('SELECT COUNT(*)::int AS count, MIN(started_at) AS min_started_at, MAX(started_at) AS max_started_at FROM conversation_turns'),
    pgPool.query('SELECT * FROM conversation_ingest_checkpoints ORDER BY updated_at DESC LIMIT 20'),
    pgPool.query('SELECT * FROM conversation_exports ORDER BY created_at DESC LIMIT 10'),
  ])
  return {
    enabled: isEnabled(),
    retentionDays: retentionDays(),
    workerRunning,
    turns: {
      count: turns.rows[0]?.count || 0,
      from: turns.rows[0]?.min_started_at,
      to: turns.rows[0]?.max_started_at,
    },
    checkpoints: checkpoints.rows,
    recentExports: exports.rows,
  }
}

function startWorker() {
  if (!isEnabled() || !pgPool || workerTimer) return
  const intervalMs = clampInt(process.env.CONVERSATION_INGEST_INTERVAL_MS, 15000, 30 * 60 * 1000, 60000)
  const run = async () => {
    if (workerRunning) return
    workerRunning = true
    try {
      await ingestRecent({ minutes: DEFAULT_INGEST_MINUTES })
      await cleanupRetention()
    } catch (err) {
      console.warn('[conversation-analysis] ingest failed:', err.message)
    } finally {
      workerRunning = false
    }
  }
  workerTimer = setInterval(run, intervalMs)
  setTimeout(run, 5000)
}

module.exports = {
  isEnabled,
  ensureSchema,
  ingestRecent,
  queryConversations,
  queryInsights,
  getConversationDetail,
  exportConversations,
  ingestStatus,
  startWorker,
  _internal: {
    redactText,
    redactValue,
    normalizeTurn,
    turnToEvents,
    deriveIssues,
    ISSUE_DEFINITIONS,
    REVIEW_TARGETS,
    parseQueryFilters,
    normalizeConversationMedia,
    buildWhere,
    MAX_EXPORT_DAYS,
    MAX_EXPORT_TURNS,
  },
}
