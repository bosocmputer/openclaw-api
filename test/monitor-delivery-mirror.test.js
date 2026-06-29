const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

process.env.MONITOR_MEDIA_PREVIEW_ENABLED = '1'

const { _internal } = require('../routes/monitor')

test('delivery mirror assistant messages are hidden from monitor views', () => {
  const msg = {
    role: 'assistant',
    model: 'delivery-mirror',
    provider: 'openclaw',
    content: [{ type: 'text', text: 'sent to telegram' }],
  }

  assert.equal(_internal.isDeliveryMirrorMessage(msg), true)
  assert.equal(_internal.shouldIncludeMonitorMessage(msg), false)
})

test('normal assistant messages still render in monitor views', () => {
  const msg = {
    role: 'assistant',
    model: 'qwen/qwen3.5-27b',
    provider: 'openrouter',
    content: [{ type: 'text', text: 'ตอบผู้ใช้ครับ' }],
  }

  assert.equal(_internal.isDeliveryMirrorMessage(msg), false)
  assert.equal(_internal.shouldIncludeMonitorMessage(msg), true)
})

test('wrapped session entries preserve provider and model metadata', () => {
  const normalized = _internal.normalizeSessionEntry({
    timestamp: '2026-06-15T05:41:43.291Z',
    errorMessage: 'outer error',
    message: {
      role: 'assistant',
      provider: 'openclaw',
      model: 'delivery-mirror',
      content: [{ type: 'text', text: 'mirror' }],
      errorMessage: 'inner error',
    },
  })

  assert.equal(normalized.provider, 'openclaw')
  assert.equal(normalized.model, 'delivery-mirror')
  assert.equal(normalized.errorMessage, 'inner error')
  assert.equal(_internal.shouldIncludeMonitorMessage(normalized), false)
})

test('tool not found loops are summarized without full session logs', () => {
  const toolName = _internal.parseToolNotFound('Tool stock__get_product_price not found')
  const warnings = _internal.summarizeToolLoopWarnings({ [toolName]: 5, other_tool: 1 })

  assert.equal(toolName, 'stock__get_product_price')
  assert.equal(warnings.length, 1)
  assert.equal(warnings[0].toolName, 'stock__get_product_price')
  assert.equal(warnings[0].count, 5)
})

test('tool names expose namespace separately from MCP tool name', () => {
  assert.deepEqual(_internal.splitToolName('admin__search_product'), {
    toolNamespace: 'admin',
    toolBaseName: 'search_product',
    toolDisplayName: 'search_product',
  })
  assert.deepEqual(_internal.splitToolName('search_product'), {
    toolNamespace: null,
    toolBaseName: 'search_product',
    toolDisplayName: 'search_product',
  })
})

test('reply quality warnings detect placeholders, English follow-up menus, and duplicates', () => {
  const warnings = _internal.detectReplyQualityWarnings(`{{1}}
ผมไม่พบข้อมูลสินค้า "โช๊ค jazz (BF0009)" ในทุกคลังสินค้าครับ
What would you like to do next?
• Check stock for another product?
ผมไม่พบข้อมูลสินค้า "โช๊ค jazz (BF0009)" ในทุกคลังสินค้าครับ`)

  assert.deepEqual(
    warnings.map(w => w.issue).sort(),
    ['duplicate_block', 'english_followup', 'placeholder_artifact'].sort()
  )
})

test('model timeout warnings are classified without leaking long payloads', () => {
  const warning = _internal.detectModelError({
    role: 'assistant',
    stopReason: 'error',
    errorMessage: 'LLM request timed out. rawError=Provider finish_reason: error '.repeat(20),
    content: [],
  })

  assert.equal(warning.type, 'model_timeout')
  assert.equal(warning.summary, 'Model/provider timeout or finish_reason error')
  assert.ok(warning.detail.length <= 500)
})

test('conversation turn is recovered when fallback succeeds after a model timeout', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-monitor-session-'))
  const file = path.join(dir, 'session.jsonl')
  const baseMs = Date.now() - 60_000
  const iso = offsetMs => new Date(baseMs + offsetMs).toISOString()
  const lines = [
    {
      role: 'user',
      timestamp: iso(0),
      content: 'ขอเช็คยอด TEST-001',
    },
    {
      role: 'assistant',
      timestamp: iso(2149),
      stopReason: 'error',
      errorMessage: 'LLM request timed out. rawError=Provider finish_reason: error',
      content: [],
    },
    {
      role: 'assistant',
      timestamp: iso(4761),
      content: [{ type: 'tool_use', name: 'stock__search_product', input: { keyword: 'TEST-001' } }],
    },
    {
      role: 'toolResult',
      timestamp: iso(5201),
      content: '{"status":"resolved","selected":{"code":"TEST-001","name":"สินค้าทดสอบ"}}',
    },
    {
      role: 'assistant',
      timestamp: iso(6351),
      content: [{ type: 'tool_use', name: 'stock__get_stock_balance', input: { code: 'TEST-001' } }],
    },
    {
      role: 'toolResult',
      timestamp: iso(6378),
      content: '{"code":"TEST-001","found":0,"stocks":[]}',
    },
    {
      role: 'assistant',
      timestamp: iso(7116),
      content: [{ type: 'text', text: 'ไม่พบยอดคงเหลือสินค้า TEST-001 ในคลังครับ' }],
    },
  ]
  fs.writeFileSync(file, lines.map(line => JSON.stringify(line)).join('\n'))

  const turns = _internal.buildConversationTurnsFromSession({
    agentId: 'stock',
    sessionKey: 'agent:stock:telegram:7548005041',
    user: '7548005041',
    channel: 'telegram',
    sessionFile: file,
    minutes: 10080,
  })

  assert.equal(turns.length, 1)
  assert.equal(turns[0].status, 'ok')
  assert.equal(turns[0].rootCause, 'model_timeout_recovered')
  assert.equal(turns[0].finalText, 'ไม่พบยอดคงเหลือสินค้า TEST-001 ในคลังครับ')
  assert.deepEqual(turns[0].toolPath.map(tool => tool.name), ['stock__search_product', 'stock__get_stock_balance'])
  assert.deepEqual(
    turns[0].toolPath.map(tool => ({
      name: tool.name,
      toolNamespace: tool.toolNamespace,
      toolDisplayName: tool.toolDisplayName,
    })),
    [
      { name: 'stock__search_product', toolNamespace: 'stock', toolDisplayName: 'search_product' },
      { name: 'stock__get_stock_balance', toolNamespace: 'stock', toolDisplayName: 'get_stock_balance' },
    ]
  )
  assert.ok(turns[0].warnings.some(w => w.type === 'model_timeout'))
  assert.ok(turns[0].warnings.some(w => w.type === 'model_fallback_recovered'))
})

test('usage metrics normalize provider token and cost shapes', () => {
  assert.deepEqual(
    _internal.normalizeUsageMetrics({
      inputTokens: 1200,
      outputTokens: 34,
      cost: 0.00123,
    }),
    { input: 1200, output: 34, totalTokens: 1234, cost: 0.00123 }
  )

  assert.deepEqual(
    _internal.normalizeUsageMetrics({
      prompt_tokens: 2000,
      completion_tokens: 50,
      total_tokens: 2050,
      cost: { total: 0.0042 },
    }),
    { input: 2000, output: 50, totalTokens: 2050, cost: 0.0042 }
  )

  assert.deepEqual(
    _internal.normalizeUsageMetrics({
      input: 1000000,
      output: 1000000,
    }),
    { input: 1000000, output: 1000000, totalTokens: 2000000, cost: 18 }
  )

  assert.equal(_internal.normalizeUsageMetrics({ input: 0, output: 0, total: 0 }), null)
})

test('model metadata reports actual model or configured fallback source', () => {
  assert.deepEqual(
    _internal.messageModelMetadata(
      { model: 'openrouter/google/gemini-2.5-flash-lite', provider: 'openrouter', stopReason: 'stop' },
      'openrouter/qwen/qwen3.5-flash-02-23',
      { input: 1, output: 1, totalTokens: 2, cost: 0.00001 }
    ),
    {
      model: 'openrouter/google/gemini-2.5-flash-lite',
      provider: 'openrouter',
      modelSource: 'actual',
      finishReason: 'stop',
    }
  )

  assert.deepEqual(
    _internal.messageModelMetadata(
      { stopReason: 'stop' },
      'openrouter/qwen/qwen3.5-flash-02-23',
      { input: 1, output: 1, totalTokens: 2, cost: 0.00001 }
    ),
    {
      model: 'openrouter/qwen/qwen3.5-flash-02-23',
      provider: 'openrouter',
      modelSource: 'configured',
      finishReason: 'stop',
    }
  )
})

test('trajectory snapshots normalize to session messages with usage', () => {
  const messages = _internal.normalizeTrajectoryEntries([
    {
      type: 'model.completed',
      data: {
        messagesSnapshot: [
          { role: 'user', content: 'สวัสดี', timestamp: 1781595321000 },
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'สวัสดีครับ' }],
            timestamp: 1781595324858,
            usage: {
              input: 1234,
              output: 56,
              cost: { total: 0.0007 },
            },
          },
        ],
      },
    },
  ])

  assert.equal(messages.length, 2)
  assert.equal(messages[0].timestamp, '2026-06-16T07:35:21.000Z')
  assert.deepEqual(
    _internal.normalizeUsageMetrics(messages[1].usage),
    { input: 1234, output: 56, totalTokens: 1290, cost: 0.0007 }
  )
})

test('monitor events sort by full timestamp across days, not HH:mm:ss text', () => {
  const events = [
    {
      ts: '23:59:59',
      timestamp: '2026-06-16T16:59:59.000Z',
      text: 'older Bangkok night',
    },
    {
      ts: '00:00:01',
      timestamp: '2026-06-17T17:00:01.000Z',
      text: 'newer next day',
    },
  ]

  _internal.sortMonitorEventsDesc(events)

  assert.equal(events[0].text, 'newer next day')
  assert.equal(events[1].text, 'older Bangkok night')
  assert.ok(_internal.monitorEventTimeMs(events[0]) > _internal.monitorEventTimeMs(events[1]))
})

test('gateway deterministic tool details are attached to conversation turns', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-monitor-'))
  const file = path.join(dir, 'gateway.log')
  const b64 = value => Buffer.from(value, 'utf8').toString('base64url')
  const baseMs = Date.now() - 60_000
  const lines = [
    JSON.stringify({
      time: new Date(baseMs).toISOString(),
      message: `telegram_monitor_tool agent=stock turnId=tg_1 channel=telegram route=tool_path intent=stock_balance tool=search_product status=ok durationMs=123 cleanKeywordB64=${b64('สินค้า')} inputB64=${b64('{"args":{"keyword":"สินค้า"}}')} resultB64=${b64('{"candidates":[{"code":"ITEM-001"}]}')} warning=-`,
    }),
    JSON.stringify({
      time: new Date(baseMs + 1000).toISOString(),
      message: `telegram_monitor_turn agent=stock turnId=tg_1 channel=telegram route=tool_path intent=stock_balance status=sent durationMs=1500 tools=search_product searchMs=123 balanceMs=0 userTextB64=${b64('ขอเช็คยอดคงเหลือ สินค้า')} finalTextB64=${b64('พบสินค้า 1 รายการครับ')}`,
    }),
  ]
  fs.writeFileSync(file, lines.join('\n'))

  const turns = _internal.buildConversationTurnsFromGatewayLog({
    minutes: 1440,
    channel: 'telegram',
    limit: 10,
    logFile: file,
  })

  assert.equal(turns.length, 1)
  assert.equal(turns[0].toolPath.length, 1)
  assert.equal(turns[0].toolPath[0].name, 'search_product')
  assert.equal(turns[0].toolPath[0].cleanKeyword, 'สินค้า')
  assert.match(turns[0].toolPath[0].toolInput, /"keyword":"สินค้า"/)
  assert.match(turns[0].toolPath[0].toolResult, /ITEM-001/)
})

test('monitor extracts media metadata without exposing preview paths by default', () => {
  const media = _internal.normalizeMediaFromMessage({
    role: 'user',
    content: [
      { type: 'text', text: 'ช่วยดูรูปนี้' },
      {
        type: 'image',
        mimeType: 'image/png',
        mediaRef: 'media://telegram/file-redacted',
        fileName: 'product.png',
        sizeBytes: 12345,
      },
    ],
  })

  assert.equal(media.length, 1)
  assert.equal(media[0].kind, 'image')
  assert.equal(media[0].mimeType, 'image/png')
  assert.equal(media[0].fileName, 'product.png')
  assert.equal(media[0].sizeBytes, 12345)
  assert.equal(media[0].hasPreview, false)
  assert.equal(media[0].previewUrl, undefined)
})

test('monitor extracts runtime MediaPath fields and returns only safe preview ids', () => {
  const inboundDir = path.join(process.env.HOME, '.openclaw', 'media', 'inbound')
  fs.mkdirSync(inboundDir, { recursive: true })
  const fileName = `openclaw-test-${Date.now()}-${Math.random().toString(16).slice(2)}.jpg`
  const filePath = path.join(inboundDir, fileName)
  fs.writeFileSync(filePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]))

  try {
    const msg = _internal.normalizeSessionEntry({
      timestamp: '2026-06-23T04:50:40.898Z',
      message: {
        role: 'user',
        content: 'มีโช็คของรถรุ่นนี้ไหม',
        MediaPath: filePath,
        MediaPaths: [filePath],
        MediaType: 'image/jpeg',
        MediaTypes: ['image/jpeg'],
      },
    })
    const media = _internal.normalizeMediaFromMessage(msg)
    const storageMedia = _internal.normalizeMediaFromMessage(msg, { includeMediaRef: true })

    assert.equal(media.length, 1)
    assert.equal(media[0].kind, 'image')
    assert.equal(media[0].mimeType, 'image/jpeg')
    assert.equal(media[0].fileName, fileName)
    assert.equal(media[0].hasPreview, true)
    assert.match(media[0].id, /^[a-f0-9]{48}$/)
    assert.equal(media[0].previewUrl, `/api/monitor/media/${media[0].id}`)
    assert.equal(media[0].mediaRef, undefined)
    assert.doesNotMatch(JSON.stringify(media[0]), /\\.openclaw|MediaPath/)
    assert.equal(storageMedia[0].mediaRef, `media://inbound/${encodeURIComponent(fileName)}`)
  } finally {
    fs.rmSync(filePath, { force: true })
  }
})

test('media-only user messages become conversation turns with a safe placeholder', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-monitor-media-'))
  const file = path.join(dir, 'session.jsonl')
  const baseMs = Date.now() - 60_000
  const iso = offsetMs => new Date(baseMs + offsetMs).toISOString()
  const lines = [
    {
      role: 'user',
      timestamp: iso(0),
      content: [{ type: 'image', mimeType: 'image/jpeg', mediaRef: 'media://telegram/file-redacted', fileName: 'photo.jpg' }],
    },
    {
      role: 'assistant',
      timestamp: iso(4761),
      content: [{ type: 'text', text: 'ผมเห็นรูปแล้วครับ' }],
    },
  ]
  fs.writeFileSync(file, lines.map(line => JSON.stringify(line)).join('\n'))

  const turns = _internal.buildConversationTurnsFromSession({
    agentId: 'stock',
    sessionKey: 'agent:stock:telegram:7548005041',
    user: '7548005041',
    channel: 'telegram',
    sessionFile: file,
    minutes: 10080,
  })

  assert.equal(turns.length, 1)
  assert.equal(turns[0].userText, '[User sent media without caption]')
  assert.equal(turns[0].mediaCount, 1)
  assert.equal(turns[0].media[0].fileName, 'photo.jpg')
})
