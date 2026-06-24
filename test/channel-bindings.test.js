const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const {
  applyRouteBinding,
  isChannelSessionKey,
  resetChannelSessions,
} = require('../lib/channel-bindings')

function makeHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-channel-bindings-'))
}

function writeSessions(home, agentId, sessions) {
  const dir = path.join(home, `.openclaw/agents/${agentId}/sessions`)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify(sessions, null, 2))
  return path.join(dir, 'sessions.json')
}

function readSessions(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

test('isChannelSessionKey detects channel sessions without matching webchat text', () => {
  assert.equal(isChannelSessionKey('line', 'agent:sale:line:direct:u123'), true)
  assert.equal(isChannelSessionKey('line', 'agent:sale:hook:webchat:uid:line-user'), false)
  assert.equal(isChannelSessionKey('telegram', 'agent:stock:telegram:direct:123'), true)
  assert.equal(isChannelSessionKey('telegram', 'agent:stock:line:direct:u123'), false)
})

test('applyRouteBinding validates account and replaces existing route', () => {
  const config = {
    channels: { line: { accounts: { admin: { channelAccessToken: 'token' } } } },
    agents: { list: [{ id: 'admin' }, { id: 'sale' }] },
    bindings: [
      { type: 'route', agentId: 'admin', match: { channel: 'line', accountId: 'admin' } },
      { type: 'route', agentId: 'stock', match: { channel: 'telegram', accountId: 'stock' } },
    ],
  }

  const result = applyRouteBinding(config, { channel: 'line', accountId: 'admin', agentId: 'sale' })

  assert.equal(result.oldAgentId, 'admin')
  assert.equal(result.newAgentId, 'sale')
  assert.deepEqual(config.bindings, [
    { type: 'route', agentId: 'stock', match: { channel: 'telegram', accountId: 'stock' } },
    { type: 'route', agentId: 'sale', match: { channel: 'line', accountId: 'admin' } },
  ])
})

test('applyRouteBinding rejects missing account and agent', () => {
  const config = {
    channels: { telegram: { accounts: { stock: { botToken: 'token' } } } },
    agents: { list: [{ id: 'stock' }] },
    bindings: [],
  }

  assert.throws(
    () => applyRouteBinding(config, { channel: 'telegram', accountId: 'missing', agentId: 'stock' }),
    /account "missing" not found/,
  )
  assert.throws(
    () => applyRouteBinding(config, { channel: 'telegram', accountId: 'stock', agentId: 'sale' }),
    /Agent "sale" not found/,
  )
})

test('resetChannelSessions removes only affected channel sessions for old and new agents', () => {
  const home = makeHome()
  const adminPath = writeSessions(home, 'admin', {
    'agent:admin:line:direct:u1': { sessionId: 'line-admin' },
    'agent:admin:telegram:direct:t1': { sessionId: 'telegram-admin' },
    'agent:admin:hook:webchat:uid:staff': { sessionId: 'webchat-admin' },
    'agent:admin:main': { sessionId: 'main-admin', lastChannel: 'line' },
  })
  const salePath = writeSessions(home, 'sale', {
    'agent:sale:line:direct:u2': { sessionId: 'line-sale' },
    'agent:sale:telegram:direct:t2': { sessionId: 'telegram-sale' },
  })

  const result = resetChannelSessions({
    home,
    channel: 'line',
    oldAgentId: 'admin',
    newAgentId: 'sale',
  })

  assert.deepEqual(result.map(item => ({ agentId: item.agentId, removed: item.removed })), [
    { agentId: 'admin', removed: 1 },
    { agentId: 'sale', removed: 1 },
  ])
  assert.ok(result[0].backupPath)
  assert.deepEqual(Object.keys(readSessions(adminPath)).sort(), [
    'agent:admin:hook:webchat:uid:staff',
    'agent:admin:main',
    'agent:admin:telegram:direct:t1',
  ])
  assert.deepEqual(Object.keys(readSessions(salePath)).sort(), [
    'agent:sale:telegram:direct:t2',
  ])
})
