const router = require('express').Router()
const { execSync } = require('child_process')

// GET /api/status — เช็ค gateway online/offline
router.get('/', (req, res) => {
  try {
    execSync('pgrep -f openclaw-gateway')
    res.json({ gateway: 'online' })
  } catch {
    res.json({ gateway: 'offline' })
  }
})

module.exports = router
