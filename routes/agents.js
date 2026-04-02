const router = require('express').Router()
const fs = require('fs')
const path = require('path')
const { HOME, CONFIG_PATH } = require('../lib/config')
const { readUserNames, writeUserNames } = require('../lib/files')
const { generateSoulTemplate } = require('../lib/soul-template')

// GET /api/agents — รายการ agents พร้อม soul, mcp, users
router.get('/', (req, res) => {
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
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/agents — เพิ่ม agent ใหม่ (auto-generate SOUL + mcporter.json จาก template)
router.post('/', (req, res) => {
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
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/agents/:id/soul/template — ดึง SOUL template ตาม access mode ปัจจุบัน
router.get('/:id/soul/template', (req, res) => {
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
    const persona = req.query.persona || 'professional'
    const soul = generateSoulTemplate(workspaceTilde, accessMode, mcpUrl, persona)
    res.json({ soul, accessMode, persona })
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/agents/:id — ลบ agent
router.delete('/:id', (req, res) => {
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
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/agents/:id/soul — อ่าน SOUL.md
router.get('/:id/soul', (req, res) => {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    const agent = config.agents?.list?.find(a => a.id === req.params.id)
    if (!agent) return res.status(404).json({ error: 'Agent not found' })
    const soulPath = path.join(agent.workspace.replace('~', HOME), 'SOUL.md')
    res.json({ soul: fs.existsSync(soulPath) ? fs.readFileSync(soulPath, 'utf8') : '' })
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT /api/agents/:id/soul — เขียน SOUL.md
router.put('/:id/soul', (req, res) => {
  try {
    if (typeof req.body.soul !== 'string')
      return res.status(400).json({ error: 'soul must be a string' })
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    const agent = config.agents?.list?.find(a => a.id === req.params.id)
    if (!agent) return res.status(404).json({ error: 'Agent not found' })
    const soulPath = path.join(agent.workspace.replace('~', HOME), 'SOUL.md')
    fs.writeFileSync(soulPath, req.body.soul)
    res.json({ ok: true })
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/agents/:id/mcp — อ่าน mcporter.json
router.get('/:id/mcp', (req, res) => {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    const agent = config.agents?.list?.find(a => a.id === req.params.id)
    if (!agent) return res.status(404).json({ error: 'Agent not found' })
    const mcpPath = path.join(agent.workspace.replace('~', HOME), 'config/mcporter.json')
    res.json(fs.existsSync(mcpPath) ? JSON.parse(fs.readFileSync(mcpPath, 'utf8')) : {})
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT /api/agents/:id/mcp — เขียน mcporter.json
router.put('/:id/mcp', (req, res) => {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    const agent = config.agents?.list?.find(a => a.id === req.params.id)
    if (!agent) return res.status(404).json({ error: 'Agent not found' })
    const mcpDir = path.join(agent.workspace.replace('~', HOME), 'config')
    fs.mkdirSync(mcpDir, { recursive: true })
    fs.writeFileSync(path.join(mcpDir, 'mcporter.json'), JSON.stringify(req.body, null, 2))
    res.json({ ok: true })
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/agents/:id/mcp/test — ทดสอบ MCP พร้อม MCP_ACCESS_MODE จริง
// body: { accessMode?: string } — ถ้าส่งมาจะ override ค่าใน mcporter.json
router.post('/:id/mcp/test', (req, res) => {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    const agent = config.agents?.list?.find(a => a.id === req.params.id)
    if (!agent) return res.status(404).json({ error: 'Agent not found' })
    const mcpPath = path.join(agent.workspace.replace('~', HOME), 'config/mcporter.json')
    if (!fs.existsSync(mcpPath)) return res.status(400).json({ error: 'mcporter.json not found — save MCP config first' })
    const mcpConfig = JSON.parse(fs.readFileSync(mcpPath, 'utf8'))
    const serverName = Object.keys(mcpConfig.mcpServers ?? {})[0]
    if (!serverName) return res.status(400).json({ error: 'No MCP server configured' })

    const overrideMode = req.body?.accessMode
    const effectiveMode = overrideMode ?? mcpConfig.mcpServers[serverName]?.headers?.['mcp-access-mode'] ?? 'general'

    // Derive base URL from server URL (strip /call or /sse path suffix)
    const serverUrl = mcpConfig.mcpServers[serverName]?.url ?? ''
    const baseUrl = serverUrl.replace(/\/(call|sse)(\/.*)?$/, '')
    if (!baseUrl) return res.status(400).json({ error: 'MCP server URL not configured' })
    const toolsUrl = `${baseUrl}/tools`

    fetch(toolsUrl, { headers: { 'mcp-access-mode': effectiveMode } })
      .then(r => r.json())
      .then(data => {
        const list = Array.isArray(data) ? data : (data.tools ?? [])
        const tools = list.map(t => ({ name: t.name, description: t.description ?? '' }))
        res.json({ ok: true, serverName, accessMode: effectiveMode, tools })
      })
      .catch(err => res.status(500).json({ error: err.message }))
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/agents/:id/users — รายการ users ของ agent
router.get('/:id/users', (req, res) => {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    const userNames = readUserNames()
    const users = (config.bindings || [])
      .filter(b => b.agentId === req.params.id)
      .map(b => b.match?.peer ? { id: b.match.peer.id, name: userNames[b.match.peer.id] } : null)
      .filter(Boolean)
    res.json(users)
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/agents/:id/users — เพิ่ม user ID
router.post('/:id/users', (req, res) => {
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
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/agents/:id/users/:userId — ลบ user ID
router.delete('/:id/users/:userId', (req, res) => {
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
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router
