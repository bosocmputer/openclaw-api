const express = require('express')
const cors = require('cors')
const fs = require('fs')
const path = require('path')
const { execSync, exec } = require('child_process')
require('dotenv').config()

const app = express()
const PORT = process.env.PORT || 4000
const API_TOKEN = process.env.API_TOKEN
if (!API_TOKEN) {
  console.error('ERROR: API_TOKEN env is not set. Set it in .env file.')
  process.exit(1)
}
const HOME = process.env.HOME
const CONFIG_PATH = path.join(HOME, '.openclaw/openclaw.json')
const USERNAMES_PATH = path.join(HOME, '.openclaw/usernames.json')

// openclaw CLI ต้องรันจาก package directory เพราะใช้ relative path หา dist/
const OPENCLAW_PKG = process.env.OPENCLAW_PKG || ''
const execOpts = OPENCLAW_PKG ? { cwd: OPENCLAW_PKG } : {}

// SOUL template generator — path ใช้ ~ เพื่อรองรับทุก server/user
function generateSoulTemplate(workspace, accessMode = 'general') {
  const configPath = `${workspace}/config/mcporter.json`

  const roleDescriptions = {
    admin:    'ผู้ช่วย AI สำหรับผู้บริหาร — เข้าถึงข้อมูลได้ทุกส่วน รวมถึงรายงานและการวิเคราะห์',
    sales:    'ผู้ช่วย AI ฝ่ายขาย — ดูข้อมูลลูกค้า สินค้า ราคา สต็อก และยอดค้างส่ง',
    purchase: 'ผู้ช่วย AI ฝ่ายจัดซื้อ — ดูข้อมูลผู้จำหน่าย สินค้า สต็อก และยอดค้างรับ',
    stock:    'ผู้ช่วย AI ฝ่ายคลังสินค้า — ดูสต็อก ยอดค้างรับ ค้างส่ง และค้างจอง',
    general:  'ผู้ช่วย AI ทั่วไป — ค้นหาข้อมูลสินค้า ลูกค้า ผู้จำหน่าย และสต็อก',
  }

  // tools ที่แต่ละ mode เห็น (ตาม test-roles.mjs EXPECTED matrix)
  const roleTools = {
    admin: `## Tools ที่ใช้ได้ (admin)
- search_product       — ค้นหาสินค้า
- search_customer      — ค้นหาลูกค้า
- search_supplier      — ค้นหาผู้จำหน่าย
- get_stock_balance    — ยอดคงเหลือสินค้า
- get_product_price    — ราคาสินค้า
- get_account_incoming     — สินค้าค้างรับ
- get_account_outstanding  — สินค้าค้างส่ง
- get_bookout_balance      — สินค้าค้างจอง
- get_sales_summary        — ยอดขายรวม (admin only)
- get_customer_rfm         — วิเคราะห์ลูกค้า RFM (admin only)
- (+ tools ยอดขายอื่นๆ อีกหลาย tools — admin only)
- fallback_response    — แจ้งเมื่อไม่มี tool รองรับ`,

    sales: `## Tools ที่ใช้ได้ (sales — 7 tools)
- search_product           — ค้นหาสินค้า
- search_customer          — ค้นหาลูกค้า
- get_stock_balance        — ยอดคงเหลือสินค้า
- get_product_price        — ราคาสินค้า
- get_account_outstanding  — สินค้าค้างส่ง
- get_bookout_balance      — สินค้าค้างจอง
- fallback_response        — แจ้งเมื่อไม่มี tool รองรับ`,

    purchase: `## Tools ที่ใช้ได้ (purchase — 5 tools)
- search_product       — ค้นหาสินค้า
- search_supplier      — ค้นหาผู้จำหน่าย
- get_stock_balance    — ยอดคงเหลือสินค้า
- get_account_incoming — สินค้าค้างรับ
- fallback_response    — แจ้งเมื่อไม่มี tool รองรับ`,

    stock: `## Tools ที่ใช้ได้ (stock — 6 tools)
- search_product           — ค้นหาสินค้า
- get_stock_balance        — ยอดคงเหลือสินค้า
- get_account_incoming     — สินค้าค้างรับ
- get_account_outstanding  — สินค้าค้างส่ง
- get_bookout_balance      — สินค้าค้างจอง
- fallback_response        — แจ้งเมื่อไม่มี tool รองรับ`,

    general: `## Tools ที่ใช้ได้ (general — 4 tools)
- search_product    — ค้นหาสินค้า
- get_stock_balance — ยอดคงเหลือสินค้า
- get_product_price — ราคาสินค้า
- fallback_response — แจ้งเมื่อไม่มี tool รองรับ`,
  }

  const desc = roleDescriptions[accessMode] || roleDescriptions.general
  const tools = roleTools[accessMode] || roleTools.general

  return `คุณคือ${desc}

## กฎ
- ดึงข้อมูลจากระบบจริงทุกครั้ง ห้ามตอบจากความจำ
- ใช้ exec tool รันคำสั่ง mcporter
- ตอบภาษาไทย กระชับ ห้ามใช้ตาราง Markdown
- ถ้าคำถามไม่ชัดเจนหรือไม่ระบุชื่อสินค้า/ลูกค้า ให้ถามกลับเพื่อขอข้อมูลเพิ่มเติมก่อน อย่าเรียก tool โดยไม่มีข้อมูลเพียงพอ
- ถ้าไม่มี tool รองรับคำถามนี้ ให้แจ้งผู้ใช้ด้วยภาษาธรรมดาว่าทำอะไรได้บ้าง ห้ามตอบว่า NO_REPLY หรือข้อความ error ให้ผู้ใช้เห็น

## วิธีเรียก tool
\`\`\`
mcporter call --config ${configPath} smlmcp.<tool> <params>
\`\`\`

${tools}
`
}

function readUserNames() {
  try {
    return fs.existsSync(USERNAMES_PATH) ? JSON.parse(fs.readFileSync(USERNAMES_PATH, 'utf8')) : {}
  } catch { return {} }
}

function writeUserNames(names) {
  fs.writeFileSync(USERNAMES_PATH, JSON.stringify(names, null, 2))
}

app.use(cors())
app.use(express.json())

// Auth middleware
app.use((req, res, next) => {
  const token = req.headers['authorization']?.replace('Bearer ', '')
  if (token !== API_TOKEN) return res.status(401).json({ error: 'Unauthorized' })
  next()
})

// GET /api/status — เช็ค gateway online/offline
app.get('/api/status', (req, res) => {
  try {
    execSync('pgrep -f openclaw-gateway')
    res.json({ gateway: 'online' })
  } catch {
    res.json({ gateway: 'offline' })
  }
})

// GET /api/config — อ่าน openclaw.json ทั้งหมด
app.get('/api/config', (req, res) => {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8')
    res.json(JSON.parse(raw))
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// PUT /api/config — เขียน openclaw.json (gateway hot-reload อัตโนมัติ)
app.put('/api/config', (req, res) => {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(req.body, null, 2))
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /api/agents — รายการ agents พร้อม soul, mcp, users
app.get('/api/agents', (req, res) => {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    const agents = (config.agents?.list || []).map(agent => {
      const workspacePath = agent.workspace.replace('~', HOME)
      const soulPath = path.join(workspacePath, 'SOUL.md')
      const mcpPath = path.join(workspacePath, 'config/mcporter.json')
      return {
        id: agent.id,
        workspace: agent.workspace,
        soul: fs.existsSync(soulPath) ? fs.readFileSync(soulPath, 'utf8') : '',
        mcp: fs.existsSync(mcpPath) ? JSON.parse(fs.readFileSync(mcpPath, 'utf8')) : null,
        users: (config.bindings || [])
          .filter(b => b.agentId === agent.id)
          .map(b => b.match?.peer ? { id: b.match.peer.id, name: readUserNames()[b.match.peer.id] } : null)
          .filter(Boolean)
      }
    })
    res.json(agents)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/agents — เพิ่ม agent ใหม่ (auto-generate SOUL + mcporter.json จาก template)
app.post('/api/agents', (req, res) => {
  try {
    const { id, workspace, accessMode = 'general' } = req.body
    if (!id || !workspace) return res.status(400).json({ error: 'id and workspace required' })
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    if (!config.agents) config.agents = { list: [] }
    if (!config.agents.list) config.agents.list = []
    if (config.agents.list.find(a => a.id === id))
      return res.status(400).json({ error: 'Agent already exists' })
    config.agents.list.push({ id, workspace })
    // สร้าง workspace directory
    const workspacePath = workspace.replace('~', HOME)
    fs.mkdirSync(path.join(workspacePath, 'config'), { recursive: true })
    fs.mkdirSync(path.join(workspacePath, 'skills/mcporter'), { recursive: true })
    // auto-generate SOUL.md จาก template (ใช้ ~ path เพื่อรองรับทุก server)
    const workspaceTilde = workspace.startsWith(HOME)
      ? workspace.replace(HOME, '~')
      : workspace
    const soul = generateSoulTemplate(workspaceTilde, accessMode)
    fs.writeFileSync(path.join(workspacePath, 'SOUL.md'), soul)
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /api/agents/:id/soul/template — ดึง SOUL template ตาม access mode ปัจจุบัน
app.get('/api/agents/:id/soul/template', (req, res) => {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    const agent = config.agents?.list?.find(a => a.id === req.params.id)
    if (!agent) return res.status(404).json({ error: 'Agent not found' })
    const mcpPath = path.join(agent.workspace.replace('~', HOME), 'config/mcporter.json')
    const mcpConfig = fs.existsSync(mcpPath) ? JSON.parse(fs.readFileSync(mcpPath, 'utf8')) : {}
    const server = Object.values(mcpConfig.mcpServers ?? {})[0]
    // รองรับทั้ง headers (ใหม่) และ env (เก่า)
    const accessMode = server?.headers?.['mcp-access-mode'] ?? server?.env?.MCP_ACCESS_MODE ?? 'general'
    const workspaceTilde = agent.workspace.startsWith(HOME)
      ? agent.workspace.replace(HOME, '~')
      : agent.workspace
    const soul = generateSoulTemplate(workspaceTilde, accessMode)
    res.json({ soul, accessMode })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// DELETE /api/agents/:id — ลบ agent
app.delete('/api/agents/:id', (req, res) => {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    config.agents.list = (config.agents.list || []).filter(a => a.id !== req.params.id)
    config.bindings = (config.bindings || []).filter(b => b.agentId !== req.params.id)
    if (config.channels?.telegram?.allowFrom) {
      // ไม่ลบ user IDs ออกจาก allowFrom เผื่อ user bind กับ agent อื่นด้วย
    }
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /api/agents/:id/soul — อ่าน SOUL.md
app.get('/api/agents/:id/soul', (req, res) => {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    const agent = config.agents?.list?.find(a => a.id === req.params.id)
    if (!agent) return res.status(404).json({ error: 'Agent not found' })
    const soulPath = path.join(agent.workspace.replace('~', HOME), 'SOUL.md')
    res.json({ soul: fs.existsSync(soulPath) ? fs.readFileSync(soulPath, 'utf8') : '' })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// PUT /api/agents/:id/soul — เขียน SOUL.md
app.put('/api/agents/:id/soul', (req, res) => {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    const agent = config.agents?.list?.find(a => a.id === req.params.id)
    if (!agent) return res.status(404).json({ error: 'Agent not found' })
    const soulPath = path.join(agent.workspace.replace('~', HOME), 'SOUL.md')
    fs.writeFileSync(soulPath, req.body.soul)
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /api/agents/:id/mcp — อ่าน mcporter.json
app.get('/api/agents/:id/mcp', (req, res) => {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    const agent = config.agents?.list?.find(a => a.id === req.params.id)
    if (!agent) return res.status(404).json({ error: 'Agent not found' })
    const mcpPath = path.join(agent.workspace.replace('~', HOME), 'config/mcporter.json')
    res.json(fs.existsSync(mcpPath) ? JSON.parse(fs.readFileSync(mcpPath, 'utf8')) : {})
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// PUT /api/agents/:id/mcp — เขียน mcporter.json
app.put('/api/agents/:id/mcp', (req, res) => {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    const agent = config.agents?.list?.find(a => a.id === req.params.id)
    if (!agent) return res.status(404).json({ error: 'Agent not found' })
    const mcpDir = path.join(agent.workspace.replace('~', HOME), 'config')
    fs.mkdirSync(mcpDir, { recursive: true })
    fs.writeFileSync(path.join(mcpDir, 'mcporter.json'), JSON.stringify(req.body, null, 2))
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /api/agents/:id/users — รายการ users ของ agent
app.get('/api/agents/:id/users', (req, res) => {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    const userNames = readUserNames()
    const users = (config.bindings || [])
      .filter(b => b.agentId === req.params.id)
      .map(b => b.match?.peer ? { id: b.match.peer.id, name: userNames[b.match.peer.id] } : null)
      .filter(Boolean)
    res.json(users)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/agents/:id/users — เพิ่ม user ID
app.post('/api/agents/:id/users', (req, res) => {
  try {
    const { userId, name } = req.body
    if (!userId) return res.status(400).json({ error: 'userId required' })
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    if (!config.bindings) config.bindings = []
    // เช็คว่ามีอยู่แล้วไหม
    const existing = config.bindings.find(
      b => b.agentId === req.params.id && b.match?.peer?.id === String(userId)
    )
    // หา accountId จาก route binding ของ agent นี้ (format ใหม่: match.accountId)
    const routeBinding = (config.bindings || []).find(
      b => b.type === 'route' && b.agentId === req.params.id && b.match?.channel === 'telegram'
    )
    const accountId = routeBinding?.match?.accountId || 'default'

    if (!existing) {
      config.bindings.push({
        agentId: req.params.id,
        match: { channel: 'telegram', accountId, peer: { kind: 'direct', id: String(userId) } }
      })
    }
    // เก็บ name ใน usernames.json แยกต่างหาก ไม่แตะ openclaw.json
    const userNames = readUserNames()
    if (name) userNames[String(userId)] = name
    else if (name === '') delete userNames[String(userId)]
    writeUserNames(userNames)

    if (!config.channels) config.channels = {}
    if (!config.channels.telegram) config.channels.telegram = {}
    if (!config.channels.telegram.accounts) config.channels.telegram.accounts = {}
    if (!config.channels.telegram.accounts[accountId]) config.channels.telegram.accounts[accountId] = {}
    if (!config.channels.telegram.accounts[accountId].allowFrom) config.channels.telegram.accounts[accountId].allowFrom = []
    const af = config.channels.telegram.accounts[accountId].allowFrom
    if (!af.includes(Number(userId)) && !af.includes(String(userId))) {
      af.push(Number(userId))
    }
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// DELETE /api/agents/:id/users/:userId — ลบ user ID
app.delete('/api/agents/:id/users/:userId', (req, res) => {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    config.bindings = (config.bindings || []).filter(
      b => !(b.agentId === req.params.id && b.match?.peer?.id === req.params.userId)
    )
    // หา accountId จาก route binding ของ agent นี้
    const delRouteBinding = (config.bindings || []).find(
      b => b.type === 'route' && b.agentId === req.params.id && b.match?.channel === 'telegram'
    )
    const delAccountId = delRouteBinding?.match?.accountId || 'default'

    // ลบออกจาก allowFrom เฉพาะถ้าไม่มี binding อื่นที่ใช้ user นี้กับ account เดียวกัน
    const stillUsed = (config.bindings || []).some(
      b => b.match?.peer?.id === req.params.userId && (b.match?.accountId || 'default') === delAccountId
    )
    if (!stillUsed) {
      const acc = config.channels?.telegram?.accounts?.[delAccountId]
      if (acc?.allowFrom) {
        acc.allowFrom = acc.allowFrom.filter(id => String(id) !== req.params.userId)
      }
    }
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /api/telegram — อ่าน telegram config
app.get('/api/telegram', (req, res) => {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    res.json(config.channels?.telegram || {})
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// PUT /api/telegram — แก้ telegram config (token, dmPolicy)
app.put('/api/telegram', (req, res) => {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    if (!config.channels) config.channels = {}
    config.channels.telegram = { ...config.channels.telegram, ...req.body }
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /api/telegram/botinfo — ดึงชื่อ bot จาก Telegram API
app.get('/api/telegram/botinfo', async (req, res) => {
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
    res.status(500).json({ error: e.message })
  }
})

// POST /api/telegram/accounts — เพิ่ม bot account ใหม่
app.post('/api/telegram/accounts', (req, res) => {
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
    res.status(500).json({ error: e.message })
  }
})

// POST /api/telegram/set-default — สลับ named account ขึ้นเป็น default
// body: { accountId: "stock", oldAccountId: "sale" }
app.post('/api/telegram/set-default', (req, res) => {
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
    res.status(500).json({ error: e.message })
  }
})

// DELETE /api/telegram/accounts/:accountId — ลบ bot account
app.delete('/api/telegram/accounts/:accountId', (req, res) => {
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
    res.status(500).json({ error: e.message })
  }
})

// POST /api/telegram/approve — approve pairing code
app.post('/api/telegram/approve', (req, res) => {
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
app.get('/api/telegram/bindings', (req, res) => {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    const routes = (config.bindings || [])
      .filter(b => b.type === 'route' && b.match?.channel === 'telegram')
      .map(b => ({ agentId: b.agentId, accountId: b.match.accountId }))
    res.json(routes)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// PUT /api/telegram/bindings — set route binding (bot account → agent)
app.put('/api/telegram/bindings', (req, res) => {
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
    res.status(500).json({ error: e.message })
  }
})

// GET /api/model — อ่าน model ปัจจุบัน
app.get('/api/model', (req, res) => {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    res.json({ model: config.agents?.defaults?.model?.primary || '' })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// PUT /api/model — เปลี่ยน model
app.put('/api/model', (req, res) => {
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
    res.status(500).json({ error: e.message })
  }
})

// POST /api/gateway/restart — restart gateway
app.post('/api/gateway/restart', (req, res) => {
  exec(
    'openclaw gateway restart',
    execOpts,
    (err) => {
      if (err) return res.status(500).json({ error: err.message })
      res.json({ ok: true })
    }
  )
})

// GET /api/usernames — อ่าน usernames.json
app.get('/api/usernames', (req, res) => {
  res.json(readUserNames())
})

// GET /api/gateway/logs — ดู gateway log ล่าสุด (parse JSONL format)
app.get('/api/gateway/logs', (req, res) => {
  try {
    const limit = parseInt(req.query.lines || '200')
    // หา log file ล่าสุดใน /tmp/openclaw/
    const logDir = '/tmp/openclaw'
    let logPath = null
    if (fs.existsSync(logDir)) {
      const files = fs.readdirSync(logDir)
        .filter(f => f.endsWith('.log'))
        .map(f => ({ name: f, mtime: fs.statSync(path.join(logDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)
      if (files.length > 0) logPath = path.join(logDir, files[0].name)
    }
    if (!logPath || !fs.existsSync(logPath)) return res.json([])

    const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean)
    const entries = []
    for (const line of lines.slice(-limit)) {
      try {
        const obj = JSON.parse(line)
        const rawMsg = obj['1'] ?? obj['0'] ?? ''
        const msg = typeof rawMsg === 'object' ? JSON.stringify(rawMsg) : String(rawMsg)
        const level = obj._meta?.logLevelName || 'INFO'
        const time = obj.time || obj._meta?.date || ''
        const subsystem = (() => {
          try { return JSON.parse(obj['0'])?.subsystem || '' } catch { return '' }
        })()
        entries.push({ time, level, subsystem, msg })
      } catch {
        // plain text line
        entries.push({ time: '', level: 'INFO', subsystem: '', msg: line })
      }
    }
    res.json(entries)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /api/agents/:id/sessions — รายการ sessions ของ agent
app.get('/api/agents/:id/sessions', (req, res) => {
  try {
    const sessionsPath = path.join(HOME, `.openclaw/agents/${req.params.id}/sessions/sessions.json`)
    if (!fs.existsSync(sessionsPath)) return res.json([])
    const raw = JSON.parse(fs.readFileSync(sessionsPath, 'utf8'))
    const sessions = Object.values(raw).map(s => ({
      sessionId: s.sessionId,
      userLabel: s.origin?.label || '',
      userFrom: s.origin?.from || '',
      updatedAt: s.updatedAt,
      inputTokens: s.inputTokens || 0,
      outputTokens: s.outputTokens || 0,
      totalTokens: s.totalTokens || 0,
    }))
    sessions.sort((a, b) => b.updatedAt - a.updatedAt)
    res.json(sessions)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /api/agents/:id/sessions/:sessionId — messages ของ session
app.get('/api/agents/:id/sessions/:sessionId', (req, res) => {
  try {
    const filePath = path.join(HOME, `.openclaw/agents/${req.params.id}/sessions/${req.params.sessionId}.jsonl`)
    if (!fs.existsSync(filePath)) return res.json([])
    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean)
    const messages = []
    for (const line of lines) {
      try {
        const obj = JSON.parse(line)
        if (obj.type !== 'message') continue
        const text = (obj.message?.content || [])
          .filter(c => c.type === 'text')
          .map(c => c.text)
          .join('')
        if (!text) continue
        // parse sender_id และ sender name จาก metadata block ใน user messages
        let senderId = null
        let senderName = null
        if (obj.message.role === 'user') {
          const senderMatch = text.match(/"sender_id"\s*:\s*"(\d+)"/)
          if (senderMatch) senderId = senderMatch[1]
          const nameMatch = text.match(/"name"\s*:\s*"([^"]+)"/)
          if (nameMatch) senderName = nameMatch[1]
        }
        messages.push({
          id: obj.id,
          timestamp: obj.timestamp,
          role: obj.message.role,
          text,
          senderId,
          senderName,
        })
      } catch {}
    }
    messages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
    res.json(messages)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /api/doctor/status — เช็ค config valid/invalid
app.get('/api/doctor/status', (req, res) => {
  exec('openclaw doctor', { ...execOpts, timeout: 15000 }, (err, stdout, stderr) => {
    const output = stdout + stderr
    const invalid = output.includes('Config invalid') || output.includes('Invalid config')
    const problems = []
    const problemMatch = output.match(/Problem:\s*([\s\S]*?)(?:\n\n|\nRun:|$)/m)
    if (problemMatch) {
      problemMatch[1].trim().split('\n')
        .map(l => l.trim())
        .filter(l => l.startsWith('-'))
        .forEach(l => problems.push(l.slice(1).trim()))
    }
    res.json({ valid: !invalid, problems })
  })
})

// POST /api/doctor/fix — รัน openclaw doctor --fix
app.post('/api/doctor/fix', (req, res) => {
  exec('openclaw doctor --fix', { ...execOpts, timeout: 30000 }, (err, stdout, stderr) => {
    if (err && !stdout.includes('Doctor complete')) {
      return res.status(500).json({ error: stderr || err.message })
    }
    res.json({ ok: true, output: stdout })
  })
})

// POST /api/agents/:id/mcp/test — ทดสอบ MCP พร้อม MCP_ACCESS_MODE จริง
// body: { accessMode?: string } — ถ้าส่งมาจะ override ค่าใน mcporter.json
app.post('/api/agents/:id/mcp/test', (req, res) => {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    const agent = config.agents?.list?.find(a => a.id === req.params.id)
    if (!agent) return res.status(404).json({ error: 'Agent not found' })
    const mcpPath = path.join(agent.workspace.replace('~', HOME), 'config/mcporter.json')
    if (!fs.existsSync(mcpPath)) return res.status(400).json({ error: 'mcporter.json not found — save MCP config first' })
    const mcpConfig = JSON.parse(fs.readFileSync(mcpPath, 'utf8'))
    const serverName = Object.keys(mcpConfig.mcpServers ?? {})[0]
    if (!serverName) return res.status(400).json({ error: 'No MCP server configured' })

    // ถ้า UI ส่ง accessMode มา ให้เขียน temp config โดย override headers["mcp-access-mode"]
    const overrideMode = req.body?.accessMode
    let configPathToUse = mcpPath
    let tempPath = null
    if (overrideMode) {
      const tempConfig = JSON.parse(JSON.stringify(mcpConfig))
      if (!tempConfig.mcpServers[serverName].headers) tempConfig.mcpServers[serverName].headers = {}
      tempConfig.mcpServers[serverName].headers['mcp-access-mode'] = overrideMode
      tempPath = mcpPath + '.test.tmp'
      fs.writeFileSync(tempPath, JSON.stringify(tempConfig, null, 2))
      configPathToUse = tempPath
    }

    const effectiveMode = overrideMode ?? mcpConfig.mcpServers[serverName]?.headers?.['mcp-access-mode'] ?? 'general'
    const cmd = `mcporter list --config "${configPathToUse}" ${serverName} --json`
    exec(cmd, { timeout: 15000 }, (err, stdout, stderr) => {
      if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath)
      if (err) return res.status(500).json({ error: stderr || err.message, raw: stdout })
      try {
        const result = JSON.parse(stdout)
        const list = Array.isArray(result) ? result : (result.tools ?? [])
        const tools = list.map(t => ({ name: t.name, description: t.description ?? '' }))
        res.json({ ok: true, serverName, accessMode: effectiveMode, tools })
      } catch {
        // fallback: parse human-readable format
        const tools = []
        const lines = stdout.split('\n')
        for (const line of lines) {
          const match = line.match(/^\s+function\s+(\w+)/)
          if (match) tools.push({ name: match[1], description: '' })
        }
        res.json({ ok: true, serverName, accessMode: effectiveMode, tools, raw: tools.length === 0 ? stdout : undefined })
      }
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /api/models — ดึง model list จาก OpenRouter
app.get('/api/models', async (req, res) => {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    const apiKey = config.env?.OPENROUTER_API_KEY || ''
    const response = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { 'Authorization': `Bearer ${apiKey}` }
    })
    const data = await response.json()
    const models = (data.data || []).map(m => ({
      id: m.id,
      name: m.name,
      pricing: m.pricing
    }))
    res.json(models)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ─── Members API (admin_users ใน PostgreSQL) ───────────────────────────────
// ต้องการ pg client — ถ้าไม่มี DATABASE_URL ข้าม block นี้ไป
let pgPool = null
try {
  if (process.env.DATABASE_URL) {
    const { Pool } = require('pg')
    pgPool = new Pool({ connectionString: process.env.DATABASE_URL })
    console.log('PostgreSQL connected')
  }
} catch (e) {
  console.warn('pg module not found — members API disabled')
}

function requirePg(req, res, next) {
  if (!pgPool) return res.status(503).json({ error: 'Database not configured' })
  next()
}

// GET /api/members
app.get('/api/members', requirePg, async (req, res) => {
  try {
    const { rows } = await pgPool.query(
      'SELECT id, username, role, display_name, is_active, created_at FROM admin_users ORDER BY created_at ASC'
    )
    res.json(rows)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/members
app.post('/api/members', requirePg, async (req, res) => {
  try {
    const { username, password, role, display_name } = req.body
    if (!username || !password) return res.status(400).json({ error: 'username and password required' })
    if (!['admin', 'chat', 'superadmin'].includes(role)) return res.status(400).json({ error: 'invalid role' })
    const bcrypt = require('bcryptjs')
    const hash = await bcrypt.hash(password, 12)
    const { rows } = await pgPool.query(
      'INSERT INTO admin_users (username, password, role, display_name) VALUES ($1, $2, $3, $4) RETURNING id, username, role, display_name, is_active, created_at',
      [username.trim(), hash, role, display_name || username.trim()]
    )
    res.json(rows[0])
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'ชื่อผู้ใช้นี้มีอยู่แล้ว' })
    res.status(500).json({ error: e.message })
  }
})

// PATCH /api/members/:id
app.patch('/api/members/:id', requirePg, async (req, res) => {
  try {
    const { id } = req.params
    const { role, display_name, is_active, password } = req.body
    if (password !== undefined) {
      const bcrypt = require('bcryptjs')
      const hash = await bcrypt.hash(password, 12)
      await pgPool.query(
        'UPDATE admin_users SET password = $1, updated_at = now() WHERE id = $2',
        [hash, id]
      )
    }
    if (role !== undefined) {
      if (!['admin', 'chat', 'superadmin'].includes(role)) return res.status(400).json({ error: 'invalid role' })
      await pgPool.query('UPDATE admin_users SET role = $1, updated_at = now() WHERE id = $2', [role, id])
    }
    if (display_name !== undefined) {
      await pgPool.query('UPDATE admin_users SET display_name = $1, updated_at = now() WHERE id = $2', [display_name, id])
    }
    if (is_active !== undefined) {
      await pgPool.query('UPDATE admin_users SET is_active = $1, updated_at = now() WHERE id = $2', [is_active, id])
    }
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// DELETE /api/members/:id
app.delete('/api/members/:id', requirePg, async (req, res) => {
  try {
    const { id } = req.params
    // ห้ามลบ superadmin คนสุดท้าย
    const { rows } = await pgPool.query(
      "SELECT id FROM admin_users WHERE role = 'superadmin' AND is_active = true"
    )
    const target = await pgPool.query("SELECT role FROM admin_users WHERE id = $1", [id])
    if (target.rows[0]?.role === 'superadmin' && rows.length <= 1) {
      return res.status(400).json({ error: 'ไม่สามารถลบ superadmin คนสุดท้ายได้' })
    }
    await pgPool.query('DELETE FROM admin_users WHERE id = $1', [id])
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ─── Webchat API ──────────────────────────────────────────────────────────────

// GET /api/webchat/rooms?username=xxx  — list rooms (กรอง policy=allowlist ตาม username)
app.get('/api/webchat/rooms', requirePg, async (req, res) => {
  try {
    const { username } = req.query
    const { rows } = await pgPool.query(`
      SELECT r.id, r.agent_id, r.display_name, r.policy, r.created_at,
             COALESCE(json_agg(u.username) FILTER (WHERE u.username IS NOT NULL), '[]') AS allowed_users
      FROM webchat_rooms r
      LEFT JOIN webchat_room_users u ON u.room_id = r.id
      GROUP BY r.id ORDER BY r.created_at ASC
    `)
    // ถ้าส่ง username มา → กรอง open ทุกห้อง + allowlist เฉพาะห้องที่ user อยู่
    if (username) {
      const filtered = rows.filter(r =>
        r.policy === 'open' || r.allowed_users.includes(username)
      )
      return res.json(filtered)
    }
    res.json(rows)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/webchat/rooms
app.post('/api/webchat/rooms', requirePg, async (req, res) => {
  try {
    const { agent_id, display_name, policy } = req.body
    if (!agent_id) return res.status(400).json({ error: 'agent_id required' })
    const p = policy || 'open'
    if (!['open', 'allowlist'].includes(p)) return res.status(400).json({ error: 'invalid policy' })
    const { rows } = await pgPool.query(
      'INSERT INTO webchat_rooms (agent_id, display_name, policy) VALUES ($1, $2, $3) RETURNING *',
      [agent_id.trim(), display_name || agent_id.trim(), p]
    )
    res.json({ ...rows[0], allowed_users: [] })
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'agent_id นี้มีห้องอยู่แล้ว' })
    res.status(500).json({ error: e.message })
  }
})

// PUT /api/webchat/rooms/:id
app.put('/api/webchat/rooms/:id', requirePg, async (req, res) => {
  try {
    const { id } = req.params
    const { display_name, policy } = req.body
    if (display_name !== undefined) {
      await pgPool.query('UPDATE webchat_rooms SET display_name = $1 WHERE id = $2', [display_name, id])
    }
    if (policy !== undefined) {
      if (!['open', 'allowlist'].includes(policy)) return res.status(400).json({ error: 'invalid policy' })
      await pgPool.query('UPDATE webchat_rooms SET policy = $1 WHERE id = $2', [policy, id])
    }
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// DELETE /api/webchat/rooms/:id
app.delete('/api/webchat/rooms/:id', requirePg, async (req, res) => {
  try {
    await pgPool.query('DELETE FROM webchat_rooms WHERE id = $1', [req.params.id])
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/webchat/rooms/:id/users  { username }
app.post('/api/webchat/rooms/:id/users', requirePg, async (req, res) => {
  try {
    const { id } = req.params
    const { username } = req.body
    if (!username) return res.status(400).json({ error: 'username required' })
    await pgPool.query(
      'INSERT INTO webchat_room_users (room_id, username) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [id, username]
    )
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// DELETE /api/webchat/rooms/:id/users/:username
app.delete('/api/webchat/rooms/:id/users/:username', requirePg, async (req, res) => {
  try {
    await pgPool.query(
      'DELETE FROM webchat_room_users WHERE room_id = $1 AND username = $2',
      [req.params.id, req.params.username]
    )
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /api/webchat/history/:roomId?username=xxx  — ดึง messages ของ user ใน room
app.get('/api/webchat/history/:roomId', requirePg, async (req, res) => {
  try {
    const { roomId } = req.params
    const { username } = req.query
    let query = 'SELECT id, username, role, content, run_id, created_at FROM webchat_messages WHERE room_id = $1'
    const params = [roomId]
    if (username) {
      // ดึงเฉพาะ messages ของ user นี้ (user rows) + assistant rows ที่ตอบ user นี้ (ผ่าน session)
      // ง่ายสุด: ดึงทุก row ของ room ที่ username ตรง หรือ role=assistant ที่อยู่ใน conversation นี้
      query += ' AND username = $2 ORDER BY created_at ASC'
      params.push(username)
    } else {
      query += ' ORDER BY created_at ASC'
    }
    const { rows } = await pgPool.query(query, params)
    res.json(rows)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/webchat/send  { roomId, username, message }
app.post('/api/webchat/send', requirePg, async (req, res) => {
  try {
    const { roomId, username, message } = req.body
    if (!roomId || !username || !message) return res.status(400).json({ error: 'roomId, username, message required' })

    // หา room + agentId
    const roomRes = await pgPool.query('SELECT agent_id FROM webchat_rooms WHERE id = $1', [roomId])
    if (!roomRes.rows.length) return res.status(404).json({ error: 'room not found' })
    const agentId = roomRes.rows[0].agent_id

    // อ่าน config เพื่อหา hooks port
    let config = {}
    try { config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) } catch {}
    const hooksPort = config?.gateway?.hooksPort || 18789
    const hooksToken = process.env.HOOKS_TOKEN || config?.hooks?.token || ''
    const sessionKey = `hook:webchat:${username}`

    // บันทึก user message ก่อน
    await pgPool.query(
      'INSERT INTO webchat_messages (room_id, username, role, content) VALUES ($1, $2, $3, $4)',
      [roomId, username, 'user', message]
    )

    // ส่งไป hooks
    const hookBody = JSON.stringify({
      agentId,
      sessionKey,
      message,
      allowRequestSessionKey: true,
    })
    const hookRes = await new Promise((resolve, reject) => {
      const http = require('http')
      const opts = {
        hostname: '127.0.0.1',
        port: hooksPort,
        path: '/hooks/agent',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(hookBody), ...(hooksToken ? { 'Authorization': `Bearer ${hooksToken}` } : {}) },
      }
      const hreq = http.request(opts, r => {
        let data = ''
        r.on('data', d => { data += d })
        r.on('end', () => {
          try { resolve(JSON.parse(data)) } catch { resolve({ ok: false }) }
        })
      })
      hreq.on('error', reject)
      const timeout = setTimeout(() => { hreq.destroy(); reject(new Error('hooks timeout')) }, 5000)
      hreq.on('close', () => clearTimeout(timeout))
      hreq.write(hookBody)
      hreq.end()
    })

    if (!hookRes.ok) return res.status(502).json({ error: 'gateway ไม่ตอบสนอง', detail: hookRes })

    // poll จาก sessions.json + .jsonl files โดยตรง (HTTP history endpoint ต้องการ auth แบบอื่น)
    const runId = hookRes.runId
    const sessionsJsonPath = path.join(HOME, `.openclaw/agents/${agentId}/sessions/sessions.json`)
    const fullSessionKey = `agent:${agentId}:${sessionKey}`
    const deadline = Date.now() + 60000
    let assistantContent = null
    let lastSeenTimestamp = Date.now()
    let stableContent = null
    let stableAt = 0

    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 1500))
      try {
        const sessions = JSON.parse(fs.readFileSync(sessionsJsonPath, 'utf8'))
        const sess = sessions[fullSessionKey]
        if (!sess?.sessionId) continue
        const jsonlPath = path.join(HOME, `.openclaw/agents/${agentId}/sessions/${sess.sessionId}.jsonl`)
        const lines = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n').filter(Boolean)
        let found = null
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const entry = JSON.parse(lines[i])
            const entryTs = new Date(entry.timestamp).getTime()
            if (entryTs < lastSeenTimestamp) break
            if (entry.type === 'message' && entry.message?.role === 'assistant') {
              const textPart = entry.message.content?.find(c => c.type === 'text')
              if (textPart?.text) { found = textPart.text; break }
            }
          } catch { continue }
        }
        if (found) {
          if (found === stableContent) {
            // content ไม่เปลี่ยนแปลงแล้ว — รอ stabilize 2 รอบ (3 วินาที) แล้วถือว่า done
            if (Date.now() - stableAt >= 3000) { assistantContent = found; break }
          } else {
            // content ยังเปลี่ยนอยู่ — อัปเดตและรอต่อ
            stableContent = found
            stableAt = Date.now()
          }
        }
      } catch { /* ยังไม่พร้อม */ }
    }

    // fallback: ใช้ stableContent ถ้า deadline หมดแต่มี content บางส่วน
    if (!assistantContent && stableContent) assistantContent = stableContent

    if (!assistantContent) return res.status(504).json({ error: 'timeout รอ agent ตอบ' })

    // บันทึก assistant response
    await pgPool.query(
      'INSERT INTO webchat_messages (room_id, username, role, content, run_id) VALUES ($1, $2, $3, $4, $5)',
      [roomId, username, 'assistant', assistantContent, runId || null]
    )

    res.json({ ok: true, reply: assistantContent })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /api/webchat/chat-users  — list users ที่มี role=chat (สำหรับ allowlist picker)
app.get('/api/webchat/chat-users', requirePg, async (_req, res) => {
  try {
    const { rows } = await pgPool.query(
      "SELECT username, display_name FROM admin_users WHERE role = 'chat' AND is_active = true ORDER BY display_name ASC"
    )
    res.json(rows)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.listen(PORT, '0.0.0.0', () => {
  console.log(`OpenClaw API running on port ${PORT}`)
})
