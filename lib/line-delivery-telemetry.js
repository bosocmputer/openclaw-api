const fs = require('fs')
const path = require('path')

const DEFAULT_GATEWAY_LOG_DIR = '/tmp/openclaw'
const DEFAULT_MAX_BYTES = 1024 * 1024
const DEFAULT_MAX_LINES = 1500
const LINE_MARKERS = new Set([
  'line_webhook_received',
  'line_loading_start',
  'line_loading_failed',
  'line_delivery_attempt',
  'line_delivery_ok',
  'line_reply_fallback_to_push',
  'line_delivery_failed',
])

function readTailLines(filePath, maxLines = DEFAULT_MAX_LINES, maxBytes = DEFAULT_MAX_BYTES) {
  const stat = fs.statSync(filePath)
  const start = Math.max(0, stat.size - maxBytes)
  const fd = fs.openSync(filePath, 'r')
  try {
    const buffer = Buffer.alloc(stat.size - start)
    fs.readSync(fd, buffer, 0, buffer.length, start)
    return buffer.toString('utf8').split('\n').filter(line => line.trim()).slice(-maxLines)
  } finally {
    fs.closeSync(fd)
  }
}

function latestGatewayLogFile(logDir = DEFAULT_GATEWAY_LOG_DIR) {
  if (!fs.existsSync(logDir)) return null
  const files = fs.readdirSync(logDir)
    .filter(name => name.endsWith('.log') || name.endsWith('.jsonl'))
    .map(name => {
      try {
        const fullPath = path.join(logDir, name)
        return { fullPath, mtime: fs.statSync(fullPath).mtimeMs }
      } catch {
        return null
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime)
  return files[0]?.fullPath || null
}

function parseGatewayLogLine(line) {
  try {
    const obj = JSON.parse(line)
    const raw = obj['1'] ?? obj.message ?? obj.msg ?? obj['0'] ?? ''
    const message = typeof raw === 'object' ? JSON.stringify(raw) : String(raw)
    const timeRaw = obj.time || obj._meta?.date || obj.timestamp
    return {
      timeRaw,
      timeMs: timeRaw ? new Date(timeRaw).getTime() : null,
      message,
    }
  } catch {
    const timeMatch = String(line).match(/^(\d{4}-\d{2}-\d{2}T[^\s]+)/)
    return {
      timeRaw: timeMatch?.[1] || null,
      timeMs: timeMatch ? new Date(timeMatch[1]).getTime() : null,
      message: String(line),
    }
  }
}

function parseKeyValues(message) {
  const values = {}
  for (const match of String(message || '').matchAll(/([A-Za-z][A-Za-z0-9_]*)=([^\s]+)/g)) {
    values[match[1]] = match[2]
  }
  return values
}

function numberValue(value) {
  if (value === undefined || value === null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function timePartFromMs(ms) {
  if (!Number.isFinite(ms)) return null
  return new Date(ms).toISOString().slice(11, 19)
}

function eventTime(ms) {
  if (!Number.isFinite(ms)) return { ts: null, timestamp: null, timeMs: null }
  return { ts: timePartFromMs(ms), timestamp: new Date(ms).toISOString(), timeMs: ms }
}

function findMarker(message) {
  const first = String(message || '').trim().split(/\s+/, 1)[0]
  if (LINE_MARKERS.has(first)) return first
  for (const marker of LINE_MARKERS) {
    if (String(message || '').includes(marker)) return marker
  }
  return null
}

function eventTypeForMarker(marker) {
  if (marker === 'line_reply_fallback_to_push') return 'line_fallback'
  if (marker.startsWith('line_loading_')) return 'line_loading'
  return 'line_delivery'
}

function eventTextForMarker(marker, method, fallbackReason) {
  if (marker === 'line_webhook_received') return 'LINE webhook received'
  if (marker === 'line_loading_start') return 'LINE loading start'
  if (marker === 'line_loading_failed') return `LINE loading failed${fallbackReason ? ` (${fallbackReason})` : ''}`
  if (marker === 'line_delivery_attempt') return `LINE ${method || 'delivery'} attempt`
  if (marker === 'line_delivery_ok') return `LINE ${method || 'delivery'} ok`
  if (marker === 'line_reply_fallback_to_push') return `LINE reply fallback to push${fallbackReason ? ` (${fallbackReason})` : ''}`
  if (marker === 'line_delivery_failed') return `LINE ${method || 'delivery'} failed${fallbackReason ? ` (${fallbackReason})` : ''}`
  return marker
}

function parseLineDeliveryEvent(line) {
  const parsed = parseGatewayLogLine(line)
  const marker = findMarker(parsed.message)
  if (!marker) return null

  const fields = parseKeyValues(parsed.message)
  const method = fields.method || (marker.includes('loading') ? 'loading' : undefined)
  const fallbackReason = fields.fallbackReason || undefined
  const ms = Number.isFinite(parsed.timeMs) ? parsed.timeMs : Date.now()

  return {
    ...eventTime(ms),
    channel: 'line',
    type: eventTypeForMarker(marker),
    marker,
    text: eventTextForMarker(marker, method, fallbackReason),
    accountId: fields.accountId || undefined,
    method,
    deliveryMethod: method,
    chatType: fields.chatType || undefined,
    messageCount: numberValue(fields.messageCount),
    durationMs: numberValue(fields.durationMs),
    replyTokenAgeMs: numberValue(fields.replyTokenAgeMs),
    fallbackReason,
    loadingSeconds: numberValue(fields.loadingSeconds),
    eventCount: numberValue(fields.eventCount),
    agentId: 'gateway',
    user: 'line',
  }
}

function buildLineDeliveryTelemetry(options = {}) {
  const minutes = Math.max(1, Math.min(Number(options.minutes || 60), 24 * 60))
  const logFile = latestGatewayLogFile(options.logDir || DEFAULT_GATEWAY_LOG_DIR)
  const events = []
  const warnings = []
  if (!logFile) {
    return {
      events,
      warnings: [{ type: 'line.telemetry', summary: 'No gateway log file found' }],
      summary: {
        count: 0,
        deliveryCount: 0,
        loadingCount: 0,
        fallbackCount: 0,
        failedCount: 0,
        lastAt: null,
      },
      source: null,
    }
  }

  const cutoff = Date.now() - minutes * 60 * 1000
  for (const line of readTailLines(
    logFile,
    options.maxLines || DEFAULT_MAX_LINES,
    options.maxBytes || DEFAULT_MAX_BYTES,
  )) {
    const event = parseLineDeliveryEvent(line)
    if (!event) continue
    if (event.timeMs && event.timeMs < cutoff) continue
    events.push(event)
  }
  events.sort((a, b) => (b.timeMs || 0) - (a.timeMs || 0))

  const failedCount = events.filter(event =>
    event.marker === 'line_delivery_failed' || event.marker === 'line_loading_failed'
  ).length
  const fallbackCount = events.filter(event => event.marker === 'line_reply_fallback_to_push').length
  const loadingCount = events.filter(event => event.type === 'line_loading').length
  const deliveryCount = events.filter(event => event.type === 'line_delivery').length

  return {
    events,
    warnings,
    summary: {
      count: events.length,
      deliveryCount,
      loadingCount,
      fallbackCount,
      failedCount,
      lastAt: events[0]?.timestamp || null,
    },
    source: logFile,
  }
}

module.exports = {
  buildLineDeliveryTelemetry,
  parseLineDeliveryEvent,
}
