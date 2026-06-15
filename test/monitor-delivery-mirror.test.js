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
    message: {
      role: 'assistant',
      provider: 'openclaw',
      model: 'delivery-mirror',
      content: [{ type: 'text', text: 'mirror' }],
    },
  })

  assert.equal(normalized.provider, 'openclaw')
  assert.equal(normalized.model, 'delivery-mirror')
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
