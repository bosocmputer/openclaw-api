const assert = require('node:assert/strict')
const test = require('node:test')

const {
  DEFAULT_RESTART_SCRIPT,
  gatewayRestartCommand,
  restartGateway,
  _internal,
} = require('../lib/gateway-restart')

test('gateway restart defaults to pm2 before falling back to openclaw CLI', () => {
  const result = gatewayRestartCommand({})

  assert.equal(result.method, 'pm2_or_openclaw')
  assert.match(result.command, /bash -lc/)
  assert.match(DEFAULT_RESTART_SCRIPT, /pm2 restart openclaw-gateway --update-env/)
  assert.match(DEFAULT_RESTART_SCRIPT, /openclaw gateway restart/)
})

test('gateway restart command can be overridden for custom deployments', () => {
  const result = gatewayRestartCommand({
    OPENCLAW_GATEWAY_RESTART_COMMAND: '/usr/bin/systemctl restart openclaw-gateway.service',
  })

  assert.equal(result.method, 'custom')
  assert.equal(result.command, '/usr/bin/systemctl restart openclaw-gateway.service')
})

test('restartGateway returns method and bounded output', async () => {
  let capturedCommand = ''
  const result = await restartGateway({
    env: {},
    execFn: (command, options, callback) => {
      capturedCommand = command
      callback(null, 'gateway restarted\n', '')
    },
  })

  assert.match(capturedCommand, /pm2 restart openclaw-gateway/)
  assert.equal(result.method, 'pm2_or_openclaw')
  assert.equal(result.stdout, 'gateway restarted\n')
})

test('restartGateway exposes safe failure details', async () => {
  await assert.rejects(
    restartGateway({
      env: { GATEWAY_RESTART_COMMAND: 'false' },
      execFn: (command, options, callback) => {
        const err = new Error('Command failed')
        callback(err, 'stdout detail', 'stderr detail')
      },
    }),
    err => {
      assert.equal(err.message, 'stderr detail')
      assert.equal(err.method, 'custom')
      assert.equal(err.stdout, 'stdout detail')
      assert.equal(err.stderr, 'stderr detail')
      return true
    },
  )
})

test('truncateOutput bounds long restart output', () => {
  assert.equal(_internal.truncateOutput('abc', 5), 'abc')
  assert.equal(_internal.truncateOutput('abcdef', 5), 'abcde…')
})
