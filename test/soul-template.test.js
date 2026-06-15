const assert = require('node:assert/strict')
const test = require('node:test')

const { generateSoulTemplate } = require('../lib/soul-template')

test('stock template does not instruct unavailable price tool calls', () => {
  const soul = generateSoulTemplate(null, 'stock', null, 'professional')

  assert.match(soul, /MCP_ACCESS_MODE=stock/)
  assert.match(soul, /Tools ที่ใช้ได้/)
  assert.match(soul, /ไม่มีสิทธิ์ตรวจราคา/)
  assert.match(soul, /ห้ามเรียก get_product_price/)
  assert.doesNotMatch(soul, /ตรวจราคาขาย: เรียก get_product_price/)
})

test('sales template keeps price tool instructions', () => {
  const soul = generateSoulTemplate(null, 'sales', null, 'professional')

  assert.match(soul, /MCP_ACCESS_MODE=sales/)
  assert.match(soul, /get_product_price/)
  assert.match(soul, /ตรวจราคาขาย: เรียก get_product_price/)
})

