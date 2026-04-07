const router = require('express').Router()
const fs = require('fs')
const path = require('path')
const { HOME, CONFIG_PATH } = require('../lib/config')

// GET /api/memory/status — สถานะ memory ของทุก agent (MEMORY.md + dreams.md)
router.get('/status', (req, res) => {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    const agents = config.agents?.list ?? []
    const result = agents.map(agent => {
      const workspacePath = agent.workspace.replace('~', HOME)
      const memoryPath = path.join(workspacePath, 'MEMORY.md')
      const dreamsPath = path.join(workspacePath, 'dreams.md')

      const memoryExists = fs.existsSync(memoryPath)
      const dreamsExists = fs.existsSync(dreamsPath)

      let memorySizeChars = 0
      let dreamsSizeChars = 0
      let memoryPreview = ''
      let dreamsPreview = ''

      if (memoryExists) {
        const content = fs.readFileSync(memoryPath, 'utf8')
        memorySizeChars = content.length
        // เอาแค่ heading lines เป็น preview
        memoryPreview = content.split('\n')
          .filter(l => l.startsWith('#') || l.startsWith('-'))
          .slice(0, 10)
          .join('\n')
      }
      if (dreamsExists) {
        const content = fs.readFileSync(dreamsPath, 'utf8')
        dreamsSizeChars = content.length
        dreamsPreview = content.split('\n').slice(0, 5).join('\n')
      }

      // ดู dreaming config จาก config
      const dreamingConfig = config.memory?.dreaming ?? null
      const dreamingEnabled = dreamingConfig?.enabled ?? false

      return {
        agentId: agent.id,
        workspace: agent.workspace,
        memory: { exists: memoryExists, sizeChars: memorySizeChars, preview: memoryPreview },
        dreams: { exists: dreamsExists, sizeChars: dreamsSizeChars, preview: dreamsPreview },
        dreaming: { enabled: dreamingEnabled, config: dreamingConfig },
      }
    })
    res.json(result)
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/memory/:agentId/memory — อ่าน MEMORY.md เต็ม
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

// GET /api/memory/:agentId/dreams — อ่าน dreams.md เต็ม
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

module.exports = router
