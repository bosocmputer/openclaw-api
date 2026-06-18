const crypto = require('crypto')

const DEFAULT_TTL_SECONDS = 300
const DEFAULT_TIMEOUT_MS = 8000

const PROVIDERS = {
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    envKey: 'OPENROUTER_API_KEY',
    requiresKeyForCatalog: true,
  },
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic',
    envKey: 'ANTHROPIC_API_KEY',
    requiresKeyForCatalog: true,
  },
  google: {
    id: 'google',
    label: 'Google Gemini',
    envKey: 'GEMINI_API_KEY',
    requiresKeyForCatalog: true,
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    envKey: 'OPENAI_API_KEY',
    requiresKeyForCatalog: true,
  },
  mistral: {
    id: 'mistral',
    label: 'Mistral',
    envKey: 'MISTRAL_API_KEY',
    requiresKeyForCatalog: true,
  },
  groq: {
    id: 'groq',
    label: 'Groq',
    envKey: 'GROQ_API_KEY',
    requiresKeyForCatalog: true,
  },
  kilocode: {
    id: 'kilocode',
    label: 'Kilo AI',
    envKey: 'KILOCODE_API_KEY',
    requiresKeyForCatalog: false,
    requiresKeyForInference: true,
  },
}

const catalogCache = new Map()

function providerFor(value) {
  return PROVIDERS[String(value || 'openrouter').toLowerCase()] || null
}

function keyFingerprint(value) {
  if (!value) return 'none'
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 12)
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function cacheKey(provider, apiKey) {
  return `${provider.id}:${keyFingerprint(apiKey)}`
}

function emptyCatalog(provider, status, summary, opts = {}) {
  return {
    ok: status === 'ready',
    provider: provider?.id || opts.provider || 'unknown',
    status,
    source: opts.source || (status === 'missing_key' ? 'not_configured' : 'none'),
    cache: { hit: false, ttlSeconds: DEFAULT_TTL_SECONDS },
    models: [],
    warnings: opts.warnings || (summary ? [summary] : []),
    summary: summary || '',
    generatedAt: new Date().toISOString(),
  }
}

function withCacheResult(result, hit) {
  return {
    ...clone(result),
    cache: { hit, ttlSeconds: DEFAULT_TTL_SECONDS },
    source: hit ? 'cache' : result.source,
  }
}

function timeoutSignal(timeoutMs) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(timeoutMs)
  }
  const controller = new AbortController()
  setTimeout(() => controller.abort(), timeoutMs).unref?.()
  return controller.signal
}

async function fetchJson(url, { headers = {}, fetchImpl = global.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  try {
    const response = await fetchImpl(url, {
      headers,
      signal: timeoutSignal(timeoutMs),
    })
    let data = null
    try {
      data = await response.json()
    } catch {
      data = null
    }
    return { ok: response.ok, status: response.status, data }
  } catch (e) {
    if (e?.name === 'AbortError' || e?.name === 'TimeoutError') {
      return { ok: false, status: 0, timeout: true, data: null }
    }
    return { ok: false, status: 0, error: e?.message || 'Connection failed', data: null }
  }
}

function errorCatalog(provider, response) {
  if (response.timeout) {
    return emptyCatalog(provider, 'timeout', `${provider.label} model catalog timed out`, { source: 'provider' })
  }
  if (response.status === 401 || response.status === 403) {
    return emptyCatalog(provider, 'auth_error', `${provider.label} API key was rejected`, { source: 'provider' })
  }
  const message = response.data?.error?.message || response.data?.error || response.error || `${provider.label} returned HTTP ${response.status || 'error'}`
  return emptyCatalog(provider, 'provider_error', String(message).slice(0, 240), { source: 'provider' })
}

function readyCatalog(provider, models, opts = {}) {
  return {
    ok: true,
    provider: provider.id,
    status: 'ready',
    source: 'live',
    cache: { hit: false, ttlSeconds: DEFAULT_TTL_SECONDS },
    models,
    warnings: opts.warnings || [],
    summary: `${models.length} models available`,
    generatedAt: new Date().toISOString(),
  }
}

function cleanModelId(value) {
  return String(value || '').replace(/^models\//, '')
}

function normalizeOpenRouter(provider, data) {
  return (data.data || []).map(m => ({
    id: m.id,
    name: m.name || m.id,
    provider: provider.id,
    pricing: m.pricing,
    contextLength: m.context_length,
    capabilities: {
      inputModalities: m.architecture?.input_modalities,
      outputModalities: m.architecture?.output_modalities,
      supportedParameters: m.supported_parameters,
    },
  })).filter(m => m.id)
}

function normalizeAnthropic(provider, data) {
  return (data.data || []).map(m => ({
    id: m.id,
    name: m.display_name || m.name || m.id,
    provider: provider.id,
    createdAt: m.created_at,
  })).filter(m => m.id)
}

function normalizeGoogle(provider, data) {
  return (data.models || [])
    .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => ({
      id: cleanModelId(m.name),
      name: m.displayName || cleanModelId(m.name),
      provider: provider.id,
      contextLength: m.inputTokenLimit,
      capabilities: {
        supportedGenerationMethods: m.supportedGenerationMethods,
        outputTokenLimit: m.outputTokenLimit,
      },
    }))
    .filter(m => m.id)
}

function normalizeOpenAiCompatible(provider, data) {
  return (data.data || []).map(m => ({
    id: m.id,
    name: m.name || m.id,
    provider: provider.id,
    ownedBy: m.owned_by || m.ownedBy,
    created: m.created,
    pricing: m.pricing,
    contextLength: m.context_length || m.contextLength,
    capabilities: m.capabilities,
  })).filter(m => m.id)
}

function normalizeKilo(provider, data) {
  const items = Array.isArray(data) ? data : (data.data || data.models || [])
  return items.map(m => ({
    id: m.id || m.slug || m.model,
    name: m.name || m.display_name || m.id || m.slug || m.model,
    provider: provider.id,
    ownedBy: m.owned_by || m.ownedBy || m.provider,
    pricing: m.pricing,
    contextLength: m.context_length || m.contextLength,
    capabilities: m.capabilities,
  })).filter(m => m.id)
}

function anthropicHeaders(apiKey) {
  if (apiKey.includes('sk-ant-oat')) {
    return {
      Authorization: `Bearer ${apiKey}`,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
      'user-agent': 'claude-cli/2.1.75',
      'x-app': 'cli',
    }
  }
  return {
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  }
}

async function loadGoogleModels(provider, apiKey, opts) {
  const all = []
  let pageToken = ''
  for (let page = 0; page < 10; page += 1) {
    const params = new URLSearchParams({ key: apiKey, pageSize: '1000' })
    if (pageToken) params.set('pageToken', pageToken)
    const response = await fetchJson(`https://generativelanguage.googleapis.com/v1beta/models?${params.toString()}`, opts)
    if (!response.ok) return errorCatalog(provider, response)
    all.push(...normalizeGoogle(provider, response.data || {}))
    pageToken = response.data?.nextPageToken || ''
    if (!pageToken) break
  }
  return readyCatalog(provider, all)
}

async function loadProviderModels(provider, apiKey, opts) {
  if (provider.id === 'openrouter') {
    const response = await fetchJson('https://openrouter.ai/api/v1/models', {
      ...opts,
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    return response.ok ? readyCatalog(provider, normalizeOpenRouter(provider, response.data || {})) : errorCatalog(provider, response)
  }

  if (provider.id === 'anthropic') {
    const response = await fetchJson('https://api.anthropic.com/v1/models', {
      ...opts,
      headers: anthropicHeaders(apiKey),
    })
    return response.ok ? readyCatalog(provider, normalizeAnthropic(provider, response.data || {})) : errorCatalog(provider, response)
  }

  if (provider.id === 'google') return loadGoogleModels(provider, apiKey, opts)

  if (provider.id === 'openai') {
    const response = await fetchJson('https://api.openai.com/v1/models', {
      ...opts,
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    return response.ok ? readyCatalog(provider, normalizeOpenAiCompatible(provider, response.data || {})) : errorCatalog(provider, response)
  }

  if (provider.id === 'mistral') {
    const response = await fetchJson('https://api.mistral.ai/v1/models', {
      ...opts,
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    return response.ok ? readyCatalog(provider, normalizeOpenAiCompatible(provider, response.data || {})) : errorCatalog(provider, response)
  }

  if (provider.id === 'groq') {
    const response = await fetchJson('https://api.groq.com/openai/v1/models', {
      ...opts,
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    return response.ok ? readyCatalog(provider, normalizeOpenAiCompatible(provider, response.data || {})) : errorCatalog(provider, response)
  }

  if (provider.id === 'kilocode') {
    const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
    const response = await fetchJson('https://api.kilo.ai/api/gateway/models', {
      ...opts,
      headers,
    })
    if (!response.ok) return errorCatalog(provider, response)
    const models = normalizeKilo(provider, response.data || {})
    const warnings = apiKey
      ? ['Kilo catalog can list models that OpenClaw runtime cannot use; run runtime verification before saving.']
      : ['Kilo model catalog is public, but an API key is required for real inference.']
    return readyCatalog(provider, models, { warnings })
  }

  return emptyCatalog(provider, 'unknown_provider', `Unknown provider: ${provider.id}`)
}

async function getModelCatalog({
  provider: providerId = 'openrouter',
  config = {},
  refresh = false,
  fetchImpl = global.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const provider = providerFor(providerId)
  if (!provider) {
    return emptyCatalog(null, 'unknown_provider', `Unknown provider: ${providerId}`, { provider: providerId })
  }

  const apiKey = String(config.env?.[provider.envKey] || '')
  if (provider.requiresKeyForCatalog && !apiKey) {
    return emptyCatalog(provider, 'missing_key', `${provider.label} API key is not configured`)
  }

  const key = cacheKey(provider, apiKey)
  const cached = catalogCache.get(key)
  if (!refresh && cached && Date.now() - cached.cachedAt < DEFAULT_TTL_SECONDS * 1000) {
    return withCacheResult(cached.result, true)
  }

  const result = await loadProviderModels(provider, apiKey, { fetchImpl, timeoutMs })
  if (result.ok) catalogCache.set(key, { cachedAt: Date.now(), result: clone(result) })
  return result
}

function clearModelCatalogCache() {
  catalogCache.clear()
}

module.exports = {
  DEFAULT_TTL_SECONDS,
  PROVIDERS,
  clearModelCatalogCache,
  getModelCatalog,
  _internal: {
    anthropicHeaders,
    cacheKey,
    errorCatalog,
    normalizeGoogle,
    normalizeKilo,
    normalizeOpenAiCompatible,
    normalizeOpenRouter,
    providerFor,
  },
}
