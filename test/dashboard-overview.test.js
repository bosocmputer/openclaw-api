const assert = require('node:assert/strict')
const test = require('node:test')

const { _internal } = require('../routes/dashboard')

test('dashboard release parser handles OpenClaw CLI output', () => {
  assert.equal(_internal.parseOpenclawVersion('OpenClaw 2026.6.8 (abc123)'), '2026.6.8')
  assert.equal(_internal.parseOpenclawVersion('2026.6.10'), '2026.6.10')
  assert.equal(_internal.parseOpenclawVersion('unknown'), null)
})

test('dashboard version compare treats date-style runtime versions numerically', () => {
  assert.equal(_internal.compareVersions('2026.6.8', '2026.6.8'), 0)
  assert.equal(_internal.compareVersions('2026.6.7', '2026.6.8'), -1)
  assert.equal(_internal.compareVersions('2026.6.10', '2026.6.8'), 1)
})

test('dashboard health summary includes release warnings without creating critical failures', () => {
  const summary = _internal.summarizeHealth({
    status: 'warn',
    checks: [
      { id: 'api.self', label: 'API', status: 'ok', severity: 'critical', summary: 'ok' },
      { id: 'mcp.stock', label: 'MCP stock', status: 'warn', severity: 'critical', summary: 'fallback' },
      { id: 'auth.stock', label: 'Auth stock', status: 'fail', severity: 'critical', summary: 'missing' },
    ],
  }, ['Installed runtime is behind target'])

  assert.equal(summary.status, 'warn')
  assert.equal(summary.criticalFail, 1)
  assert.equal(summary.warn, 2)
  assert.equal(summary.ok, 1)
  assert.equal(summary.warnings.some(w => w.id === 'release.runtime'), true)
})

test('dashboard cost summary counts model calls separately from deterministic tool-only turns', () => {
  const summary = _internal.summarizeCost({
    days: [
      {
        date: '2026-06-16',
        agents: [
          { agentId: 'stock', cost: 0.00123, inputTokens: 1000, outputTokens: 200, turns: 2 },
          { agentId: 'sale', cost: 0.002, inputTokens: 3000, outputTokens: 400, turns: 1 },
        ],
      },
    ],
    summary: { totalCost: 0.00323, byAgent: { stock: 0.00123, sale: 0.002 } },
  })

  assert.equal(summary.days, 1)
  assert.equal(summary.modelCalls, 3)
  assert.equal(summary.inputTokens, 4000)
  assert.equal(summary.outputTokens, 600)
  assert.equal(summary.byAgent[0].agentId, 'sale')
})
