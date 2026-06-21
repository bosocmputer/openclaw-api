const router = require('express').Router()
const { requirePg } = require('../lib/pg')
const history = require('../lib/conversation-history')

function adminActor(req) {
  return req.headers['x-openclaw-admin-user'] || null
}

function ensureEnabled(req, res, next) {
  if (!history.isEnabled()) return res.status(404).json({ error: 'Conversation analysis is disabled' })
  next()
}

router.use(ensureEnabled)

router.get('/conversations', requirePg, async (req, res) => {
  try {
    res.json(await history.queryConversations(req.query))
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(e.statusCode || 500).json({ error: e.statusCode ? e.message : 'Internal server error' })
  }
})

router.get('/conversations/ingest-status', requirePg, async (req, res) => {
  try {
    res.json(await history.ingestStatus())
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(e.statusCode || 500).json({ error: e.statusCode ? e.message : 'Internal server error' })
  }
})

router.get('/conversations/insights', requirePg, async (req, res) => {
  try {
    res.json(await history.queryInsights(req.query))
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(e.statusCode || 500).json({ error: e.statusCode ? e.message : 'Internal server error' })
  }
})

router.post('/conversations/backfill', requirePg, async (req, res) => {
  try {
    const days = Math.min(Math.max(Number.parseInt(String(req.body?.days || '7'), 10) || 7, 1), 31)
    const minutes = days * 24 * 60
    const result = await history.ingestRecent({
      minutes,
      from: req.body?.from,
      to: req.body?.to,
      agent: req.body?.agent,
      channel: req.body?.channel,
      dryRun: Boolean(req.body?.dryRun),
      limit: 10000,
    })
    res.json({ ...result, days })
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(e.statusCode || 500).json({ error: e.statusCode ? e.message : 'Internal server error' })
  }
})

router.get('/conversations/export', requirePg, async (req, res) => {
  try {
    const mode = String(req.query.mode || 'raw').toLowerCase()
    const format = String(req.query.format || (mode === 'codex_review_pack' ? 'markdown' : mode === 'issues_csv' ? 'csv' : mode === 'events_jsonl' ? 'jsonl' : 'csv')).toLowerCase()
    const exported = await history.exportConversations(req.query, format, adminActor(req))
    res.setHeader('Content-Type', exported.contentType)
    res.setHeader('Content-Disposition', `attachment; filename="${exported.filename}"`)
    res.send(exported.body)
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(e.statusCode || 500).json({ error: e.statusCode ? e.message : 'Internal server error' })
  }
})

router.get('/conversations/:turnId', requirePg, async (req, res) => {
  try {
    const detail = await history.getConversationDetail(req.params.turnId)
    if (!detail) return res.status(404).json({ error: 'Conversation turn not found' })
    res.json(detail)
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(e.statusCode || 500).json({ error: e.statusCode ? e.message : 'Internal server error' })
  }
})

module.exports = router
