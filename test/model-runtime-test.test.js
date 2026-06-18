const assert = require('node:assert/strict')
const test = require('node:test')
const { EventEmitter } = require('node:events')

const {
  clearModelRuntimeTestCache,
  runModelImageMessageTest,
  runModelRuntimeTest,
  runtimeStatusForRef,
  _internal,
} = require('../lib/model-runtime-test')

function fakeChild({ stdout = '', stderr = '', code = 0, delayMs = 0 }) {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = () => {}
  setTimeout(() => {
    if (stdout) child.stdout.emit('data', stdout)
    if (stderr) child.stderr.emit('data', stderr)
    child.emit('close', code)
  }, delayMs)
  return child
}

function spawnFor(responder) {
  const calls = []
  const spawnImpl = (_command, args) => {
    calls.push(args)
    return fakeChild(responder(args))
  }
  spawnImpl.calls = calls
  return spawnImpl
}

test('runtime model test succeeds and is cached per model/key/runtime', async () => {
  clearModelRuntimeTestCache()
  let inferCalls = 0
  const spawnImpl = spawnFor(args => {
    if (args.includes('--version')) {
      return { stdout: 'OpenClaw 2026.6.8 (test)\n' }
    }
    inferCalls += 1
    return {
      stdout: JSON.stringify({
        ok: true,
        provider: 'openrouter',
        model: 'google/gemini-2.5-flash-lite',
        attempts: [],
        outputs: [{ text: 'OPENCLAW_MODEL_TEST_OK' }],
      }),
    }
  })

  const config = { env: { OPENROUTER_API_KEY: 'sk-or-test' } }
  const first = await runModelRuntimeTest({
    model: 'openrouter/google/gemini-2.5-flash-lite',
    capability: 'text',
    config,
    spawnImpl,
  })
  const second = await runModelRuntimeTest({
    model: 'openrouter/google/gemini-2.5-flash-lite',
    capability: 'text',
    config,
    spawnImpl,
  })

  assert.equal(first.ok, true)
  assert.equal(first.status, 'runtime_verified')
  assert.equal(first.expectedOutput, 'OPENCLAW_MODEL_TEST_OK')
  assert.equal(first.outputPreview, 'OPENCLAW_MODEL_TEST_OK')
  assert.equal(second.cache.hit, true)
  assert.equal(inferCalls, 1)

  const cached = runtimeStatusForRef('openrouter/google/gemini-2.5-flash-lite', { capability: 'text', config })
  assert.equal(cached.runtimeStatus, 'runtime_verified')
})

test('runtime model test rejects provider error text emitted as successful output', async () => {
  clearModelRuntimeTestCache()
  const spawnImpl = spawnFor(args => {
    if (args.includes('--version')) {
      return { stdout: 'OpenClaw 2026.6.8 (test)\n' }
    }
    return {
      stdout: JSON.stringify({
        ok: true,
        outputs: [{ text: 'LLM request failed.' }],
      }),
    }
  })

  const result = await runModelRuntimeTest({
    model: 'kilocode/google/gemini-3.1-flash-lite',
    capability: 'image',
    config: { env: { KILOCODE_API_KEY: 'kc-test' } },
    spawnImpl,
  })

  assert.equal(result.ok, false)
  assert.equal(result.status, 'invalid_output')
  assert.equal(result.failureReason, 'error_text_output')
  assert.equal(result.expectedOutput, 'OPENCLAW_IMAGE_TEST_OK')
  assert.match(result.safeMessage, /error/)
})

test('runtime model test requires the exact sentinel response', async () => {
  clearModelRuntimeTestCache()
  const spawnImpl = spawnFor(args => {
    if (args.includes('--version')) {
      return { stdout: 'OpenClaw 2026.6.8 (test)\n' }
    }
    return {
      stdout: JSON.stringify({
        ok: true,
        outputs: [{ text: 'Sure, OPENCLAW_MODEL_TEST_OK' }],
      }),
    }
  })

  const result = await runModelRuntimeTest({
    model: 'openrouter/google/gemini-2.5-flash-lite',
    capability: 'text',
    config: { env: { OPENROUTER_API_KEY: 'sk-or-test' } },
    spawnImpl,
  })

  assert.equal(result.ok, false)
  assert.equal(result.status, 'invalid_output')
  assert.equal(result.failureReason, 'unexpected_output')
  assert.equal(result.outputPreview, 'Sure, OPENCLAW_MODEL_TEST_OK')
})

test('runtime model test maps OpenClaw unknown model errors to model_not_found', async () => {
  clearModelRuntimeTestCache()
  const spawnImpl = spawnFor(args => {
    if (args.includes('--version')) return { stdout: 'OpenClaw 2026.6.8 (test)\n' }
    return {
      code: 1,
      stderr: 'FailoverError: Unknown model: kilocode/google/gemini-3.1-flash-lite',
    }
  })

  const result = await runModelRuntimeTest({
    model: 'kilocode/google/gemini-3.1-flash-lite',
    capability: 'text',
    config: { env: { KILOCODE_API_KEY: 'kc-test' } },
    spawnImpl,
  })

  assert.equal(result.ok, false)
  assert.equal(result.status, 'model_not_found')
  assert.match(result.safeMessage, /runtime/)
})

test('runtime model test maps unsupported image attachments to not_image_capable', async () => {
  clearModelRuntimeTestCache()
  const spawnImpl = spawnFor(args => {
    if (args.includes('--version')) return { stdout: 'OpenClaw 2026.6.8 (test)\n' }
    return {
      code: 1,
      stderr: 'UnsupportedAttachmentError: attachment model-test.png: active model does not accept image inputs',
    }
  })

  const result = await runModelRuntimeTest({
    model: 'openrouter/google/gemini-2.5-flash-lite',
    capability: 'image',
    config: { env: { OPENROUTER_API_KEY: 'sk-or-test' } },
    spawnImpl,
  })

  assert.equal(result.ok, false)
  assert.equal(result.status, 'not_image_capable')
  assert.match(result.safeMessage, /รูปภาพ/)
})

test('runtime status is unverified before a runtime test has run', () => {
  clearModelRuntimeTestCache()
  const status = runtimeStatusForRef('openrouter/google/gemini-2.5-flash-lite', {
    capability: 'text',
    config: { env: { OPENROUTER_API_KEY: 'sk-or-test' } },
  })

  assert.equal(status.runtimeStatus, 'runtime_unverified')
})

test('runtime test cache key includes provider key from env vars', async () => {
  clearModelRuntimeTestCache()
  let inferCalls = 0
  const spawnImpl = spawnFor(args => {
    if (args.includes('--version')) return { stdout: 'OpenClaw 2026.6.8 (test)\n' }
    inferCalls += 1
    return {
      stdout: JSON.stringify({
        ok: true,
        provider: 'kilocode',
        model: 'openai/gpt-4o-mini',
        outputs: [{ text: 'OPENCLAW_MODEL_TEST_OK' }],
      }),
    }
  })

  await runModelRuntimeTest({
    model: 'kilocode/openai/gpt-4o-mini',
    capability: 'text',
    config: { env: { vars: { KILOCODE_API_KEY: 'kc-first' } } },
    spawnImpl,
  })
  const cached = await runModelRuntimeTest({
    model: 'kilocode/openai/gpt-4o-mini',
    capability: 'text',
    config: { env: { vars: { KILOCODE_API_KEY: 'kc-first' } } },
    spawnImpl,
  })
  await runModelRuntimeTest({
    model: 'kilocode/openai/gpt-4o-mini',
    capability: 'text',
    config: { env: { vars: { KILOCODE_API_KEY: 'kc-second' } } },
    spawnImpl,
  })

  assert.equal(cached.cache.hit, true)
  assert.equal(inferCalls, 2)
})

test('uploaded image message test passes the selected image file to runtime', async () => {
  clearModelRuntimeTestCache()
  const samplePng = 'iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAIAAAACUFjqAAAAFElEQVR4nGP8z4APMOGVhZnhPwMApH0BAbf9u0YAAAAASUVORK5CYII='
  let inferArgs = null
  const spawnImpl = spawnFor(args => {
    if (args.includes('--version')) return { stdout: 'OpenClaw 2026.6.8 (test)\n' }
    inferArgs = args
    return {
      stdout: JSON.stringify({
        ok: true,
        provider: 'openrouter',
        model: 'google/gemini-2.5-flash-lite',
        outputs: [{ text: 'เห็นรูปสินค้า 1 ชิ้น' }],
      }),
    }
  })

  const result = await runModelImageMessageTest({
    model: 'openrouter/google/gemini-2.5-flash-lite',
    prompt: 'รูปนี้คืออะไร',
    image: { base64: samplePng, mimeType: 'image/png', fileName: 'sample.png' },
    config: { env: { OPENROUTER_API_KEY: 'sk-or-test' } },
    spawnImpl,
  })

  assert.equal(result.ok, true)
  assert.equal(result.status, 'runtime_verified')
  assert.equal(result.outputPreview, 'เห็นรูปสินค้า 1 ชิ้น')
  assert.ok(inferArgs.includes('--file'))
  assert.equal(inferArgs[inferArgs.indexOf('--prompt') + 1], 'รูปนี้คืออะไร')

  const cached = runtimeStatusForRef('openrouter/google/gemini-2.5-flash-lite', {
    capability: 'image',
    config: { env: { OPENROUTER_API_KEY: 'sk-or-test' } },
  })
  assert.equal(cached.runtimeStatus, 'runtime_verified')
})

test('uploaded image message test rejects unsupported payloads before runtime', async () => {
  clearModelRuntimeTestCache()
  let spawnCalls = 0
  const spawnImpl = spawnFor(args => {
    spawnCalls += 1
    if (args.includes('--version')) return { stdout: 'OpenClaw 2026.6.8 (test)\n' }
    return { stdout: '' }
  })

  const result = await runModelImageMessageTest({
    model: 'openrouter/google/gemini-2.5-flash-lite',
    prompt: 'รูปนี้คืออะไร',
    image: { base64: Buffer.from('not image').toString('base64'), mimeType: 'application/pdf' },
    config: { env: { OPENROUTER_API_KEY: 'sk-or-test' } },
    spawnImpl,
  })

  assert.equal(result.ok, false)
  assert.equal(result.status, 'not_image_capable')
  assert.equal(spawnCalls, 1)
})

test('failure classifier redacts common secret shapes from details', () => {
  const failure = _internal.classifyFailure('401 invalid api key sk-or-secret-value')
  const redacted = _internal.redact('Authorization: Bearer abcdefghijklmnop\nOPENROUTER_API_KEY=sk-or-secret-value')

  assert.equal(failure.status, 'auth_error')
  assert.doesNotMatch(redacted, /abcdefghijklmnop|sk-or-secret-value/)
})
