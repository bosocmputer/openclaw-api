const assert = require('node:assert/strict')
const test = require('node:test')

const {
  applyModelSettings,
  getModelReadinessForConfig,
} = require('../lib/model-readiness')
const {
  clearModelRuntimeTestCache,
  runModelRuntimeTest,
} = require('../lib/model-runtime-test')

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
  clearModelRuntimeTestCache()
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
  assert.equal(readiness.runtimeVerificationIssues.length, 4)
  assert.equal(readiness.defaults.model.primary.status, 'ready')
  assert.equal(readiness.defaults.model.primary.runtimeStatus, 'runtime_unverified')
  assert.equal(readiness.defaults.imageModel.primary.status, 'ready')
  assert.equal(readiness.agents[0].imageModel.primary.status, 'ready')
})

test('readiness marks runtime verified after a runtime test passes', async () => {
  clearModelRuntimeTestCache()
  const config = {
    env: { OPENROUTER_API_KEY: 'sk-or-test' },
    agents: {
      defaults: {
        model: { primary: 'openrouter/google/gemini-2.5-flash-lite', fallbacks: [] },
      },
      list: [],
    },
  }
  const spawnImpl = (_command, args) => {
    const { EventEmitter } = require('node:events')
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => {}
    process.nextTick(() => {
      if (args.includes('--version')) child.stdout.emit('data', 'OpenClaw 2026.6.8 (test)\n')
      else child.stdout.emit('data', JSON.stringify({ ok: true, outputs: [{ text: 'OPENCLAW_MODEL_TEST_OK' }] }))
      child.emit('close', 0)
    })
    return child
  }

  await runModelRuntimeTest({
    model: 'openrouter/google/gemini-2.5-flash-lite',
    capability: 'text',
    config,
    spawnImpl,
  })
  const readiness = await getModelReadinessForConfig(config, {
    getModelCatalog: catalogLoaderByProvider({
      openrouter: readyCatalog([
        { id: 'google/gemini-2.5-flash-lite', capabilities: { inputModalities: ['text'] } },
      ]),
    }),
  })

  assert.equal(readiness.defaults.model.primary.runtimeStatus, 'runtime_verified')
  assert.equal(readiness.runtimeVerificationIssues.length, 0)
})

test('readiness reports invalid runtime output as a runtime verification issue', async () => {
  clearModelRuntimeTestCache()
  const config = {
    env: { KILOCODE_API_KEY: 'kc-test' },
    agents: {
      defaults: {
        model: { primary: 'kilocode/google/gemini-3.1-flash-lite', fallbacks: [] },
      },
      list: [],
    },
  }
  const spawnImpl = (_command, args) => {
    const { EventEmitter } = require('node:events')
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => {}
    process.nextTick(() => {
      if (args.includes('--version')) child.stdout.emit('data', 'OpenClaw 2026.6.8 (test)\n')
      else child.stdout.emit('data', JSON.stringify({ ok: true, outputs: [{ text: 'LLM request failed.' }] }))
      child.emit('close', 0)
    })
    return child
  }

  await runModelRuntimeTest({
    model: 'kilocode/google/gemini-3.1-flash-lite',
    capability: 'text',
    config,
    spawnImpl,
  })
  const readiness = await getModelReadinessForConfig(config, {
    getModelCatalog: catalogLoaderByProvider({
      kilocode: {
        ...readyCatalog([
          { id: 'google/gemini-3.1-flash-lite', capabilities: { inputModalities: ['text'] } },
        ]),
        provider: 'kilocode',
        warnings: ['Kilo runtime verification required'],
      },
    }),
  })

  assert.equal(readiness.defaults.model.primary.status, 'ready')
  assert.equal(readiness.defaults.model.primary.runtimeStatus, 'invalid_output')
  assert.equal(readiness.runtimeVerificationIssues.length, 1)
  assert.equal(readiness.runtimeVerificationIssues[0].status, 'invalid_output')
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
