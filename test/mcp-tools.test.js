const assert = require('node:assert/strict')
const test = require('node:test')

const {
  compareSoulContractToTools,
  deriveCapabilities,
  getFallbackTools,
  hashToolNames,
  parseSoulContract,
  buildSoulContract,
  serializeSoulContract,
  normalizeAccessMode,
} = require('../lib/mcp-tools')

test('fallback tool snapshots expose price only for modes that have it', () => {
  const stock = getFallbackTools('stock')
  const sales = getFallbackTools('sales')

  assert.equal(stock.some(t => t.name === 'get_product_price'), false)
  assert.equal(sales.some(t => t.name === 'get_product_price'), true)
})

test('fallback tool snapshots exclude generic fallback and write tools by default', () => {
  for (const mode of ['admin', 'sales', 'purchase', 'stock', 'general']) {
    const names = getFallbackTools(mode).map(t => t.name)

    assert.equal(names.includes('fallback_response'), false, mode)
    assert.equal(names.includes('create_sale_reserve'), false, mode)
  }
})

test('fallback search_product exposes optional limit arg', () => {
  const search = getFallbackTools('stock').find(t => t.name === 'search_product')

  assert.ok(search)
  assert.deepEqual(search.required, ['keyword'])
  assert.ok(search.args.includes('keyword'))
  assert.ok(search.args.includes('limit'))
})

test('legacy sale agent ids normalize to sales access mode', () => {
  assert.equal(normalizeAccessMode('sale'), 'sales')
  assert.equal(normalizeAccessMode('sale_goh'), 'sales')
})

test('capability derivation separates allowed and denied capabilities', () => {
  const { capabilities, deniedCapabilities } = deriveCapabilities(getFallbackTools('stock'))

  assert.ok(capabilities.some(c => c.id === 'stock_balance'))
  assert.ok(deniedCapabilities.some(c => c.id === 'price_lookup'))
})

test('contract parser and comparer detect hash mismatch as warning', () => {
  const tools = getFallbackTools('sales')
  const contract = buildSoulContract({
    accessMode: 'sales',
    toolSource: 'live',
    tools,
    generatedAt: new Date().toISOString(),
  })
  const parsed = parseSoulContract(serializeSoulContract({ ...contract, allowedToolsHash: hashToolNames(['missing_tool']) }))
  const result = compareSoulContractToTools(parsed, tools)

  assert.equal(result.status, 'warn')
  assert.ok(result.warnings.some(w => w.includes('hash mismatch')))
})
