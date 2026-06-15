const fs = require('fs')
const path = require('path')
const { CONFIG_PATH } = require('./config')

let configQueue = Promise.resolve()

function backupId() {
  return new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)
}

function readOpenclawConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
}

function fsyncDir(filePath) {
  try {
    const fd = fs.openSync(path.dirname(filePath), 'r')
    try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  } catch {}
}

function writeFileSynced(filePath, content, mode) {
  const fd = fs.openSync(filePath, 'w', mode)
  try {
    fs.writeFileSync(fd, content)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

function acquireFileLock(lockPath, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      return fs.openSync(lockPath, 'wx', 0o600)
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      try {
        const stat = fs.statSync(lockPath)
        if (Date.now() - stat.mtimeMs > 15_000) fs.unlinkSync(lockPath)
      } catch {}
      const start = Date.now()
      while (Date.now() - start < 25) {}
    }
  }
  throw new Error(`Timed out waiting for config lock: ${lockPath}`)
}

function writeOpenclawConfigAtomic(nextConfig, opts = {}) {
  if (!nextConfig || typeof nextConfig !== 'object' || Array.isArray(nextConfig)) {
    throw new Error('openclaw config must be a JSON object')
  }

  const id = opts.backupId || backupId()
  const serialized = JSON.stringify(nextConfig, null, 2)
  JSON.parse(serialized)

  const backupPath = `${CONFIG_PATH}.bak.${id}`
  const tmpPath = `${CONFIG_PATH}.tmp.${process.pid}.${Date.now()}`
  const lockPath = `${CONFIG_PATH}.lock`
  const lockFd = acquireFileLock(lockPath)

  try {
    if (fs.existsSync(CONFIG_PATH) && !fs.existsSync(backupPath)) {
      fs.copyFileSync(CONFIG_PATH, backupPath)
    }

    writeFileSynced(tmpPath, serialized, 0o600)
    fs.renameSync(tmpPath, CONFIG_PATH)
    fsyncDir(CONFIG_PATH)
  } finally {
    try { fs.closeSync(lockFd) } catch {}
    try { fs.unlinkSync(lockPath) } catch {}
    try { fs.unlinkSync(tmpPath) } catch {}
  }

  return {
    ok: true,
    backupId: id,
    backupPath: fs.existsSync(backupPath) ? backupPath : null,
    bytes: Buffer.byteLength(serialized),
    reason: opts.reason || 'config-write',
  }
}

function withConfigLock(fn) {
  const run = configQueue.then(() => Promise.resolve().then(fn))
  configQueue = run.catch(() => {})
  return run
}

function updateOpenclawConfig(mutator, opts = {}) {
  return withConfigLock(() => {
    const config = readOpenclawConfig()
    const next = mutator(config) || config
    return writeOpenclawConfigAtomic(next, opts)
  })
}

module.exports = {
  readOpenclawConfig,
  writeOpenclawConfigAtomic,
  updateOpenclawConfig,
  withConfigLock,
  backupId,
}
