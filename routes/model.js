const router = require('express').Router()
const fs = require('fs')
const { CONFIG_PATH } = require('../lib/config')

// GET /api/model — อ่าน model ปัจจุบัน
router.get('/model', (req, res) => {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
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
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    if (!config.agents) config.agents = {}
    if (!config.agents.defaults) config.agents.defaults = {}
    if (!config.agents.defaults.model) config.agents.defaults.model = {}
    config.agents.defaults.model.primary = model
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
    res.json({ ok: true })
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/models?provider=openrouter|anthropic|google|openai|mistral|groq|kilocode
router.get('/models', async (req, res) => {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    const provider = req.query.provider || 'openrouter'

    if (provider === 'openrouter') {
      const apiKey = config.env?.OPENROUTER_API_KEY || ''
      const response = await fetch('https://openrouter.ai/api/v1/models', {
        headers: { 'Authorization': `Bearer ${apiKey}` }
      })
      const data = await response.json()
      const models = (data.data || []).map(m => ({ id: m.id, name: m.name, pricing: m.pricing }))
      return res.json(models)
    }

    if (provider === 'anthropic') {
      const apiKey = config.env?.ANTHROPIC_API_KEY || ''
      const response = await fetch('https://api.anthropic.com/v1/models', {
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
      })
      const data = await response.json()
      const models = (data.data || []).map(m => ({ id: m.id, name: m.display_name || m.id }))
      return res.json(models)
    }

    if (provider === 'google') {
      const apiKey = config.env?.GEMINI_API_KEY || ''
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`)
      const data = await response.json()
      const models = (data.models || [])
        .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
        .map(m => ({ id: m.name.replace('models/', ''), name: m.displayName || m.name }))
      return res.json(models)
    }

    if (provider === 'openai') {
      const apiKey = config.env?.OPENAI_API_KEY || ''
      const response = await fetch('https://api.openai.com/v1/models', {
        headers: { 'Authorization': `Bearer ${apiKey}` }
      })
      const data = await response.json()
      const models = (data.data || [])
        .filter(m => m.id.startsWith('gpt-') || m.id.startsWith('o1') || m.id.startsWith('o3'))
        .sort((a, b) => b.created - a.created)
        .map(m => ({ id: m.id, name: m.id }))
      return res.json(models)
    }

    if (provider === 'mistral') {
      const apiKey = config.env?.MISTRAL_API_KEY || ''
      const response = await fetch('https://api.mistral.ai/v1/models', {
        headers: { 'Authorization': `Bearer ${apiKey}` }
      })
      const data = await response.json()
      const models = (data.data || []).map(m => ({ id: m.id, name: m.id }))
      return res.json(models)
    }

    if (provider === 'groq') {
      const apiKey = config.env?.GROQ_API_KEY || ''
      const response = await fetch('https://api.groq.com/openai/v1/models', {
        headers: { 'Authorization': `Bearer ${apiKey}` }
      })
      const data = await response.json()
      const models = (data.data || []).map(m => ({ id: m.id, name: m.id }))
      return res.json(models)
    }

    if (provider === 'kilocode') {
      const apiKey = config.env?.KILOCODE_API_KEY || ''
      const response = await fetch('https://api.kilo.ai/api/gateway/models', {
        headers: { 'Authorization': `Bearer ${apiKey}` }
      })
      const data = await response.json()
      const items = data.data || data.models || data || []
      const models = items.map(m => ({ id: m.id || m.slug, name: m.name || m.id || m.slug }))
      return res.json(models)
    }

    res.status(400).json({ error: `Unknown provider: ${provider}` })
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
