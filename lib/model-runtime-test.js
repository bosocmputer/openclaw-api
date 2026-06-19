const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const { HOME } = require('./config')
const { PROVIDERS } = require('./model-catalog')

const TEXT_TIMEOUT_MS = 12_000
const IMAGE_TIMEOUT_MS = 35_000
const CACHE_TTL_MS = 15 * 60 * 1000
const STATUS_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000
const VERSION_TTL_MS = 60_000
const MAX_OUTPUT_BYTES = 240_000
const MAX_PERSISTED_CACHE_ENTRIES = 240
const PERSISTED_CACHE_PATH = path.join(HOME, '.openclaw/model-runtime-test-cache.json')
const TEXT_EXPECTED_OUTPUT = 'OPENCLAW_MODEL_TEST_OK'
const IMAGE_EXPECTED_OUTPUT = 'OPENCLAW_IMAGE_TEST_OK'
const TEST_PROMPT = `Reply exactly: ${TEXT_EXPECTED_OUTPUT}`
const IMAGE_TEST_PROMPT = `If the attached image is visible, reply exactly: ${IMAGE_EXPECTED_OUTPUT}`
const MAX_MESSAGE_TEST_PROMPT_CHARS = 2000
const MAX_MESSAGE_TEST_PREVIEW_CHARS = 800
const MAX_UPLOADED_IMAGE_BYTES = 4 * 1024 * 1024
const SUPPORTED_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

const runtimeTestCache = new Map()
let versionCache = null
let activeRuntimeTests = 0
let persistentCacheLoaded = false
const MAX_ACTIVE_RUNTIME_TESTS = 2

function nowIso() {
  return new Date().toISOString()
}

function providerForRef(ref) {
  const raw = String(ref || '').trim()
  const slash = raw.indexOf('/')
  if (slash <= 0) return null
  const providerId = raw.slice(0, slash).toLowerCase()
  const provider = PROVIDERS[providerId]
  if (!provider) return null
  return { provider, providerId, modelId: raw.slice(slash + 1), ref: raw }
}

function keyFingerprintForRef(ref, config = {}) {
  const parsed = providerForRef(ref)
  if (!parsed) return 'unknown-provider'
  const key = String(
    config?.env?.[parsed.provider.envKey] ||
    config?.env?.vars?.[parsed.provider.envKey] ||
    process.env[parsed.provider.envKey] ||
    '',
  )
  if (!key) return 'none'
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 12)
}

function commandParts() {
  const configured = process.env.OPENCLAW_BIN || process.env.OPENCLAW_RUNTIME_BIN || 'openclaw'
  if (/\.m?js$/i.test(configured)) {
    return { command: process.execPath, prefixArgs: [configured] }
  }
  return { command: configured, prefixArgs: [] }
}

function truncateBuffer(current, chunk) {
  const next = current + String(chunk || '')
  if (Buffer.byteLength(next) <= MAX_OUTPUT_BYTES) return next
  return next.slice(Math.max(0, next.length - MAX_OUTPUT_BYTES))
}

function redact(value) {
  return String(value || '')
    .replace(/(sk-[a-z0-9_-]{8,})/gi, '[redacted-key]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1[redacted]')
    .replace(/([A-Za-z0-9_]*API_KEY["'=:\s]+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[redacted]')
    .slice(0, 1200)
}

function classifyFailure(text, timedOut = false) {
  const value = String(text || '')
  if (timedOut || /timed?\s*out|timeout/i.test(value)) {
    return {
      status: 'timeout',
      summary: 'OpenClaw runtime model test timed out',
      safeMessage: 'ทดสอบ model ไม่สำเร็จเพราะ timeout',
    }
  }
  if (/unknown model|model_not_found|model not found|not present in .*catalog|not in .*catalog/i.test(value)) {
    return {
      status: 'model_not_found',
      summary: 'OpenClaw runtime does not recognize this model',
      safeMessage: 'Model นี้อยู่ใน catalog แต่ OpenClaw runtime ใช้งานจริงไม่ได้',
    }
  }
  if (/UnsupportedAttachmentError|does not accept image inputs|doesn'?t accept image inputs|image inputs? (?:is|are) not supported|vision.*not supported/i.test(value)) {
    return {
      status: 'not_image_capable',
      summary: 'OpenClaw runtime does not accept image inputs for this model',
      safeMessage: 'Model นี้ยังไม่รองรับการรับรูปภาพผ่าน OpenClaw runtime',
    }
  }
  if (/no credentials|credentials.*not found|missing.*api key|api key.*not configured|no api key/i.test(value)) {
    return {
      status: 'missing_key',
      summary: 'Provider credentials are not configured for runtime inference',
      safeMessage: 'ยังไม่ได้ตั้งค่า key สำหรับ provider นี้',
    }
  }
  if (/401|403|unauthori[sz]ed|invalid api key|permission denied|auth(?:entication)? failed/i.test(value)) {
    return {
      status: 'auth_error',
      summary: 'Provider rejected runtime authentication',
      safeMessage: 'Provider ปฏิเสธ key หรือสิทธิ์ใช้งาน model นี้',
    }
  }
  if (/ECONNREFUSED|gateway.*not.*running|failed to connect|connection refused|gateway unavailable|no listener|socket hang up/i.test(value)) {
    return {
      status: 'runtime_unavailable',
      summary: 'OpenClaw gateway/runtime is unavailable for model tests',
      safeMessage: 'OpenClaw runtime หรือ gateway ยังไม่พร้อมสำหรับทดสอบ model',
    }
  }
  return {
    status: 'provider_error',
    summary: 'Provider/runtime returned an error during model test',
    safeMessage: 'Provider หรือ runtime ตอบ error ระหว่างทดสอบ model',
  }
}

function looksLikeRuntimeErrorOutput(text) {
  return /llm request failed|all models failed|model fallback|unknown model|model_not_found|provider error|provider_error|finish_reason:\s*error|unauthori[sz]ed|invalid api key|rate limit|quota|timed?\s*out|timeout/i.test(String(text || ''))
}

function validateRuntimeOutput(outputText, { capability = 'text' } = {}) {
  const expectedOutput = capability === 'image' ? IMAGE_EXPECTED_OUTPUT : TEXT_EXPECTED_OUTPUT
  const preview = String(outputText || '').trim()
  if (!preview) {
    return {
      ok: false,
      status: 'invalid_output',
      expectedOutput,
      outputPreview: '',
      failureReason: 'empty_output',
      summary: 'Runtime test returned no text output',
      safeMessage: 'Runtime ทดสอบแล้วไม่พบข้อความตอบกลับ',
    }
  }
  if (looksLikeRuntimeErrorOutput(preview)) {
    return {
      ok: false,
      status: 'invalid_output',
      expectedOutput,
      outputPreview: preview.slice(0, 240),
      failureReason: 'error_text_output',
      summary: 'Runtime test returned an error message as model output',
      safeMessage: 'Runtime เรียก model แล้วได้ข้อความ error กลับมา ไม่ควรใช้ใน production',
    }
  }
  if (preview !== expectedOutput) {
    return {
      ok: false,
      status: 'invalid_output',
      expectedOutput,
      outputPreview: preview.slice(0, 240),
      failureReason: 'unexpected_output',
      summary: 'Runtime test returned unexpected model output',
      safeMessage: 'Runtime เรียก model ได้ แต่คำตอบทดสอบไม่ตรงตามที่กำหนด',
    }
  }
  return {
    ok: true,
    expectedOutput,
    outputPreview: preview.slice(0, 240),
  }
}

function parseJsonOutput(stdout) {
  const raw = String(stdout || '').trim()
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {}
  const lines = raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i])
    } catch {}
  }
  return null
}

function runCommand(args, { timeoutMs, spawnImpl = spawn } = {}) {
  return new Promise(resolve => {
    const parts = commandParts()
    const child = spawnImpl(parts.command, [...parts.prefixArgs, ...args], {
      cwd: os.homedir(),
      env: {
        ...process.env,
        HOME: process.env.HOME || os.homedir(),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const startedAt = Date.now()
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGTERM') } catch {}
      setTimeout(() => {
        try { child.kill('SIGKILL') } catch {}
      }, 1500).unref?.()
    }, timeoutMs)

    child.stdout?.on('data', chunk => { stdout = truncateBuffer(stdout, chunk) })
    child.stderr?.on('data', chunk => { stderr = truncateBuffer(stderr, chunk) })
    child.once('error', err => {
      clearTimeout(timer)
      resolve({
        exitCode: null,
        error: err,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - startedAt,
      })
    })
    child.once('close', code => {
      clearTimeout(timer)
      resolve({
        exitCode: code,
        error: null,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - startedAt,
      })
    })
  })
}

async function getOpenclawVersion({ refresh = false, spawnImpl } = {}) {
  if (!refresh && versionCache && Date.now() - versionCache.createdAt < VERSION_TTL_MS) {
    return versionCache.version
  }
  const result = await runCommand(['--version'], { timeoutMs: 3000, spawnImpl })
  const version = result.exitCode === 0
    ? String(result.stdout || '').trim().split(/\r?\n/)[0].trim()
    : 'unknown'
  versionCache = { createdAt: Date.now(), version: version || 'unknown' }
  return versionCache.version
}

function cacheKey({ model, capability = 'text', mode = 'gateway', config = {}, runtimeVersion = 'unknown' }) {
  return [
    mode,
    capability,
    String(model || '').trim(),
    runtimeVersion,
    keyFingerprintForRef(model, config),
  ].join('|')
}

function loadPersistentRuntimeTestCache() {
  if (persistentCacheLoaded) return
  persistentCacheLoaded = true
  try {
    const raw = JSON.parse(fs.readFileSync(PERSISTED_CACHE_PATH, 'utf8'))
    const entries = Array.isArray(raw?.entries) ? raw.entries : []
    for (const entry of entries) {
      if (!entry?.key || !entry?.result || !Number.isFinite(Number(entry.cachedAt))) continue
      runtimeTestCache.set(String(entry.key), {
        cachedAt: Number(entry.cachedAt),
        result: entry.result,
      })
    }
  } catch {}
}

function persistRuntimeTestCache() {
  try {
    const entries = [...runtimeTestCache.entries()]
      .sort((a, b) => Number(b[1]?.cachedAt || 0) - Number(a[1]?.cachedAt || 0))
      .slice(0, MAX_PERSISTED_CACHE_ENTRIES)
      .map(([key, value]) => ({
        key,
        cachedAt: Number(value.cachedAt || Date.now()),
        result: value.result,
      }))
    fs.mkdirSync(path.dirname(PERSISTED_CACHE_PATH), { recursive: true })
    const tmp = `${PERSISTED_CACHE_PATH}.${process.pid}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify({ updatedAt: nowIso(), entries }, null, 2)}\n`, { mode: 0o600 })
    fs.renameSync(tmp, PERSISTED_CACHE_PATH)
  } catch {}
}

function cacheRuntimeTest(key, result) {
  loadPersistentRuntimeTestCache()
  runtimeTestCache.set(key, { cachedAt: Date.now(), result })
  persistRuntimeTestCache()
  return result
}

function getCachedRuntimeTest({ model, capability = 'text', mode = 'gateway', config = {}, runtimeVersion, maxAgeMs = CACHE_TTL_MS } = {}) {
  loadPersistentRuntimeTestCache()
  const exactKey = cacheKey({ model, capability, mode, config, runtimeVersion: runtimeVersion || 'unknown' })
  const exact = runtimeTestCache.get(exactKey)
  if (exact && Date.now() - exact.cachedAt < maxAgeMs) return { ...exact.result, cache: { hit: true, ttlSeconds: Math.ceil((maxAgeMs - (Date.now() - exact.cachedAt)) / 1000) } }

  const prefix = [mode, capability, String(model || '').trim()].join('|') + '|'
  const keyFingerprint = keyFingerprintForRef(model, config)
  let latest = null
  for (const [key, value] of runtimeTestCache.entries()) {
    if (!key.startsWith(prefix) || !key.endsWith(`|${keyFingerprint}`)) continue
    if (Date.now() - value.cachedAt >= maxAgeMs) continue
    if (!latest || value.cachedAt > latest.cachedAt) latest = value
  }
  return latest ? { ...latest.result, cache: { hit: true, ttlSeconds: Math.ceil((maxAgeMs - (Date.now() - latest.cachedAt)) / 1000) } } : null
}

function writeSampleImage() {
  const file = path.join(os.tmpdir(), `openclaw-model-test-${process.pid}-${Date.now()}.png`)
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAIAAAACUFjqAAAAFElEQVR4nGP8z4APMOGVhZnhPwMApH0BAbf9u0YAAAAASUVORK5CYII=',
    'base64',
  )
  fs.writeFileSync(file, png, { mode: 0o600 })
  return file
}

function extensionForMimeType(mimeType) {
  if (mimeType === 'image/jpeg') return 'jpg'
  if (mimeType === 'image/webp') return 'webp'
  if (mimeType === 'image/gif') return 'gif'
  return 'png'
}

function normalizeImageUpload(upload = {}) {
  let mimeType = String(upload.mimeType || upload.type || '').toLowerCase().trim()
  let base64 = String(upload.base64 || upload.data || '').trim()
  if (!base64 && typeof upload.dataUrl === 'string') {
    const match = upload.dataUrl.match(/^data:([^;,]+);base64,(.+)$/i)
    if (match) {
      mimeType = mimeType || String(match[1] || '').toLowerCase().trim()
      base64 = match[2]
    }
  }
  if (!SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) {
    return {
      ok: false,
      status: 'not_image_capable',
      safeMessage: 'รองรับเฉพาะไฟล์รูปภาพ PNG, JPG, WEBP หรือ GIF',
      summary: 'Unsupported image MIME type',
    }
  }
  if (!base64 || !/^[A-Za-z0-9+/=\s]+$/.test(base64)) {
    return {
      ok: false,
      status: 'invalid_output',
      safeMessage: 'ไฟล์รูปภาพไม่ถูกต้อง กรุณาเลือกไฟล์ใหม่',
      summary: 'Invalid base64 image payload',
    }
  }
  const buffer = Buffer.from(base64.replace(/\s+/g, ''), 'base64')
  if (!buffer.length || buffer.length > MAX_UPLOADED_IMAGE_BYTES) {
    return {
      ok: false,
      status: 'invalid_output',
      safeMessage: `รูปภาพต้องมีขนาดไม่เกิน ${Math.round(MAX_UPLOADED_IMAGE_BYTES / 1024 / 1024)}MB`,
      summary: 'Uploaded image is empty or too large',
    }
  }
  return { ok: true, mimeType, buffer }
}

function writeUploadedImage(upload) {
  const normalized = normalizeImageUpload(upload)
  if (!normalized.ok) return normalized
  const file = path.join(
    os.tmpdir(),
    `openclaw-uploaded-image-test-${process.pid}-${Date.now()}.${extensionForMimeType(normalized.mimeType)}`,
  )
  fs.writeFileSync(file, normalized.buffer, { mode: 0o600 })
  return { ok: true, path: file, mimeType: normalized.mimeType, size: normalized.buffer.length }
}

function buildResult({ ok, status, model, capability, mode, runtimeVersion, durationMs, summary, safeMessage, data, detail, expectedOutput, outputPreview, failureReason, cache = false }) {
  return {
    ok,
    status,
    model,
    capability,
    mode,
    runtimeVersion,
    durationMs,
    summary,
    safeMessage,
    expectedOutput: expectedOutput || null,
    outputPreview: outputPreview || null,
    failureReason: failureReason || null,
    data: data || null,
    detail: detail ? redact(detail) : undefined,
    testedAt: nowIso(),
    cache: { hit: cache, ttlSeconds: CACHE_TTL_MS / 1000 },
  }
}

async function runModelRuntimeTest({
  model,
  capability = 'text',
  mode = 'gateway',
  config = {},
  refresh = false,
  spawnImpl,
} = {}) {
  const modelRef = String(model || '').trim()
  if (!modelRef) {
    return buildResult({
      ok: false,
      status: 'model_not_found',
      model: modelRef,
      capability,
      mode,
      runtimeVersion: 'unknown',
      durationMs: 0,
      summary: 'Model ref is required',
      safeMessage: 'กรุณาเลือก model ก่อนทดสอบ',
    })
  }
  if (!providerForRef(modelRef)) {
    return buildResult({
      ok: false,
      status: 'model_not_found',
      model: modelRef,
      capability,
      mode,
      runtimeVersion: 'unknown',
      durationMs: 0,
      summary: 'Model ref must use provider/model format',
      safeMessage: 'Model ต้องอยู่ในรูปแบบ provider/model',
    })
  }

  const runtimeVersion = await getOpenclawVersion({ spawnImpl })
  const key = cacheKey({ model: modelRef, capability, mode, config, runtimeVersion })
  const cached = runtimeTestCache.get(key)
  if (!refresh && cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return { ...cached.result, cache: { hit: true, ttlSeconds: Math.ceil((CACHE_TTL_MS - (Date.now() - cached.cachedAt)) / 1000) } }
  }

  if (activeRuntimeTests >= MAX_ACTIVE_RUNTIME_TESTS) {
    return buildResult({
      ok: false,
      status: 'runtime_unavailable',
      model: modelRef,
      capability,
      mode,
      runtimeVersion,
      durationMs: 0,
      summary: 'Too many runtime model tests are already running',
      safeMessage: 'มีการทดสอบ model อยู่แล้ว กรุณารอสักครู่',
    })
  }

  let imagePath = null
  activeRuntimeTests += 1
  try {
    const isImage = capability === 'image'
    if (isImage) imagePath = writeSampleImage()
    const args = [
      'infer',
      'model',
      'run',
      '--gateway',
      '--model',
      modelRef,
      '--prompt',
      isImage ? IMAGE_TEST_PROMPT : TEST_PROMPT,
      '--json',
    ]
    if (imagePath) args.push('--file', imagePath)

    const commandResult = await runCommand(args, {
      timeoutMs: isImage ? IMAGE_TIMEOUT_MS : TEXT_TIMEOUT_MS,
      spawnImpl,
    })
    const combined = `${commandResult.stderr || ''}\n${commandResult.stdout || ''}`
    if (commandResult.error || commandResult.exitCode !== 0 || commandResult.timedOut) {
      const failure = classifyFailure(combined || commandResult.error?.message, commandResult.timedOut)
      const result = buildResult({
        ok: false,
        status: failure.status,
        model: modelRef,
        capability,
        mode,
        runtimeVersion,
        durationMs: commandResult.durationMs,
        summary: failure.summary,
        safeMessage: failure.safeMessage,
        detail: combined || commandResult.error?.message,
      })
      return cacheRuntimeTest(key, result)
    }

    const data = parseJsonOutput(commandResult.stdout)
    const outputText = (data?.outputs || [])
      .map(item => item?.text || '')
      .filter(Boolean)
      .join('\n')
      .trim()
    if (!data?.ok) {
      const outputValidation = outputText
        ? validateRuntimeOutput(outputText, { capability })
        : null
      if (outputValidation && !outputValidation.ok) {
        const result = buildResult({
          ok: false,
          status: outputValidation.status,
          model: modelRef,
          capability,
          mode,
          runtimeVersion,
          durationMs: commandResult.durationMs,
          summary: outputValidation.summary,
          safeMessage: outputValidation.safeMessage,
          expectedOutput: outputValidation.expectedOutput,
          outputPreview: outputValidation.outputPreview,
          failureReason: outputValidation.failureReason,
          data,
          detail: combined,
        })
        return cacheRuntimeTest(key, result)
      }
      const failure = classifyFailure(JSON.stringify(data || {}) || combined)
      const result = buildResult({
        ok: false,
        status: failure.status === 'provider_error' ? 'provider_error' : failure.status,
        model: modelRef,
        capability,
        mode,
        runtimeVersion,
        durationMs: commandResult.durationMs,
        summary: failure.summary,
        safeMessage: failure.safeMessage,
        outputPreview: outputText.slice(0, 240),
        failureReason: 'runtime_json_not_ok',
        data,
        detail: combined,
      })
      return cacheRuntimeTest(key, result)
    }

    const outputValidation = validateRuntimeOutput(outputText, { capability })
    if (!outputValidation.ok) {
      const result = buildResult({
        ok: false,
        status: outputValidation.status,
        model: modelRef,
        capability,
        mode,
        runtimeVersion,
        durationMs: commandResult.durationMs,
        summary: outputValidation.summary,
        safeMessage: outputValidation.safeMessage,
        expectedOutput: outputValidation.expectedOutput,
        outputPreview: outputValidation.outputPreview,
        failureReason: outputValidation.failureReason,
        data,
        detail: combined,
      })
      return cacheRuntimeTest(key, result)
    }

    const result = buildResult({
      ok: true,
      status: 'runtime_verified',
      model: modelRef,
      capability,
      mode,
      runtimeVersion,
      durationMs: commandResult.durationMs,
      summary: 'OpenClaw runtime inference test passed',
      safeMessage: 'Runtime เรียก model นี้ได้สำเร็จ',
      expectedOutput: outputValidation.expectedOutput,
      outputPreview: outputValidation.outputPreview,
      data: {
        provider: data.provider || null,
        model: data.model || null,
        attempts: Array.isArray(data.attempts) ? data.attempts.slice(0, 5) : [],
        outputPreview: outputValidation.outputPreview,
      },
    })
    return cacheRuntimeTest(key, result)
  } finally {
    activeRuntimeTests -= 1
    if (imagePath) {
      try { fs.unlinkSync(imagePath) } catch {}
    }
  }
}

async function runModelMessageTest({
  model,
  prompt,
  capability = 'text',
  mode = 'gateway',
  config = {},
  spawnImpl,
} = {}) {
  const modelRef = String(model || '').trim()
  const cleanPrompt = String(prompt || '').trim().slice(0, MAX_MESSAGE_TEST_PROMPT_CHARS)
  if (!modelRef) {
    return buildResult({
      ok: false,
      status: 'model_not_found',
      model: modelRef,
      capability,
      mode,
      runtimeVersion: 'unknown',
      durationMs: 0,
      summary: 'Model ref is required',
      safeMessage: 'กรุณาเลือก model ก่อนทดสอบ',
    })
  }
  if (!cleanPrompt) {
    return buildResult({
      ok: false,
      status: 'invalid_output',
      model: modelRef,
      capability,
      mode,
      runtimeVersion: 'unknown',
      durationMs: 0,
      summary: 'Prompt is required',
      safeMessage: 'กรุณาพิมพ์ข้อความทดสอบก่อน',
      failureReason: 'empty_prompt',
    })
  }
  if (!providerForRef(modelRef)) {
    return buildResult({
      ok: false,
      status: 'model_not_found',
      model: modelRef,
      capability,
      mode,
      runtimeVersion: 'unknown',
      durationMs: 0,
      summary: 'Model ref must use provider/model format',
      safeMessage: 'Model ต้องอยู่ในรูปแบบ provider/model',
    })
  }

  const runtimeVersion = await getOpenclawVersion({ spawnImpl })
  const key = cacheKey({ model: modelRef, capability, mode, config, runtimeVersion })
  const cacheAndReturn = result => cacheRuntimeTest(key, result)
  if (activeRuntimeTests >= MAX_ACTIVE_RUNTIME_TESTS) {
    return buildResult({
      ok: false,
      status: 'runtime_unavailable',
      model: modelRef,
      capability,
      mode,
      runtimeVersion,
      durationMs: 0,
      summary: 'Too many runtime model tests are already running',
      safeMessage: 'มีการทดสอบ model อยู่แล้ว กรุณารอสักครู่',
    })
  }

  activeRuntimeTests += 1
  try {
    const args = [
      'infer',
      'model',
      'run',
      '--gateway',
      '--model',
      modelRef,
      '--prompt',
      cleanPrompt,
      '--json',
    ]

    const commandResult = await runCommand(args, {
      timeoutMs: TEXT_TIMEOUT_MS,
      spawnImpl,
    })
    const combined = `${commandResult.stderr || ''}\n${commandResult.stdout || ''}`
    if (commandResult.error || commandResult.exitCode !== 0 || commandResult.timedOut) {
      const failure = classifyFailure(combined || commandResult.error?.message, commandResult.timedOut)
      return cacheAndReturn(buildResult({
        ok: false,
        status: failure.status,
        model: modelRef,
        capability,
        mode,
        runtimeVersion,
        durationMs: commandResult.durationMs,
        summary: failure.summary,
        safeMessage: failure.safeMessage,
        detail: combined || commandResult.error?.message,
      }))
    }

    const data = parseJsonOutput(commandResult.stdout)
    const outputText = (data?.outputs || [])
      .map(item => item?.text || '')
      .filter(Boolean)
      .join('\n')
      .trim()
    if (!data?.ok) {
      const failure = classifyFailure(JSON.stringify(data || {}) || combined)
      return cacheAndReturn(buildResult({
        ok: false,
        status: failure.status === 'provider_error' ? 'provider_error' : failure.status,
        model: modelRef,
        capability,
        mode,
        runtimeVersion,
        durationMs: commandResult.durationMs,
        summary: failure.summary,
        safeMessage: failure.safeMessage,
        outputPreview: outputText.slice(0, MAX_MESSAGE_TEST_PREVIEW_CHARS),
        failureReason: 'runtime_json_not_ok',
        data,
        detail: combined,
      }))
    }
    if (!outputText || looksLikeRuntimeErrorOutput(outputText)) {
      return cacheAndReturn(buildResult({
        ok: false,
        status: 'invalid_output',
        model: modelRef,
        capability,
        mode,
        runtimeVersion,
        durationMs: commandResult.durationMs,
        summary: outputText ? 'Runtime returned an error message as model output' : 'Runtime returned no text output',
        safeMessage: outputText
          ? 'Runtime เรียก model แล้วได้ข้อความ error กลับมา ไม่ควรใช้ใน production'
          : 'Runtime ทดสอบแล้วไม่พบข้อความตอบกลับ',
        outputPreview: outputText.slice(0, MAX_MESSAGE_TEST_PREVIEW_CHARS),
        failureReason: outputText ? 'error_text_output' : 'empty_output',
        data,
        detail: combined,
      }))
    }

    return cacheAndReturn(buildResult({
      ok: true,
      status: 'runtime_verified',
      model: modelRef,
      capability,
      mode,
      runtimeVersion,
      durationMs: commandResult.durationMs,
      summary: 'OpenClaw runtime message test passed',
      safeMessage: 'Runtime เรียก model นี้ได้สำเร็จ',
      outputPreview: outputText.slice(0, MAX_MESSAGE_TEST_PREVIEW_CHARS),
      data: {
        provider: data.provider || null,
        model: data.model || null,
        attempts: Array.isArray(data.attempts) ? data.attempts.slice(0, 5) : [],
        outputPreview: outputText.slice(0, MAX_MESSAGE_TEST_PREVIEW_CHARS),
      },
    }))
  } finally {
    activeRuntimeTests -= 1
  }
}

async function runModelImageMessageTest({
  model,
  prompt,
  image,
  capability = 'image',
  mode = 'gateway',
  config = {},
  spawnImpl,
} = {}) {
  const modelRef = String(model || '').trim()
  const cleanPrompt = String(prompt || '').trim().slice(0, MAX_MESSAGE_TEST_PROMPT_CHARS)
  if (!modelRef) {
    return buildResult({
      ok: false,
      status: 'model_not_found',
      model: modelRef,
      capability,
      mode,
      runtimeVersion: 'unknown',
      durationMs: 0,
      summary: 'Model ref is required',
      safeMessage: 'กรุณาเลือก model ก่อนทดสอบ',
    })
  }
  if (!cleanPrompt) {
    return buildResult({
      ok: false,
      status: 'invalid_output',
      model: modelRef,
      capability,
      mode,
      runtimeVersion: 'unknown',
      durationMs: 0,
      summary: 'Prompt is required',
      safeMessage: 'กรุณาพิมพ์ข้อความทดสอบรูปภาพก่อน',
      failureReason: 'empty_prompt',
    })
  }
  if (!providerForRef(modelRef)) {
    return buildResult({
      ok: false,
      status: 'model_not_found',
      model: modelRef,
      capability,
      mode,
      runtimeVersion: 'unknown',
      durationMs: 0,
      summary: 'Model ref must use provider/model format',
      safeMessage: 'Model ต้องอยู่ในรูปแบบ provider/model',
    })
  }

  const runtimeVersion = await getOpenclawVersion({ spawnImpl })
  const key = cacheKey({ model: modelRef, capability, mode, config, runtimeVersion })
  const cacheAndReturn = result => cacheRuntimeTest(key, result)
  if (activeRuntimeTests >= MAX_ACTIVE_RUNTIME_TESTS) {
    return buildResult({
      ok: false,
      status: 'runtime_unavailable',
      model: modelRef,
      capability,
      mode,
      runtimeVersion,
      durationMs: 0,
      summary: 'Too many runtime model tests are already running',
      safeMessage: 'มีการทดสอบ model อยู่แล้ว กรุณารอสักครู่',
    })
  }

  const uploaded = writeUploadedImage(image)
  if (!uploaded.ok) {
    return buildResult({
      ok: false,
      status: uploaded.status,
      model: modelRef,
      capability,
      mode,
      runtimeVersion,
      durationMs: 0,
      summary: uploaded.summary,
      safeMessage: uploaded.safeMessage,
    })
  }

  activeRuntimeTests += 1
  try {
    const args = [
      'infer',
      'model',
      'run',
      '--gateway',
      '--model',
      modelRef,
      '--prompt',
      cleanPrompt,
      '--json',
      '--file',
      uploaded.path,
    ]

    const commandResult = await runCommand(args, {
      timeoutMs: IMAGE_TIMEOUT_MS,
      spawnImpl,
    })
    const combined = `${commandResult.stderr || ''}\n${commandResult.stdout || ''}`
    if (commandResult.error || commandResult.exitCode !== 0 || commandResult.timedOut) {
      const failure = classifyFailure(combined || commandResult.error?.message, commandResult.timedOut)
      return cacheAndReturn(buildResult({
        ok: false,
        status: failure.status,
        model: modelRef,
        capability,
        mode,
        runtimeVersion,
        durationMs: commandResult.durationMs,
        summary: failure.summary,
        safeMessage: failure.safeMessage,
        detail: combined || commandResult.error?.message,
      }))
    }

    const data = parseJsonOutput(commandResult.stdout)
    const outputText = (data?.outputs || [])
      .map(item => item?.text || '')
      .filter(Boolean)
      .join('\n')
      .trim()
    if (!data?.ok) {
      const failure = classifyFailure(JSON.stringify(data || {}) || combined)
      return cacheAndReturn(buildResult({
        ok: false,
        status: failure.status === 'provider_error' ? 'provider_error' : failure.status,
        model: modelRef,
        capability,
        mode,
        runtimeVersion,
        durationMs: commandResult.durationMs,
        summary: failure.summary,
        safeMessage: failure.safeMessage,
        outputPreview: outputText.slice(0, MAX_MESSAGE_TEST_PREVIEW_CHARS),
        failureReason: 'runtime_json_not_ok',
        data,
        detail: combined,
      }))
    }
    if (!outputText || looksLikeRuntimeErrorOutput(outputText)) {
      return cacheAndReturn(buildResult({
        ok: false,
        status: 'invalid_output',
        model: modelRef,
        capability,
        mode,
        runtimeVersion,
        durationMs: commandResult.durationMs,
        summary: outputText ? 'Runtime returned an error message as model output' : 'Runtime returned no text output',
        safeMessage: outputText
          ? 'Runtime เรียก model แล้วได้ข้อความ error กลับมา ไม่ควรใช้ใน production'
          : 'Runtime ทดสอบแล้วไม่พบข้อความตอบกลับ',
        outputPreview: outputText.slice(0, MAX_MESSAGE_TEST_PREVIEW_CHARS),
        failureReason: outputText ? 'error_text_output' : 'empty_output',
        data,
        detail: combined,
      }))
    }

    return cacheAndReturn(buildResult({
      ok: true,
      status: 'runtime_verified',
      model: modelRef,
      capability,
      mode,
      runtimeVersion,
      durationMs: commandResult.durationMs,
      summary: 'OpenClaw runtime image message test passed',
      safeMessage: 'Runtime เรียก model รูปภาพนี้ได้สำเร็จ',
      outputPreview: outputText.slice(0, MAX_MESSAGE_TEST_PREVIEW_CHARS),
      data: {
        provider: data.provider || null,
        model: data.model || null,
        attempts: Array.isArray(data.attempts) ? data.attempts.slice(0, 5) : [],
        outputPreview: outputText.slice(0, MAX_MESSAGE_TEST_PREVIEW_CHARS),
      },
    }))
  } finally {
    activeRuntimeTests -= 1
    try { fs.unlinkSync(uploaded.path) } catch {}
  }
}

function runtimeStatusForRef(ref, { capability = 'text', config = {} } = {}) {
  if (!ref) {
    return {
      runtimeStatus: 'not_configured',
      runtimeSummary: 'No model configured',
      runtimeTestedAt: null,
      runtimeDurationMs: null,
      runtimeVersion: null,
    }
  }
  const cached = getCachedRuntimeTest({ model: ref, capability, config, maxAgeMs: STATUS_CACHE_TTL_MS })
  if (!cached) {
    return {
      runtimeStatus: 'runtime_unverified',
      runtimeSummary: 'Runtime test has not been run for this model',
      runtimeTestedAt: null,
      runtimeDurationMs: null,
      runtimeVersion: null,
    }
  }
  return {
    runtimeStatus: cached.ok ? 'runtime_verified' : cached.status,
    runtimeSummary: cached.safeMessage || cached.summary,
    runtimeTestedAt: cached.testedAt || null,
    runtimeDurationMs: cached.durationMs ?? null,
    runtimeVersion: cached.runtimeVersion || null,
  }
}

function clearModelRuntimeTestCache() {
  runtimeTestCache.clear()
  versionCache = null
  persistentCacheLoaded = true
  try { fs.unlinkSync(PERSISTED_CACHE_PATH) } catch {}
}

module.exports = {
  CACHE_TTL_MS,
  IMAGE_TIMEOUT_MS,
  STATUS_CACHE_TTL_MS,
  TEXT_TIMEOUT_MS,
  clearModelRuntimeTestCache,
  getCachedRuntimeTest,
  getOpenclawVersion,
  keyFingerprintForRef,
  runModelImageMessageTest,
  runModelMessageTest,
  runModelRuntimeTest,
  runtimeStatusForRef,
  _internal: {
    cacheKey,
    classifyFailure,
    commandParts,
    parseJsonOutput,
    providerForRef,
    redact,
    runCommand,
    normalizeImageUpload,
    validateRuntimeOutput,
  },
}
