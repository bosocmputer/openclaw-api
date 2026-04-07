const router = require('express').Router()
const fs = require('fs')
const path = require('path')
const { HOME, CONFIG_PATH } = require('../lib/config')

// GET /api/compaction/checkpoints/:agentId — รายการ checkpoints ของ agent
router.get('/checkpoints/:agentId', (req, res) => {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    const agent = config.agents?.list?.find(a => a.id === req.params.agentId)
    if (!agent) return res.status(404).json({ error: 'Agent not found' })

    const sessionsDir = path.join(HOME, `.openclaw/agents/${req.params.agentId}/sessions`)
    if (!fs.existsSync(sessionsDir)) return res.json([])

    // checkpoints = .jsonl.reset.* files
    const checkpoints = fs.readdirSync(sessionsDir)
      .filter(f => f.includes('.jsonl.reset.'))
      .map(f => {
        const match = f.match(/^(.+)\.jsonl\.reset\.(.+)$/)
        if (!match) return null
        const [, sessionId, tsRaw] = match
        const ts = tsRaw.replace(/-/g, ':').replace('T', 'T') // restore ISO format
        const stat = fs.statSync(path.join(sessionsDir, f))
        return { filename: f, sessionId, checkpointAt: ts, sizeBytes: stat.size }
      })
      .filter(Boolean)
      .sort((a, b) => b.checkpointAt.localeCompare(a.checkpointAt))

    res.json(checkpoints)
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/compaction/restore — restore session จาก checkpoint
// body: { agentId, filename }  — filename คือ *.jsonl.reset.* file
router.post('/restore', (req, res) => {
  try {
    const { agentId, filename } = req.body
    if (!agentId || !filename) return res.status(400).json({ error: 'agentId and filename required' })

    // security: ห้าม path traversal
    if (filename.includes('/') || filename.includes('..'))
      return res.status(400).json({ error: 'Invalid filename' })
    if (!filename.includes('.jsonl.reset.'))
      return res.status(400).json({ error: 'Not a valid checkpoint file' })

    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    const agent = config.agents?.list?.find(a => a.id === agentId)
    if (!agent) return res.status(404).json({ error: 'Agent not found' })

    const sessionsDir = path.join(HOME, `.openclaw/agents/${agentId}/sessions`)
    const checkpointPath = path.join(sessionsDir, filename)
    if (!fs.existsSync(checkpointPath))
      return res.status(404).json({ error: 'Checkpoint file not found' })

    // sessionId คือ prefix ก่อน .jsonl.reset.*
    const sessionId = filename.split('.jsonl.reset.')[0]
    const activePath = path.join(sessionsDir, `${sessionId}.jsonl`)

    // backup active session ก่อน restore
    if (fs.existsSync(activePath)) {
      const backupTs = new Date().toISOString().replace(/:/g, '-').replace('.', '-')
      fs.copyFileSync(activePath, path.join(sessionsDir, `${sessionId}.jsonl.backup.${backupTs}`))
    }

    // copy checkpoint → active
    fs.copyFileSync(checkpointPath, activePath)
    res.json({ ok: true, sessionId, restoredFrom: filename })
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router
