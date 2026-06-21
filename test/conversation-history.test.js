const assert = require('node:assert/strict')
const test = require('node:test')

const history = require('../lib/conversation-history')

test('conversation history redacts secrets in text and payloads', () => {
  const text = history._internal.redactText('authorization: Bearer abc123 apiKey: sk-test password=secret')
  assert.match(text, /Bearer \[redacted\]/)
  assert.match(text, /apiKey: \[redacted\]/)
  assert.match(text, /password=\[redacted\]/)
  assert.doesNotMatch(text, /abc123|sk-test|secret$/)

  const payload = history._internal.redactValue({
    headers: { authorization: 'Bearer token-value' },
    nested: { botToken: 'telegram-token', ok: true },
    list: [{ api_key: 'provider-key' }],
  })
  assert.equal(payload.headers.authorization, '[redacted]')
  assert.equal(payload.nested.botToken, '[redacted]')
  assert.equal(payload.list[0].api_key, '[redacted]')
  assert.equal(payload.nested.ok, true)
})

test('conversation turn normalization creates bounded event timeline', () => {
  const normalized = history._internal.normalizeTurn({
    id: 'turn-1',
    source: 'gateway',
    startedAt: '2026-06-19T01:00:00.000Z',
    agentId: 'stock',
    channel: 'telegram',
    user: '7548005041',
    userText: 'ขอเช็คยอด TEST',
    finalText: 'พบสินค้า TEST ครับ',
    route: 'tool_path',
    intent: 'stock_balance',
    status: 'ok',
    durationMs: 1200,
    toolPath: [{
      name: 'stock__search_product',
      status: 'ok',
      toolInput: '{"keyword":"TEST","authorization":"Bearer leaked"}',
      toolResult: '{"selected":{"code":"TEST"}}',
    }],
    warnings: [{ type: 'sample', summary: 'warning text' }],
  })

  assert.equal(normalized.turnId, 'turn-1')
  assert.equal(normalized.toolCount, 1)
  assert.equal(normalized.warningCount, 1)
  assert.deepEqual(normalized.events.map(event => event.type), ['user', 'tool', 'warning', 'assistant'])
  assert.ok(normalized.events.every(event => event.hash.length === 64))
  assert.doesNotMatch(JSON.stringify(normalized.events), /Bearer leaked/)
})

test('conversation query filters default to bounded 24 hour window and clamp limit', () => {
  const filters = history._internal.parseQueryFilters({ limit: '9999' })
  assert.equal(filters.limit, 500)
  assert.equal(filters.from instanceof Date, true)
  assert.equal(filters.to instanceof Date, true)
  assert.ok(filters.to.getTime() - filters.from.getTime() <= 24 * 60 * 60 * 1000 + 1000)
})

test('conversation export guardrail constants are conservative', () => {
  assert.equal(history._internal.MAX_EXPORT_DAYS, 31)
  assert.equal(history._internal.MAX_EXPORT_TURNS, 50000)
})
