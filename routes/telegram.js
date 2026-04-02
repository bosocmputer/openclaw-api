const router = require('express').Router()
const fs = require('fs')
const { exec } = require('child_process')
const { CONFIG_PATH } = require('../lib/config')

// GET /api/telegram — อ่าน telegram config
router.get('/', (req, res) => {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    res.json(config.channels?.telegram || {})
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT /api/telegram — แก้ telegram config (token, dmPolicy)
router.put('/', (req, res) => {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    if (!config.channels) config.channels = {}
    config.channels.telegram = { ...config.channels.telegram, ...req.body }
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
    res.json({ ok: true })
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/telegram/botinfo — ดึงชื่อ bot จาก Telegram API
router.get('/botinfo', async (req, res) => {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    const tg = config.channels?.telegram || {}
    const results = {}

    async function fetchBotName(token) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 5000)
      try {
        const r = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: controller.signal })
        const j = await r.json()
        return j.ok ? (j.result.first_name || j.result.username) : null
      } catch {
        return null
      } finally {
        clearTimeout(timer)
      }
    }

    // format ใหม่: botToken อยู่ใน accounts.*
    for (const [id, acc] of Object.entries(tg.accounts || {})) {
      if (acc.botToken) {
        results[id] = await fetchBotName(acc.botToken).catch(() => null)
      }
    }
    // fallback format เก่า: top-level botToken
    if (!results['default'] && tg.botToken) {
      results['default'] = await fetchBotName(tg.botToken).catch(() => null)
    }
    res.json(results)
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/telegram/accounts — เพิ่ม bot account ใหม่
router.post('/accounts', (req, res) => {
  try {
    const { accountId, token } = req.body
    if (!accountId || !token) return res.status(400).json({ error: 'accountId and token required' })
    if (accountId === 'default') return res.status(400).json({ error: 'accountId cannot be "default"' })
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    if (!config.channels) config.channels = {}
    if (!config.channels.telegram) config.channels.telegram = {}
    if (!config.channels.telegram.accounts) config.channels.telegram.accounts = {}
    if (config.channels.telegram.accounts[accountId]) {
      return res.status(400).json({ error: `Account "${accountId}" already exists` })
    }
    config.channels.telegram.accounts[accountId] = {
      botToken: token,
      dmPolicy: 'open',
      allowFrom: ['*'],
      groupPolicy: 'allowlist',
      streaming: 'partial',
    }
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
    res.json({ ok: true })
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/telegram/set-default — สลับ named account ขึ้นเป็น default
// body: { accountId: "stock", oldAccountId: "sale" }
router.post('/set-default', (req, res) => {
  try {
    const { accountId, oldAccountId } = req.body
    if (!accountId || !oldAccountId) return res.status(400).json({ error: 'accountId and oldAccountId required' })
    if (oldAccountId === 'default') return res.status(400).json({ error: 'oldAccountId cannot be "default"' })
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    const tg = config.channels?.telegram
    if (!tg) return res.status(400).json({ error: 'No telegram config' })

    const namedAcc = tg.accounts?.[accountId]
    if (!namedAcc) return res.status(400).json({ error: `Account "${accountId}" not found` })

    // อ่าน default account จาก accounts.default (schema ใหม่ v2026.3.13)
    const defaultAcc = tg.accounts?.['default'] || {}

    // บันทึก default เดิมเป็น named account ชื่อ oldAccountId
    if (!tg.accounts) tg.accounts = {}
    tg.accounts[oldAccountId] = {
      botToken: defaultAcc.botToken,
      dmPolicy: defaultAcc.dmPolicy ?? tg.dmPolicy,
      allowFrom: defaultAcc.allowFrom ?? [],
      groupPolicy: defaultAcc.groupPolicy ?? tg.groupPolicy,
      streaming: defaultAcc.streaming ?? tg.streaming,
    }

    // ยก named account ขึ้นเป็น default
    tg.accounts['default'] = {
      botToken: namedAcc.botToken,
      dmPolicy: namedAcc.dmPolicy ?? tg.dmPolicy,
      allowFrom: namedAcc.allowFrom ?? [],
      groupPolicy: namedAcc.groupPolicy ?? tg.groupPolicy,
      streaming: namedAcc.streaming ?? tg.streaming,
    }

    // ลบ named account นั้นออก
    delete tg.accounts[accountId]

    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
    res.json({ ok: true })
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/telegram/accounts/:accountId — ลบ bot account
router.delete('/accounts/:accountId', (req, res) => {
  try {
    const accountId = req.params.accountId
    if (accountId === 'default') return res.status(400).json({ error: 'Cannot delete default account' })
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    if (!config.channels?.telegram?.accounts?.[accountId]) {
      return res.status(404).json({ error: `Account "${accountId}" not found` })
    }
    delete config.channels.telegram.accounts[accountId]
    if (Object.keys(config.channels.telegram.accounts).length === 0) {
      delete config.channels.telegram.accounts
    }
    // ลบ route binding ของ account นี้ด้วย
    config.bindings = (config.bindings || []).filter(
      b => !(b.type === 'route' && b.match?.accountId === accountId)
    )
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
    res.json({ ok: true })
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/telegram/approve — approve pairing code
router.post('/approve', (req, res) => {
  const { code } = req.body
  if (!code) return res.status(400).json({ error: 'code required' })
  exec(
    `openclaw pairing approve telegram ${code}`,
    (err, stdout, stderr) => {
      if (err) return res.status(500).json({ error: stderr || err.message })
      res.json({ ok: true, output: stdout })
    }
  )
})

// GET /api/telegram/bindings — route bindings (bot account → agent)
router.get('/bindings', (req, res) => {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    const routes = (config.bindings || [])
      .filter(b => b.type === 'route' && b.match?.channel === 'telegram')
      .map(b => ({ agentId: b.agentId, accountId: b.match.accountId }))
    res.json(routes)
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT /api/telegram/bindings — set route binding (bot account → agent)
router.put('/bindings', (req, res) => {
  try {
    const { accountId, agentId } = req.body
    if (!accountId) return res.status(400).json({ error: 'accountId required' })
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    if (!config.bindings) config.bindings = []
    // ลบ route binding เดิมของ account นี้ออกก่อน
    config.bindings = config.bindings.filter(
      b => !(b.type === 'route' && b.match?.channel === 'telegram' && b.match?.accountId === accountId)
    )
    // ถ้า agentId ไม่ใช่ '' ให้เพิ่มใหม่
    if (agentId) {
      config.bindings.push({ type: 'route', agentId, match: { channel: 'telegram', accountId } })
    }
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
    res.json({ ok: true })
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router
