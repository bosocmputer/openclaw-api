const router = require('express').Router()
const fs = require('fs')
const path = require('path')
const { exec } = require('child_process')
const { HOME, execOpts } = require('../lib/config')
const { readUserNames } = require('../lib/files')

// cleanStaleSessions — ลบ sessions ที่ทำให้ webchat ตอบผ่าน LINE ผิดช่อง
// 1. key=*:main ที่มี lastChannel=line (gateway fallback session)
// 2. key=*:hook:webchat:* ที่ไม่มี uid: prefix (เวอร์ชันเก่าก่อน uid: fix)
function cleanStaleSessions() {
  try {
    const agentsBase = path.join(HOME, '.openclaw/agents')
    if (!fs.existsSync(agentsBase)) return
    for (const agentId of fs.readdirSync(agentsBase)) {
      const sessFile = path.join(agentsBase, agentId, 'sessions/sessions.json')
      if (!fs.existsSync(sessFile)) continue
      const data = JSON.parse(fs.readFileSync(sessFile, 'utf8'))
      const toDelete = Object.keys(data).filter(key =>
        (key.endsWith(':main') && data[key]?.lastChannel === 'line') ||
        (key.includes(':hook:webchat:') && !key.includes(':hook:webchat:uid:'))
      )
      if (toDelete.length === 0) continue
      for (const k of toDelete) delete data[k]
      fs.writeFileSync(sessFile, JSON.stringify(data, null, 2))
      console.log(`[cleanStaleSessions] ${agentId}: removed ${toDelete.length} stale session(s): ${toDelete.join(', ')}`)
    }
  } catch (e) {
    console.error('[cleanStaleSessions] error:', e.message)
  }
}

// POST /api/gateway/clean-sessions — trigger cleanStaleSessions manually
router.post('/clean-sessions', (req, res) => {
  cleanStaleSessions()
  res.json({ ok: true })
})

// รัน cleanStaleSessions อัตโนมัติทุกวัน ตี 3 (ช่วงที่ไม่มีการใช้งาน)
const CLEAN_INTERVAL_MS = 24 * 60 * 60 * 1000
function scheduleDailyClean() {
  const now = new Date()
  const next3am = new Date(now)
  next3am.setHours(3, 0, 0, 0)
  if (next3am <= now) next3am.setDate(next3am.getDate() + 1)
  const msUntil3am = next3am - now
  setTimeout(() => {
    cleanStaleSessions()
    setInterval(cleanStaleSessions, CLEAN_INTERVAL_MS)
  }, msUntil3am)
}
scheduleDailyClean()

// POST /api/gateway/restart — restart gateway
router.post('/restart', (req, res) => {
  cleanStaleSessions()
  exec(
    'openclaw gateway restart',
    execOpts,
    (err) => {
      if (err) return res.status(500).json({ error: err.message })
      res.json({ ok: true })
    }
  )
})

// GET /api/gateway/logs — ดู gateway log ล่าสุด (parse JSONL format)
router.get('/logs', (req, res) => {
  try {
    const limit = parseInt(req.query.lines || '200')
    // หา log file ล่าสุดใน /tmp/openclaw/
    const logDir = '/tmp/openclaw'
    let logPath = null
    if (fs.existsSync(logDir)) {
      const files = fs.readdirSync(logDir)
        .filter(f => f.endsWith('.log'))
        .map(f => ({ name: f, mtime: fs.statSync(path.join(logDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)
      if (files.length > 0) logPath = path.join(logDir, files[0].name)
    }
    if (!logPath || !fs.existsSync(logPath)) return res.json([])

    const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean)
    const entries = []
    for (const line of lines.slice(-limit)) {
      try {
        const obj = JSON.parse(line)
        const rawMsg = obj['1'] ?? obj['0'] ?? ''
        const msg = typeof rawMsg === 'object' ? JSON.stringify(rawMsg) : String(rawMsg)
        const level = obj._meta?.logLevelName || 'INFO'
        const time = obj.time || obj._meta?.date || ''
        const subsystem = (() => {
          try { return JSON.parse(obj['0'])?.subsystem || '' } catch { return '' }
        })()
        entries.push({ time, level, subsystem, msg })
      } catch {
        // plain text line
        entries.push({ time: '', level: 'INFO', subsystem: '', msg: line })
      }
    }
    res.json(entries)
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ─── Separate routers for routes not under /api/gateway ──────────────────────

const usernamesRouter = require('express').Router()
// GET /api/usernames — อ่าน usernames.json
usernamesRouter.get('/', (req, res) => {
  res.json(readUserNames())
})

const doctorRouter = require('express').Router()
// GET /api/doctor/status — เช็ค config valid/invalid
doctorRouter.get('/status', (req, res) => {
  exec('openclaw doctor', { ...execOpts, timeout: 15000 }, (err, stdout, stderr) => {
    const output = stdout + stderr
    const invalid = output.includes('Config invalid') || output.includes('Invalid config')
    const problems = []
    const problemMatch = output.match(/Problem:\s*([\s\S]*?)(?:\n\n|\nRun:|$)/m)
    if (problemMatch) {
      problemMatch[1].trim().split('\n')
        .map(l => l.trim())
        .filter(l => l.startsWith('-'))
        .forEach(l => problems.push(l.slice(1).trim()))
    }
    res.json({ valid: !invalid, problems })
  })
})

// POST /api/doctor/fix — รัน openclaw doctor --fix
doctorRouter.post('/fix', (req, res) => {
  exec('openclaw doctor --fix', { ...execOpts, timeout: 30000 }, (err, stdout, stderr) => {
    if (err && !stdout.includes('Doctor complete')) {
      return res.status(500).json({ error: stderr || err.message })
    }
    res.json({ ok: true, output: stdout })
  })
})

module.exports = { router, usernamesRouter, doctorRouter }
