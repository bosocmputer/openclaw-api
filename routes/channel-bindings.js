const router = require('express').Router()
const { HOME, execOpts } = require('../lib/config')
const { restartGateway } = require('../lib/gateway-restart')
const { updateOpenclawConfig } = require('../lib/openclaw-config')
const {
  applyRouteBinding,
  resetChannelSessions,
  publicResetResult,
} = require('../lib/channel-bindings')

function boolDefault(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

function durationSince(startedAt) {
  return Date.now() - startedAt
}

function sanitizeRestartResult(result) {
  if (!result) return null
  return {
    ok: true,
    method: result.method,
    stdout: result.stdout,
    stderr: result.stderr,
  }
}

function logApplyResult(result) {
  const resetSummary = (result.reset || []).map(item => `${item.agentId}:${item.removed}`).join(',')
  console.log(
    `[channel-binding-apply] channel=${result.channel} account=${result.accountId} `
      + `old=${result.oldAgentId || '-'} new=${result.newAgentId} `
      + `reset=[${resetSummary}] restart=${result.restart?.ok === false ? 'failed' : result.restart ? 'ok' : 'skipped'} `
      + `durationMs=${result.durationMs}`,
  )
}

// POST /api/channel-bindings/apply
// Save route binding, optionally reset sessions for the affected channel, then restart gateway.
router.post('/apply', async (req, res) => {
  const startedAt = Date.now()
  const resetSessions = boolDefault(req.body?.resetSessions, true)
  const shouldRestartGateway = boolDefault(req.body?.restartGateway, true)
  let binding = null
  let reset = []

  try {
    const writeResult = await updateOpenclawConfig(config => {
      binding = applyRouteBinding(config, req.body || {})
      return config
    }, { reason: 'channel-binding-apply' })

    if (resetSessions) {
      try {
        reset = resetChannelSessions({
          home: HOME,
          channel: binding.channel,
          oldAgentId: binding.oldAgentId,
          newAgentId: binding.newAgentId,
        }).map(publicResetResult)
      } catch (err) {
        const result = {
          ok: false,
          stage: 'resetSessions',
          channel: binding.channel,
          accountId: binding.accountId,
          oldAgentId: binding.oldAgentId,
          newAgentId: binding.newAgentId,
          config: { ok: true, backupPath: writeResult.backupPath },
          reset,
          restart: null,
          durationMs: durationSince(startedAt),
          safeMessage: 'Agent binding was saved, but session reset failed. Gateway was not restarted.',
          error: String(err?.message || err).slice(0, 300),
        }
        logApplyResult(result)
        return res.status(500).json(result)
      }
    }

    let restart = null
    if (shouldRestartGateway) {
      try {
        restart = sanitizeRestartResult(await restartGateway({ execOptions: execOpts }))
      } catch (err) {
        const result = {
          ok: false,
          stage: 'restartGateway',
          channel: binding.channel,
          accountId: binding.accountId,
          oldAgentId: binding.oldAgentId,
          newAgentId: binding.newAgentId,
          config: { ok: true, backupPath: writeResult.backupPath },
          reset,
          restart: {
            ok: false,
            method: err.method,
            stdout: err.stdout,
            stderr: err.stderr,
            error: String(err?.message || err).slice(0, 300),
          },
          durationMs: durationSince(startedAt),
          safeMessage: 'Agent binding was saved, but Gateway restart failed. Restart Gateway before testing the new agent.',
        }
        logApplyResult(result)
        return res.status(500).json(result)
      }
    }

    const result = {
      ok: true,
      stage: 'ready',
      channel: binding.channel,
      accountId: binding.accountId,
      oldAgentId: binding.oldAgentId,
      newAgentId: binding.newAgentId,
      changed: binding.changed,
      config: { ok: true, backupPath: writeResult.backupPath },
      reset,
      restart,
      durationMs: durationSince(startedAt),
      safeMessage: shouldRestartGateway
        ? 'Agent binding applied. Existing channel sessions were reset; the next message will use the new agent.'
        : 'Agent binding saved. Restart Gateway before testing the new agent.',
    }
    logApplyResult(result)
    res.json(result)
  } catch (err) {
    const status = err.status || 500
    res.status(status).json({
      ok: false,
      stage: 'validate',
      durationMs: durationSince(startedAt),
      safeMessage: status >= 500 ? 'Failed to apply channel binding.' : err.message,
      error: status >= 500 ? 'Internal server error' : err.message,
    })
  }
})

module.exports = router
