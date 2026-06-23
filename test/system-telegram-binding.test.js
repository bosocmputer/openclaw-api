const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { _internal } = require('../routes/system')
const { generateSoulTemplate } = require('../lib/soul-template')
const { getFallbackTools } = require('../lib/mcp-tools')

function configForBinding(agentId = 'admin') {
  return {
    channels: {
      telegram: {
        accounts: {
          chang168_stock_bot: { botToken: 'bot<redacted>' },
        },
      },
    },
    bindings: [
      {
        type: 'route',
        agentId,
        match: { channel: 'telegram', accountId: 'chang168_stock_bot' },
      },
    ],
  }
}

test('telegram binding intent report warns when task-specific bot routes to broad agent', () => {
  const report = _internal.telegramBindingIntentReport(configForBinding('admin'), { acknowledgements: {} })

  assert.equal(report.warnings.length, 1)
  assert.equal(report.warnings[0].accountId, 'chang168_stock_bot')
  assert.equal(report.warnings[0].agentId, 'admin')
  assert.equal(report.accepted.length, 0)
})

test('telegram binding intent report accepts acknowledged broad route only for matching agent', () => {
  const state = {
    acknowledgements: {
      'chang168_stock_bot::admin': {
        accountId: 'chang168_stock_bot',
        agentId: 'admin',
        acknowledgedAt: '2026-06-23T00:00:00.000Z',
        note: 'trial admin route',
      },
    },
  }

  const acceptedReport = _internal.telegramBindingIntentReport(configForBinding('admin'), state)
  assert.equal(acceptedReport.warnings.length, 0)
  assert.equal(acceptedReport.accepted.length, 1)
  assert.equal(acceptedReport.accepted[0].note, 'trial admin route')

  const changedRouteReport = _internal.telegramBindingIntentReport(configForBinding('general'), state)
  assert.equal(changedRouteReport.warnings.length, 1)
  assert.equal(changedRouteReport.accepted.length, 0)
})

test('telegram binding intent report does not warn when task-specific bot routes to matching specific agent', () => {
  const report = _internal.telegramBindingIntentReport(configForBinding('stock'), { acknowledgements: {} })

  assert.equal(report.warnings.length, 0)
  assert.equal(report.accepted.length, 0)
})

test('soul status warns when image-enabled agent is missing native media contract', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-soul-native-missing-'))
  fs.writeFileSync(path.join(workspace, 'SOUL.md'), '## SOUL\nnative image is not contracted yet\n')

  const status = _internal.soulStatus(
    { id: 'stock', workspace, tools: { allow: ['image'] } },
    getFallbackTools('stock')
  )

  assert.equal(status.nativeMediaStatus, 'missing')
  assert.ok(status.workflowWarnings.includes('SOUL missing native image/media contract'))
})

test('soul status accepts generated template with native image contract', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-soul-native-ok-'))
  const tools = getFallbackTools('stock')
  fs.writeFileSync(path.join(workspace, 'SOUL.md'), generateSoulTemplate(workspace, 'stock', null, 'professional', {
    tools,
    toolSource: 'test',
    nativeCapabilities: ['image'],
    generatedAt: '2026-06-23T00:00:00.000Z',
  }))

  const status = _internal.soulStatus(
    { id: 'stock', workspace, tools: { allow: ['image'] } },
    tools
  )

  assert.equal(status.nativeMediaStatus, 'ok')
  assert.equal(status.workflowWarnings.includes('SOUL missing native image/media contract'), false)
})

test('line account extraction supports named and default webhook paths', () => {
  const accounts = _internal.lineAccounts({
    channels: {
      line: {
        channelAccessToken: 'line-default-token',
        webhookPath: '/line/webhook/main',
        accounts: {
          stock_oa: {
            channelAccessToken: 'line-stock-token',
            webhookPath: 'line/custom/stock',
          },
          disabled_oa: {},
        },
      },
    },
  })

  assert.deepEqual(accounts, [
    { id: 'stock_oa', webhookPath: 'line/custom/stock' },
    { id: 'default', webhookPath: '/line/webhook/main' },
  ])
})

test('recent stalled media sessions ignore markers before latest gateway ready', () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-stalled-media-'))
  const logPath = path.join(logDir, 'openclaw-test.log')
  fs.writeFileSync(logPath, [
    '{"message":"stalled session: sessionKey=agent:stock:line:direct:u1 reason=active_work_without_progress"}',
    '{"message":"gateway ready"}',
    '{"message":"ordinary line event"}',
  ].join('\n'))

  assert.deepEqual(_internal.recentStalledMediaSessions(logDir), [])

  fs.appendFileSync(logPath, '\n{"message":"stalled session: sessionKey=agent:stock:line:direct:u2 reason=active_work_without_progress"}\n')
  const warnings = _internal.recentStalledMediaSessions(logDir)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0].summary, /u2/)
})
