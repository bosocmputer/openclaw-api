const assert = require('node:assert/strict')
const test = require('node:test')

const { _internal } = require('../routes/system')

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
