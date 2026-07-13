const router = require('express').Router()
const { requirePg } = require('../lib/pg')
const memoryAuto = require('../lib/memory-auto')

function adminActor(req) {
  return req.headers['x-openclaw-admin-user'] || null
}

function safeError(res, err) {
  const status = Number(err.status || err.statusCode || 500)
  if (status >= 500) {
    console.error('[openclaw-api] agent-brain', err.message)
    return res.status(500).json({ error: 'Internal server error' })
  }
  return res.status(status).json({ error: err.message })
}

// POST /api/agent-brain/evaluate-turn
router.post('/evaluate-turn', requirePg, async (req, res) => {
  try {
    res.json(await memoryAuto.evaluateAgentBrainTurn(req.body || {}, adminActor(req)))
  } catch (err) {
    safeError(res, err)
  }
})

// GET /api/agent-brain/health
router.get('/health', requirePg, async (req, res) => {
  try {
    res.json(await memoryAuto.getAgentBrainHealth({ agentId: req.query.agentId }))
  } catch (err) {
    safeError(res, err)
  }
})

// POST /api/agent-brain/maintenance/reclassify (dry-run by default)
router.post('/maintenance/reclassify', requirePg, async (req, res) => {
  try {
    res.json(await memoryAuto.reclassifyAgentBrain(req.body || {}, adminActor(req) || 'admin'))
  } catch (err) {
    safeError(res, err)
  }
})

// GET /api/agent-brain/items
router.get('/items', requirePg, async (req, res) => {
  try {
    res.json(await memoryAuto.listMemories({
      agentId: req.query.agentId,
      status: req.query.status,
      type: req.query.type,
      scope: req.query.scope,
      q: req.query.q,
      limit: req.query.limit,
    }))
  } catch (err) {
    safeError(res, err)
  }
})

// PATCH /api/agent-brain/items/:id
router.patch('/items/:id', requirePg, async (req, res) => {
  try {
    res.json(await memoryAuto.updateMemory(req.params.id, req.body || {}, adminActor(req)))
  } catch (err) {
    safeError(res, err)
  }
})

// DELETE /api/agent-brain/items/:id
router.delete('/items/:id', requirePg, async (req, res) => {
  try {
    res.json(await memoryAuto.deleteMemory(req.params.id, req.query || {}, adminActor(req)))
  } catch (err) {
    safeError(res, err)
  }
})

// POST /api/agent-brain/items/:id/block-relearn
router.post('/items/:id/block-relearn', requirePg, async (req, res) => {
  try {
    res.json(await memoryAuto.blockRelearn(req.params.id, req.body || {}, adminActor(req)))
  } catch (err) {
    safeError(res, err)
  }
})

// GET /api/agent-brain/policies/:agentId
router.get('/policies/:agentId', requirePg, async (req, res) => {
  try {
    res.json(await memoryAuto.getPolicy(req.params.agentId))
  } catch (err) {
    safeError(res, err)
  }
})

// PUT /api/agent-brain/policies/:agentId
router.put('/policies/:agentId', requirePg, async (req, res) => {
  try {
    res.json(await memoryAuto.upsertPolicy(req.params.agentId, req.body || {}, adminActor(req)))
  } catch (err) {
    safeError(res, err)
  }
})

// GET /api/agent-brain/channel-policies
router.get('/channel-policies', requirePg, async (req, res) => {
  try {
    res.json(await memoryAuto.listChannelPolicies({
      channel: req.query.channel,
      accountId: req.query.accountId,
    }))
  } catch (err) {
    safeError(res, err)
  }
})

// GET /api/agent-brain/channel-policies/:channel/:accountId
router.get('/channel-policies/:channel/:accountId', requirePg, async (req, res) => {
  try {
    res.json(await memoryAuto.getChannelPolicy(req.params.channel, req.params.accountId))
  } catch (err) {
    safeError(res, err)
  }
})

// PUT /api/agent-brain/channel-policies/:channel/:accountId
router.put('/channel-policies/:channel/:accountId', requirePg, async (req, res) => {
  try {
    res.json(await memoryAuto.upsertChannelPolicy(
      req.params.channel,
      req.params.accountId,
      req.body || {},
      adminActor(req),
    ))
  } catch (err) {
    safeError(res, err)
  }
})

module.exports = router
