const assert = require('node:assert/strict')
const test = require('node:test')

const { generateSoulTemplate } = require('../lib/soul-template')
const { getFallbackTools, parseSoulContract } = require('../lib/mcp-tools')
const { buildBusinessProfileSoulBlock } = require('../lib/business-profiles')

test('stock template does not instruct unavailable price tool calls', () => {
  const soul = generateSoulTemplate(null, 'stock', null, 'professional')

  assert.match(soul, /MCP_ACCESS_MODE=stock/)
  assert.match(soul, /workflowContract=stock-flow-v1/)
  assert.match(soul, /responseContract=grounded-reply-v1/)
  assert.match(soul, /Tools ที่ใช้ได้/)
  assert.match(soul, /ไม่มีสิทธิ์ตรวจราคา/)
  assert.match(soul, /ห้ามเรียก search_product หรือ tool อื่นเพื่ออ้อมไปหาราคา/)
  assert.match(soul, /OPENCLAW_SOUL_CONTRACT/)
  assert.doesNotMatch(soul, /ตรวจราคาด้วย get_product_price/)
  assert.doesNotMatch(soul, /write tool/)
  assert.doesNotMatch(soul, /memory\/YYYY-MM-DD/)
  assert.doesNotMatch(soul, /## ความจำระหว่าง Session/)
  assert.doesNotMatch(soul, /\bcurl\b/i)
  assert.doesNotMatch(soul, /\/call\b/i)
  assert.doesNotMatch(soul, /exec\s+tool/i)
  assert.doesNotMatch(soul, /mcporter/i)
  assert.doesNotMatch(soul, /fallback_response/)
  assert.doesNotMatch(soul, /create_sale_reserve/)
})

test('stock template enforces stock balance workflow after single product match', () => {
  const soul = generateSoulTemplate(null, 'stock', null, 'professional')

  assert.match(soul, /stock-flow-v1/)
  assert.match(soul, /ยอดคงเหลือ.*ให้รหัสสินค้าแล้ว.*เรียก get_stock_balance โดยตรง/s)
  assert.match(soul, /search_product ด้วย limit:20/)
  assert.match(soul, /search_product พบสินค้า 1 รายการ.*เรียก get_stock_balance ต่อทันที/s)
  assert.match(soul, /ไม่มี page\/offset ใน schema.*พบ X รายการ แสดงได้สูงสุด Y รายการแรก/s)
  assert.match(soul, /ห้ามบอกว่าเปิดหน้าถัดไปได้/)
  assert.match(soul, /รายการ N.*ระบบแนบรหัสที่ตีความแล้ว.*เรียก get_stock_balance ทันที/s)
  assert.match(soul, /เลือกเลขที่ไม่ได้อยู่ในรายการที่แสดง.*ยังเลือกไม่ได้/s)
  assert.match(soul, /found:0.*พบสินค้า CODE - NAME แล้ว แต่ไม่พบยอดคงเหลือในคลังครับ/s)
  assert.match(soul, /ห้ามตอบ generic/)
  assert.match(soul, /ห้ามตอบว่าไม่พบสินค้า/)
  assert.match(soul, /ห้ามใส่ placeholder/)
  assert.match(soul, /ห้ามปนภาษาอังกฤษในคำตอบสุดท้าย/)
  assert.match(soul, /ห้ามใส่รายการ follow-up ยาว/)
  assert.match(soul, /native command ที่ระบบจัดการเองแล้ว.*ห้ามตอบซ้ำ/)
})

test('template grounds answers in tool results and avoids generic market estimates', () => {
  const soul = generateSoulTemplate(null, 'admin', null, 'professional')

  assert.match(soul, /ผลลัพธ์จาก tool เป็น source of truth/)
  assert.match(soul, /ห้ามเติมจากความรู้ทั่วไป ความจำ ราคาตลาด/)
  assert.match(soul, /ห้ามใช้คำว่า "ราคาโดยประมาณ"/)
  assert.match(soul, /status เช่น needs_refine, ambiguous, no_result, found:0/)
  assert.match(soul, /ถามข้อมูลเพิ่มสั้น ๆ หนึ่งข้อ/)
  assert.match(soul, /ห้ามเรียก tool เดิมด้วย keyword เดิมหรือใกล้เคียงกันเกิน 2 ครั้ง/)
  assert.match(soul, /ใช้สิ่งที่อ่านได้จากรูปเป็น keyword หรือ context สำหรับค้นเท่านั้น/)
  assert.match(soul, /ห้ามลงท้ายซ้ำ เช่น "ครับครับ"/)
})

test('template search guidance is generic and avoids business-specific examples', () => {
  const soul = generateSoulTemplate(null, 'general', null, 'professional')

  assert.match(soul, /ยี่ห้อ ผู้ผลิต รุ่น ประเภทสินค้า หรือรหัส/)
  assert.match(soul, /retry ได้ไม่เกิน 1 ครั้ง/)
  assert.match(soul, /ห้ามค้นแยกทีละคำจนได้รายการไม่เกี่ยวข้องจำนวนมาก/)
  assert.doesNotMatch(soul, /หลอดไฟ/i)
  assert.doesNotMatch(soul, /kotto/i)
  assert.doesNotMatch(soul, /civic/i)
  assert.doesNotMatch(soul, /denso/i)
  assert.doesNotMatch(soul, /hitachi/i)
})

test('stock template allows search pagination only when schema exposes page or offset', () => {
  const tools = getFallbackTools('stock').map(tool => {
    if (tool.name !== 'search_product') return tool
    return { ...tool, args: ['keyword', 'limit', 'page'] }
  })
  const soul = generateSoulTemplate(null, 'stock', null, 'professional', {
    tools,
    toolSource: 'live',
  })

  assert.match(soul, /ถ้า total_found > returned และ user ขอหน้าถัดไป ให้ใช้ page หรือ offset/)
  assert.doesNotMatch(soul, /search_product ไม่มี page\/offset ใน schema/)
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

test('template injects bounded business profile before MCP tool contract', () => {
  const businessProfileSoulBlock = buildBusinessProfileSoulBlock({
    id: '00000000-0000-4000-8000-000000000001',
    soulBlockHash: 'profilehash1234',
    soulBlock: '## Business Profile\nธุรกิจ: ธุรกิจตัวอย่าง\n\nแนวทางตอบ:\n- ห้ามเดาข้อมูลถ้า tool ไม่ยืนยัน',
  })
  const soul = generateSoulTemplate(null, 'general', null, 'professional', {
    businessProfileSoulBlock,
  })

  assert.match(soul, /OPENCLAW_BUSINESS_PROFILE/)
  assert.match(soul, /## Business Profile/)
  assert.ok(soul.indexOf('## Business Profile') > soul.indexOf('## บุคลิก'))
  assert.ok(soul.indexOf('## Business Profile') < soul.indexOf('## MCP Tool Contract'))
  assert.match(soul, /ห้ามเดาข้อมูลถ้า tool ไม่ยืนยัน/)
})

test('all default templates avoid legacy MCP invocation patterns', () => {
  for (const mode of ['admin', 'sales', 'purchase', 'stock', 'general']) {
    const soul = generateSoulTemplate(null, mode, null, 'professional')
    assert.doesNotMatch(soul, /\bcurl\b/i, mode)
    assert.doesNotMatch(soul, /\/call\b/i, mode)
    assert.doesNotMatch(soul, /exec\s+tool/i, mode)
    assert.doesNotMatch(soul, /mcporter/i, mode)
    assert.doesNotMatch(soul, /fallback_response/, mode)
    assert.doesNotMatch(soul, /create_sale_reserve/, mode)
  }
})
