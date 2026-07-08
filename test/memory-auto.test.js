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

test('managed Agent Brain context is stripped before learning from user text', () => {
  const pollutedText = [
    'จำไว้ว่า ลูกค้าร้านนี้มักพิมพ์คำว่า ลูกปืนดุม แทน ดุมล้อ',
    '',
    '## Agent Knowledge Brain',
    'Use the following admin-approved stable hints only as extra context.',
    '- [term] โช๊ค = โช้คอัพ',
  ].join('\n')
  const observation = memoryAuto._internal.explicitTeachingObservation({
    id: 'turn-polluted',
    agentId: 'stock',
    channel: 'telegram',
    userText: pollutedText,
  })

  assert.ok(observation)
  assert.equal(observation.type, 'staff_instruction')
  assert.equal(observation.recommendedAction, 'policy_promote')
  assert.match(observation.summary, /ลูกปืนดุม/)
  assert.doesNotMatch(observation.summary, /Agent Knowledge Brain/)
  assert.doesNotMatch(observation.evidence.userPreview, /Agent Knowledge Brain/)
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

test('blocked ERP teaching strips managed Agent Brain context from summary', () => {
  const observation = memoryAuto._internal.explicitTeachingObservation({
    id: 'turn-price-polluted',
    agentId: 'stock',
    channel: 'telegram',
    userText: [
      'จำไว้ว่า น้ำมันเครื่องตัวนี้ราคา 999 บาท',
      '',
      '## Agent Knowledge Brain',
      '- [term] ลูกปืนดุม = ดุมล้อ',
    ].join('\n'),
  })

  assert.ok(observation)
  assert.equal(observation.type, 'blocked_fact')
  assert.match(observation.summary, /ราคา 999/)
  assert.doesNotMatch(observation.summary, /Agent Knowledge Brain/)
  assert.doesNotMatch(observation.evidence.userPreview, /Agent Knowledge Brain/)
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

test('safe auto promotes only policy-safe observations and blocks high risk', () => {
  const policy = {
    mode: 'safe_auto',
    safeTypes: ['terminology', 'workflow_hint', 'entity_alias'],
    allowChatTeaching: true,
  }

  assert.equal(memoryAuto._internal.canAutoPromoteObservation({
    status: 'observed',
    type: 'terminology',
    risk: 'low',
    recommendedAction: 'observe',
    evidence: {},
  }, policy), false)

  assert.equal(memoryAuto._internal.canAutoPromoteObservation({
    status: 'observed',
    type: 'terminology',
    risk: 'medium',
    recommendedAction: 'policy_promote',
    evidence: { source: 'explicit_chat_teaching' },
    summary: 'ลูกค้ากลุ่มนี้มักใช้คำย่อ ABC สำหรับบริการนี้',
  }, policy), true)

  assert.equal(memoryAuto._internal.canAutoPromoteObservation({
    status: 'observed',
    type: 'entity_alias',
    risk: 'low',
    recommendedAction: 'mcp_search_review',
    evidence: {},
  }, policy), false)

  assert.equal(memoryAuto._internal.canAutoPromoteObservation({
    status: 'observed',
    type: 'blocked_fact',
    risk: 'high',
    recommendedAction: 'block_truth',
    evidence: {},
  }, policy), true)
})

test('safe auto never promotes issue/log/media observations', () => {
  const policy = {
    mode: 'safe_auto',
    safeTypes: ['terminology', 'workflow_hint', 'entity_alias'],
    allowChatTeaching: true,
  }
  const issueObservation = memoryAuto._internal.issueToObservation({
    id: 'turn-refine',
    agentId: 'sale',
    userText: 'ถามกว้าง ๆ',
  }, {
    tag: 'needs_user_refine',
    label: 'Needs user refine',
    reviewTarget: 'user ambiguity',
    evidence: { userPreview: 'ถามกว้าง ๆ' },
  })

  assert.equal(issueObservation.recommendedAction, 'manual_review')
  assert.equal(memoryAuto._internal.canAutoPromoteObservation(issueObservation, policy), false)
  assert.equal(memoryAuto._internal.canAutoPromoteObservation({
    status: 'observed',
    type: 'workflow_hint',
    risk: 'low',
    recommendedAction: 'manual_review',
    evidence: { source: 'media_workflow' },
    summary: '[User sent media without caption]',
  }, policy), false)
})

test('vague explicit teaching is review-only and dynamic facts stay blocked', () => {
  const vague = memoryAuto._internal.explicitTeachingObservation({
    id: 'turn-vague',
    agentId: 'sale',
    userText: 'จำไว้ว่า ตัวนี้ใช้เป็นเบอร์นี้',
  })
  assert.ok(vague)
  assert.equal(vague.type, 'staff_instruction')
  assert.equal(vague.recommendedAction, 'manual_review')
  assert.equal(memoryAuto._internal.canAutoPromoteObservation(vague, {
    mode: 'safe_auto',
    safeTypes: ['staff_instruction'],
    allowChatTeaching: true,
  }), false)

  const dynamic = memoryAuto._internal.classifyMemoryText('จำไว้ว่าลูกค้าคนนี้ได้ราคาพิเศษเสมอ', { source: 'explicit_chat_teaching', promotable: true })
  assert.equal(dynamic.decision, 'blocked_dynamic_fact')
  assert.equal(dynamic.safeToPromote, false)
})

test('explicit search teaching becomes search hint candidate, not generic truth', () => {
  const observation = memoryAuto._internal.explicitTeachingObservation({
    id: 'turn-search-hint',
    agentId: 'sale',
    channel: 'line',
    userText: 'จำไว้ว่า C010113-0318 ใช้กับผ้าเบรคหน้า',
  })

  assert.ok(observation)
  assert.equal(observation.type, 'search_hint')
  assert.equal(observation.recommendedAction, 'search_hint_candidate')
  assert.equal(observation.evidence.productCodes[0], 'C010113-0318')
  assert.equal(memoryAuto._internal.canAutoPromoteObservation(observation, {
    mode: 'safe_auto',
    safeTypes: ['search_hint'],
    allowChatTeaching: true,
  }), false)
})

test('description suggestions are generated from product code plus terms but not runtime context', () => {
  const observation = memoryAuto._internal.descriptionSuggestionObservation({
    id: 'turn-desc',
    agentId: 'sale',
    channel: 'line',
    userText: 'C010113-0318 ผ้าเบรคหน้า',
    finalText: 'ผ้าเบรคหน้า รหัส C010113-0318 ราคา 750 บาท',
  })

  assert.ok(observation)
  assert.equal(observation.type, 'description_suggestion')
  assert.equal(observation.recommendedAction, 'description_suggestion')
  assert.equal(observation.evidence.productCodes[0], 'C010113-0318')

  const selected = memoryAuto._internal.selectRuntimeMemoryLines([
    { id: 'desc', status: 'active', type: 'description_suggestion', content: observation.summary, confidence: 0.8 },
    { id: 'term', status: 'active', type: 'terminology', content: 'เบรค = เบรก', confidence: 0.8 },
  ], 500)
  assert.equal(selected.includedMemoryIds.includes('desc'), false)
  assert.equal(selected.includedMemoryIds.includes('term'), true)
})

test('channel and audience validators protect customer channels from SML suggestions', () => {
  assert.equal(memoryAuto._internal.normalizeChannel('line'), 'line')
  assert.equal(memoryAuto._internal.normalizeAudience('internal'), 'internal')
  assert.throws(() => memoryAuto._internal.normalizeChannel('sms'), /channel is invalid/)
  assert.throws(() => memoryAuto._internal.normalizeAudience('public'), /audience is invalid/)
})

test('runtime memory selection respects max context chars and priority', () => {
  const selection = memoryAuto._internal.selectRuntimeMemoryLines([
    { id: 'low', status: 'active', type: 'workflow_hint', content: 'ตอบให้สุภาพและถามเพิ่มเมื่อข้อมูลไม่พอ', confidence: 0.8, updatedAt: '2026-01-01T00:00:00Z' },
    { id: 'term', status: 'active', type: 'terminology', content: 'คำว่า ABC หมายถึงชื่อเรียกเดียวกับ Alpha Beta', confidence: 0.9, updatedAt: '2026-01-02T00:00:00Z' },
    { id: 'blocked', status: 'blocked', type: 'blocked_fact', content: 'ราคา 100 บาท', confidence: 0.9, updatedAt: '2026-01-03T00:00:00Z' },
  ], 90)

  assert.ok(selection.chars <= 90)
  assert.ok(selection.includedMemoryIds.includes('term'))
  assert.equal(selection.includedMemoryIds.includes('blocked'), false)
})

test('auto learned block is replaced without touching other memory sections', () => {
  const current = [
    '# Long-Term Memory',
    '',
    '<!-- OPENCLAW_AUTO_LEARN_MEMORY_START -->',
    '- old',
    '<!-- OPENCLAW_AUTO_LEARN_MEMORY_END -->',
    '',
    '## Manual Notes',
    '- keep me',
    '',
  ].join('\n')
  const next = memoryAuto._internal.replaceAutoMemoryBlock(current, ['- [term] โช๊ค = โช้คอัพ'])
  assert.match(next, /# Long-Term Memory/)
  assert.match(next, /Auto-Learned Business Memory/)
  assert.match(next, /\[term\] โช๊ค = โช้คอัพ/)
  assert.doesNotMatch(next, /- old/)
  assert.match(next, /## Manual Notes\n- keep me/)
})
