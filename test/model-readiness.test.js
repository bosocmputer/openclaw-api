const assert = require('node:assert/strict')
const test = require('node:test')

const {
  applyModelSettings,
  getModelReadinessForConfig,
} = require('../lib/model-readiness')

function readyCatalog(models) {
  return {
    ok: true,
    provider: 'openrouter',
    status: 'ready',
    source: 'test',
    cache: { hit: false, ttlSeconds: 300 },
    models,
    warnings: [],
    summary: 'ready',
  }
}

function catalogLoaderByProvider(catalogs) {
  return async ({ provider }) => catalogs[provider] || {
    ok: false,
    provider,
    status: 'missing_key',
    source: 'none',
    cache: { hit: false, ttlSeconds: 300 },
    models: [],
    warnings: [],
    summary: `${provider} key missing`,
  }
}

test('readiness passes when primary, fallback, and image models exist in live catalog', async () => {
  const config = {
    agents: {
      defaults: {
        model: {
          primary: 'openrouter/google/gemini-2.5-flash-lite',
          fallbacks: ['openrouter/qwen/qwen3.5-27b'],
        },
        imageModel: {
          primary: 'openrouter/google/gemini-2.5-flash-image',
          fallbacks: ['openrouter/openai/gpt-4o-mini'],
          timeoutMs: 30000,
        },
      },
      list: [
        { id: 'stock', workspace: '~/.openclaw/workspace-stock', tools: { allow: ['image'] } },
      ],
    },
  }

  const readiness = await getModelReadinessForConfig(config, {
    getModelCatalog: catalogLoaderByProvider({
      openrouter: readyCatalog([
        { id: 'google/gemini-2.5-flash-lite', name: 'Gemini Lite', capabilities: { inputModalities: ['text'] } },
        { id: 'qwen/qwen3.5-27b', name: 'Qwen', capabilities: { inputModalities: ['text'] } },
        { id: 'google/gemini-2.5-flash-image', name: 'Gemini Vision', capabilities: { inputModalities: ['text', 'image'] } },
        { id: 'openai/gpt-4o-mini', name: 'GPT 4o Mini', capabilities: { inputModalities: ['text', 'image'] } },
      ]),
    }),
  })

  assert.equal(readiness.ok, true)
  assert.equal(readiness.blockingIssues.length, 0)
  assert.equal(readiness.defaults.model.primary.status, 'ready')
  assert.equal(readiness.defaults.imageModel.primary.status, 'ready')
  assert.equal(readiness.agents[0].imageModel.primary.status, 'ready')
})

test('missing provider catalog key becomes a blocking issue for configured model refs', async () => {
  const config = {
    agents: {
      defaults: {
        model: { primary: 'google/gemini-2.5-flash-lite', fallbacks: [] },
      },
      list: [],
    },
  }

  const readiness = await getModelReadinessForConfig(config, {
    getModelCatalog: catalogLoaderByProvider({}),
  })

  assert.equal(readiness.ok, false)
  assert.equal(readiness.defaults.model.primary.status, 'missing_key')
  assert.equal(readiness.blockingIssues[0].scope, 'defaults.model.primary')
})

test('image model without image input support fails validation', async () => {
  const config = {
    agents: {
      defaults: {
        model: { primary: 'openrouter/google/gemini-2.5-flash-lite', fallbacks: [] },
        imageModel: { primary: 'openrouter/google/gemini-2.5-flash-lite', fallbacks: [] },
      },
      list: [{ id: 'stock', tools: { allow: ['image'] } }],
    },
  }

  const readiness = await getModelReadinessForConfig(config, {
    getModelCatalog: catalogLoaderByProvider({
      openrouter: readyCatalog([
        { id: 'google/gemini-2.5-flash-lite', capabilities: { inputModalities: ['text'] } },
      ]),
    }),
  })

  assert.equal(readiness.ok, false)
  assert.equal(readiness.defaults.imageModel.primary.status, 'not_image_capable')
  assert.equal(readiness.blockingIssues.some(issue => issue.status === 'not_image_capable'), true)
})

test('image model with unknown capability metadata is blocked in normal validation', async () => {
  const config = {
    agents: {
      defaults: {
        model: { primary: 'openrouter/google/gemini-2.5-flash-lite', fallbacks: [] },
        imageModel: { primary: 'openrouter/vendor/no-metadata', fallbacks: [] },
      },
      list: [{ id: 'stock', tools: { allow: ['image'] } }],
    },
  }

  const readiness = await getModelReadinessForConfig(config, {
    getModelCatalog: catalogLoaderByProvider({
      openrouter: readyCatalog([
        { id: 'google/gemini-2.5-flash-lite', capabilities: { inputModalities: ['text'] } },
        { id: 'vendor/no-metadata' },
      ]),
    }),
  })

  assert.equal(readiness.ok, false)
  assert.equal(readiness.defaults.imageModel.primary.status, 'capability_unknown')
})

test('applyModelSettings writes defaults and deletes per-agent overrides when null', () => {
  const config = {
    agents: {
      defaults: {
        model: { primary: 'openrouter/old', fallbacks: [] },
      },
      list: [
        {
          id: 'stock',
          model: { primary: 'openrouter/agent-old', fallbacks: [] },
          imageModel: { primary: 'openrouter/vision-old', fallbacks: [] },
        },
      ],
    },
  }

  const next = applyModelSettings(config, {
    defaults: {
      model: { primary: 'openrouter/new', fallbacks: ['openrouter/fallback'] },
      imageModel: { primary: 'openrouter/vision', fallbacks: [], timeoutMs: 45000 },
    },
    agents: {
      stock: { model: null, imageModel: null },
    },
  })

  assert.equal(next.agents.defaults.model.primary, 'openrouter/new')
  assert.deepEqual(next.agents.defaults.model.fallbacks, ['openrouter/fallback'])
  assert.equal(next.agents.defaults.imageModel.timeoutMs, 45000)
  assert.equal(Object.prototype.hasOwnProperty.call(next.agents.list[0], 'model'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(next.agents.list[0], 'imageModel'), false)
})

test('applyModelSettings rejects unknown agent overrides', () => {
  assert.throws(
    () => applyModelSettings({ agents: { list: [{ id: 'stock' }] } }, { agents: { missing: { model: null } } }),
    /Unknown agent: missing/
  )
})

test('applyModelSettings rejects duplicate or primary fallback models', () => {
  assert.throws(
    () => applyModelSettings(
      { agents: { defaults: {}, list: [] } },
      { defaults: { model: { primary: 'openrouter/a', fallbacks: ['openrouter/a'] } } }
    ),
    /must not include the primary model/
  )

  assert.throws(
    () => applyModelSettings(
      { agents: { defaults: {}, list: [] } },
      { defaults: { imageModel: { primary: 'openrouter/vision', fallbacks: ['openrouter/fallback', 'openrouter/fallback'] } } }
    ),
    /contains duplicate model/
  )
})
