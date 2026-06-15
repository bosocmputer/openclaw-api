const assert = require('node:assert/strict')
const test = require('node:test')

const { generateSoulTemplate } = require('../lib/soul-template')
const { getFallbackTools, parseSoulContract } = require('../lib/mcp-tools')

test('stock template does not instruct unavailable price tool calls', () => {
  const soul = generateSoulTemplate(null, 'stock', null, 'professional')

  assert.match(soul, /MCP_ACCESS_MODE=stock/)
  assert.match(soul, /Tools ที่ใช้ได้/)
  assert.match(soul, /ไม่มีสิทธิ์ตรวจราคา/)
  assert.match(soul, /OPENCLAW_SOUL_CONTRACT/)
  assert.doesNotMatch(soul, /ตรวจราคาด้วย get_product_price/)
  assert.doesNotMatch(soul, /write tool/)
  assert.doesNotMatch(soul, /memory\/YYYY-MM-DD/)
  assert.doesNotMatch(soul, /## ความจำระหว่าง Session/)
  assert.doesNotMatch(soul, /\bcurl\b/i)
  assert.doesNotMatch(soul, /\/call\b/i)
  assert.doesNotMatch(soul, /exec\s+tool/i)
  assert.doesNotMatch(soul, /mcporter/i)
})

test('sales template keeps price tool instructions', () => {
  const soul = generateSoulTemplate(null, 'sales', null, 'professional')

  assert.match(soul, /MCP_ACCESS_MODE=sales/)
  assert.match(soul, /get_product_price/)
  assert.match(soul, /ตรวจราคาด้วย get_product_price/)
})

test('purchase template does not instruct price tool calls', () => {
  const soul = generateSoulTemplate(null, 'purchase', null, 'professional')

  assert.match(soul, /MCP_ACCESS_MODE=purchase/)
  assert.match(soul, /ไม่มีสิทธิ์ตรวจราคา/)
  assert.doesNotMatch(soul, /ตรวจราคาด้วย get_product_price/)
})

test('template contract allowed tools match tool source', () => {
  const tools = getFallbackTools('stock')
  const soul = generateSoulTemplate(null, 'stock', null, 'professional', {
    accessMode: 'stock',
    toolSource: 'fallback',
    tools,
    generatedAt: '2026-06-15T00:00:00.000Z',
  })
  const contract = parseSoulContract(soul)

  assert.equal(contract.accessMode, 'stock')
  assert.equal(contract.toolSource, 'fallback')
  assert.deepEqual(contract.allowedTools, tools.map(t => t.name).sort())
})

test('all default templates avoid legacy MCP invocation patterns', () => {
  for (const mode of ['admin', 'sales', 'purchase', 'stock', 'general']) {
    const soul = generateSoulTemplate(null, mode, null, 'professional')
    assert.doesNotMatch(soul, /\bcurl\b/i, mode)
    assert.doesNotMatch(soul, /\/call\b/i, mode)
    assert.doesNotMatch(soul, /exec\s+tool/i, mode)
    assert.doesNotMatch(soul, /mcporter/i, mode)
  }
})
