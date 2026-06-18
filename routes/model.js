const router = require('express').Router()
const crypto = require('crypto')
const { readOpenclawConfig, writeOpenclawConfigAtomic, withConfigLock } = require('../lib/openclaw-config')
const { getModelCatalog } = require('../lib/model-catalog')
const {
  applyModelSettings,
  collectRuntimeVerificationIssues,
  getModelReadinessForConfig,
} = require('../lib/model-readiness')
const { materializeProviderCatalogsForRefs, materializeSelectedProviderCatalogs } = require('../lib/model-provider-materialize')
const { runModelImageMessageTest, runModelMessageTest, runModelRuntimeTest } = require('../lib/model-runtime-test')

const READINESS_TTL_MS = 30_000
let readinessCache = null

function configHash(config) {
  return crypto.createHash('sha256').update(JSON.stringify(config || {})).digest('hex')
}

async function getCachedReadiness(config, { refresh = false } = {}) {
  const hash = configHash(config)
  if (!refresh && readinessCache && readinessCache.hash === hash && Date.now() - readinessCache.createdAt < READINESS_TTL_MS) {
    return {
      ...readinessCache.data,
      cache: {
        hit: true,
        ttlSeconds: Math.ceil((READINESS_TTL_MS - (Date.now() - readinessCache.createdAt)) / 1000),
      },
    }
  }
  const readiness = await getModelReadinessForConfig(config, { refresh })
  const cached = {
    ...readiness,
    cache: { hit: false, ttlSeconds: READINESS_TTL_MS / 1000 },
  }
  readinessCache = { hash, createdAt: Date.now(), data: cached }
  return cached
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function prepareRuntimeCatalogsForRefs(refs, { reason = 'model-runtime-test-catalog' } = {}) {
  const selectedRefs = [...new Set((refs || []).map(item => String(item || '').trim()).filter(Boolean))]
  if (!selectedRefs.length) {
    return { changed: false, preparedProviders: [], warnings: [], config: readOpenclawConfig() }
  }

  const result = await withConfigLock(async () => {
    const current = readOpenclawConfig()
    const materialized = await materializeProviderCatalogsForRefs(current, selectedRefs, { refresh: true })
    if (!materialized.changed) return materialized
    const write = writeOpenclawConfigAtomic(materialized.config, { reason })
    readinessCache = null
    return { ...materialized, write }
  })

  // OpenClaw gateway hot-reloads config asynchronously. A short pause prevents
  // the immediate retry from racing the file watcher on slower customer VMs.
  if (result.changed) await sleep(1200)
  return result
}

function withPreparedCatalogFailureHint(result, prepared) {
  if (!prepared?.changed || result?.status !== 'model_not_found') return result
  return {
    ...result,
    safeMessage: 'เตรียม catalog ให้ OpenClaw แล้ว แต่ gateway ยังไม่โหลดค่าใหม่ กรุณา Restart Gateway แล้วทดสอบอีกครั้ง',
    catalogPrepared: true,
    preparedProviders: prepared.preparedProviders,
  }
}

// GET /api/model — อ่าน model ปัจจุบัน
router.get('/model', (req, res) => {
  try {
    const config = readOpenclawConfig()
    res.json({ model: config.agents?.defaults?.model?.primary || '' })
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT /api/model — เปลี่ยน model
router.put('/model', (req, res) => {
  try {
    const { model } = req.body
    if (!model) return res.status(400).json({ error: 'model required' })
    const config = readOpenclawConfig()
    if (!config.agents) config.agents = {}
    if (!config.agents.defaults) config.agents.defaults = {}
    if (!config.agents.defaults.model) config.agents.defaults.model = {}
    config.agents.defaults.model.primary = model
    writeOpenclawConfigAtomic(config)
    res.json({ ok: true })
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/models/catalog?provider=openrouter|anthropic|google|openai|mistral|groq|kilocode
router.get('/models/catalog', async (req, res) => {
  try {
    const config = readOpenclawConfig()
    const provider = req.query.provider || 'openrouter'
    const refresh = req.query.refresh === 'true' || req.query.refresh === '1'
    const catalog = await getModelCatalog({ provider, config, refresh })
    const httpStatus = catalog.status === 'unknown_provider' ? 400 : 200
    res.status(httpStatus).json(catalog)
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/models/readiness?refresh=false — resolved model/fallback/image readiness
router.get('/models/readiness', async (req, res) => {
  try {
    const config = readOpenclawConfig()
    const refresh = req.query.refresh === 'true' || req.query.refresh === '1'
    const readiness = await getCachedReadiness(config, { refresh })
    res.json(readiness)
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/models/runtime-test — run a bounded OpenClaw runtime inference smoke for one model
router.post('/models/runtime-test', async (req, res) => {
  try {
    const config = readOpenclawConfig()
    const { model, capability = 'text', mode = 'gateway', refresh = false } = req.body || {}
    if (!model || typeof model !== 'string') {
      return res.status(400).json({
        ok: false,
        status: 'model_not_found',
        error: 'model is required',
        safeMessage: 'กรุณาเลือก model ก่อนทดสอบ',
      })
    }
    if (!['text', 'image'].includes(String(capability))) {
      return res.status(400).json({
        ok: false,
        status: 'provider_error',
        error: 'capability must be text or image',
      })
    }
    if (String(mode) !== 'gateway') {
      return res.status(400).json({
        ok: false,
        status: 'provider_error',
        error: 'only gateway runtime tests are supported',
      })
    }
    const prepared = await prepareRuntimeCatalogsForRefs([model], { reason: 'model-runtime-test-catalog' })
    const result = await runModelRuntimeTest({
      model,
      capability,
      mode,
      config: prepared.config || config,
      refresh: Boolean(refresh),
    })
    res.json(withPreparedCatalogFailureHint({
      ...result,
      catalogPrepared: Boolean(prepared.changed),
      preparedProviders: prepared.preparedProviders || [],
    }, prepared))
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({
      ok: false,
      status: 'runtime_unavailable',
      error: 'Runtime test failed',
      safeMessage: 'OpenClaw runtime หรือ gateway ยังไม่พร้อมสำหรับทดสอบ model',
    })
  }
})

// POST /api/models/message-test — run an admin-supplied text prompt through selected runtime models
router.post('/models/message-test', async (req, res) => {
  try {
    const config = readOpenclawConfig()
    const { primary, fallbacks = [], prompt, capability = 'text' } = req.body || {}
    const primaryModel = String(primary || '').trim()
    const fallbackModels = Array.isArray(fallbacks)
      ? fallbacks.map(item => String(item || '').trim()).filter(Boolean)
      : []
    const testPrompt = String(prompt || '').trim()

    if (String(capability) !== 'text') {
      return res.status(400).json({
        ok: false,
        status: 'provider_error',
        selectedModel: null,
        durationMs: 0,
        safeMessage: 'Message test รองรับข้อความเท่านั้น',
        attempts: [],
      })
    }
    if (!primaryModel) {
      return res.status(400).json({
        ok: false,
        status: 'model_not_found',
        selectedModel: null,
        durationMs: 0,
        safeMessage: 'กรุณาเลือก Model หลักก่อนทดสอบ',
        attempts: [],
      })
    }
    if (!testPrompt) {
      return res.status(400).json({
        ok: false,
        status: 'invalid_output',
        selectedModel: null,
        durationMs: 0,
        safeMessage: 'กรุณาพิมพ์ข้อความทดสอบก่อน',
        attempts: [],
      })
    }

    const models = [primaryModel, ...fallbackModels]
      .filter((item, index, arr) => item && arr.indexOf(item) === index)
    const prepared = await prepareRuntimeCatalogsForRefs(models, { reason: 'model-message-test-catalog' })
    const startedAt = Date.now()
    const attempts = []

    for (const model of models) {
      const result = await runModelMessageTest({
        model,
        prompt: testPrompt,
        capability: 'text',
        mode: 'gateway',
        config: prepared.config || config,
      })
      attempts.push({
        model,
        ok: result.ok,
        status: result.ok ? 'ok' : result.status,
        durationMs: result.durationMs,
        safeMessage: withPreparedCatalogFailureHint(result, prepared).safeMessage || result.summary,
        outputPreview: result.outputPreview || null,
        runtimeVersion: result.runtimeVersion || null,
      })
    }

    const failed = attempts.find(item => !item.ok)
    const primaryAttempt = attempts[0]
    const totalDurationMs = Date.now() - startedAt
    if (failed || !primaryAttempt?.ok) {
      return res.json({
        ok: false,
        status: failed?.status || 'provider_error',
        selectedModel: primaryAttempt?.ok ? primaryAttempt.model : null,
        durationMs: totalDurationMs,
        safeMessage: failed?.safeMessage || 'ทดสอบ model ไม่ผ่าน',
        outputPreview: primaryAttempt?.outputPreview || null,
        attempts,
        catalogPrepared: Boolean(prepared.changed),
        preparedProviders: prepared.preparedProviders || [],
      })
    }

    res.json({
      ok: true,
      status: 'ok',
      selectedModel: primaryAttempt.model,
      durationMs: totalDurationMs,
      outputPreview: primaryAttempt.outputPreview || null,
      attempts,
      catalogPrepared: Boolean(prepared.changed),
      preparedProviders: prepared.preparedProviders || [],
      safeMessage: models.length > 1
        ? 'Model หลักและ Model สำรองที่เลือกไว้ทดสอบผ่าน'
        : 'Model หลักทดสอบผ่าน',
    })
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({
      ok: false,
      status: 'runtime_unavailable',
      selectedModel: null,
      durationMs: 0,
      safeMessage: 'OpenClaw runtime หรือ gateway ยังไม่พร้อมสำหรับทดสอบ model',
      attempts: [],
    })
  }
})

// POST /api/models/image-message-test — run an admin-uploaded image prompt through an image runtime model
router.post('/models/image-message-test', async (req, res) => {
  try {
    const config = readOpenclawConfig()
    const { model, prompt, image } = req.body || {}
    const modelRef = String(model || '').trim()
    const testPrompt = String(prompt || '').trim()

    if (!modelRef) {
      return res.status(400).json({
        ok: false,
        status: 'model_not_found',
        model: modelRef,
        capability: 'image',
        mode: 'gateway',
        runtimeVersion: 'unknown',
        durationMs: 0,
        safeMessage: 'กรุณาเลือก Model รูปภาพก่อนทดสอบ',
      })
    }
    if (!testPrompt) {
      return res.status(400).json({
        ok: false,
        status: 'invalid_output',
        model: modelRef,
        capability: 'image',
        mode: 'gateway',
        runtimeVersion: 'unknown',
        durationMs: 0,
        safeMessage: 'กรุณาพิมพ์ข้อความทดสอบรูปภาพก่อน',
      })
    }
    if (!image || typeof image !== 'object') {
      return res.status(400).json({
        ok: false,
        status: 'invalid_output',
        model: modelRef,
        capability: 'image',
        mode: 'gateway',
        runtimeVersion: 'unknown',
        durationMs: 0,
        safeMessage: 'กรุณาอัปโหลดรูปภาพก่อนทดสอบ',
      })
    }

    const prepared = await prepareRuntimeCatalogsForRefs([modelRef], { reason: 'model-image-test-catalog' })
    const result = await runModelImageMessageTest({
      model: modelRef,
      prompt: testPrompt,
      image,
      capability: 'image',
      mode: 'gateway',
      config: prepared.config || config,
    })
    res.json(withPreparedCatalogFailureHint({
      ...result,
      catalogPrepared: Boolean(prepared.changed),
      preparedProviders: prepared.preparedProviders || [],
    }, prepared))
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({
      ok: false,
      status: 'runtime_unavailable',
      model: String(req.body?.model || ''),
      capability: 'image',
      mode: 'gateway',
      runtimeVersion: 'unknown',
      durationMs: 0,
      safeMessage: 'OpenClaw runtime หรือ gateway ยังไม่พร้อมสำหรับทดสอบ model รูปภาพ',
    })
  }
})

// PUT /api/models/settings — validate and save primary/fallback/image model config
router.put('/models/settings', async (req, res) => {
  try {
    const validateOnly = req.query.validateOnly === 'true' || req.query.validateOnly === '1'
    const allowRuntimeOverride = req.query.allowRuntimeOverride === 'true'
      || req.query.allowRuntimeOverride === '1'
      || req.body?.allowRuntimeOverride === true
    const actorRole = String(req.headers['x-openclaw-admin-role'] || '')
    if (allowRuntimeOverride && actorRole !== 'superadmin') {
      return res.status(403).json({
        ok: false,
        error: 'Runtime verification override requires superadmin',
      })
    }
    const result = await withConfigLock(async () => {
      const config = readOpenclawConfig()
      const nextConfig = applyModelSettings(config, req.body || {})
      const materialized = await materializeSelectedProviderCatalogs(nextConfig, { refresh: true })
      const effectiveConfig = materialized.config
      const readiness = await getModelReadinessForConfig(effectiveConfig, { refresh: true })
      const runtimeIssues = collectRuntimeVerificationIssues(readiness)
      const hash = configHash(effectiveConfig)
      const cachedReadiness = {
        ...readiness,
        cache: { hit: false, ttlSeconds: READINESS_TTL_MS / 1000 },
      }

      if (readiness.blockingIssues.length) {
        const err = new Error('Model settings are not ready')
        err.statusCode = 400
        err.payload = {
          ok: false,
          error: err.message,
          blockingIssues: readiness.blockingIssues,
          readiness: cachedReadiness,
        }
        throw err
      }

      if (runtimeIssues.length && !allowRuntimeOverride) {
        const err = new Error('Runtime model tests must pass before saving')
        err.statusCode = 400
        err.payload = {
          ok: false,
          error: err.message,
          blockingIssues: runtimeIssues,
          readiness: cachedReadiness,
        }
        throw err
      }

      if (validateOnly) {
        return {
          ok: true,
          validateOnly: true,
          runtimeOverride: Boolean(runtimeIssues.length && allowRuntimeOverride),
          readiness: cachedReadiness,
        }
      }

      const write = writeOpenclawConfigAtomic(effectiveConfig, {
        reason: allowRuntimeOverride && runtimeIssues.length ? 'model-settings-runtime-override' : 'model-settings',
      })
      readinessCache = { hash, createdAt: Date.now(), data: cachedReadiness }
      return {
        ok: true,
        runtimeOverride: Boolean(runtimeIssues.length && allowRuntimeOverride),
        preparedProviders: materialized.preparedProviders || [],
        materializeWarnings: materialized.warnings || [],
        write,
        readiness: cachedReadiness,
      }
    })
    res.json(result)
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(e.statusCode || 400).json(e.payload || { error: e.message || 'Invalid model settings' })
  }
})

// GET /api/models?provider=X — legacy array response for existing Admin callers
router.get('/models', async (req, res) => {
  try {
    const config = readOpenclawConfig()
    const provider = req.query.provider || 'openrouter'
    const refresh = req.query.refresh === 'true' || req.query.refresh === '1'
    const catalog = await getModelCatalog({ provider, config, refresh })
    if (catalog.status === 'unknown_provider') return res.status(400).json({ error: catalog.summary })
    res.setHeader('X-Model-Catalog-Status', catalog.status)
    res.setHeader('X-Model-Catalog-Source', catalog.source)
    res.json(catalog.models || [])
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/models/test — ทดสอบ API key ฝั่ง server (แก้ปัญหา CORS)
router.post('/models/test', async (req, res) => {
  const { provider, apiKey } = req.body || {}
  try {
    let url, headers = {}

    if (provider === 'openrouter') {
      url = 'https://openrouter.ai/api/v1/models'
      headers = { 'Authorization': `Bearer ${apiKey}` }
    } else if (provider === 'anthropic') {
      url = 'https://api.anthropic.com/v1/models'
      headers = { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
    } else if (provider === 'anthropic-oauth') {
      // OAuth token (sk-ant-oat...) ต้องใช้ Bearer + beta headers เหมือน Claude Code
      url = 'https://api.anthropic.com/v1/models'
      headers = {
        'Authorization': `Bearer ${apiKey}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
        'user-agent': 'claude-cli/2.1.75',
        'x-app': 'cli',
      }
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
    console.error('[openclaw-api]', req.method, req.path, e.message)
    const msg = e.name === 'TimeoutError' ? 'Request timed out' : 'Connection failed'
    res.json({ ok: false, error: msg })
  }
})

module.exports = router
