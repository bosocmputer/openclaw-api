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
