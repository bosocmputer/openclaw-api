const assert = require('node:assert/strict')
const test = require('node:test')

const businessProfiles = require('../lib/business-profiles')

test('business profile templates use production-facing names', () => {
  const names = businessProfiles.getTemplates().map(template => template.name)
  assert.deepEqual(names, [
    'Automotive Parts Retail & Service',
    'Restaurant & Food Service',
    'Construction Materials & Hardware Retail',
    'General Retail & Consumer Goods',
  ])
})

test('business profile validation rejects long soul blocks and secret-like values', () => {
  assert.throws(() => businessProfiles.normalizeProfileInput({
    name: 'Long',
    nameTh: 'ยาว',
    businessType: 'test',
    soulBlock: 'x'.repeat(businessProfiles.SOUL_BLOCK_MAX_CHARS + 1),
  }), /soulBlock must be <=/)

  assert.throws(() => businessProfiles.normalizeProfileInput({
    name: 'Secret',
    nameTh: 'มี secret',
    businessType: 'test',
    soulBlock: '## Business Profile\npassword=secret',
  }), /secret-like/)
})

test('business profile soul block carries stable hash marker', () => {
  const block = businessProfiles.buildBusinessProfileSoulBlock({
    id: '00000000-0000-4000-8000-000000000002',
    soulBlockHash: 'abc123',
    soulBlock: '## Business Profile\nธุรกิจ: ทดสอบ',
  })

  assert.match(block, /OPENCLAW_BUSINESS_PROFILE/)
  assert.match(block, /"hash":"abc123"/)
  assert.equal(businessProfiles.extractBusinessProfileHashFromSoul(block), 'abc123')
})
