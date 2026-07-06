const assert = require('node:assert/strict')
const test = require('node:test')

const {
  clearModelCatalogCache,
  getModelCatalog,
  _internal,
} = require('../lib/model-catalog')

function response({ ok = true, status = 200, body = {} } = {}) {
  return {
    ok,
    status,
    async json() {
      return body
    },
  }
}

test('provider live success returns normalized models and caches result', async () => {
  clearModelCatalogCache()
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    return response({
      body: {
        data: [
          {
            id: 'openai/gpt-live',
            name: 'GPT Live',
            pricing: { prompt: '0.1', completion: '0.2' },
            context_length: 128000,
            supported_parameters: ['tools'],
          },
        ],
      },
    })
  }

  const first = await getModelCatalog({
    provider: 'openrouter',
    config: { env: { OPENROUTER_API_KEY: 'sk-test' } },
    fetchImpl,
  })
  const second = await getModelCatalog({
    provider: 'openrouter',
    config: { env: { OPENROUTER_API_KEY: 'sk-test' } },
    fetchImpl,
  })

  assert.equal(first.status, 'ready')
  assert.equal(first.models[0].id, 'openai/gpt-live')
  assert.equal(first.models[0].contextLength, 128000)
  assert.equal(second.cache.hit, true)
  assert.equal(calls, 1)
})

test('Kilo catalog marks kilo auto as text and image capable from documented static fallback metadata', async () => {
  clearModelCatalogCache()
  const result = await getModelCatalog({
    provider: 'kilocode',
    config: { env: { KILOCODE_API_KEY: 'kc-test' } },
    fetchImpl: async () => response({
      body: {
        data: [
          {
            id: 'kilo/auto',
          },
        ],
      },
    }),
  })

  assert.equal(result.status, 'ready')
  assert.equal(result.models[0].id, 'kilo/auto')
  assert.deepEqual(result.models[0].capabilities.inputModalities, ['text', 'image'])
})

test('missing key does not call provider and returns explicit missing_key', async () => {
  clearModelCatalogCache()
  let calls = 0
  const result = await getModelCatalog({
    provider: 'google',
    config: { env: {} },
    fetchImpl: async () => {
      calls += 1
      return response()
    },
  })

  assert.equal(result.ok, false)
  assert.equal(result.status, 'missing_key')
  assert.equal(result.models.length, 0)
  assert.equal(calls, 0)
})

test('provider 401 returns auth_error instead of silent empty list', async () => {
  clearModelCatalogCache()
  const result = await getModelCatalog({
    provider: 'openai',
    config: { env: { OPENAI_API_KEY: 'bad-key' } },
    fetchImpl: async () => response({ ok: false, status: 401, body: { error: { message: 'invalid api key' } } }),
  })

  assert.equal(result.ok, false)
  assert.equal(result.status, 'auth_error')
  assert.equal(result.models.length, 0)
})

test('timeout returns bounded timeout status', async () => {
  clearModelCatalogCache()
  const err = new Error('timed out')
  err.name = 'TimeoutError'

  const result = await getModelCatalog({
    provider: 'mistral',
    config: { env: { MISTRAL_API_KEY: 'sk-test' } },
    fetchImpl: async () => { throw err },
  })

  assert.equal(result.ok, false)
  assert.equal(result.status, 'timeout')
})

test('refresh bypasses cache and replaces model list', async () => {
  clearModelCatalogCache()
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    return response({ body: { data: [{ id: `model-${calls}`, name: `Model ${calls}` }] } })
  }

  const first = await getModelCatalog({
    provider: 'groq',
    config: { env: { GROQ_API_KEY: 'sk-test' } },
    fetchImpl,
  })
  const cached = await getModelCatalog({
    provider: 'groq',
    config: { env: { GROQ_API_KEY: 'sk-test' } },
    fetchImpl,
  })
  const refreshed = await getModelCatalog({
    provider: 'groq',
    config: { env: { GROQ_API_KEY: 'sk-test' } },
    fetchImpl,
    refresh: true,
  })

  assert.equal(first.models[0].id, 'model-1')
  assert.equal(cached.models[0].id, 'model-1')
  assert.equal(cached.cache.hit, true)
  assert.equal(refreshed.models[0].id, 'model-2')
  assert.equal(calls, 2)
})

test('anthropic oauth token uses bearer oauth headers', async () => {
  clearModelCatalogCache()
  let capturedHeaders = null
  await getModelCatalog({
    provider: 'anthropic',
    config: { env: { ANTHROPIC_API_KEY: 'sk-ant-oat-test' } },
    fetchImpl: async (_url, opts) => {
      capturedHeaders = opts.headers
      return response({ body: { data: [{ id: 'claude-live', display_name: 'Claude Live' }] } })
    },
  })

  assert.equal(capturedHeaders.Authorization, 'Bearer sk-ant-oat-test')
  assert.equal(capturedHeaders['x-api-key'], undefined)
  assert.match(capturedHeaders['anthropic-beta'], /oauth-2025-04-20/)
})

test('anthropic api key uses x-api-key headers', () => {
  const headers = _internal.anthropicHeaders('sk-ant-api03-test')

  assert.equal(headers['x-api-key'], 'sk-ant-api03-test')
  assert.equal(headers.Authorization, undefined)
})

test('kilo catalog works without key and warns about inference key', async () => {
  clearModelCatalogCache()
  let calls = 0
  const result = await getModelCatalog({
    provider: 'kilocode',
    config: { env: {} },
    fetchImpl: async () => {
      calls += 1
      return response({ body: { data: [{ id: 'kilo-auto/free', name: 'Auto Free' }] } })
    },
  })

  assert.equal(result.status, 'ready')
  assert.equal(result.models[0].id, 'kilo-auto/free')
  assert.equal(result.warnings.length, 1)
  assert.equal(calls, 1)
})

test('kilo catalog accepts provider-specific models envelope', async () => {
  clearModelCatalogCache()
  const result = await getModelCatalog({
    provider: 'kilocode',
    config: { env: {} },
    fetchImpl: async () => response({ body: { models: [{ slug: 'kilo-live/router', display_name: 'Kilo Router' }] } }),
  })

  assert.equal(result.status, 'ready')
  assert.equal(result.models[0].id, 'kilo-live/router')
  assert.equal(result.models[0].name, 'Kilo Router')
})

test('kilo catalog with key still warns that runtime verification is required', async () => {
  clearModelCatalogCache()
  const result = await getModelCatalog({
    provider: 'kilocode',
    config: { env: { KILOCODE_API_KEY: 'kc-test' } },
    fetchImpl: async () => response({ body: { models: [{ slug: 'kilo-auto/small', display_name: 'Auto Small' }] } }),
  })

  assert.equal(result.status, 'ready')
  assert.equal(result.models[0].id, 'kilo-auto/small')
  assert.equal(result.warnings.length, 1)
  assert.match(result.warnings[0], /runtime verification/)
})

test('ollama cloud catalog uses hosted ids exactly and sends bearer auth', async () => {
  clearModelCatalogCache()
  let capturedUrl = ''
  let capturedHeaders = null
  const result = await getModelCatalog({
    provider: 'ollama-cloud',
    config: { env: { OLLAMA_API_KEY: 'ol-test' } },
    fetchImpl: async (url, opts) => {
      capturedUrl = url
      capturedHeaders = opts.headers
      return response({
        body: {
          models: [
            { name: 'gemini-3-flash-preview', model: 'gemini-3-flash-preview', modified_at: '2026-01-01T00:00:00Z' },
            { name: 'gemma4:31b', model: 'gemma4:31b' },
          ],
        },
      })
    },
  })

  assert.equal(capturedUrl, 'https://ollama.com/api/tags')
  assert.equal(capturedHeaders.Authorization, 'Bearer ol-test')
  assert.equal(result.status, 'ready')
  assert.deepEqual(result.models.map(model => model.id), ['gemini-3-flash-preview', 'gemma4:31b'])
  assert.equal(result.models.some(model => /:cloud|-cloud/.test(model.id)), false)
  assert.deepEqual(result.models[0].capabilities.inputModalities, ['text'])
})

test('ollama cloud catalog requires key before provider call', async () => {
  clearModelCatalogCache()
  let calls = 0
  const result = await getModelCatalog({
    provider: 'ollama-cloud',
    config: { env: {} },
    fetchImpl: async () => {
      calls += 1
      return response()
    },
  })

  assert.equal(result.status, 'missing_key')
  assert.equal(calls, 0)
})
