const router = require('express').Router()
const fs = require('fs')
const path = require('path')
const { exec } = require('child_process')
const { HOME, CONFIG_PATH, execOpts } = require('../lib/config')

async function fetchLineBotInfo(token) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5000)
  try {
    const r = await fetch('https://api.line.me/v2/bot/info', {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    })
    const j = await r.json()
    if (!r.ok) return null
    return { displayName: j.displayName, pictureUrl: j.pictureUrl, basicId: j.basicId }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

// GET /api/line — อ่าน LINE config ปัจจุบัน
router.get('/', (req, res) => {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    const line = config.channels?.line || null
    res.json({ line })
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/line/botinfo — ดึงชื่อ/รูป bot ทุก account { accountId: { displayName, pictureUrl, basicId } }
router.get('/botinfo', async (req, res) => {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    const line = config.channels?.line || {}
    const results = {}
    // format ใหม่: token อยู่ใน accounts.*
    for (const [id, acc] of Object.entries(line.accounts || {})) {
      if (acc?.channelAccessToken) {
        results[id] = await fetchLineBotInfo(acc.channelAccessToken)
      }
    }
    // fallback: top-level channelAccessToken (เดิม 1 OA)
    if (!results['default'] && line.channelAccessToken) {
      results['default'] = await fetchLineBotInfo(line.channelAccessToken)
    }
    res.json(results)
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/line/accounts — เพิ่ม LINE OA account ใหม่
// body: { accountId, channelAccessToken, channelSecret }
// หมายเหตุ: LINE default account ต้องอยู่ที่ top-level (channelAccessToken/channelSecret)
//            named accounts อยู่ใน accounts.*
router.post('/accounts', (req, res) => {
  try {
    const { accountId, channelAccessToken, channelSecret, webhookPath } = req.body
    if (!accountId || !channelAccessToken || !channelSecret) {
      return res.status(400).json({ error: 'accountId, channelAccessToken and channelSecret required' })
    }
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    if (!config.channels) config.channels = {}
    if (!config.channels.line) config.channels.line = { enabled: true, dmPolicy: 'pairing', groupPolicy: 'disabled' }
    const line = config.channels.line

    if (accountId === 'default') {
      // default → top-level token
      if (line.channelAccessToken) {
        return res.status(400).json({ error: 'Default LINE OA already configured. Delete first.' })
      }
      line.channelAccessToken = channelAccessToken
      line.channelSecret = channelSecret
      if (webhookPath) line.webhookPath = webhookPath
    } else {
      // named account → accounts.*
      if (!line.accounts) line.accounts = {}
      if (line.accounts[accountId]) {
        return res.status(400).json({ error: `Account "${accountId}" already exists` })
      }
      const acc = {
        enabled: true,
        channelAccessToken,
        channelSecret,
        dmPolicy: 'pairing',
        groupPolicy: 'disabled',
      }
      if (webhookPath) acc.webhookPath = webhookPath
      line.accounts[accountId] = acc
    }
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
    res.json({ ok: true })
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/line/accounts/:accountId — ลบ LINE OA account
router.delete('/accounts/:accountId', (req, res) => {
  try {
    const { accountId } = req.params
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    const line = config.channels?.line
    if (!line) return res.status(404).json({ error: 'LINE not configured' })

    if (accountId === 'default') {
      // default → ลบ top-level token
      if (!line.channelAccessToken) return res.status(404).json({ error: 'Default LINE OA not found' })
      delete line.channelAccessToken
      delete line.channelSecret
    } else {
      // named account → ลบจาก accounts.*
      if (!line.accounts?.[accountId]) return res.status(404).json({ error: `Account "${accountId}" not found` })
      delete line.accounts[accountId]
      if (Object.keys(line.accounts).length === 0) delete line.accounts
    }

    // ถ้าไม่มี account เหลือเลย ลบ line channel ออก
    const hasAccounts = line.accounts && Object.keys(line.accounts).length > 0
    const hasTopLevel = !!line.channelAccessToken
    if (!hasAccounts && !hasTopLevel) {
      delete config.channels.line
    }

    // ลบ route binding ของ account นี้
    config.bindings = (config.bindings || []).filter(
      b => !(b.type === 'route' && b.match?.channel === 'line' && b.match?.accountId === accountId)
    )
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
    res.json({ ok: true })
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PATCH /api/line/accounts/:accountId — แก้ไข LINE OA (channelAccessToken, channelSecret, webhookPath)
// body: { channelAccessToken?, channelSecret?, webhookPath? }
router.patch('/accounts/:accountId', (req, res) => {
  try {
    const { accountId } = req.params
    const { channelAccessToken, channelSecret, webhookPath } = req.body
    if (!channelAccessToken && !channelSecret && webhookPath === undefined) {
      return res.status(400).json({ error: 'ต้องระบุอย่างน้อยหนึ่งฟิลด์: channelAccessToken, channelSecret, webhookPath' })
    }
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    const line = config.channels?.line
    if (!line) return res.status(404).json({ error: 'LINE not configured' })

    if (accountId === 'default') {
      if (line.accounts?.default) {
        // stored as named account 'default' under accounts
        line.accounts.default.enabled = true
        if (channelAccessToken) line.accounts.default.channelAccessToken = channelAccessToken
        if (channelSecret) line.accounts.default.channelSecret = channelSecret
        if (webhookPath !== undefined) {
          if (webhookPath) line.accounts.default.webhookPath = webhookPath
          else delete line.accounts.default.webhookPath
        }
      } else if (line.channelAccessToken) {
        // stored top-level
        if (channelAccessToken) line.channelAccessToken = channelAccessToken
        if (channelSecret) line.channelSecret = channelSecret
        if (webhookPath !== undefined) line.webhookPath = webhookPath || undefined
      } else {
        return res.status(404).json({ error: 'Default LINE OA not found' })
      }
    } else {
      if (!line.accounts?.[accountId]) return res.status(404).json({ error: `Account "${accountId}" not found` })
      if (channelAccessToken) line.accounts[accountId].channelAccessToken = channelAccessToken
      if (channelSecret) line.accounts[accountId].channelSecret = channelSecret
      if (webhookPath !== undefined) {
        if (webhookPath) line.accounts[accountId].webhookPath = webhookPath
        else delete line.accounts[accountId].webhookPath
      }
    }
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
    res.json({ ok: true })
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/line/bindings — route bindings ทุก account [{ accountId, agentId }]
router.get('/bindings', (req, res) => {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    const routes = (config.bindings || [])
      .filter(b => b.type === 'route' && b.match?.channel === 'line')
      .map(b => ({ accountId: b.match.accountId, agentId: b.agentId }))
    res.json(routes)
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT /api/line/bindings — set route binding ของ account นั้น
// body: { accountId, agentId }
router.put('/bindings', (req, res) => {
  try {
    const { accountId, agentId } = req.body
    if (!accountId) return res.status(400).json({ error: 'accountId required' })
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    if (!config.bindings) config.bindings = []
    config.bindings = config.bindings.filter(
      b => !(b.type === 'route' && b.match?.channel === 'line' && b.match?.accountId === accountId)
    )
    if (agentId) {
      config.bindings.push({ type: 'route', agentId, match: { channel: 'line', accountId } })
    }
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
    res.json({ ok: true })
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/line/pending — รายการ pairing รอ approve
router.get('/pending', (req, res) => {
  try {
    const pendingPath = path.join(HOME, '.openclaw/credentials/line-pairing.json')
    if (!fs.existsSync(pendingPath)) return res.json([])
    const data = JSON.parse(fs.readFileSync(pendingPath, 'utf8'))
    const now = Date.now()
    const pending = Object.entries(data)
      .filter(([, v]) => v.expiresAt > now)
      .map(([code, v]) => ({ code, senderId: v.id, createdAt: v.createdAt, expiresAt: v.expiresAt }))
    res.json(pending)
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/line/approve — approve pairing code
router.post('/approve', (req, res) => {
  const { code } = req.body
  if (!code) return res.status(400).json({ error: 'code required' })
  exec(
    `openclaw pairing approve line ${code} --notify`,
    execOpts,
    (err, stdout, stderr) => {
      if (err) return res.status(500).json({ error: stderr || err.message })
      res.json({ ok: true, output: stdout })
    }
  )
})

module.exports = router
