const { getModelCatalog, PROVIDERS } = require('./model-catalog')
const { runtimeStatusForRef } = require('./model-runtime-test')

const READY = 'ready'
const OPTIONAL_MISSING = 'not_configured'
const BLOCKING_STATUSES = new Set([
  'missing_key',
  'auth_error',
  'provider_error',
  'timeout',
  'unknown_provider',
  'model_not_found',
  'not_image_capable',
  'capability_unknown',
])

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function providerForRef(ref) {
  const raw = String(ref || '').trim()
  const slash = raw.indexOf('/')
  if (slash <= 0) return null
  const providerId = raw.slice(0, slash).toLowerCase()
  const provider = PROVIDERS[providerId]
  if (!provider) return null
  return { provider, modelId: raw.slice(slash + 1), ref: raw }
}

function normalizeModelConfig(value) {
  if (!value) return { primary: '', fallbacks: [], timeoutMs: undefined, configured: false }
  if (typeof value === 'string') {
    return { primary: value.trim(), fallbacks: [], timeoutMs: undefined, configured: Boolean(value.trim()) }
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    const primary = String(value.primary || '').trim()
    const fallbacks = Array.isArray(value.fallbacks)
      ? value.fallbacks.map(item => String(item || '').trim()).filter(Boolean)
      : []
    const timeoutMs = Number.isFinite(Number(value.timeoutMs)) ? Number(value.timeoutMs) : undefined
    return { primary, fallbacks, timeoutMs, configured: Boolean(primary || fallbacks.length || timeoutMs) }
  }
  return { primary: '', fallbacks: [], timeoutMs: undefined, configured: false }
}

function normalizeInputModelConfig(value, { field, allowNull = true } = {}) {
  if (value === null) {
    if (allowNull) return null
    throw new Error(`${field || 'model'} cannot be null`)
  }
  if (typeof value === 'string') {
    const primary = value.trim()
    if (!primary) throw new Error(`${field || 'model'}.primary is required`)
    return { primary, fallbacks: [] }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field || 'model'} must be a string, object, or null`)
  }
  const primary = String(value.primary || '').trim()
  const fallbacks = Array.isArray(value.fallbacks)
    ? value.fallbacks.map(item => String(item || '').trim()).filter(Boolean)
    : []
  const next = { primary, fallbacks }
  if (!primary) throw new Error(`${field || 'model'}.primary is required`)
  if (fallbacks.includes(primary)) {
    throw new Error(`${field || 'model'}.fallbacks must not include the primary model`)
  }
  const seen = new Set()
  for (const fallback of fallbacks) {
    if (seen.has(fallback)) {
      throw new Error(`${field || 'model'}.fallbacks contains duplicate model: ${fallback}`)
    }
    seen.add(fallback)
  }
  if (value.timeoutMs !== undefined && value.timeoutMs !== null && value.timeoutMs !== '') {
    const timeoutMs = Number(value.timeoutMs)
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 180000) {
      throw new Error(`${field || 'model'}.timeoutMs must be between 1000 and 180000`)
    }
    next.timeoutMs = Math.round(timeoutMs)
  }
  return next
}

function modelHasImageCapability(model) {
  const caps = model?.capabilities || {}
  const inputModalities = caps.inputModalities || caps.input_modalities || model?.input || model?.inputModalities
  if (Array.isArray(inputModalities)) {
    return inputModalities.map(item => String(item).toLowerCase()).includes('image')
  }
  return null
}

function findModel(catalog, providerId, modelId) {
  const wanted = String(modelId || '').trim()
  return (catalog.models || []).find(model => (
    model.id === wanted ||
    `${providerId}/${model.id}` === wanted ||
    `${providerId}/${model.id}` === `${providerId}/${wanted}`
  )) || null
}

function makeRefStatus(ref, role, status, summary, extra = {}) {
  return {
    ref: ref || '',
    role,
    status,
    summary,
    provider: extra.provider || null,
    modelId: extra.modelId || null,
    source: extra.source || null,
    catalogStatus: extra.catalogStatus || null,
    capability: extra.capability || null,
    keyStatus: extra.keyStatus || null,
    runtimeStatus: extra.runtimeStatus || null,
    runtimeSummary: extra.runtimeSummary || null,
    runtimeTestedAt: extra.runtimeTestedAt || null,
    runtimeDurationMs: extra.runtimeDurationMs || null,
    runtimeVersion: extra.runtimeVersion || null,
    configured: Boolean(ref),
  }
}

async function evaluateModelRef(ref, { role = 'primary', image = false, loadCatalog, config = {} }) {
  const raw = String(ref || '').trim()
  const runtime = runtimeStatusForRef(raw, { capability: image ? 'image' : 'text', config })
  if (!raw) {
    return makeRefStatus('', role, OPTIONAL_MISSING, 'No model configured', { capability: image ? 'image' : 'text', ...runtime })
  }

  const parsed = providerForRef(raw)
  if (!parsed) {
    return makeRefStatus(raw, role, 'model_not_found', 'Model ref must use provider/model format', {
      capability: image ? 'image' : 'text',
      ...runtime,
    })
  }

  const catalog = await loadCatalog(parsed.provider.id)
  if (catalog.status !== READY) {
    return makeRefStatus(raw, role, catalog.status, catalog.summary || `${parsed.provider.label} catalog is not ready`, {
      provider: parsed.provider.id,
      modelId: parsed.modelId,
      source: catalog.source,
      catalogStatus: catalog.status,
      capability: image ? 'image' : 'text',
      keyStatus: catalog.status,
      ...runtime,
    })
  }

  const model = findModel(catalog, parsed.provider.id, parsed.modelId)
  if (!model) {
    return makeRefStatus(raw, role, 'model_not_found', `${raw} is not present in ${parsed.provider.label} catalog`, {
      provider: parsed.provider.id,
      modelId: parsed.modelId,
      source: catalog.source,
      catalogStatus: catalog.status,
      capability: image ? 'image' : 'text',
      keyStatus: 'ready',
      ...runtime,
    })
  }

  if (image) {
    const supportsImage = modelHasImageCapability(model)
    if (supportsImage === false) {
      return makeRefStatus(raw, role, 'not_image_capable', `${raw} does not advertise image input support`, {
        provider: parsed.provider.id,
        modelId: parsed.modelId,
        source: catalog.source,
        catalogStatus: catalog.status,
        capability: 'image',
        keyStatus: 'ready',
        ...runtime,
      })
    }
    if (supportsImage === null) {
      return makeRefStatus(raw, role, 'capability_unknown', `${raw} has no image capability metadata`, {
        provider: parsed.provider.id,
        modelId: parsed.modelId,
        source: catalog.source,
        catalogStatus: catalog.status,
        capability: 'image',
        keyStatus: 'ready',
        ...runtime,
      })
    }
  }

  return makeRefStatus(raw, role, READY, `${raw} is ready`, {
    provider: parsed.provider.id,
    modelId: parsed.modelId,
    source: catalog.source,
    catalogStatus: catalog.status,
    capability: image ? 'image' : 'text',
    keyStatus: 'ready',
    ...runtime,
  })
}

async function evaluateModelConfig(value, { loadCatalog, image = false, config = {} } = {}) {
  const chain = normalizeModelConfig(value)
  const primary = await evaluateModelRef(chain.primary, { role: 'primary', image, loadCatalog, config })
  const fallbacks = await Promise.all(chain.fallbacks.map((ref, index) => (
    evaluateModelRef(ref, { role: `fallback.${index + 1}`, image, loadCatalog, config })
  )))
  return {
    primary,
    fallbacks,
    timeoutMs: chain.timeoutMs ?? null,
    configured: chain.configured,
  }
}

function agentUsesImageTool(agent) {
  const allow = agent?.tools?.allow
  return Array.isArray(allow) && allow.includes('image')
}

function collectProviderStatuses(catalogs) {
  return Object.fromEntries([...catalogs.entries()].map(([provider, catalog]) => [provider, {
    status: catalog.status,
    source: catalog.source,
    cache: catalog.cache,
    modelCount: Array.isArray(catalog.models) ? catalog.models.length : 0,
    warnings: catalog.warnings || [],
    summary: catalog.summary || '',
  }]))
}

function collectBlockingIssues(readiness) {
  const issues = []
  const pushRef = (scope, item) => {
    if (!item?.configured) return
    if (!BLOCKING_STATUSES.has(item.status)) return
    issues.push({
      scope,
      ref: item.ref,
      status: item.status,
      summary: item.summary,
      capability: item.capability,
    })
  }

  pushRef('defaults.model.primary', readiness.defaults.model.primary)
  readiness.defaults.model.fallbacks.forEach((item, index) => pushRef(`defaults.model.fallbacks.${index}`, item))
  pushRef('defaults.imageModel.primary', readiness.defaults.imageModel.primary)
  readiness.defaults.imageModel.fallbacks.forEach((item, index) => pushRef(`defaults.imageModel.fallbacks.${index}`, item))

  for (const agent of readiness.agents) {
    if (agent.modelSource === 'agent') {
      pushRef(`agents.${agent.id}.model.primary`, agent.model.primary)
      agent.model.fallbacks.forEach((item, index) => pushRef(`agents.${agent.id}.model.fallbacks.${index}`, item))
    }
    if (agent.imageModelSource === 'agent') {
      pushRef(`agents.${agent.id}.imageModel.primary`, agent.imageModel.primary)
      agent.imageModel.fallbacks.forEach((item, index) => pushRef(`agents.${agent.id}.imageModel.fallbacks.${index}`, item))
    }
  }

  return issues
}

function collectRuntimeVerificationIssues(readiness) {
  const issues = []
  const pushRef = (scope, item) => {
    if (!item?.configured) return
    if (item.status !== READY) return
    if (item.runtimeStatus === 'runtime_verified') return
    issues.push({
      scope,
      ref: item.ref,
      status: item.runtimeStatus || 'runtime_unverified',
      summary: item.runtimeSummary || 'Runtime test has not passed for this model',
      capability: item.capability,
    })
  }

  pushRef('defaults.model.primary', readiness.defaults.model.primary)
  readiness.defaults.model.fallbacks.forEach((item, index) => pushRef(`defaults.model.fallbacks.${index}`, item))
  pushRef('defaults.imageModel.primary', readiness.defaults.imageModel.primary)
  readiness.defaults.imageModel.fallbacks.forEach((item, index) => pushRef(`defaults.imageModel.fallbacks.${index}`, item))

  for (const agent of readiness.agents) {
    if (agent.modelSource === 'agent') {
      pushRef(`agents.${agent.id}.model.primary`, agent.model.primary)
      agent.model.fallbacks.forEach((item, index) => pushRef(`agents.${agent.id}.model.fallbacks.${index}`, item))
    }
    if (agent.imageModelSource === 'agent') {
      pushRef(`agents.${agent.id}.imageModel.primary`, agent.imageModel.primary)
      agent.imageModel.fallbacks.forEach((item, index) => pushRef(`agents.${agent.id}.imageModel.fallbacks.${index}`, item))
    }
  }

  return issues
}

function collectWarnings(readiness) {
  const warnings = []
  const defaultFallbacks = readiness.defaults.model.fallbacks || []
  if (readiness.defaults.model.primary.status !== READY) {
    warnings.push({
      id: 'model.primary',
      status: readiness.defaults.model.primary.status,
      summary: readiness.defaults.model.primary.summary,
    })
  }
  if (defaultFallbacks.length === 0) {
    warnings.push({
      id: 'model.fallbacks.empty',
      status: 'warn',
      summary: 'No default fallback model configured',
    })
  }
  for (const agent of readiness.agents) {
    if (agent.usesImageTool && !agent.imageModel.configured) {
      warnings.push({
        id: `model.image.${agent.id}.missing`,
        status: 'warn',
        summary: `${agent.id} uses image tool but has no imageModel configured`,
      })
    } else if (agent.usesImageTool && agent.imageModel.primary.status !== READY) {
      warnings.push({
        id: `model.image.${agent.id}.${agent.imageModel.primary.status}`,
        status: agent.imageModel.primary.status,
        summary: agent.imageModel.primary.summary,
      })
    }
  }
  const runtimeIssues = collectRuntimeVerificationIssues(readiness)
  for (const issue of runtimeIssues.slice(0, 8)) {
    warnings.push({
      id: `model.runtime.${issue.scope}`,
      status: issue.status,
      summary: `${issue.ref}: ${issue.summary}`,
    })
  }
  return warnings
}

async function getModelReadinessForConfig(config, opts = {}) {
  const catalogs = new Map()
  const catalogLoader = opts.getModelCatalog || getModelCatalog
  const loadCatalog = async (provider) => {
    if (!catalogs.has(provider)) {
      catalogs.set(provider, await catalogLoader({
        provider,
        config,
        refresh: Boolean(opts.refresh),
        timeoutMs: opts.timeoutMs,
      }))
    }
    return catalogs.get(provider)
  }

  const defaults = config?.agents?.defaults || {}
  const defaultModel = await evaluateModelConfig(defaults.model, { loadCatalog, config })
  const defaultImageModel = await evaluateModelConfig(defaults.imageModel, { loadCatalog, image: true, config })

  const agents = await Promise.all((config?.agents?.list || []).map(async (agent) => {
    const hasAgentModel = Object.prototype.hasOwnProperty.call(agent, 'model') && agent.model != null
    const hasAgentImageModel = Object.prototype.hasOwnProperty.call(agent, 'imageModel') && agent.imageModel != null
    const model = await evaluateModelConfig(hasAgentModel ? agent.model : defaults.model, { loadCatalog, config })
    const imageModel = await evaluateModelConfig(hasAgentImageModel ? agent.imageModel : defaults.imageModel, { loadCatalog, image: true, config })
    return {
      id: agent.id,
      modelSource: hasAgentModel ? 'agent' : 'defaults',
      imageModelSource: hasAgentImageModel ? 'agent' : 'defaults',
      usesImageTool: agentUsesImageTool(agent),
      model,
      imageModel,
    }
  }))

  const readiness = {
    ok: true,
    generatedAt: new Date().toISOString(),
    cache: { hit: false, ttlSeconds: 300 },
    defaults: {
      model: defaultModel,
      imageModel: defaultImageModel,
    },
    agents,
    providers: collectProviderStatuses(catalogs),
    warnings: [],
    blockingIssues: [],
    runtimeVerificationIssues: [],
  }
  readiness.blockingIssues = collectBlockingIssues(readiness)
  readiness.runtimeVerificationIssues = collectRuntimeVerificationIssues(readiness)
  readiness.warnings = collectWarnings(readiness)
  readiness.ok = readiness.blockingIssues.length === 0
  return readiness
}

function applyModelSettings(config, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('settings body must be a JSON object')
  }
  const next = clone(config || {})
  if (!next.agents) next.agents = {}
  if (!next.agents.defaults) next.agents.defaults = {}
  if (!Array.isArray(next.agents.list)) next.agents.list = []

  if (body.defaults && typeof body.defaults === 'object' && !Array.isArray(body.defaults)) {
    if (Object.prototype.hasOwnProperty.call(body.defaults, 'model')) {
      const model = normalizeInputModelConfig(body.defaults.model, { field: 'defaults.model' })
      if (model === null) delete next.agents.defaults.model
      else next.agents.defaults.model = model
    }
    if (Object.prototype.hasOwnProperty.call(body.defaults, 'imageModel')) {
      const imageModel = normalizeInputModelConfig(body.defaults.imageModel, { field: 'defaults.imageModel' })
      if (imageModel === null) delete next.agents.defaults.imageModel
      else next.agents.defaults.imageModel = imageModel
    }
  }

  if (body.agents !== undefined) {
    if (!body.agents || typeof body.agents !== 'object' || Array.isArray(body.agents)) {
      throw new Error('agents must be an object keyed by agent id')
    }
    const byId = new Map(next.agents.list.map(agent => [agent.id, agent]))
    for (const [agentId, changes] of Object.entries(body.agents)) {
      if (!byId.has(agentId)) throw new Error(`Unknown agent: ${agentId}`)
      if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
        throw new Error(`agents.${agentId} must be an object`)
      }
      const agent = byId.get(agentId)
      if (Object.prototype.hasOwnProperty.call(changes, 'model')) {
        const model = normalizeInputModelConfig(changes.model, { field: `agents.${agentId}.model` })
        if (model === null) delete agent.model
        else agent.model = model
      }
      if (Object.prototype.hasOwnProperty.call(changes, 'imageModel')) {
        const imageModel = normalizeInputModelConfig(changes.imageModel, { field: `agents.${agentId}.imageModel` })
        if (imageModel === null) delete agent.imageModel
        else agent.imageModel = imageModel
      }
    }
  }

  return next
}

module.exports = {
  BLOCKING_STATUSES,
  applyModelSettings,
  collectBlockingIssues,
  collectRuntimeVerificationIssues,
  getModelReadinessForConfig,
  modelHasImageCapability,
  normalizeModelConfig,
  normalizeInputModelConfig,
  providerForRef,
  _internal: {
    evaluateModelRef,
    modelHasImageCapability,
  },
}
