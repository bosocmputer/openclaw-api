const { exec } = require('child_process')

const DEFAULT_RESTART_SCRIPT = [
  'if command -v pm2 >/dev/null 2>&1; then',
  '  pm2 restart openclaw-gateway --update-env;',
  'elif [ -x "$HOME/.npm-global/bin/pm2" ]; then',
  '  "$HOME/.npm-global/bin/pm2" restart openclaw-gateway --update-env;',
  'else',
  '  openclaw gateway restart;',
  'fi',
].join(' ')

function shellCommand(script) {
  return `bash -lc ${JSON.stringify(script)}`
}

function gatewayRestartCommand(env = process.env) {
  const custom = String(env.OPENCLAW_GATEWAY_RESTART_COMMAND || env.GATEWAY_RESTART_COMMAND || '').trim()
  if (custom) {
    return {
      command: custom,
      method: 'custom',
    }
  }
  return {
    command: shellCommand(DEFAULT_RESTART_SCRIPT),
    method: 'pm2_or_openclaw',
  }
}

function truncateOutput(value, max = 4000) {
  const text = String(value || '')
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function restartGateway(opts = {}) {
  const execFn = opts.execFn || exec
  const execOptions = opts.execOptions || {}
  const timeout = opts.timeoutMs || 30000
  const { command, method } = gatewayRestartCommand(opts.env || process.env)

  return new Promise((resolve, reject) => {
    execFn(command, { ...execOptions, timeout }, (err, stdout = '', stderr = '') => {
      const result = {
        method,
        stdout: truncateOutput(stdout),
        stderr: truncateOutput(stderr),
      }
      if (err) {
        const failure = new Error(stderr || stdout || err.message)
        failure.method = method
        failure.stdout = result.stdout
        failure.stderr = result.stderr
        reject(failure)
        return
      }
      resolve(result)
    })
  })
}

module.exports = {
  DEFAULT_RESTART_SCRIPT,
  gatewayRestartCommand,
  restartGateway,
  _internal: {
    shellCommand,
    truncateOutput,
  },
}
