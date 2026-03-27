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

// SOUL template generator — ใช้ HTTP POST /call แทน mcporter exec
function generateSoulTemplate(_workspace, accessMode = 'general', mcpUrl = null) {
  const callUrl = mcpUrl
    ? mcpUrl.replace('/sse', '/call').replace(/\/call\/.*/, '/call')
    : 'http://<mcp-server>:3002/call'

  const roleDescriptions = {
    admin:    'ผู้ช่วย AI สำหรับผู้บริหาร — เข้าถึงข้อมูลได้ทุกส่วน รวมถึงรายงานและการวิเคราะห์',
    sales:    'ผู้ช่วย AI ฝ่ายขาย — ดูข้อมูลลูกค้า สินค้า ราคา สต็อก และยอดค้างส่ง',
    purchase: 'ผู้ช่วย AI ฝ่ายจัดซื้อ — ดูข้อมูลผู้จำหน่าย สินค้า สต็อก และยอดค้างรับ',
    stock:    'ผู้ช่วย AI ฝ่ายคลังสินค้า — ดูสต็อก ยอดค้างรับ ค้างส่ง และค้างจอง',
    general:  'ผู้ช่วย AI ทั่วไป — ค้นหาข้อมูลสินค้า ลูกค้า ผู้จำหน่าย และสต็อก',
  }

  // tools ที่แต่ละ mode เห็น (ตาม work-order-openclaw-http-integration.md)
  const roleTools = {
    admin: `## Tools ที่ใช้ได้ (admin)
- search_product          — ค้นหาสินค้า
- search_customer         — ค้นหาลูกค้า
- search_supplier         — ค้นหาผู้จำหน่าย
- get_stock_balance       — ยอดคงเหลือสินค้า
- get_product_price       — ราคาสินค้า
- get_account_incoming    — สินค้าค้างรับ
- get_account_outstanding — สินค้าค้างส่ง
- get_bookout_balance     — สินค้าค้างจอง
- get_sales_summary       — ยอดขายรวม (admin only)
- get_customer_rfm        — วิเคราะห์ลูกค้า RFM (admin only)
- fallback_response       — แจ้งเมื่อไม่มี tool รองรับ`,

    sales: `## Tools ที่ใช้ได้ (sales)
- search_product          — ค้นหาสินค้า
- search_customer         — ค้นหาลูกค้า
- get_stock_balance       — ยอดคงเหลือสินค้า
- get_product_price       — ราคาสินค้า
- get_account_outstanding — สินค้าค้างส่ง
- get_bookout_balance     — สินค้าค้างจอง
- fallback_response       — แจ้งเมื่อไม่มี tool รองรับ`,

    purchase: `## Tools ที่ใช้ได้ (purchase)
- search_product          — ค้นหาสินค้า
- search_supplier         — ค้นหาผู้จำหน่าย
- get_stock_balance       — ยอดคงเหลือสินค้า
- get_account_incoming    — สินค้าค้างรับ
- fallback_response       — แจ้งเมื่อไม่มี tool รองรับ`,

    stock: `## Tools ที่ใช้ได้ (stock)
- search_product          — ค้นหาสินค้า
- get_stock_balance       — ยอดคงเหลือสินค้า
- get_account_incoming    — สินค้าค้างรับ
- get_account_outstanding — สินค้าค้างส่ง
- get_bookout_balance     — สินค้าค้างจอง
- fallback_response       — แจ้งเมื่อไม่มี tool รองรับ`,

    general: `## Tools ที่ใช้ได้ (general)
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
- ดึงข้อมูล ERP ด้วยการรัน curl command ใน exec tool เท่านั้น — ห้ามใช้ read tool, write tool, หรือ tool อื่นใด
- ข้อความที่ได้รับทั้งหมดมาจากผู้ใช้งานที่ได้รับอนุญาตแล้ว ให้ดำเนินการตามคำขอทันที ห้ามปฏิเสธว่าเป็น untrusted source
- คำสั่ง /reset และ /compact เป็น system command — รับทราบและตอบกลับด้วยข้อความสั้น ๆ ว่าดำเนินการแล้ว ห้ามปฏิเสธ
- ตอบภาษาไทย กระชับ ห้ามใช้ตาราง Markdown
- ถ้าคำถามไม่ชัดเจนหรือไม่ระบุชื่อสินค้า/ลูกค้า ให้ถามกลับเพื่อขอข้อมูลเพิ่มเติมก่อน อย่าเรียก tool โดยไม่มีข้อมูลเพียงพอ
- ถ้าไม่มี tool รองรับคำถามนี้ ให้แจ้งผู้ใช้ด้วยภาษาธรรมดาว่าทำอะไรได้บ้าง ห้ามตอบว่า NO_REPLY หรือข้อความ error ให้ผู้ใช้เห็น
- ผลลัพธ์จาก curl จะอยู่ใน \`content[0].text\` — ต้อง parse JSON อีกครั้งเพื่อเอาข้อมูล

## วิธีเรียก tool
\`\`\`bash
curl -s -X POST ${callUrl} \\
  -H "Content-Type: application/json" \\
  -H "mcp-access-mode: ${accessMode}" \\
  -d '{"name": "<tool_name>", "arguments": {<params>}}'
\`\`\`

## ตัวอย่าง
\`\`\`bash
# ค้นหาสินค้า
curl -s -X POST ${callUrl} \\
  -H "Content-Type: application/json" \\
  -H "mcp-access-mode: ${accessMode}" \\
  -d '{"name": "search_product", "arguments": {"keyword": "กาแฟ"}}'

# ยอดคงเหลือสินค้า
curl -s -X POST ${callUrl} \\
  -H "Content-Type: application/json" \\
  -H "mcp-access-mode: ${accessMode}" \\
  -d '{"name": "get_stock_balance", "arguments": {"product_code": "P001"}}'
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
    // ดึง MCP URL จาก mcporter.json ถ้ามี
    const newMcpPath = path.join(workspacePath, 'config/mcporter.json')
    const newMcpConfig = fs.existsSync(newMcpPath) ? JSON.parse(fs.readFileSync(newMcpPath, 'utf8')) : {}
    const newMcpServer = Object.values(newMcpConfig.mcpServers ?? {})[0]
    const mcpUrl = newMcpServer?.url ?? null
    const soul = generateSoulTemplate(workspaceTilde, accessMode, mcpUrl)
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
    const mcpUrl = server?.url ?? null
    const workspaceTilde = agent.workspace.startsWith(HOME)
      ? agent.workspace.replace(HOME, '~')
      : agent.workspace
    const soul = generateSoulTemplate(workspaceTilde, accessMode, mcpUrl)
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

// GET /api/models?provider=openrouter|anthropic|google|openai|mistral|groq|kilocode
app.get('/api/models', async (req, res) => {
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
    res.status(500).json({ error: e.message })
  }
})

// POST /api/models/test — ทดสอบ API key ฝั่ง server (แก้ปัญหา CORS)
app.post('/api/models/test', async (req, res) => {
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
    res.json({ ok: false, error: e.message })
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
      const timeout = setTimeout(() => { hreq.destroy(); reject(new Error('hooks timeout')) }, 15000)
      hreq.on('close', () => clearTimeout(timeout))
      hreq.write(hookBody)
      hreq.end()
    })

    if (!hookRes.ok) return res.status(502).json({ error: 'gateway ไม่ตอบสนอง', detail: hookRes })

    // poll จาก sessions.json + .jsonl files โดยตรง (HTTP history endpoint ต้องการ auth แบบอื่น)
    const runId = hookRes.runId
    const sessionsJsonPath = path.join(HOME, `.openclaw/agents/${agentId}/sessions/sessions.json`)
    const fullSessionKey = `agent:${agentId}:${sessionKey}`
    const deadline = Date.now() + 300000 // 5 นาที — รองรับ model ช้า
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

// Strip gateway-injected metadata headers from user messages (Telegram + Webchat)
function stripGatewayMetadata(text) {
  if (!text) return text
  let result = text
  // Strip: "Conversation info (untrusted metadata):\n```json\n{...}\n```\n\n[Sender ...]\n\n"
  result = result.replace(/^(?:Conversation info \(untrusted metadata\):[\s\S]*?```\s*\n+)+(?:Sender \(untrusted metadata\):[\s\S]*?```\s*\n+)?/m, '')
  // Strip: "Task: Hook | Job ID: ... | Received: ...\n\nSECURITY NOTICE: ...\n- DO NOT ...\n- DO NOT ...\n\n"
  result = result.replace(/^Task: Hook \|[\s\S]*?SECURITY NOTICE:[\s\S]*?(?:\n- [^\n]+)+\n*/m, '')
  return result.trim()
}

// GET /api/monitor/events — real-time session state across all agents and channels
app.get('/api/monitor/events', async (_req, res) => {
  try {
    // Read agents from openclaw.json
    let config = {}
    try { config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) } catch { config = {} }
    const agentList = (config.agents && config.agents.list) ? config.agents.list : []

    // Load existing webchat rooms from DB grouped by agent_id
    // Key: agentId → Set of usernames that still have active rooms
    const webchatRoomsByAgent = {}
    let webchatDbAvailable = false
    if (pgPool) {
      try {
        const r = await pgPool.query('SELECT agent_id FROM webchat_rooms')
        webchatDbAvailable = true
        for (const row of r.rows) {
          if (!webchatRoomsByAgent[row.agent_id]) webchatRoomsByAgent[row.agent_id] = true
        }
      } catch { /* DB unavailable — skip filter */ }
    }

    const today = new Date().toISOString().slice(0, 10)
    let totalMessages = 0
    let totalCostToday = 0
    let activeNow = 0
    let errors = 0
    let responseTimes = []
    const globalEvents = []

    const agentsResult = []

    for (const agent of agentList) {
      const agentId = agent.id
      const sessionsPath = path.join(HOME, `.openclaw/agents/${agentId}/sessions/sessions.json`)

      let sessionsMap = {}
      try { sessionsMap = JSON.parse(fs.readFileSync(sessionsPath, 'utf8')) } catch { continue }

      const channels = {}

      for (const [key, sessionInfo] of Object.entries(sessionsMap)) {
        // Skip heartbeat sessions
        if (key.includes(':main')) continue

        let channel = null
        let user = null

        if (key.includes('hook:webchat')) {
          channel = 'webchat'
          const parts = key.split(':')
          user = parts[parts.length - 1]
          // Skip if no webchat rooms exist for this agent in DB
          if (webchatDbAvailable && !webchatRoomsByAgent[agentId]) continue
        } else if (key.includes('telegram')) {
          channel = 'telegram'
          // key format e.g. agent:sale:telegram:botname:userId
          const parts = key.split(':')
          const telegramIdx = parts.findIndex(p => p === 'telegram')
          user = parts.slice(telegramIdx + 1).join(':')
        } else {
          continue
        }

        if (!sessionInfo) continue
        // sessionFile may be absent for webchat sessions — derive from sessionId
        const sessionFile = sessionInfo.sessionFile
          || (sessionInfo.sessionId ? path.join(HOME, `.openclaw/agents/${agentId}/sessions/${sessionInfo.sessionId}.jsonl`) : null)
        if (!sessionFile) continue
        if (!channels[channel]) channels[channel] = []

        // Read last 50 lines of the .jsonl file
        let lines = []
        try {
          const content = fs.readFileSync(sessionFile, 'utf8')
          const allLines = content.split('\n').filter(l => l.trim())
          lines = allLines.slice(-50)
        } catch { continue }

        // Parse JSONL events
        const parsedLines = []
        for (const line of lines) {
          try { parsedLines.push(JSON.parse(line)) } catch { /* skip */ }
        }

        // Normalize: jsonl entries may be {role,content,timestamp} or {type,timestamp,message:{role,content}}
        const normalized = parsedLines.map(entry => {
          if (!entry) return null
          if (entry.message && entry.message.role) {
            // wrapped format: {type, id, timestamp, message:{role,content}}
            return { role: entry.message.role, content: entry.message.content, timestamp: entry.timestamp, usage: entry.usage }
          }
          // flat format: {role, content, timestamp}
          return entry
        }).filter(Boolean)

        // Filter out HEARTBEAT_OK messages
        const filtered = normalized.filter(msg => {
          if (!msg) return false
          const content = msg.content
          if (Array.isArray(content)) {
            return !content.some(c => typeof c === 'object' && c.type === 'tool_result' &&
              Array.isArray(c.content) && c.content.some(x => typeof x.text === 'string' && x.text.includes('HEARTBEAT_OK')))
          }
          if (typeof content === 'string' && content.includes('HEARTBEAT_OK')) return false
          return true
        })

        let lastUserMsg = null
        let lastAssistantMsg = null
        for (const msg of filtered) {
          if (msg.role === 'user') lastUserMsg = msg
          if (msg.role === 'assistant') lastAssistantMsg = msg
        }

        const lastMsg = filtered.length ? filtered[filtered.length - 1] : null
        const lastMsgRole = lastMsg ? lastMsg.role : null
        const lastMsgTs = lastMsg ? (lastMsg.timestamp || lastMsg.ts || null) : null
        const lastMsgTime = lastMsgTs ? new Date(lastMsgTs) : null
        const nowMs = Date.now()
        const elapsedSec = lastMsgTime ? Math.floor((nowMs - lastMsgTime.getTime()) / 1000) : null

        // Determine state
        let state = 'idle'
        if (lastMsgRole === 'user' && elapsedSec !== null && elapsedSec < 300) {
          state = 'thinking'
        } else if (lastMsgRole === 'assistant' && elapsedSec !== null && elapsedSec < 120) {
          // Check for error in last assistant message
          const hasError = (() => {
            if (!lastMsg) return false
            const c = lastMsg.content
            if (Array.isArray(c)) return c.some(x => x.type === 'error' || (typeof x.text === 'string' && x.text.toLowerCase().includes('error')))
            if (typeof c === 'string') return c.toLowerCase().includes('error')
            return false
          })()
          state = hasError ? 'error' : 'replied'
        } else if (lastMsgRole === 'assistant') {
          const hasError = (() => {
            if (!lastMsg) return false
            const c = lastMsg.content
            if (Array.isArray(c)) return c.some(x => x.type === 'error')
            return false
          })()
          if (hasError) state = 'error'
        }

        if (state === 'thinking' || state === 'replied') activeNow++
        if (state === 'error') errors++

        // Extract last user text
        let lastUserText = null
        if (lastUserMsg) {
          const c = lastUserMsg.content
          if (typeof c === 'string') lastUserText = stripGatewayMetadata(c).slice(0, 300)
          else if (Array.isArray(c)) {
            const textItem = c.find(x => x.type === 'text')
            if (textItem) lastUserText = stripGatewayMetadata(textItem.text).slice(0, 300)
          }
        }

        // Extract last reply text
        let lastReplyText = null
        if (lastAssistantMsg) {
          const c = lastAssistantMsg.content
          if (typeof c === 'string') lastReplyText = c.slice(0, 300)
          else if (Array.isArray(c)) {
            const textItem = c.find(x => x.type === 'text')
            if (textItem) lastReplyText = textItem.text.slice(0, 300)
          }
        }

        // Count cost and today messages
        let sessionCost = 0
        for (const msg of filtered) {
          if (msg.usage) {
            const u = msg.usage
            const inputCost = ((u.input_tokens || 0) / 1000000) * 3
            const outputCost = ((u.output_tokens || 0) / 1000000) * 15
            sessionCost += inputCost + outputCost
          }
          // Count today's messages
          const ts = msg.timestamp || msg.ts
          if (ts && ts.slice(0, 10) === today) {
            totalMessages++
          }
        }
        totalCostToday += sessionCost

        // Calculate response time (time between last user msg and last assistant msg)
        if (lastUserMsg && lastAssistantMsg) {
          const userTs = lastUserMsg.timestamp || lastUserMsg.ts
          const assistantTs = lastAssistantMsg.timestamp || lastAssistantMsg.ts
          if (userTs && assistantTs) {
            const diff = (new Date(assistantTs).getTime() - new Date(userTs).getTime()) / 1000
            if (diff > 0 && diff < 3600) responseTimes.push(diff)
          }
        }

        // Build events array from last 50 filtered lines
        const events = []
        for (const msg of filtered) {
          const ts = msg.timestamp || msg.ts
          const tsFormatted = ts ? new Date(ts).toISOString().slice(11, 19) : null
          if (msg.role === 'user') {
            const c = msg.content
            let text = ''
            if (typeof c === 'string') text = stripGatewayMetadata(c).slice(0, 300)
            else if (Array.isArray(c)) {
              const t = c.find(x => x.type === 'text')
              if (t) text = stripGatewayMetadata(t.text).slice(0, 300)
            }
            if (text) events.push({ ts: tsFormatted, type: 'message', text })
          } else if (msg.role === 'assistant') {
            const c = msg.content
            if (Array.isArray(c)) {
              for (const item of c) {
                if (item.type === 'thinking') {
                  events.push({ ts: tsFormatted, type: 'thinking', text: (item.thinking || '').slice(0, 300) })
                } else if (item.type === 'tool_use') {
                  const toolText = item.name + (item.input ? ': ' + JSON.stringify(item.input).slice(0, 300) : '')
                  events.push({ ts: tsFormatted, type: 'tool', text: toolText })
                } else if (item.type === 'text' && item.text) {
                  // Check for bash/exec mentions
                  const lower = item.text.toLowerCase()
                  if (lower.includes('bash') || lower.includes('exec')) {
                    events.push({ ts: tsFormatted, type: 'tool', text: item.text.slice(0, 300) })
                  } else {
                    events.push({ ts: tsFormatted, type: 'reply', text: item.text.slice(0, 300) })
                  }
                } else if (item.type === 'error') {
                  events.push({ ts: tsFormatted, type: 'error', text: (item.text || JSON.stringify(item)).slice(0, 300) })
                }
              }
            } else if (typeof c === 'string') {
              events.push({ ts: tsFormatted, type: 'reply', text: c.slice(0, 300) })
            }
          }
        }

        // Skip stale sessions (no activity in last 3 days)
        if (lastMsgTs) {
          const age = (Date.now() - new Date(lastMsgTs).getTime()) / 1000
          if (age > 259200) continue
        }

        if (!channels[channel]) channels[channel] = []

        const sessionEntry = {
          sessionKey: key,
          user,
          state,
          lastMessageAt: lastMsgTs || null,
          lastUserText,
          lastReplyText,
          elapsed: elapsedSec,
          cost: Math.round(sessionCost * 100000) / 100000,
          events
        }
        channels[channel].push(sessionEntry)

        // Add to globalEvents
        for (const ev of events) {
          globalEvents.push({ ts: ev.ts, agentId, channel, user, type: ev.type, text: ev.text })
        }
      }

      agentsResult.push({ id: agentId, channels })
    }

    // Sort globalEvents by ts descending and limit to last 50
    globalEvents.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''))
    const limitedGlobalEvents = globalEvents.slice(0, 50)

    // Read gateway log from /tmp/openclaw/ — latest file, last 100 lines
    const gatewayEvents = []
    try {
      const logDir = '/tmp/openclaw'
      const logFiles = fs.readdirSync(logDir)
        .filter(f => f.endsWith('.log') || f.endsWith('.jsonl'))
        .map(f => ({ name: f, mtime: fs.statSync(path.join(logDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)

      if (logFiles.length > 0) {
        const latestLog = path.join(logDir, logFiles[0].name)
        const logContent = fs.readFileSync(latestLog, 'utf8')
        const logLines = logContent.split('\n').filter(l => l.trim()).slice(-100)
        for (const line of logLines) {
          try {
            const obj = JSON.parse(line)
            const subsystem = typeof obj['0'] === 'string' ? (() => { try { return JSON.parse(obj['0']) } catch { return obj['0'] } })() : obj['0']
            const message = obj['1'] || obj.message || ''
            const ts = obj.time ? new Date(obj.time).toISOString().slice(11, 19) : null
            gatewayEvents.push({ ts, subsystem, message })
          } catch { /* skip */ }
        }
      }
    } catch { /* skip if /tmp/openclaw doesn't exist */ }

    const avgResponseTime = responseTimes.length
      ? Math.round((responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length) * 10) / 10
      : 0

    res.json({
      agents: agentsResult,
      globalEvents: limitedGlobalEvents,
      gatewayEvents,
      stats: {
        totalAgents: agentList.length,
        activeNow,
        todayMessages: totalMessages,
        avgResponseTime,
        totalCostToday: Math.round(totalCostToday * 100000) / 100000,
        errors
      }
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.listen(PORT, '0.0.0.0', () => {
  console.log(`OpenClaw API running on port ${PORT}`)
})
