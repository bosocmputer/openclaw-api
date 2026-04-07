const router = require('express').Router()
const fs = require('fs')
const path = require('path')
const { HOME, CONFIG_PATH } = require('../lib/config')

function readWorkspaceMemory(workspacePath) {
  const memoryDir = path.join(workspacePath, 'memory')
  if (!fs.existsSync(memoryDir)) return { files: [], totalChars: 0, latestPreview: '', latestDate: null }

  let files = []
  try {
    files = fs.readdirSync(memoryDir)
      .filter(f => f.endsWith('.md'))
      .sort()
      .reverse() // newest first
  } catch { return { files: [], totalChars: 0, latestPreview: '', latestDate: null } }

  let totalChars = 0
  let latestPreview = ''
  let latestDate = null

  for (const f of files) {
    try {
      const content = fs.readFileSync(path.join(memoryDir, f), 'utf8')
      totalChars += content.length
    } catch {}
  }

  if (files.length > 0) {
    latestDate = files[0].replace('.md', '')
    try {
      const content = fs.readFileSync(path.join(memoryDir, files[0]), 'utf8')
      latestPreview = content.split('\n').slice(0, 6).join('\n')
    } catch {}
  }

  return { files, totalChars, latestPreview, latestDate }
}

// GET /api/memory/status
router.get('/status', (req, res) => {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    const agents = config.agents?.list ?? []
    const dreamingEnabled = config.memory?.dreaming?.enabled ?? false
    const dreamingConfig = config.memory?.dreaming ?? null

    const result = agents.map(agent => {
      const workspacePath = agent.workspace.replace('~', HOME)

      // MEMORY.md (long-term, main session only)
      const memoryPath = path.join(workspacePath, 'MEMORY.md')
      const memoryExists = fs.existsSync(memoryPath)
      let memorySizeChars = 0
      let memoryPreview = ''
      if (memoryExists) {
        const content = fs.readFileSync(memoryPath, 'utf8')
        memorySizeChars = content.length
        memoryPreview = content.split('\n')
          .filter(l => l.startsWith('#') || l.startsWith('-'))
          .slice(0, 10)
          .join('\n')
      }

      // dreams.md
      const dreamsPath = path.join(workspacePath, 'dreams.md')
      const dreamsExists = fs.existsSync(dreamsPath)
      let dreamsSizeChars = 0
      let dreamsPreview = ''
      if (dreamsExists) {
        const content = fs.readFileSync(dreamsPath, 'utf8')
        dreamsSizeChars = content.length
        dreamsPreview = content.split('\n').slice(0, 5).join('\n')
      }

      // memory/*.md (daily notes — ระบบจริงที่ใช้งาน)
      const daily = readWorkspaceMemory(workspacePath)

      return {
        agentId: agent.id,
        workspace: agent.workspace,
        memory: { exists: memoryExists, sizeChars: memorySizeChars, preview: memoryPreview },
        dreams: { exists: dreamsExists, sizeChars: dreamsSizeChars, preview: dreamsPreview },
        dailyMemory: {
          fileCount: daily.files.length,
          totalChars: daily.totalChars,
          latestDate: daily.latestDate,
          latestPreview: daily.latestPreview,
          files: daily.files,
        },
        dreaming: { enabled: dreamingEnabled, config: dreamingConfig },
      }
    })
    res.json(result)
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/memory/:agentId/memory — อ่าน MEMORY.md
router.get('/:agentId/memory', (req, res) => {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    const agent = config.agents?.list?.find(a => a.id === req.params.agentId)
    if (!agent) return res.status(404).json({ error: 'Agent not found' })
    const memPath = path.join(agent.workspace.replace('~', HOME), 'MEMORY.md')
    res.json({ content: fs.existsSync(memPath) ? fs.readFileSync(memPath, 'utf8') : '' })
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/memory/:agentId/dreams — อ่าน dreams.md
router.get('/:agentId/dreams', (req, res) => {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    const agent = config.agents?.list?.find(a => a.id === req.params.agentId)
    if (!agent) return res.status(404).json({ error: 'Agent not found' })
    const dreamsPath = path.join(agent.workspace.replace('~', HOME), 'dreams.md')
    res.json({ content: fs.existsSync(dreamsPath) ? fs.readFileSync(dreamsPath, 'utf8') : '' })
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/memory/:agentId/daily/:filename — อ่าน daily memory file
router.get('/:agentId/daily/:filename', (req, res) => {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    const agent = config.agents?.list?.find(a => a.id === req.params.agentId)
    if (!agent) return res.status(404).json({ error: 'Agent not found' })
    // sanitize filename — allow only YYYY-MM-DD*.md pattern
    const { filename } = req.params
    if (!/^[\w\-]+\.md$/.test(filename)) return res.status(400).json({ error: 'Invalid filename' })
    const filePath = path.join(agent.workspace.replace('~', HOME), 'memory', filename)
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' })
    res.json({ content: fs.readFileSync(filePath, 'utf8') })
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router
