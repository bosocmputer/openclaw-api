const assert = require('node:assert/strict')
const test = require('node:test')

const {
  collectModelRefsFromConfig,
  materializeProviderCatalogsForRefs,
  materializeSelectedProviderCatalogs,
  _internal,
} = require('../lib/model-provider-materialize')

function kiloCatalog(models) {
  return {
    ok: true,
    provider: 'kilocode',
    status: 'ready',
    source: 'test',
    cache: { hit: false, ttlSeconds: 300 },
    models,
    warnings: [],
    summary: 'ready',
  }
}

test('materializeProviderCatalogsForRefs writes Kilo catalog metadata without copying raw key', async () => {
  const config = {
    env: { KILOCODE_API_KEY: 'kc-secret-value' },
    agents: { defaults: { model: { primary: 'kilocode/openai/gpt-4o-mini', fallbacks: [] } }, list: [] },
  }

  const result = await materializeProviderCatalogsForRefs(config, ['kilocode/openai/gpt-4o-mini'], {
    getModelCatalog: async () => kiloCatalog([
      {
        id: 'openai/gpt-4o-mini',
        name: 'OpenAI GPT-4o-mini',
        pricing: { prompt: '0.00000015', completion: '0.0000006' },
        contextLength: 128000,
        capabilities: { inputModalities: ['text'], supportedParameters: ['tools'] },
      },
    ]),
  })

  assert.equal(result.changed, true)
  const provider = result.config.models.providers.kilocode
  assert.equal(provider.baseUrl, 'https://api.kilo.ai/api/gateway/')
  assert.equal(provider.api, 'openai-completions')
  assert.deepEqual(provider.apiKey, { source: 'env', provider: 'default', id: 'KILOCODE_API_KEY' })
  assert.equal(provider.models.length, 1)
  assert.equal(provider.models[0].id, 'openai/gpt-4o-mini')
  assert.equal(provider.models[0].cost.input, 0.15)
  assert.equal(JSON.stringify(provider).includes('kc-secret-value'), false)
})

test('materializeSelectedProviderCatalogs collects default and agent model refs', async () => {
  const config = {
    agents: {
      defaults: {
        model: { primary: 'kilocode/openai/gpt-4o-mini', fallbacks: ['kilocode/google/gemini-3.1-flash-lite'] },
      },
      list: [
        { id: 'stock', imageModel: { primary: 'kilocode/qwen/qwen3-vl-235b-a22b-instruct', fallbacks: [] } },
      ],
    },
  }

  assert.deepEqual(collectModelRefsFromConfig(config), [
    'kilocode/openai/gpt-4o-mini',
    'kilocode/google/gemini-3.1-flash-lite',
    'kilocode/qwen/qwen3-vl-235b-a22b-instruct',
  ])

  const result = await materializeSelectedProviderCatalogs(config, {
    getModelCatalog: async () => kiloCatalog([
      { id: 'openai/gpt-4o-mini', name: 'GPT', capabilities: { inputModalities: ['text'] } },
      { id: 'google/gemini-3.1-flash-lite', name: 'Gemini', capabilities: { inputModalities: ['text'] } },
      { id: 'qwen/qwen3-vl-235b-a22b-instruct', name: 'Qwen VL', capabilities: { inputModalities: ['text', 'image'] } },
    ]),
  })

  assert.equal(result.changed, true)
  assert.deepEqual(
    result.config.models.providers.kilocode.models.map(model => model.id),
    [
      'google/gemini-3.1-flash-lite',
      'openai/gpt-4o-mini',
      'qwen/qwen3-vl-235b-a22b-instruct',
    ],
  )
})

test('materializeProviderCatalogsForRefs is a no-op for providers without runtime defaults', async () => {
  let catalogCalls = 0
  const result = await materializeProviderCatalogsForRefs({}, ['openrouter/openai/gpt-4o-mini'], {
    getModelCatalog: async () => {
      catalogCalls += 1
      return kiloCatalog([])
    },
  })

  assert.equal(result.changed, false)
  assert.equal(catalogCalls, 0)
})

test('materializeProviderCatalogsForRefs sanitizes stale Kilo input metadata without refetching catalog', async () => {
  let catalogCalls = 0
  const config = {
    models: {
      providers: {
        kilocode: {
          models: [
            {
              id: 'openai/gpt-4o-mini',
              name: 'OpenAI GPT-4o-mini',
              input: ['text', 'image', 'audio', 'video'],
            },
          ],
        },
      },
    },
  }

  const result = await materializeProviderCatalogsForRefs(config, ['kilocode/openai/gpt-4o-mini'], {
    getModelCatalog: async () => {
      catalogCalls += 1
      return kiloCatalog([])
    },
  })

  assert.equal(result.changed, true)
  assert.equal(catalogCalls, 0)
  assert.deepEqual(result.config.models.providers.kilocode.models[0].input, ['text', 'image'])
})

test('materializeProviderCatalogsForRefs repairs unsupported-only Kilo input metadata', async () => {
  const config = {
    models: {
      providers: {
        kilocode: {
          models: [
            {
              id: 'vendor/audio-only',
              name: 'Audio Only',
              input: ['audio'],
            },
          ],
        },
      },
    },
  }

  const result = await materializeProviderCatalogsForRefs(config, ['kilocode/vendor/audio-only'])

  assert.equal(result.changed, true)
  assert.deepEqual(result.config.models.providers.kilocode.models[0].input, ['text'])
})

test('model definition normalization keeps image input and reasoning metadata', () => {
  const model = _internal.toModelDefinition({
    id: 'vendor/vision',
    name: 'Vision',
    pricing: { prompt: '0.000001', completion: '0.000002' },
    capabilities: {
      inputModalities: ['text', 'image'],
      supportedParameters: ['reasoning'],
      maxCompletionTokens: 4096,
    },
    contextLength: 32000,
  }, 'kilocode')

  assert.deepEqual(model.input, ['text', 'image'])
  assert.equal(model.reasoning, true)
  assert.equal(model.maxTokens, 4096)
  assert.equal(model.cost.input, 1)
  assert.equal(model.cost.output, 2)
})

test('model definition drops provider input modalities not accepted by runtime catalog schema', () => {
  const model = _internal.toModelDefinition({
    id: 'vendor/multimodal',
    name: 'Multimodal',
    capabilities: {
      inputModalities: ['text', 'image', 'audio', 'video', 'tool', 'file'],
    },
  }, 'kilocode')

  assert.deepEqual(model.input, ['text', 'image'])
})

test('model definition falls back to text when provider only advertises unsupported inputs', () => {
  const model = _internal.toModelDefinition({
    id: 'vendor/audio-only',
    name: 'Audio Only',
    capabilities: {
      inputModalities: ['audio', 'video'],
    },
  }, 'kilocode')

  assert.deepEqual(model.input, ['text'])
})
