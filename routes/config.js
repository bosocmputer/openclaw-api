const router = require('express').Router()
const fs = require('fs')
const { CONFIG_PATH } = require('../lib/config')

// GET /api/config — อ่าน openclaw.json ทั้งหมด
router.get('/', (req, res) => {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8')
    res.json(JSON.parse(raw))
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT /api/config — เขียน openclaw.json (gateway hot-reload อัตโนมัติ)
router.put('/', (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body))
      return res.status(400).json({ error: 'Invalid config: must be a JSON object' })
    // ต้องมี gateway key เป็น object
    if (req.body.gateway !== undefined && (typeof req.body.gateway !== 'object' || Array.isArray(req.body.gateway)))
      return res.status(400).json({ error: 'Invalid config: gateway must be an object' })
    const serialized = JSON.stringify(req.body, null, 2)
    // เขียน temp file ก่อน แล้ว rename เพื่อป้องกัน partial write
    const tmpPath = CONFIG_PATH + '.tmp'
    fs.writeFileSync(tmpPath, serialized)
    fs.renameSync(tmpPath, CONFIG_PATH)
    res.json({ ok: true })
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router
