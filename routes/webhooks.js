const router = require('express').Router()
const fs = require('fs')
const { CONFIG_PATH } = require('../lib/config')

// helper — อ่าน webhook routes จาก plugins.entries.webhooks.config.routes
function getWebhookRoutes(config) {
  return config?.plugins?.entries?.webhooks?.config?.routes ?? {}
}

// helper — เขียน webhook routes กลับ
function setWebhookRoutes(config, routes) {
  if (!config.plugins) config.plugins = {}
  if (!config.plugins.entries) config.plugins.entries = {}
  if (!config.plugins.entries.webhooks) config.plugins.entries.webhooks = {}
  if (!config.plugins.entries.webhooks.config) config.plugins.entries.webhooks.config = {}
  config.plugins.entries.webhooks.config.routes = routes
}

// GET /api/webhooks — รายการ webhook routes ทั้งหมด
router.get('/', (req, res) => {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    const routes = getWebhookRoutes(config)
    // ไม่ส่ง secret value ออก — mask แทน
    const safe = {}
    for (const [name, route] of Object.entries(routes)) {
      safe[name] = { ...route, secret: route.secret ? '••••••••' : '' }
    }
    res.json(safe)
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/webhooks — เพิ่ม / แก้ไข route
// body: { name, path, sessionKey, secret, description?, enabled? }
router.post('/', (req, res) => {
  try {
    const { name, path: webhookPath, sessionKey, secret, description, enabled } = req.body
    if (!name || !webhookPath || !sessionKey || !secret)
      return res.status(400).json({ error: 'name, path, sessionKey, secret required' })
    if (!/^[a-z0-9_-]+$/.test(name))
      return res.status(400).json({ error: 'name ต้องเป็น lowercase a-z 0-9 _ - เท่านั้น' })

    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    const routes = getWebhookRoutes(config)

    routes[name] = {
      path: webhookPath,
      sessionKey,
      secret,
      ...(description !== undefined ? { description } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
    }
    setWebhookRoutes(config, routes)
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
    res.json({ ok: true })
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/webhooks/:name — ลบ route
router.delete('/:name', (req, res) => {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    const routes = getWebhookRoutes(config)
    if (!routes[req.params.name])
      return res.status(404).json({ error: 'Route not found' })
    delete routes[req.params.name]
    setWebhookRoutes(config, routes)
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
    res.json({ ok: true })
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PATCH /api/webhooks/:name — toggle enabled / แก้ description
router.patch('/:name', (req, res) => {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    const routes = getWebhookRoutes(config)
    if (!routes[req.params.name])
      return res.status(404).json({ error: 'Route not found' })
    const { enabled, description } = req.body
    if (enabled !== undefined) routes[req.params.name].enabled = Boolean(enabled)
    if (description !== undefined) routes[req.params.name].description = description
    setWebhookRoutes(config, routes)
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
    res.json({ ok: true })
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router
