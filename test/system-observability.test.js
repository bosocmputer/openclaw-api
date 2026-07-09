const assert = require('node:assert/strict')
const test = require('node:test')

const observability = require('../lib/system-observability')

test('OpenClaw version parser extracts version and commit', () => {
  assert.deepEqual(
    observability._internal.parseOpenclawVersion('OpenClaw 2026.6.11 (fe43292)'),
    { raw: 'OpenClaw 2026.6.11 (fe43292)', version: '2026.6.11', commit: 'fe43292' },
  )
})

test('semantic version compare handles patch upgrades', () => {
  assert.equal(observability._internal.compareVersions('2026.6.11', '2026.6.8'), 1)
  assert.equal(observability._internal.compareVersions('2026.6.8', '2026.6.11'), -1)
  assert.equal(observability._internal.compareVersions('2026.6.11', '2026.6.11'), 0)
})

test('gateway process runtime matcher checks PM2 command shape', () => {
  assert.equal(observability._internal.processUsesRuntime({
    execPath: '/usr/bin/node',
    args: '/root/openclaw-runtime-2026.6.11-erp/dist/index.js gateway --port 18789',
    cwd: '/root',
  }, '2026.6.11'), true)

  assert.equal(observability._internal.processUsesRuntime({
    execPath: '/usr/bin/node',
    args: '/root/openclaw-runtime-2026.6.8-erp/dist/index.js gateway --port 18789',
    cwd: '/root',
  }, '2026.6.11'), false)
})

test('customer update command runs release gate as POST', () => {
  const command = observability.buildCustomerUpdateCommand().command
  assert.match(command, /OPENCLAW_BIN=\/root\/openclaw-runtime-2026\.6\.11-erp\/dist\/index\.js/)
  assert.match(command, /TARGET_RUNTIME_BRANCH=codex\/openclaw-2026\.6\.11-erp-line-burst/)
  assert.match(command, /git clone --depth 1 --branch "\$TARGET_RUNTIME_BRANCH" https:\/\/github\.com\/bosocmputer\/openclaw\.git "\$NEW_RUNTIME"/)
  assert.match(command, /pnpm build:docker/)
  assert.match(command, /cat > \/root\/start-openclaw-gateway\.sh/)
  assert.match(command, /pm2 start \/root\/start-openclaw-gateway\.sh --name openclaw-gateway/)
  assert.match(command, /curl -fsS -X POST .*\/api\/system\/release-gate\/run/)
})
