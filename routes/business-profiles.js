const router = require('express').Router()
const { requirePg } = require('../lib/pg')
const businessProfiles = require('../lib/business-profiles')

function safeError(res, err) {
  const status = Number(err.status || 500)
  if (status >= 500) {
    console.error('[openclaw-api] business-profiles', err.message)
    return res.status(500).json({ error: 'Internal server error' })
  }
  return res.status(status).json({ error: err.message })
}

router.get('/templates', (_req, res) => {
  res.json(businessProfiles.getTemplates())
})

router.use(requirePg)

router.get('/', async (_req, res) => {
  try {
    res.json(await businessProfiles.listProfiles())
  } catch (err) {
    safeError(res, err)
  }
})

router.post('/', async (req, res) => {
  try {
    const profile = await businessProfiles.createProfile(req.body)
    res.status(201).json(profile)
  } catch (err) {
    safeError(res, err)
  }
})

router.put('/:id', async (req, res) => {
  try {
    const profile = await businessProfiles.updateProfile(req.params.id, req.body)
    if (!profile) return res.status(404).json({ error: 'Profile not found' })
    res.json(profile)
  } catch (err) {
    safeError(res, err)
  }
})

router.delete('/:id', async (req, res) => {
  try {
    const ok = await businessProfiles.deleteProfile(req.params.id)
    if (!ok) return res.status(404).json({ error: 'Profile not found' })
    res.json({ ok: true })
  } catch (err) {
    safeError(res, err)
  }
})

router.post('/:id/link-agent', async (req, res) => {
  try {
    const agentId = String(req.body?.agentId || '').trim()
    if (!agentId) return res.status(400).json({ error: 'agentId is required' })
    const link = await businessProfiles.linkProfileToAgent(req.params.id, agentId)
    res.json(link)
  } catch (err) {
    safeError(res, err)
  }
})

router.delete('/:id/link-agent/:agentId', async (req, res) => {
  try {
    const ok = await businessProfiles.unlinkProfileFromAgent(req.params.id, req.params.agentId)
    if (!ok) return res.status(404).json({ error: 'Business profile link not found' })
    res.json({ ok: true })
  } catch (err) {
    safeError(res, err)
  }
})

module.exports = router
