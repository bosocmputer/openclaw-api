const router = require('express').Router()
const { readOpenclawConfig, writeOpenclawConfigAtomic } = require('../lib/openclaw-config')
const { getModelCatalog } = require('../lib/model-catalog')

// GET /api/model — อ่าน model ปัจจุบัน
router.get('/model', (req, res) => {
  try {
    const config = readOpenclawConfig()
    res.json({ model: config.agents?.defaults?.model?.primary || '' })
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT /api/model — เปลี่ยน model
router.put('/model', (req, res) => {
  try {
    const { model } = req.body
    if (!model) return res.status(400).json({ error: 'model required' })
    const config = readOpenclawConfig()
    if (!config.agents) config.agents = {}
    if (!config.agents.defaults) config.agents.defaults = {}
    if (!config.agents.defaults.model) config.agents.defaults.model = {}
    config.agents.defaults.model.primary = model
    writeOpenclawConfigAtomic(config)
    res.json({ ok: true })
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/models/catalog?provider=openrouter|anthropic|google|openai|mistral|groq|kilocode
router.get('/models/catalog', async (req, res) => {
  try {
    const config = readOpenclawConfig()
    const provider = req.query.provider || 'openrouter'
    const refresh = req.query.refresh === 'true' || req.query.refresh === '1'
    const catalog = await getModelCatalog({ provider, config, refresh })
    const httpStatus = catalog.status === 'unknown_provider' ? 400 : 200
    res.status(httpStatus).json(catalog)
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/models?provider=X — legacy array response for existing Admin callers
router.get('/models', async (req, res) => {
  try {
    const config = readOpenclawConfig()
    const provider = req.query.provider || 'openrouter'
    const refresh = req.query.refresh === 'true' || req.query.refresh === '1'
    const catalog = await getModelCatalog({ provider, config, refresh })
    if (catalog.status === 'unknown_provider') return res.status(400).json({ error: catalog.summary })
    res.setHeader('X-Model-Catalog-Status', catalog.status)
    res.setHeader('X-Model-Catalog-Source', catalog.source)
    res.json(catalog.models || [])
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/models/test — ทดสอบ API key ฝั่ง server (แก้ปัญหา CORS)
router.post('/models/test', async (req, res) => {
  const { provider, apiKey } = req.body || {}
  try {
    let url, headers = {}

    if (provider === 'openrouter') {
      url = 'https://openrouter.ai/api/v1/models'
      headers = { 'Authorization': `Bearer ${apiKey}` }
    } else if (provider === 'anthropic') {
      url = 'https://api.anthropic.com/v1/models'
      headers = { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
    } else if (provider === 'anthropic-oauth') {
      // OAuth token (sk-ant-oat...) ต้องใช้ Bearer + beta headers เหมือน Claude Code
      url = 'https://api.anthropic.com/v1/models'
      headers = {
        'Authorization': `Bearer ${apiKey}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
        'user-agent': 'claude-cli/2.1.75',
        'x-app': 'cli',
      }
    } else if (provider === 'google') {
      url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`
    } else if (provider === 'openai') {
      url = 'https://api.openai.com/v1/models'
      headers = { 'Authorization': `Bearer ${apiKey}` }
    } else if (provider === 'mistral') {
      url = 'https://api.mistral.ai/v1/models'
      headers = { 'Authorization': `Bearer ${apiKey}` }
    } else if (provider === 'groq') {
      url = 'https://api.groq.com/openai/v1/models'
      headers = { 'Authorization': `Bearer ${apiKey}` }
    } else if (provider === 'kilocode') {
      url = 'https://api.kilo.ai/api/gateway/models'
      headers = { 'Authorization': `Bearer ${apiKey}` }
    } else {
      return res.status(400).json({ ok: false, error: 'Unknown provider' })
    }

    const response = await fetch(url, { headers, signal: AbortSignal.timeout(8000) })
    res.json({ ok: response.ok, status: response.status })
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    const msg = e.name === 'TimeoutError' ? 'Request timed out' : 'Connection failed'
    res.json({ ok: false, error: msg })
  }
})

module.exports = router
