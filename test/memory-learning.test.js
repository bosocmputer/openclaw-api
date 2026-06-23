const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const memoryLearning = require('../lib/memory-learning')
const memoryRoute = require('../routes/memory')

test('memory status reads current memory-core dreaming config path', () => {
  const current = memoryRoute._internal.getDreamingConfig({
    plugins: {
      entries: {
        'memory-core': {
          config: { dreaming: { enabled: true, frequency: '0 3 * * *' } },
        },
      },
    },
    memory: { dreaming: { enabled: false } },
  })

  assert.equal(current.enabled, true)
  assert.equal(current.source, 'plugins.entries.memory-core.config.dreaming')
})

test('memory status supports uppercase DREAMS.md', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-dreams-'))
  try {
    fs.writeFileSync(path.join(dir, 'DREAMS.md'), '# Dream Diary\n')
    const found = memoryRoute._internal.findDreamsFile(dir)
    assert.equal(found.name, 'DREAMS.md')
    assert.equal(found.path, path.join(dir, 'DREAMS.md'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('learning candidate normalization dedupes by stable redacted source hash', () => {
  const a = memoryLearning._internal.normalizeCandidateInput({
    agentId: 'stock',
    targetType: 'memory',
    summary: 'ลูกค้าชอบถามรุ่นรถก่อนราคา',
    evidence: [{ turnId: 't1', authorization: 'Bearer abc123', keyword: 'โช๊ค' }],
    sourceTurnIds: ['t1'],
    confidence: 0.9,
  })
  const b = memoryLearning._internal.normalizeCandidateInput({
    sourceTurnIds: ['t1'],
    confidence: 0.9,
    evidence: [{ keyword: 'โช๊ค', authorization: 'Bearer abc123', turnId: 't1' }],
    summary: 'ลูกค้าชอบถามรุ่นรถก่อนราคา',
    targetType: 'memory',
    agentId: 'stock',
  })

  assert.equal(a.sourceHash, b.sourceHash)
  assert.doesNotMatch(JSON.stringify(a.evidence), /abc123/)
})

test('learning candidate rejects secret-like summaries', () => {
  assert.throws(() => memoryLearning._internal.normalizeCandidateInput({
    agentId: 'stock',
    targetType: 'memory',
    summary: 'apiKey: sk-test-secret',
  }), /secret-like/)
})

test('managed memory append does not overwrite user-authored sections', () => {
  const current = '# Long-Term Memory\n\n## User Notes\n- keep me\n'
  const next = memoryLearning._internal.buildManagedMemoryContent(current, {
    summary: 'ลูกค้ามักถามด้วยชื่ออะไหล่และรุ่นรถ',
    sourceTurnIds: ['turn-1'],
    confidence: 0.8,
  })

  assert.match(next, /## User Notes\n- keep me/)
  assert.match(next, /## Admin-Approved Business Memory/)
  assert.match(next, /ลูกค้ามักถามด้วยชื่ออะไหล่และรุ่นรถ/)
  assert.equal((next.match(/ลูกค้ามักถามด้วยชื่ออะไหล่และรุ่นรถ/g) || []).length, 1)
})

test('managed memory block enforces size budget', () => {
  const current = `# Long-Term Memory

## Admin-Approved Business Memory
<!-- OPENCLAW_ADMIN_APPROVED_MEMORY_START -->
${'- already approved memory\n'.repeat(260)}
<!-- OPENCLAW_ADMIN_APPROVED_MEMORY_END -->
`
  assert.throws(() => memoryLearning._internal.buildManagedMemoryContent(current, {
    summary: 'อีกหนึ่ง memory',
    sourceTurnIds: [],
    confidence: null,
  }), /exceed/)
})
