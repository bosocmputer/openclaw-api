const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

function loadConfigHelper(home) {
  process.env.HOME = home
  const configPath = path.resolve(__dirname, '../lib/config.js')
  const helperPath = path.resolve(__dirname, '../lib/openclaw-config.js')
  delete require.cache[configPath]
  delete require.cache[helperPath]
  return require(helperPath)
}

function makeState(initial = { agents: { list: [] } }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-config-'))
  const stateDir = path.join(home, '.openclaw')
  fs.mkdirSync(stateDir, { recursive: true })
  fs.writeFileSync(path.join(stateDir, 'openclaw.json'), JSON.stringify(initial, null, 2))
  return { home, configPath: path.join(stateDir, 'openclaw.json') }
}

test('writeOpenclawConfigAtomic writes valid JSON and creates a backup', () => {
  const { home, configPath } = makeState({ version: 1 })
  const { readOpenclawConfig, writeOpenclawConfigAtomic } = loadConfigHelper(home)

  const result = writeOpenclawConfigAtomic({ version: 2, agents: { list: [{ id: 'stock' }] } }, {
    backupId: 'testbackup',
    reason: 'unit-test',
  })

  assert.equal(result.backupId, 'testbackup')
  assert.equal(result.reason, 'unit-test')
  assert.deepEqual(readOpenclawConfig(), { version: 2, agents: { list: [{ id: 'stock' }] } })
  assert.deepEqual(JSON.parse(fs.readFileSync(`${configPath}.bak.testbackup`, 'utf8')), { version: 1 })
})

test('writeOpenclawConfigAtomic rejects non-object config', () => {
  const { home } = makeState()
  const { writeOpenclawConfigAtomic } = loadConfigHelper(home)

  assert.throws(() => writeOpenclawConfigAtomic(null), /JSON object/)
  assert.throws(() => writeOpenclawConfigAtomic([]), /JSON object/)
})

test('concurrent config writes do not corrupt openclaw.json', async () => {
  const { home } = makeState({ counter: 0 })
  const { readOpenclawConfig, writeOpenclawConfigAtomic } = loadConfigHelper(home)

  await Promise.all(Array.from({ length: 20 }, (_, i) => Promise.resolve().then(() => {
    writeOpenclawConfigAtomic({ counter: i }, { backupId: `c${i}` })
  })))

  const finalConfig = readOpenclawConfig()
  assert.equal(typeof finalConfig.counter, 'number')
})
