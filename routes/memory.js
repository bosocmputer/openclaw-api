const router = require('express').Router()
const fs = require('fs')
const path = require('path')
const { HOME } = require('../lib/config')
const { readOpenclawConfig } = require('../lib/openclaw-config')
const { requirePg } = require('../lib/pg')
const memoryLearning = require('../lib/memory-learning')
const memoryAuto = require('../lib/memory-auto')

function adminActor(req) {
  return req.headers['x-openclaw-admin-user'] || null
}

function safeError(res, err) {
  const status = Number(err.status || err.statusCode || 500)
  if (status >= 500) {
    console.error('[openclaw-api] memory', err.message)
    return res.status(500).json({ error: 'Internal server error' })
  }
  return res.status(status).json({ error: err.message })
}

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

function getDreamingConfig(config) {
  const pluginDreaming = config.plugins?.entries?.['memory-core']?.config?.dreaming
  if (pluginDreaming && typeof pluginDreaming === 'object') {
    return { enabled: pluginDreaming.enabled === true, config: pluginDreaming, source: 'plugins.entries.memory-core.config.dreaming' }
  }
  const legacyDreaming = config.memory?.dreaming
  if (legacyDreaming && typeof legacyDreaming === 'object') {
    return { enabled: legacyDreaming.enabled === true, config: legacyDreaming, source: 'memory.dreaming' }
  }
  return { enabled: false, config: null, source: 'default' }
}

function findDreamsFile(workspacePath) {
  const names = ['DREAMS.md', 'dreams.md']
  for (const name of names) {
    const filePath = path.join(workspacePath, name)
    if (fs.existsSync(filePath)) return { path: filePath, name }
  }
  return { path: path.join(workspacePath, 'DREAMS.md'), name: 'DREAMS.md' }
}

function memorySizeInfo(sizeChars, config) {
  const bootstrapMaxChars = Number(config.agents?.defaults?.bootstrapMaxChars || 20000)
  const estimatedTokens = Math.ceil(sizeChars / 4)
  return {
    estimatedTokens,
    sizeWarning: memoryLearning.memorySizeWarning(sizeChars),
    injectedLikely: sizeChars > 0 ? (sizeChars <= bootstrapMaxChars ? 'full' : 'truncated') : 'missing',
    bootstrapMaxChars,
  }
}

// GET /api/memory/status
router.get('/status', async (req, res) => {
  try {
    const config = readOpenclawConfig()
    const agents = config.agents?.list ?? []
    const dreaming = getDreamingConfig(config)
    const autoSummary = memoryAuto.isAvailable()
      ? await memoryAuto.summaryForAgents(agents.map(agent => agent.id).filter(Boolean)).catch(() => ({}))
      : {}

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

      // DREAMS.md / dreams.md
      const dreamsFile = findDreamsFile(workspacePath)
      const dreamsPath = dreamsFile.path
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
        memory: { exists: memoryExists, sizeChars: memorySizeChars, preview: memoryPreview, ...memorySizeInfo(memorySizeChars, config) },
        dreams: { exists: dreamsExists, sizeChars: dreamsSizeChars, preview: dreamsPreview, path: dreamsExists ? dreamsPath : null, canonicalName: dreamsFile.name },
        dailyMemory: {
          fileCount: daily.files.length,
          totalChars: daily.totalChars,
          latestDate: daily.latestDate,
          latestPreview: daily.latestPreview,
          files: daily.files,
        },
        dreaming,
        autoLearn: {
          autoLearnMode: autoSummary[agent.id]?.autoLearnMode || 'observe_only',
          activeMemoryCount: autoSummary[agent.id]?.activeMemoryCount || 0,
          softMemoryCount: autoSummary[agent.id]?.softMemoryCount || 0,
          blockedCount: autoSummary[agent.id]?.blockedCount || 0,
          deletedCount: autoSummary[agent.id]?.deletedCount || 0,
          estimatedInjectedChars: autoSummary[agent.id]?.estimatedInjectedChars || 0,
          maxContextChars: autoSummary[agent.id]?.maxContextChars || 1200,
          memoryHealth: autoSummary[agent.id]?.memoryHealth || {
            noiseCount: 0,
            duplicateCount: 0,
            dynamicFactCount: 0,
            vagueTeachingCount: 0,
            overBudget: false,
            injectedChars: 0,
            activeButNotInjectedCount: 0,
            totalActiveChars: 0,
          },
        },
      }
    })
    res.json(result)
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/memory/memories
router.get('/memories', requirePg, async (req, res) => {
  try {
    res.json(await memoryAuto.listMemories({
      agentId: req.query.agentId,
      status: req.query.status,
      type: req.query.type,
      scope: req.query.scope,
      q: req.query.q,
      limit: req.query.limit,
    }))
  } catch (err) {
    safeError(res, err)
  }
})

// POST /api/memory/memories
router.post('/memories', requirePg, async (req, res) => {
  try {
    res.status(201).json(await memoryAuto.createMemory(req.body, adminActor(req)))
  } catch (err) {
    safeError(res, err)
  }
})

// PATCH /api/memory/memories/:id
router.patch('/memories/:id', requirePg, async (req, res) => {
  try {
    res.json(await memoryAuto.updateMemory(req.params.id, req.body, adminActor(req)))
  } catch (err) {
    safeError(res, err)
  }
})

// DELETE /api/memory/memories/:id
router.delete('/memories/:id', requirePg, async (req, res) => {
  try {
    res.json(await memoryAuto.deleteMemory(req.params.id, req.query, adminActor(req)))
  } catch (err) {
    safeError(res, err)
  }
})

// POST /api/memory/memories/:id/block-relearn
router.post('/memories/:id/block-relearn', requirePg, async (req, res) => {
  try {
    res.json(await memoryAuto.blockRelearn(req.params.id, req.body, adminActor(req)))
  } catch (err) {
    safeError(res, err)
  }
})

// GET /api/memory/observations
router.get('/observations', requirePg, async (req, res) => {
  try {
    res.json(await memoryAuto.listObservations({
      agentId: req.query.agentId,
      status: req.query.status,
      type: req.query.type,
      q: req.query.q,
      sourceTurnId: req.query.sourceTurnId,
      limit: req.query.limit,
    }))
  } catch (err) {
    safeError(res, err)
  }
})

// POST /api/memory/observations/:id/promote
router.post('/observations/:id/promote', requirePg, async (req, res) => {
  try {
    res.json(await memoryAuto.promoteObservation(req.params.id, req.body, adminActor(req)))
  } catch (err) {
    safeError(res, err)
  }
})

// GET /api/memory/policies
router.get('/policies', requirePg, async (req, res) => {
  try {
    res.json(await memoryAuto.listPolicies())
  } catch (err) {
    safeError(res, err)
  }
})

// PUT /api/memory/policies/:agentId
router.put('/policies/:agentId', requirePg, async (req, res) => {
  try {
    res.json(await memoryAuto.upsertPolicy(req.params.agentId, req.body, adminActor(req)))
  } catch (err) {
    safeError(res, err)
  }
})

// POST /api/memory/policies/:agentId/apply-auto-learn
router.post('/policies/:agentId/apply-auto-learn', requirePg, async (req, res) => {
  try {
    res.json(await memoryAuto.applyAutoLearnForAgent(req.params.agentId, {
      actor: adminActor(req) || 'admin',
      limit: req.body?.limit || 200,
    }))
  } catch (err) {
    safeError(res, err)
  }
})

// POST /api/memory/maintenance/cleanup
router.post('/maintenance/cleanup', requirePg, async (req, res) => {
  try {
    const body = req.body || {}
    const agentId = body.agentId || body.agent_id || req.query.agentId || req.query.agent_id
    res.json(await memoryAuto.cleanupMemories(agentId, body, adminActor(req) || 'admin'))
  } catch (err) {
    safeError(res, err)
  }
})

// GET /api/memory/usage
router.get('/usage', requirePg, async (req, res) => {
  try {
    res.json(await memoryAuto.listUsage({
      turnId: req.query.turnId,
      agentId: req.query.agentId,
      limit: req.query.limit,
    }))
  } catch (err) {
    safeError(res, err)
  }
})

// GET /api/memory/learning-candidates
router.get('/learning-candidates', requirePg, async (req, res) => {
  try {
    res.json(await memoryLearning.listCandidates({
      agentId: req.query.agentId,
      status: req.query.status,
      targetType: req.query.targetType,
      limit: req.query.limit,
    }))
  } catch (err) {
    safeError(res, err)
  }
})

// POST /api/memory/learning-candidates
router.post('/learning-candidates', requirePg, async (req, res) => {
  try {
    const candidate = await memoryLearning.createCandidate(req.body, adminActor(req))
    res.status(candidate.deduped ? 200 : 201).json(candidate)
  } catch (err) {
    safeError(res, err)
  }
})

router.post('/learning-candidates/:id/approve', requirePg, async (req, res) => {
  try {
    res.json(await memoryLearning.setCandidateStatus(req.params.id, 'approved', adminActor(req)))
  } catch (err) {
    safeError(res, err)
  }
})

router.post('/learning-candidates/:id/reject', requirePg, async (req, res) => {
  try {
    res.json(await memoryLearning.setCandidateStatus(req.params.id, 'rejected', adminActor(req)))
  } catch (err) {
    safeError(res, err)
  }
})

router.post('/learning-candidates/:id/apply', requirePg, async (req, res) => {
  try {
    res.json(await memoryLearning.applyCandidate(req.params.id, { force: req.body?.force === true }, adminActor(req)))
  } catch (err) {
    safeError(res, err)
  }
})

// GET /api/memory/:agentId/memory — อ่าน MEMORY.md
router.get('/:agentId/memory', (req, res) => {
  try {
    const config = readOpenclawConfig()
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
    const config = readOpenclawConfig()
    const agent = config.agents?.list?.find(a => a.id === req.params.agentId)
    if (!agent) return res.status(404).json({ error: 'Agent not found' })
    const dreamsPath = findDreamsFile(agent.workspace.replace('~', HOME)).path
    res.json({ content: fs.existsSync(dreamsPath) ? fs.readFileSync(dreamsPath, 'utf8') : '' })
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/memory/:agentId/backups
router.get('/:agentId/backups', (req, res) => {
  try {
    res.json({ backups: memoryLearning.listBackups(req.params.agentId) })
  } catch (err) {
    safeError(res, err)
  }
})

// POST /api/memory/:agentId/rollback
router.post('/:agentId/rollback', async (req, res) => {
  try {
    res.json(await memoryLearning.rollbackMemory(req.params.agentId, req.body?.backupId, adminActor(req)))
  } catch (err) {
    safeError(res, err)
  }
})

// GET /api/memory/:agentId/daily/:filename — อ่าน daily memory file
router.get('/:agentId/daily/:filename', (req, res) => {
  try {
    const config = readOpenclawConfig()
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
module.exports._internal = {
  getDreamingConfig,
  findDreamsFile,
  memorySizeInfo,
}
