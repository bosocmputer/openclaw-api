const crypto = require('crypto')
const path = require('path')

const { pgPool } = require('./pg')
const { HOME } = require('./config')
const { readOpenclawConfig } = require('./openclaw-config')
const monitorRoute = require('../routes/monitor')

const monitor = monitorRoute._internal

const DEFAULT_RETENTION_DAYS = 180
const DEFAULT_QUERY_LIMIT = 100
const MAX_QUERY_LIMIT = 500
const MAX_EXPORT_DAYS = 31
const MAX_EXPORT_TURNS = 50000
const MAX_BACKFILL_DAYS = 31
const DEFAULT_INGEST_MINUTES = 180
const MAX_INGEST_TURNS_PER_RUN = 2000

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

function eventHash(turnId, type, index, body, payload) {
  return sha256(JSON.stringify({ turnId, type, index, body, payload: redactValue(payload) }))
}

function turnToEvents(turn) {
  const events = []
  const startedAt = turn.startedAt || new Date().toISOString()
  events.push({
    type: 'user',
    occurredAt: startedAt,
    title: 'User message',
    body: redactText(turn.userText, 16000),
    payload: { channel: turn.channel, user: turn.user },
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
    try {
      await client.query('BEGIN')
      for (const turn of turns) {
        await upsertTurn(client, turn)
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
  }
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

async function queryConversations(rawFilters = {}) {
  await ensureSchema()
  const filters = parseQueryFilters(rawFilters)
  const params = []
  const where = buildWhere(filters, params)
  const limitParam = params.push(filters.limit + 1)

  const { rows } = await pgPool.query(`
    SELECT turn_id, source, session_key, started_at, agent_id, channel, chat_user, user_text, final_text,
           route, intent, status, root_cause, duration_ms, ack_ms, model_ms, model, provider,
           input_tokens, output_tokens, cost, tool_count, warning_count
    FROM conversation_turns t
    WHERE ${where}
    ORDER BY started_at DESC, turn_id DESC
    LIMIT $${limitParam}
  `, params)

  const hasMore = rows.length > filters.limit
  const pageRows = rows.slice(0, filters.limit)
  const nextCursor = hasMore ? encodeCursor(pageRows[pageRows.length - 1]) : null
  const summary = await querySummary(filters)
  return {
    generatedAt: new Date().toISOString(),
    filters: serializeFilters(filters),
    summary,
    turns: pageRows.map(rowToTurn),
    hasMore,
    nextCursor,
    warnings: [],
  }
}

function serializeFilters(filters) {
  return {
    ...filters,
    from: filters.from.toISOString(),
    to: filters.to.toISOString(),
  }
}

function rowToTurn(row) {
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
  return {
    turn: rowToTurn(turnRes.rows[0]),
    events: eventsRes.rows.map(row => ({
      type: row.event_type,
      occurredAt: row.occurred_at instanceof Date ? row.occurred_at.toISOString() : row.occurred_at,
      title: row.title,
      body: row.body,
      payload: row.payload || {},
    })),
  }
}

function daysBetween(from, to) {
  return Math.max(0, (to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000))
}

async function exportConversations(rawFilters, format, actor) {
  await ensureSchema()
  const filters = parseQueryFilters({ ...rawFilters, limit: MAX_QUERY_LIMIT })
  if (daysBetween(filters.from, filters.to) > MAX_EXPORT_DAYS) {
    const err = new Error(`Export range is limited to ${MAX_EXPORT_DAYS} days`)
    err.statusCode = 400
    throw err
  }
  const params = []
  const where = buildWhere({ ...filters, cursor: null }, params)
  const countRes = await pgPool.query(`SELECT COUNT(*)::int AS count FROM conversation_turns t WHERE ${where}`, params)
  const count = countRes.rows[0]?.count || 0
  if (count > MAX_EXPORT_TURNS) {
    const err = new Error(`Export is limited to ${MAX_EXPORT_TURNS} turns. Narrow the date range or filters.`)
    err.statusCode = 400
    throw err
  }

  const rows = (await pgPool.query(`
    SELECT * FROM conversation_turns t
    WHERE ${where}
    ORDER BY started_at ASC, turn_id ASC
  `, params)).rows

  await pgPool.query(
    'INSERT INTO conversation_exports (actor, format, filters, row_count) VALUES ($1,$2,$3::jsonb,$4)',
    [actor || null, format, JSON.stringify(serializeFilters(filters)), rows.length]
  )

  if (format === 'csv') return { contentType: 'text/csv; charset=utf-8', filename: 'conversation-history.csv', body: toCsv(rows) }
  if (format === 'jsonl') return { contentType: 'application/x-ndjson; charset=utf-8', filename: 'conversation-history.jsonl', body: rows.map(row => JSON.stringify(rowToTurn(row))).join('\n') + '\n' }
  if (format === 'markdown') return { contentType: 'text/markdown; charset=utf-8', filename: 'conversation-history.md', body: toMarkdown(rows) }
  const err = new Error('Unsupported export format')
  err.statusCode = 400
  throw err
}

function csvEscape(value) {
  const text = value === null || value === undefined ? '' : String(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function toCsv(rows) {
  const cols = ['started_at', 'agent_id', 'channel', 'chat_user', 'status', 'route', 'intent', 'model', 'duration_ms', 'cost', 'user_text', 'final_text']
  const lines = [cols.join(',')]
  for (const row of rows) lines.push(cols.map(col => csvEscape(row[col])).join(','))
  return lines.join('\n') + '\n'
}

function toMarkdown(rows) {
  const lines = ['# Conversation History', '']
  for (const row of rows) {
    const turn = rowToTurn(row)
    lines.push(`## ${turn.startedAt} · ${turn.agentId || 'unknown'} · ${turn.channel}`)
    lines.push('')
    lines.push(`- Status: ${turn.status}`)
    lines.push(`- Route: ${turn.route}`)
    lines.push(`- Intent: ${turn.intent}`)
    if (turn.model) lines.push(`- Model: ${turn.model}`)
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
  getConversationDetail,
  exportConversations,
  ingestStatus,
  startWorker,
  _internal: {
    redactText,
    redactValue,
    normalizeTurn,
    turnToEvents,
    parseQueryFilters,
    buildWhere,
    MAX_EXPORT_DAYS,
    MAX_EXPORT_TURNS,
  },
}
