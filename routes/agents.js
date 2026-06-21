const router = require('express').Router()
const fs = require('fs')
const path = require('path')
const { HOME } = require('../lib/config')
const { readOpenclawConfig, writeOpenclawConfigAtomic } = require('../lib/openclaw-config')
const { readUserNames, writeUserNames } = require('../lib/files')
const { generateSoulTemplate } = require('../lib/soul-template')
const { getMcpTools } = require('../lib/mcp-tools')

// ─── openclaw mcp helpers — ใช้ openclaw.json mcp.servers โดยตรง ───────────────
function _readOcJson() {
  return readOpenclawConfig()
}
function _writeOcJson(d) {
  writeOpenclawConfigAtomic(d, { reason: 'agent-mcp' })
}
// server name ใน openclaw.json mcp.servers = agentId
function _mcpServerName(agentId) { return agentId }
// แปลง UI format → openclaw mcp.servers entry
function _toOcServer(s) {
  const url = s.url ?? ''
  const transport = url.includes('/sse') ? 'sse' : 'streamable-http'
  const r = { url, transport }
  if (s.headers && Object.keys(s.headers).length) r.headers = s.headers
  return r
}
// แปลง openclaw mcp.servers entry → UI format
function _fromOcServer(name, s) {
  return { type: 'http', url: s.url, allowHttp: true, headers: s.headers ?? {} }
}
// หา MCP server ของ agent จาก openclaw.json (รองรับ sml-{id} legacy)
function _getOcServer(agentId) {
  const ocJson = _readOcJson()
  const name = _mcpServerName(agentId)
  return ocJson.mcp?.servers?.[name] ?? ocJson.mcp?.servers?.['sml-' + name] ?? null
}

// GET /api/agents — รายการ agents พร้อม soul, mcp, users
router.get('/', (req, res) => {
  try {
    const config = readOpenclawConfig()
    const ocJson = _readOcJson()
    const agents = (config.agents?.list || []).map(agent => {
      const workspacePath = agent.workspace.replace('~', HOME)
      const soulPath = path.join(workspacePath, 'SOUL.md')
      const name = _mcpServerName(agent.id)
      const ocServer = ocJson.mcp?.servers?.[name] ?? ocJson.mcp?.servers?.['sml-' + name]
      const mcp = ocServer ? { mcpServers: { [name]: _fromOcServer(name, ocServer) } } : null
      return {
        id: agent.id,
        workspace: agent.workspace,
        soul: fs.existsSync(soulPath) ? fs.readFileSync(soulPath, 'utf8') : '',
        mcp,
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

// POST /api/agents — เพิ่ม agent ใหม่
router.post('/', async (req, res) => {
  try {
    const { id, workspace, accessMode = 'general' } = req.body
    if (!id || !workspace) return res.status(400).json({ error: 'id and workspace required' })
    const config = readOpenclawConfig()
    if (!config.agents) config.agents = { list: [] }
    if (!config.agents.list) config.agents.list = []
    if (config.agents.list.find(a => a.id === id))
      return res.status(400).json({ error: 'Agent already exists' })
    config.agents.list.push({ id, workspace })
    const workspacePath = workspace.replace('~', HOME)
    fs.mkdirSync(path.join(workspacePath, 'config'), { recursive: true })
    const workspaceTilde = workspace.startsWith(HOME)
      ? workspace.replace(HOME, '~')
      : workspace
    // ไม่สร้าง mcporter.json อีกต่อไป — ใช้ openclaw mcp ผ่าน UI แทน
    const toolResult = await getMcpTools({ accessMode, mcpUrl: null })
    const soul = generateSoulTemplate(workspaceTilde, accessMode, null, 'professional', toolResult)
    fs.writeFileSync(path.join(workspacePath, 'SOUL.md'), soul)
    writeOpenclawConfigAtomic(config, { reason: 'agent-create' })
    res.json({ ok: true })
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/agents/:id/soul/template — ดึง SOUL template ตาม access mode ปัจจุบัน
router.get('/:id/soul/template', async (req, res) => {
  try {
    const config = readOpenclawConfig()
    const agent = config.agents?.list?.find(a => a.id === req.params.id)
    if (!agent) return res.status(404).json({ error: 'Agent not found' })
    // อ่าน accessMode จาก openclaw.json mcp.servers
    const ocServer = _getOcServer(req.params.id)
    const requestedAccessMode = ocServer?.headers?.['mcp-access-mode'] ?? 'general'
    const mcpUrl = ocServer?.url ?? null
    const workspaceTilde = agent.workspace.startsWith(HOME)
      ? agent.workspace.replace(HOME, '~')
      : agent.workspace
    const persona = req.query.persona || 'professional'
    const refreshTools = req.query.refreshTools === 'true'
    const toolResult = await getMcpTools({ accessMode: requestedAccessMode, mcpUrl, refresh: refreshTools })
    const accessMode = toolResult.accessMode
    const soul = generateSoulTemplate(workspaceTilde, accessMode, mcpUrl, persona, toolResult)
    const warnings = [...(toolResult.warnings || [])]
    if (accessMode === 'stock' && !/workflowContract=stock-flow-v1\b/.test(soul)) {
      warnings.push('Template missing stock-flow-v1 workflow contract')
    }
    if (!/responseContract=grounded-reply-v1\b/.test(soul)) {
      warnings.push('Template missing grounded-reply-v1 response contract')
    }
    res.json({
      soul,
      accessMode,
      persona,
      mcpUrl,
      toolSource: toolResult.toolSource,
      tools: toolResult.tools,
      capabilities: toolResult.capabilities,
      deniedCapabilities: toolResult.deniedCapabilities,
      warnings,
      generatedAt: toolResult.generatedAt,
      cache: toolResult.cache,
    })
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/agents/:id — ลบ agent
router.delete('/:id', (req, res) => {
  try {
    const config = readOpenclawConfig()
    config.agents.list = (config.agents.list || []).filter(a => a.id !== req.params.id)
    config.bindings = (config.bindings || []).filter(b => b.agentId !== req.params.id)
    if (config.channels?.telegram?.allowFrom) {
      // ไม่ลบ user IDs ออกจาก allowFrom เผื่อ user bind กับ agent อื่นด้วย
    }
    writeOpenclawConfigAtomic(config, { reason: 'agent-delete' })
    res.json({ ok: true })
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/agents/:id/soul — อ่าน SOUL.md
router.get('/:id/soul', (req, res) => {
  try {
    const config = readOpenclawConfig()
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
    const config = readOpenclawConfig()
    const agent = config.agents?.list?.find(a => a.id === req.params.id)
    if (!agent) return res.status(404).json({ error: 'Agent not found' })
    const soulPath = path.join(agent.workspace.replace('~', HOME), 'SOUL.md')
    if (fs.existsSync(soulPath)) {
      const current = fs.readFileSync(soulPath, 'utf8')
      if (current !== req.body.soul) {
        const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)
        fs.copyFileSync(soulPath, `${soulPath}.bak.${stamp}`)
      }
    }
    fs.writeFileSync(soulPath, req.body.soul)
    res.json({ ok: true })
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/agents/:id/sessions/reset-active — ลบ session key ที่ active ของ agent นี้
router.post('/:id/sessions/reset-active', (req, res) => {
  try {
    const config = readOpenclawConfig()
    const agent = config.agents?.list?.find(a => a.id === req.params.id)
    if (!agent) return res.status(404).json({ error: 'Agent not found' })

    const sessionsPath = path.join(HOME, `.openclaw/agents/${req.params.id}/sessions/sessions.json`)
    if (!fs.existsSync(sessionsPath)) {
      return res.json({ ok: true, removed: 0, backupPath: null })
    }

    const sessions = JSON.parse(fs.readFileSync(sessionsPath, 'utf8'))
    const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)
    const backupPath = `${sessionsPath}.bak.${stamp}`
    const keys = Object.keys(sessions)
    const removedKeys = keys.filter(key => !key.endsWith(':main'))
    if (removedKeys.length === 0) {
      return res.json({ ok: true, removed: 0, backupPath: null })
    }

    fs.copyFileSync(sessionsPath, backupPath)
    for (const key of removedKeys) delete sessions[key]
    const serialized = JSON.stringify(sessions, null, 2)
    JSON.parse(serialized)
    const tmpPath = `${sessionsPath}.tmp.${process.pid}.${Date.now()}`
    const fd = fs.openSync(tmpPath, 'w', 0o600)
    try {
      fs.writeFileSync(fd, serialized)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(tmpPath, sessionsPath)
    res.json({ ok: true, removed: removedKeys.length, backupPath, reason: req.body?.reason || 'manual-reset' })
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/agents/:id/mcp — อ่านจาก openclaw.json mcp.servers
router.get('/:id/mcp', (req, res) => {
  try {
    const config = readOpenclawConfig()
    if (!config.agents?.list?.find(a => a.id === req.params.id))
      return res.status(404).json({ error: 'Agent not found' })
    const name = _mcpServerName(req.params.id)
    const ocServer = _getOcServer(req.params.id)
    if (!ocServer) return res.json({})
    res.json({ mcpServers: { [name]: _fromOcServer(name, ocServer) } })
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT /api/agents/:id/mcp — เขียนลง openclaw.json mcp.servers (hot-reload อัตโนมัติ)
router.put('/:id/mcp', (req, res) => {
  try {
    const config = readOpenclawConfig()
    const agent = config.agents?.list?.find(a => a.id === req.params.id)
    if (!agent) return res.status(404).json({ error: 'Agent not found' })
    const firstServer = Object.values(req.body.mcpServers ?? {})[0]
    if (!firstServer?.url) return res.status(400).json({ error: 'url required in mcpServers' })
    const ocJson = _readOcJson()
    if (!ocJson.mcp) ocJson.mcp = {}
    if (!ocJson.mcp.servers) ocJson.mcp.servers = {}
    const name = _mcpServerName(req.params.id)
    // ลบ legacy sml-{agentId} entry ถ้ามี
    delete ocJson.mcp.servers['sml-' + name]
    ocJson.mcp.servers[name] = _toOcServer(firstServer)
    _writeOcJson(ocJson)
    res.json({ ok: true })
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/agents/:id/mcp/test — ทดสอบ MCP จาก openclaw.json mcp.servers
// body: { accessMode?: string } — override ถ้าต้องการ
router.post('/:id/mcp/test', async (req, res) => {
  try {
    const config = readOpenclawConfig()
    if (!config.agents?.list?.find(a => a.id === req.params.id))
      return res.status(404).json({ error: 'Agent not found' })
    const ocServer = _getOcServer(req.params.id)
    if (!ocServer?.url) return res.status(400).json({ error: 'No MCP server configured — save config first' })
    const name = _mcpServerName(req.params.id)
    const effectiveMode = req.body?.accessMode ?? ocServer.headers?.['mcp-access-mode'] ?? 'general'
    const result = await getMcpTools({ mcpUrl: ocServer.url, accessMode: effectiveMode, refresh: req.body?.refreshTools === true })
    if (result.toolSource !== 'live') {
      return res.status(502).json({
        ok: false,
        serverName: name,
        accessMode: result.accessMode,
        error: result.error || 'MCP unavailable',
        tools: result.tools,
        toolSource: result.toolSource,
        warnings: result.warnings,
        cache: result.cache,
      })
    }
    res.json({
      ok: true,
      serverName: name,
      accessMode: result.accessMode,
      tools: result.tools,
      capabilities: result.capabilities,
      deniedCapabilities: result.deniedCapabilities,
      toolSource: result.toolSource,
      warnings: result.warnings,
      cache: result.cache,
    })
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/agents/:id/users — รายการ users ของ agent
router.get('/:id/users', (req, res) => {
  try {
    const config = readOpenclawConfig()
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
    const config = readOpenclawConfig()
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
    writeOpenclawConfigAtomic(config, { reason: 'agent-user-add' })
    res.json({ ok: true })
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/agents/:id/users/:userId — ลบ user ID
router.delete('/:id/users/:userId', (req, res) => {
  try {
    const config = readOpenclawConfig()
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
    writeOpenclawConfigAtomic(config, { reason: 'agent-user-delete' })
    res.json({ ok: true })
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router
