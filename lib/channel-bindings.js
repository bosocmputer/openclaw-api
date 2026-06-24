const fs = require('fs')
const path = require('path')

const SUPPORTED_CHANNELS = new Set(['line', 'telegram'])

function normalizeId(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function isChannelSessionKey(channel, key) {
  const parts = String(key || '').split(':')
  if (channel === 'line') return parts.includes('line')
  if (channel === 'telegram') return parts.includes('telegram')
  return false
}

function accountExists(config, channel, accountId) {
  if (channel === 'line') {
    const line = config.channels?.line
    if (!line) return false
    if (accountId === 'default') return Boolean(line.channelAccessToken || line.accounts?.default?.channelAccessToken)
    return Boolean(line.accounts?.[accountId]?.channelAccessToken)
  }
  if (channel === 'telegram') {
    const telegram = config.channels?.telegram
    if (!telegram) return false
    if (accountId === 'default') return Boolean(telegram.botToken || telegram.accounts?.default?.botToken)
    return Boolean(telegram.accounts?.[accountId]?.botToken)
  }
  return false
}

function assertApplyRequest(config, input) {
  const channel = normalizeId(input.channel)
  const accountId = normalizeId(input.accountId)
  const agentId = normalizeId(input.agentId)

  if (!SUPPORTED_CHANNELS.has(channel)) {
    const err = new Error('channel must be line or telegram')
    err.status = 400
    throw err
  }
  if (!accountId) {
    const err = new Error('accountId required')
    err.status = 400
    throw err
  }
  if (!agentId) {
    const err = new Error('agentId required')
    err.status = 400
    throw err
  }
  if (!accountExists(config, channel, accountId)) {
    const err = new Error(`${channel} account "${accountId}" not found`)
    err.status = 404
    throw err
  }
  const agent = (config.agents?.list || []).find(item => item?.id === agentId)
  if (!agent) {
    const err = new Error(`Agent "${agentId}" not found`)
    err.status = 404
    throw err
  }

  return { channel, accountId, agentId }
}

function applyRouteBinding(config, input) {
  const { channel, accountId, agentId } = assertApplyRequest(config, input)
  if (!config.bindings) config.bindings = []
  const existing = config.bindings.find(
    binding => binding?.type === 'route'
      && binding.match?.channel === channel
      && binding.match?.accountId === accountId
  )
  const oldAgentId = existing?.agentId || null
  config.bindings = config.bindings.filter(
    binding => !(binding?.type === 'route'
      && binding.match?.channel === channel
      && binding.match?.accountId === accountId)
  )
  config.bindings.push({ type: 'route', agentId, match: { channel, accountId } })
  return { channel, accountId, oldAgentId, newAgentId: agentId, changed: oldAgentId !== agentId }
}

function writeJsonSynced(filePath, data) {
  const serialized = JSON.stringify(data, null, 2)
  JSON.parse(serialized)
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`
  const fd = fs.openSync(tmpPath, 'w', 0o600)
  try {
    fs.writeFileSync(fd, serialized)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmpPath, filePath)
}

function resetChannelSessionsForAgent({ home, agentId, channel, stamp = null }) {
  const sessionsPath = path.join(home, `.openclaw/agents/${agentId}/sessions/sessions.json`)
  if (!fs.existsSync(sessionsPath)) {
    return { agentId, removed: 0, backupPath: null, removedKeys: [] }
  }
  const sessions = JSON.parse(fs.readFileSync(sessionsPath, 'utf8'))
  const removedKeys = Object.keys(sessions).filter(key => {
    if (key.endsWith(':main')) return false
    if (key.includes(':hook:webchat:')) return false
    return isChannelSessionKey(channel, key)
  })

  if (removedKeys.length === 0) {
    return { agentId, removed: 0, backupPath: null, removedKeys: [] }
  }

  const backupStamp = stamp || new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)
  const backupPath = `${sessionsPath}.bak.${backupStamp}`
  fs.copyFileSync(sessionsPath, backupPath)
  for (const key of removedKeys) delete sessions[key]
  writeJsonSynced(sessionsPath, sessions)
  return { agentId, removed: removedKeys.length, backupPath, removedKeys }
}

function resetChannelSessions({ home, channel, oldAgentId, newAgentId }) {
  const agentIds = Array.from(new Set([oldAgentId, newAgentId].filter(Boolean)))
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)
  return agentIds.map(agentId => resetChannelSessionsForAgent({ home, agentId, channel, stamp }))
}

function publicResetResult(result) {
  return {
    agentId: result.agentId,
    removed: result.removed,
    backupPath: result.backupPath,
  }
}

module.exports = {
  SUPPORTED_CHANNELS,
  isChannelSessionKey,
  accountExists,
  applyRouteBinding,
  resetChannelSessions,
  resetChannelSessionsForAgent,
  publicResetResult,
}
