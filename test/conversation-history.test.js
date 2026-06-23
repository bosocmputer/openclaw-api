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

test('conversation history stores only safe media preview references', () => {
  const normalized = history._internal.normalizeTurn({
    id: 'turn-media',
    source: 'session',
    startedAt: '2026-06-19T01:00:00.000Z',
    agentId: 'stock',
    channel: 'telegram',
    user: '7548005041',
    userText: '[User sent media without caption]',
    finalText: 'อ่านรูปได้ครับ',
    route: 'model_path',
    intent: 'unknown',
    status: 'ok',
    media: [{
      id: 'a'.repeat(48),
      kind: 'image',
      mimeType: 'image/jpeg',
      fileName: '../../photo.jpg',
      sizeBytes: 12345,
      caption: 'สินค้า',
      hasPreview: true,
      previewUrl: `/api/monitor/media/${'a'.repeat(48)}`,
      path: '/root/.openclaw/private/photo.jpg',
      botToken: 'telegram-secret',
    }],
  })

  const userEvent = normalized.events.find(event => event.type === 'user')
  assert.equal(userEvent.payload.mediaCount, 1)
  assert.equal(userEvent.payload.media[0].id, 'a'.repeat(48))
  assert.equal(userEvent.payload.media[0].previewUrl, `/api/monitor/media/${'a'.repeat(48)}`)
  assert.equal(userEvent.payload.media[0].fileName, 'photo.jpg')
  assert.doesNotMatch(JSON.stringify(userEvent.payload), /openclaw|private|telegram-secret/)
})

test('conversation media preview ids do not change stable event hashes', () => {
  const baseTurn = {
    id: 'turn-media-hash',
    source: 'session',
    startedAt: '2026-06-19T01:00:00.000Z',
    agentId: 'stock',
    channel: 'telegram',
    user: '7548005041',
    userText: '[User sent media without caption]',
    finalText: 'อ่านรูปได้ครับ',
    route: 'model_path',
    intent: 'unknown',
    status: 'ok',
  }
  const withoutPreview = history._internal.normalizeTurn({
    ...baseTurn,
    media: [{ kind: 'image', mimeType: 'image/jpeg', fileName: 'photo.jpg', hasPreview: true }],
  })
  const withPreview = history._internal.normalizeTurn({
    ...baseTurn,
    media: [{
      id: 'b'.repeat(48),
      kind: 'image',
      mimeType: 'image/jpeg',
      fileName: 'photo.jpg',
      hasPreview: true,
      previewUrl: `/api/monitor/media/${'b'.repeat(48)}`,
    }],
  })

  assert.equal(withPreview.events.find(event => event.type === 'user').payload.media[0].id, 'b'.repeat(48))
  assert.equal(withoutPreview.events.find(event => event.type === 'user').hash, withPreview.events.find(event => event.type === 'user').hash)
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

test('conversation issue tagging detects search no-result from real tool evidence', () => {
  const issues = history._internal.deriveIssues({
    id: 'turn-search',
    userText: 'ค้นหาสินค้า TEST',
    finalText: 'ไม่พบสินค้าที่ตรงกับคำค้นนี้ครับ',
    route: 'tool_path',
    intent: 'search',
    status: 'ok',
    durationMs: 900,
  }, [{
    type: 'tool',
    title: 'stock__search_product',
    body: '{"status":"no_result","keyword":"TEST","candidates":[]}',
    payload: {
      name: 'stock__search_product',
      status: 'ok',
      input: { keyword: 'TEST' },
      result: { status: 'no_result', keyword: 'TEST', candidates: [] },
    },
  }])

  assert.ok(issues.some(issue => issue.tag === 'search_no_result'))
  assert.equal(issues.find(issue => issue.tag === 'search_no_result').reviewTarget, 'MCP/search')
})

test('conversation issue tagging does not treat needs_refine as search no-result', () => {
  const issues = history._internal.deriveIssues({
    id: 'turn-refine',
    userText: 'ของเดนโซ่ หรือ hitachi',
    finalText: 'กรุณาระบุรุ่นหรือรหัสสินค้าเพิ่มเติมครับ',
    route: 'tool_path',
    intent: 'search',
    status: 'ok',
    durationMs: 1200,
  }, [{
    type: 'tool',
    title: 'stock__search_product',
    body: '{"schema_version":"search_product.v2","status":"needs_refine","keyword":"brand query","candidates":[]}',
    payload: {
      name: 'stock__search_product',
      status: 'ok',
      result: '{"schema_version":"search_product.v2","status":"needs_refine","keyword":"brand query","candidates":[]}',
    },
  }])

  const tags = issues.map(issue => issue.tag)
  assert.ok(tags.includes('needs_user_refine'))
  assert.ok(!tags.includes('search_no_result'))
})

test('conversation issue tagging detects model timeout, fallback, and slow turns', () => {
  const issues = history._internal.deriveIssues({
    id: 'turn-model',
    userText: 'สวัสดี',
    finalText: 'Model/provider timeout or finish_reason error',
    route: 'model_path',
    intent: 'unknown',
    status: 'error',
    rootCause: 'provider timeout',
    durationMs: 15000,
    model: 'openrouter/example/model',
  }, [{
    type: 'warning',
    title: 'model_fallback_decision',
    body: 'Model Fallback selected because primary timed out',
    payload: { reason: 'timeout' },
  }])

  const tags = issues.map(issue => issue.tag)
  assert.ok(tags.includes('model_timeout'))
  assert.ok(tags.includes('fallback_used'))
  assert.ok(tags.includes('slow_turn'))
})

test('conversation issue tagging detects unverified price guesses and reply repetition', () => {
  const issues = history._internal.deriveIssues({
    id: 'turn-price-guess',
    agentId: 'admin',
    channel: 'telegram',
    userText: 'สายพาน 6PK1995 ราคา',
    finalText: 'โดยปกติราคาประมาณ 850 บาทครับครับ',
    route: 'tool_path',
    intent: 'price',
    status: 'ok',
    durationMs: 1200,
  }, [{
    type: 'tool',
    title: 'admin__search_product',
    body: '{"status":"no_result","keyword":"6PK1995","candidates":[]}',
    payload: {
      name: 'admin__search_product',
      status: 'ok',
      result: { status: 'no_result', keyword: '6PK1995', candidates: [] },
    },
  }])

  const tags = issues.map(issue => issue.tag)
  assert.ok(tags.includes('unverified_price_guess'))
  assert.ok(tags.includes('reply_repetition'))
  assert.ok(tags.includes('wrong_agent_or_capability'))
})

test('conversation issue tagging detects multi-item search retry loops', () => {
  const events = [1, 2, 3].map(i => ({
    type: 'tool',
    title: 'stock__search_product',
    body: JSON.stringify({ status: i === 3 ? 'needs_refine' : 'no_result', keyword: `item-${i}`, candidates: [] }),
    payload: {
      name: 'stock__search_product',
      status: 'ok',
      input: { keyword: `item-${i}` },
      result: { status: i === 3 ? 'needs_refine' : 'no_result', candidates: [] },
    },
  }))
  const issues = history._internal.deriveIssues({
    id: 'turn-loop',
    agentId: 'stock',
    channel: 'telegram',
    userText: 'ผ้าเบรก, สายพาน และ ลูกรอก ราคา',
    finalText: 'กรุณาระบุข้อมูลเพิ่มเติมครับ',
    route: 'tool_path',
    intent: 'search',
    status: 'ok',
    durationMs: 25000,
  }, events)

  const tags = issues.map(issue => issue.tag)
  assert.ok(tags.includes('search_retry_loop'))
  assert.ok(tags.includes('multi_item_slow'))
})

test('conversation issue evidence is redacted', () => {
  const issues = history._internal.deriveIssues({
    id: 'turn-secret',
    userText: 'ค้นหา TEST',
    finalText: 'ไม่พบสินค้า',
    route: 'tool_path',
    intent: 'search',
    status: 'ok',
  }, [{
    type: 'tool',
    title: 'search_product',
    body: 'authorization: Bearer should-not-leak',
    payload: {
      name: 'search_product',
      status: 'error',
      input: { keyword: 'TEST', apiKey: 'sk-secret' },
      result: { error: 'no_result' },
    },
  }])

  const serialized = JSON.stringify(issues)
  assert.doesNotMatch(serialized, /should-not-leak|sk-secret/)
  assert.match(serialized, /\[redacted\]/)
})
