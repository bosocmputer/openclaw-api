/**
 * /api/auth/anthropic — OAuth 2.0 + PKCE flow สำหรับ Claude Pro/Max subscription
 *
 * Flow:
 *   1. POST /api/auth/anthropic/start  → สร้าง URL + เก็บ session state (verifier, state)
 *   2. User เปิด URL ใน browser → login → claude.ai redirect ไปที่ localhost (error ปกติ)
 *   3. User copy URL จาก address bar มาส่ง POST /api/auth/anthropic/submit
 *   4. ระบบแลก code → access_token → เก็บใน openclaw.json (ANTHROPIC_API_KEY)
 */

const router = require('express').Router()
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { CONFIG_PATH, HOME } = require('../lib/config')

const CLIENT_ID = Buffer.from('OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl', 'base64').toString('utf8')
const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize'
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
const REDIRECT_URI = 'http://localhost:53692/callback'
const SCOPES = 'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload'

// เก็บ session ลงไฟล์ (ทนต่อ pm2 restart)
const SESSION_FILE = path.join(HOME, '.openclaw', 'oauth-pending.json')

function savePendingSession(session) {
  try { fs.writeFileSync(SESSION_FILE, JSON.stringify(session), { mode: 0o600 }) } catch {}
}

function loadPendingSession() {
  try {
    const s = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'))
    if (s && Date.now() < s.expiresAt) return s
    clearPendingSession()
    return null
  } catch { return null }
}

function clearPendingSession() {
  try { fs.unlinkSync(SESSION_FILE) } catch {}
}

// ─── PKCE helpers (Web Crypto API — available in Node.js 18+) ────────────────

function base64urlEncode(buffer) {
  return Buffer.from(buffer).toString('base64url')
}

async function generatePKCE() {
  const verifierBytes = crypto.randomBytes(32)
  const verifier = base64urlEncode(verifierBytes)
  const hash = crypto.createHash('sha256').update(verifier).digest()
  const challenge = base64urlEncode(hash)
  return { verifier, challenge }
}

function generateState() {
  return base64urlEncode(crypto.randomBytes(32))
}

function parseRedirectUrl(input) {
  // รับ URL เต็ม หรือ query string หรือ code ล้วน
  // รองรับทั้ง: localhost:53692/callback?code=... และ chang168.../oauth/callback?code=...
  try {
    const url = new URL(input)
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    if (code) return { code, state }
  } catch {}
  // ลอง parse เป็น query string
  try {
    const queryPart = input.includes('?') ? input.split('?')[1] : input
    const params = new URLSearchParams(queryPart)
    const code = params.get('code')
    const state = params.get('state')
    if (code) return { code, state }
  } catch {}
  return { code: input.trim(), state: null }
}

// ─── POST /api/auth/anthropic/start ─────────────────────────────────────────

router.post('/anthropic/start', async (req, res) => {
  try {
    const { verifier, challenge } = await generatePKCE()
    const state = generateState()

    // เก็บ session ลงไฟล์ (TTL 10 นาที — ทนต่อ pm2 restart)
    savePendingSession({
      verifier,
      state,
      expiresAt: Date.now() + 10 * 60 * 1000,
    })

    const authParams = new URLSearchParams({
      code: 'true',
      client_id: CLIENT_ID,
      response_type: 'code',
      redirect_uri: REDIRECT_URI,
      scope: SCOPES,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
    })

    const authUrl = `${AUTHORIZE_URL}?${authParams.toString()}`

    res.json({
      ok: true,
      url: authUrl,
      instructions: 'เปิด URL ในหน้าต่างใหม่ → Login → claude.ai จะ redirect ไปที่ localhost (browser จะแสดง error — ปกติ) → Copy URL ทั้งหมดจาก address bar มาวางในช่องถัดไป',
    })
  } catch (e) {
    console.error('[openclaw-api] auth/anthropic/start', e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ─── POST /api/auth/anthropic/submit ────────────────────────────────────────

router.post('/anthropic/submit', async (req, res) => {
  try {
    const { redirectUrl } = req.body
    if (!redirectUrl) return res.status(400).json({ error: 'redirectUrl required' })

    const pendingSession = loadPendingSession()
    if (!pendingSession) {
      return res.status(400).json({ error: 'Session expired — กรุณากด "เชื่อมต่อ" ใหม่อีกครั้ง' })
    }

    const { code, state } = parseRedirectUrl(redirectUrl)
    if (!code) return res.status(400).json({ error: 'ไม่พบ authorization code ใน URL' })

    // ตรวจ state เพื่อป้องกัน CSRF (ถ้ามี)
    if (state && state !== pendingSession.state) {
      clearPendingSession()
      return res.status(400).json({ error: 'State mismatch — กรุณากด "เชื่อมต่อ" ใหม่' })
    }

    const { verifier } = pendingSession
    clearPendingSession()

    // แลก code → access_token
    const tokenBody = {
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code,
      state: state || pendingSession.state,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }
    console.log('[openclaw-api] token exchange body keys:', Object.keys(tokenBody))
    const tokenResponse = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tokenBody),
      signal: AbortSignal.timeout(15000),
    })

    if (!tokenResponse.ok) {
      const body = await tokenResponse.text().catch(() => '')
      console.error('[openclaw-api] token exchange failed', tokenResponse.status, body.slice(0, 500))
      return res.status(502).json({ error: `Anthropic token exchange failed (${tokenResponse.status}): ${body.slice(0, 200)}` })
    }

    const tokenData = await tokenResponse.json()
    const accessToken = tokenData.access_token
    if (!accessToken) {
      return res.status(502).json({ error: 'ไม่ได้รับ access_token จาก Anthropic' })
    }

    // เก็บ token ใน openclaw.json เป็น ANTHROPIC_API_KEY
    let config = {}
    try { config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) } catch {}
    if (!config.env) config.env = {}
    config.env.ANTHROPIC_API_KEY = accessToken
    const tmpPath = CONFIG_PATH + '.tmp'
    fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2))
    fs.renameSync(tmpPath, CONFIG_PATH)

    res.json({ ok: true, message: 'เชื่อมต่อ Anthropic Account สำเร็จ — token บันทึกแล้ว' })
  } catch (e) {
    console.error('[openclaw-api] auth/anthropic/submit', e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router
