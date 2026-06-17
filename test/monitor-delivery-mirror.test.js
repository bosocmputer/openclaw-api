const assert = require('node:assert/strict')
const test = require('node:test')

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
