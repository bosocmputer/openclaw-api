const router = require('express').Router()
const fs = require('fs')
const path = require('path')
const { HOME, CONFIG_PATH } = require('../lib/config')
const { pgPool, requirePg } = require('../lib/pg')

// Strip gateway-injected metadata headers from user messages (Telegram + Webchat)
function stripGatewayMetadata(text) {
  if (!text) return text
  let result = text
  // Strip: "Conversation info (untrusted metadata):\n```json\n{...}\n```\n\n[Sender ...]\n\n"
  result = result.replace(/(?:Conversation info \(untrusted metadata\):[\s\S]*?```\s*\n+)+(?:Sender \(untrusted metadata\):[\s\S]*?```\s*\n+)?/, '')
  // Strip: "Task: Hook | Job ID: ... | Received: ...\n\nSECURITY NOTICE: ...\n- DO NOT ...\n...\n\n"
  result = result.replace(/Task: Hook \|[\s\S]*?SECURITY NOTICE:[\s\S]*?(?:\n- [^\n]+)+\n*/, '')
  return result.trim()
}

// GET /api/webchat/rooms?username=xxx  — list rooms (กรอง policy=allowlist ตาม username)
router.get('/rooms', requirePg, async (req, res) => {
  try {
    const { username } = req.query
    const { rows } = await pgPool.query(`
      SELECT r.id, r.agent_id, r.display_name, r.policy, r.created_at,
             COALESCE(json_agg(u.username) FILTER (WHERE u.username IS NOT NULL), '[]') AS allowed_users
      FROM webchat_rooms r
      LEFT JOIN webchat_room_users u ON u.room_id = r.id
      GROUP BY r.id ORDER BY r.created_at ASC
    `)
    // ถ้าส่ง username มา → กรอง open ทุกห้อง + allowlist เฉพาะห้องที่ user อยู่
    if (username) {
      const filtered = rows.filter(r =>
        r.policy === 'open' || r.allowed_users.includes(username)
      )
      return res.json(filtered)
    }
    res.json(rows)
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/webchat/rooms
router.post('/rooms', requirePg, async (req, res) => {
  try {
    const { agent_id, display_name, policy } = req.body
    if (!agent_id) return res.status(400).json({ error: 'agent_id required' })
    const p = policy || 'open'
    if (!['open', 'allowlist'].includes(p)) return res.status(400).json({ error: 'invalid policy' })
    const { rows } = await pgPool.query(
      'INSERT INTO webchat_rooms (agent_id, display_name, policy) VALUES ($1, $2, $3) RETURNING *',
      [agent_id.trim(), display_name || agent_id.trim(), p]
    )
    res.json({ ...rows[0], allowed_users: [] })
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    if (e.code === '23505') return res.status(400).json({ error: 'agent_id นี้มีห้องอยู่แล้ว' })
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT /api/webchat/rooms/:id
router.put('/rooms/:id', requirePg, async (req, res) => {
  try {
    const { id } = req.params
    const { display_name, policy } = req.body
    if (display_name !== undefined) {
      await pgPool.query('UPDATE webchat_rooms SET display_name = $1 WHERE id = $2', [display_name, id])
    }
    if (policy !== undefined) {
      if (!['open', 'allowlist'].includes(policy)) return res.status(400).json({ error: 'invalid policy' })
      await pgPool.query('UPDATE webchat_rooms SET policy = $1 WHERE id = $2', [policy, id])
    }
    res.json({ ok: true })
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/webchat/rooms/:id
router.delete('/rooms/:id', requirePg, async (req, res) => {
  try {
    await pgPool.query('DELETE FROM webchat_rooms WHERE id = $1', [req.params.id])
    res.json({ ok: true })
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/webchat/rooms/:id/users  { username }
router.post('/rooms/:id/users', requirePg, async (req, res) => {
  try {
    const { id } = req.params
    const { username } = req.body
    if (!username) return res.status(400).json({ error: 'username required' })
    await pgPool.query(
      'INSERT INTO webchat_room_users (room_id, username) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [id, username]
    )
    res.json({ ok: true })
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/webchat/rooms/:id/users/:username
router.delete('/rooms/:id/users/:username', requirePg, async (req, res) => {
  try {
    await pgPool.query(
      'DELETE FROM webchat_room_users WHERE room_id = $1 AND username = $2',
      [req.params.id, req.params.username]
    )
    res.json({ ok: true })
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/webchat/history/:roomId?username=xxx  — ดึง messages ของ user ใน room
router.get('/history/:roomId', requirePg, async (req, res) => {
  try {
    const { roomId } = req.params
    const { username } = req.query
    let query = 'SELECT id, username, role, content, run_id, created_at FROM webchat_messages WHERE room_id = $1'
    const params = [roomId]
    if (username) {
      // ดึงเฉพาะ messages ของ user นี้ (user rows) + assistant rows ที่ตอบ user นี้ (ผ่าน session)
      // ง่ายสุด: ดึงทุก row ของ room ที่ username ตรง หรือ role=assistant ที่อยู่ใน conversation นี้
      query += ' AND username = $2 ORDER BY created_at ASC'
      params.push(username)
    } else {
      query += ' ORDER BY created_at ASC'
    }
    const { rows } = await pgPool.query(query, params)
    res.json(rows)
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/webchat/send  { roomId, username, message }
router.post('/send', requirePg, async (req, res) => {
  try {
    const { roomId, username, message } = req.body
    if (!roomId || !username || !message) return res.status(400).json({ error: 'roomId, username, message required' })

    // หา room + agentId
    const roomRes = await pgPool.query('SELECT agent_id FROM webchat_rooms WHERE id = $1', [roomId])
    if (!roomRes.rows.length) return res.status(404).json({ error: 'room not found' })
    const agentId = roomRes.rows[0].agent_id

    // อ่าน config เพื่อหา hooks port
    let config = {}
    try { config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) } catch {}
    const hooksPort = config?.gateway?.hooksPort || 18789
    const hooksToken = process.env.HOOKS_TOKEN || config?.hooks?.token || ''
    const sessionKey = `hook:webchat:uid:${username}`

    // บันทึก user message ก่อน
    await pgPool.query(
      'INSERT INTO webchat_messages (room_id, username, role, content) VALUES ($1, $2, $3, $4)',
      [roomId, username, 'user', message]
    )

    // ส่งไป hooks
    const hookBody = JSON.stringify({
      agentId,
      sessionKey,
      message,
      allowRequestSessionKey: true,
    })
    const hookRes = await new Promise((resolve, reject) => {
      const http = require('http')
      const opts = {
        hostname: '127.0.0.1',
        port: hooksPort,
        path: '/hooks/agent',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(hookBody), ...(hooksToken ? { 'Authorization': `Bearer ${hooksToken}` } : {}) },
      }
      const hreq = http.request(opts, r => {
        let data = ''
        r.on('data', d => { data += d })
        r.on('end', () => {
          try { resolve(JSON.parse(data)) } catch { resolve({ ok: false }) }
        })
      })
      hreq.on('error', reject)
      const timeout = setTimeout(() => { hreq.destroy(); reject(new Error('hooks timeout')) }, 15000)
      hreq.on('close', () => clearTimeout(timeout))
      hreq.write(hookBody)
      hreq.end()
    })

    if (!hookRes.ok) return res.status(502).json({ error: 'gateway ไม่ตอบสนอง', detail: hookRes })

    // poll จาก sessions.json + .jsonl files โดยตรง (HTTP history endpoint ต้องการ auth แบบอื่น)
    const runId = hookRes.runId
    const sessionsJsonPath = path.join(HOME, `.openclaw/agents/${agentId}/sessions/sessions.json`)
    const fullSessionKey = `agent:${agentId}:${sessionKey}`
    const deadline = Date.now() + 300000 // 5 นาที — รองรับ model ช้า
    let assistantContent = null
    let lastSeenTimestamp = Date.now()
    let stableContent = null
    let stableAt = 0

    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 1500))
      try {
        const sessions = JSON.parse(fs.readFileSync(sessionsJsonPath, 'utf8'))
        const sess = sessions[fullSessionKey]
        if (!sess?.sessionId) continue
        const jsonlPath = path.join(HOME, `.openclaw/agents/${agentId}/sessions/${sess.sessionId}.jsonl`)
        const lines = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n').filter(Boolean)
        let found = null
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const entry = JSON.parse(lines[i])
            const entryTs = new Date(entry.timestamp).getTime()
            if (entryTs < lastSeenTimestamp) break
            if (entry.type === 'message' && entry.message?.role === 'assistant') {
              const textPart = entry.message.content?.find(c => c.type === 'text')
              if (textPart?.text) { found = textPart.text; break }
            }
          } catch { continue }
        }
        if (found) {
          if (found === stableContent) {
            // content ไม่เปลี่ยนแปลงแล้ว — รอ stabilize 2 รอบ (3 วินาที) แล้วถือว่า done
            if (Date.now() - stableAt >= 3000) { assistantContent = found; break }
          } else {
            // content ยังเปลี่ยนอยู่ — อัปเดตและรอต่อ
            stableContent = found
            stableAt = Date.now()
          }
        }
      } catch { /* ยังไม่พร้อม */ }
    }

    // fallback: ใช้ stableContent ถ้า deadline หมดแต่มี content บางส่วน
    if (!assistantContent && stableContent) assistantContent = stableContent

    if (!assistantContent) return res.status(504).json({ error: 'timeout รอ agent ตอบ' })

    // บันทึก assistant response
    await pgPool.query(
      'INSERT INTO webchat_messages (room_id, username, role, content, run_id) VALUES ($1, $2, $3, $4, $5)',
      [roomId, username, 'assistant', assistantContent, runId || null]
    )

    res.json({ ok: true, reply: assistantContent })
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/webchat/chat-users  — list users ที่มี role=chat (สำหรับ allowlist picker)
router.get('/chat-users', requirePg, async (_req, res) => {
  try {
    const { rows } = await pgPool.query(
      "SELECT username, display_name FROM admin_users WHERE role = 'chat' AND is_active = true ORDER BY display_name ASC"
    )
    res.json(rows)
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = { router, stripGatewayMetadata }
