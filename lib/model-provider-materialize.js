const { getModelCatalog, PROVIDERS } = require('./model-catalog')

const PROVIDER_RUNTIME_DEFAULTS = {
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    api: 'openai-completions',
    envKey: 'OPENROUTER_API_KEY',
    defaultContextWindow: 128000,
    defaultMaxTokens: 8192,
  },
  kilocode: {
    baseUrl: 'https://api.kilo.ai/api/gateway/',
    api: 'openai-completions',
    envKey: 'KILOCODE_API_KEY',
    defaultContextWindow: 200000,
    defaultMaxTokens: 128000,
  },
  'ollama-cloud': {
    baseUrl: 'https://ollama.com',
    api: 'ollama',
    envKey: 'OLLAMA_API_KEY',
    defaultContextWindow: 128000,
    defaultMaxTokens: 8192,
  },
}

const MODEL_INPUTS = new Set(['text', 'image'])

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function parseModelRef(ref) {
  const raw = String(ref || '').trim()
  const slash = raw.indexOf('/')
  if (slash <= 0) return null
  const providerId = raw.slice(0, slash).toLowerCase()
  const modelId = raw.slice(slash + 1).trim()
  if (!providerId || !modelId || !PROVIDERS[providerId]) return null
  return { providerId, modelId, ref: raw }
}

function collectModelRefsFromConfig(config = {}) {
  const refs = []
  const pushConfig = value => {
    if (!value) return
    if (typeof value === 'string') {
      refs.push(value)
      return
    }
    if (typeof value !== 'object' || Array.isArray(value)) return
    if (value.primary) refs.push(value.primary)
    if (Array.isArray(value.fallbacks)) refs.push(...value.fallbacks)
  }

  pushConfig(config.agents?.defaults?.model)
  pushConfig(config.agents?.defaults?.imageModel)
  for (const agent of config.agents?.list || []) {
    pushConfig(agent?.model)
    pushConfig(agent?.imageModel)
  }
  return refs
}

function normalizeNumber(value, fallback = 0) {
  const num = Number(value)
  return Number.isFinite(num) && num >= 0 ? num : fallback
}

function pricePerMillion(value) {
  if (value === undefined || value === null || value === '') return 0
  const num = Number(value)
  if (!Number.isFinite(num) || num < 0) return 0
  return num > 0 && num < 0.01 ? num * 1_000_000 : num
}

function normalizeInputModality(value) {
  const item = String(value || '').toLowerCase().trim()
  if (item === 'images' || item === 'vision') return 'image'
  if (item === 'messages' || item === 'prompt') return 'text'
  return item
}

function inputModalitiesForModel(model) {
  const caps = model?.capabilities || {}
  const raw = caps.inputModalities || caps.input_modalities || model.input || model.inputModalities
  const items = Array.isArray(raw) ? raw : ['text']
  // OpenClaw runtime catalog schema currently accepts stable text/image inputs.
  // Providers such as Kilo may advertise audio/video/tool/file inputs; passing
  // those through makes the generated runtime catalog fail schema validation.
  const normalized = items
    .map(normalizeInputModality)
    .filter(item => MODEL_INPUTS.has(item))
  return normalized.length ? [...new Set(normalized)] : ['text']
}

function supportedParametersForModel(model) {
  const caps = model?.capabilities || {}
  const params = caps.supportedParameters || caps.supported_parameters || model.supported_parameters
  return Array.isArray(params) ? params.map(item => String(item || '').trim()).filter(Boolean) : []
}

function toModelDefinition(model, providerId) {
  const defaults = PROVIDER_RUNTIME_DEFAULTS[providerId] || {}
  const pricing = model?.pricing || {}
  const supportedParameters = supportedParametersForModel(model)
  const contextWindow = normalizeNumber(
    model?.contextLength || model?.context_window || model?.contextWindow,
    defaults.defaultContextWindow || 200000,
  )
  return {
    id: String(model.id || '').trim(),
    name: String(model.name || model.id || '').trim(),
    reasoning: supportedParameters.includes('reasoning') || supportedParameters.includes('include_reasoning'),
    input: inputModalitiesForModel(model),
    cost: {
      input: pricePerMillion(pricing.prompt ?? pricing.input),
      output: pricePerMillion(pricing.completion ?? pricing.output),
      cacheRead: pricePerMillion(pricing.input_cache_read ?? pricing.cacheRead),
      cacheWrite: pricePerMillion(pricing.input_cache_write ?? pricing.cacheWrite),
    },
    contextWindow,
    maxTokens: normalizeNumber(
      model?.capabilities?.maxCompletionTokens || model?.maxTokens || model?.max_tokens,
      defaults.defaultMaxTokens || contextWindow,
    ),
  }
}

function providerCatalogModel(config, providerId, modelId) {
  const models = config?.models?.providers?.[providerId]?.models
  return Array.isArray(models) ? models.find(model => model?.id === modelId) : null
}

function providerNeedsCatalogRefresh(config, ref, capability) {
  const existing = providerCatalogModel(config, ref.providerId, ref.modelId)
  if (!existing) return true
  if (capability === 'image') {
    return !inputModalitiesForModel(existing).includes('image')
  }
  return false
}

function sanitizeExistingProviderModelInputs(config) {
  const providers = config?.models?.providers
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return false

  let changed = false
  for (const providerId of Object.keys(PROVIDER_RUNTIME_DEFAULTS)) {
    const provider = providers[providerId]
    if (!provider || typeof provider !== 'object' || Array.isArray(provider) || !Array.isArray(provider.models)) continue

    let providerChanged = false
    const models = provider.models.map(model => {
      if (!model || typeof model !== 'object' || Array.isArray(model)) return model
      const input = inputModalitiesForModel(model)
      const current = Array.isArray(model.input) ? model.input : []
      const isSame = current.length === input.length && current.every((item, index) => item === input[index])
      if (isSame) return model
      providerChanged = true
      return { ...model, input }
    })

    if (providerChanged) {
      providers[providerId] = { ...provider, models }
      changed = true
    }
  }

  return changed
}

function envKeyIsAvailable(config, envKey) {
  if (!envKey) return false
  if (typeof config?.env?.[envKey] === 'string' && config.env[envKey].trim()) return true
  if (typeof config?.env?.vars?.[envKey] === 'string' && config.env.vars[envKey].trim()) return true
  return Boolean(process.env[envKey]?.trim())
}

function secretRefForEnv(envKey) {
  return { source: 'env', provider: 'default', id: envKey }
}

function mergeModelDefinitions(existingModels = [], nextModels = []) {
  const byId = new Map()
  for (const model of existingModels) {
    if (model?.id) byId.set(model.id, model)
  }
  for (const model of nextModels) {
    if (!model?.id) continue
    const existing = byId.get(model.id) || {}
    byId.set(model.id, { ...existing, ...model })
  }
  return [...byId.values()].sort((left, right) => String(left.id).localeCompare(String(right.id)))
}

function defaultProviderModelsForRefs(providerId, refs = []) {
  if (providerId !== 'kilocode') return []
  const wantsKiloAuto = refs.some(ref => ref.providerId === 'kilocode' && ref.modelId === 'kilo/auto')
  if (!wantsKiloAuto) return []
  return [{
    id: 'kilo/auto',
    name: 'Kilo Auto',
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000000,
    maxTokens: 128000,
  }]
}

async function materializeProviderCatalogsForRefs(config, refs, opts = {}) {
  const next = clone(config || {})
  const sanitizedExisting = sanitizeExistingProviderModelInputs(next)
  const parsedRefs = [...new Map(
    (refs || [])
      .map(parseModelRef)
      .filter(Boolean)
      .map(ref => [`${ref.providerId}/${ref.modelId}`, ref]),
  ).values()]
  const providersToPrepare = [...new Set(parsedRefs
    .filter(ref => PROVIDER_RUNTIME_DEFAULTS[ref.providerId])
    .filter(ref => providerNeedsCatalogRefresh(next, ref, opts.capability))
    .map(ref => ref.providerId))]

  if (providersToPrepare.length === 0) {
    return { changed: sanitizedExisting, config: next, preparedProviders: [], warnings: [] }
  }

  const preparedProviders = []
  const warnings = []
  next.models = next.models && typeof next.models === 'object' && !Array.isArray(next.models)
    ? { ...next.models }
    : {}
  next.models.providers = next.models.providers && typeof next.models.providers === 'object' && !Array.isArray(next.models.providers)
    ? { ...next.models.providers }
    : {}

  for (const providerId of providersToPrepare) {
    const defaults = PROVIDER_RUNTIME_DEFAULTS[providerId]
    const catalog = await (opts.getModelCatalog || getModelCatalog)({
      provider: providerId,
      config: next,
      refresh: Boolean(opts.refresh),
      timeoutMs: opts.timeoutMs,
    })
    if (catalog.status !== 'ready' || !Array.isArray(catalog.models) || catalog.models.length === 0) {
      warnings.push({
        provider: providerId,
        status: catalog.status,
        summary: catalog.summary || 'Provider catalog is not ready',
      })
      continue
    }

    const existing = next.models.providers[providerId] || {}
    const modelDefinitions = catalog.models
      .map(model => toModelDefinition(model, providerId))
      .filter(model => model.id && model.name)
    const fallbackDefinitions = defaultProviderModelsForRefs(providerId, parsedRefs)

    const providerConfig = {
      ...defaults,
      ...existing,
      models: mergeModelDefinitions(existing.models, [...fallbackDefinitions, ...modelDefinitions]),
    }
    if (providerId === 'ollama-cloud') {
      providerConfig.baseUrl = defaults.baseUrl
      providerConfig.api = defaults.api
      delete providerConfig.baseURL
    }
    if (!providerConfig.apiKey && envKeyIsAvailable(next, defaults.envKey)) {
      providerConfig.apiKey = secretRefForEnv(defaults.envKey)
    }
    delete providerConfig.envKey
    delete providerConfig.defaultContextWindow
    delete providerConfig.defaultMaxTokens
    next.models.providers[providerId] = providerConfig
    preparedProviders.push({
      provider: providerId,
      modelCount: providerConfig.models.length,
    })
  }

  return {
    changed: sanitizedExisting || preparedProviders.length > 0,
    config: next,
    preparedProviders,
    warnings,
  }
}

async function materializeSelectedProviderCatalogs(config, opts = {}) {
  return materializeProviderCatalogsForRefs(config, collectModelRefsFromConfig(config), opts)
}

module.exports = {
  PROVIDER_RUNTIME_DEFAULTS,
  collectModelRefsFromConfig,
  materializeProviderCatalogsForRefs,
  materializeSelectedProviderCatalogs,
  _internal: {
    defaultProviderModelsForRefs,
    providerCatalogModel,
    providerNeedsCatalogRefresh,
    inputModalitiesForModel,
    normalizeInputModality,
    parseModelRef,
    pricePerMillion,
    sanitizeExistingProviderModelInputs,
    toModelDefinition,
  },
}
