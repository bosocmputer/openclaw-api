const assert = require('node:assert/strict')
const test = require('node:test')

const memoryAuto = require('../lib/memory-auto')

test('explicit teaching becomes a staff instruction observation without auto truth', () => {
  const observation = memoryAuto._internal.explicitTeachingObservation({
    id: 'turn-1',
    agentId: 'sale',
    channel: 'line',
    userText: 'จำไว้ว่า ลูกค้ารายนี้ชอบให้สรุปเป็นข้อสั้น ๆ',
  })

  assert.ok(observation)
  assert.equal(observation.agentId, 'sale')
  assert.equal(observation.type, 'staff_instruction')
  assert.equal(observation.scope, 'agent')
  assert.equal(observation.risk, 'medium')
  assert.equal(observation.recommendedAction, 'policy_promote')
  assert.match(observation.summary, /ลูกค้ารายนี้/)
})

test('explicit ERP value teaching is blocked instead of promoted', () => {
  const observation = memoryAuto._internal.explicitTeachingObservation({
    id: 'turn-price',
    agentId: 'stock',
    channel: 'telegram',
    userText: 'จำไว้ว่า น้ำมันเครื่องตัวนี้ราคา 620 บาท',
  })

  assert.ok(observation)
  assert.equal(observation.type, 'blocked_fact')
  assert.equal(observation.risk, 'high')
  assert.equal(observation.recommendedAction, 'block_truth')
  assert.match(observation.summary, /ห้ามจำเป็นข้อมูลถาวร/)
})

test('observations avoid duplicate staff instruction when teaching blocked ERP values', () => {
  const observations = memoryAuto._internal.observationsFromTurn({
    id: 'turn-stock',
    agentId: 'stock',
    channel: 'telegram',
    userText: 'จำไว้ว่า สินค้านี้มีสต็อก 7 ชิ้น',
    issues: [{
      tag: 'unsupported_capability',
      label: 'Unsupported capability',
      reviewTarget: 'business capability',
      severity: 'issue',
      evidence: { userPreview: 'จำไว้ว่า สินค้านี้มีสต็อก 7 ชิ้น' },
    }],
  })

  assert.equal(observations.length, 1)
  assert.equal(observations[0].type, 'blocked_fact')
  assert.equal(observations[0].risk, 'high')
  assert.equal(observations.some(item => item.type === 'staff_instruction'), false)
})

test('price and capability issues are classified as blocked facts', () => {
  const observation = memoryAuto._internal.issueToObservation({
    id: 'turn-2',
    agentId: 'stock',
    channel: 'telegram',
    userText: 'ราคาเท่าไหร่',
  }, {
    tag: 'unverified_price_guess',
    label: 'Unverified price guess',
    reviewTarget: 'SOUL',
    severity: 'issue',
    evidence: { userPreview: 'ราคาเท่าไหร่', finalPreview: 'ราคาประมาณ 100 บาท' },
  })

  assert.equal(observation.type, 'blocked_fact')
  assert.equal(observation.risk, 'high')
  assert.equal(observation.recommendedAction, 'block_truth')
  assert.equal(observation.confidence, 0.2)
})

test('search issues stay as MCP/Search review signals, not hardcoded business logic', () => {
  const observation = memoryAuto._internal.issueToObservation({
    id: 'turn-3',
    agentId: 'sale',
    channel: 'line',
    userText: 'มีของไหม',
  }, {
    tag: 'search_no_result',
    label: 'Search no result',
    reviewTarget: 'MCP/search',
    severity: 'issue',
    evidence: { keyword: 'ของ', userPreview: 'มีของไหม' },
  })

  assert.equal(observation.type, 'entity_alias')
  assert.equal(observation.risk, 'low')
  assert.equal(observation.recommendedAction, 'mcp_search_review')
  assert.doesNotMatch(observation.summary, /chang168/i)
})

test('normalized content hash is whitespace and case insensitive for tombstones', () => {
  const a = memoryAuto._internal.normalizedContentHash('  ลูกค้า ชอบ คำตอบ สั้น  ')
  const b = memoryAuto._internal.normalizedContentHash('ลูกค้า ชอบ คำตอบ สั้น')
  assert.equal(a, b)
})

test('memory enum validators reject invalid values', () => {
  assert.throws(() => memoryAuto._internal.normalizeMemoryType('price_truth'), /type is invalid/)
  assert.throws(() => memoryAuto._internal.normalizeMemoryScope('customer-server'), /scope is invalid/)
  assert.throws(() => memoryAuto._internal.normalizePolicyMode('auto-everything'), /mode is invalid/)
})
