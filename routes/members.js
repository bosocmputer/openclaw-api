const router = require('express').Router()
const { pgPool, requirePg } = require('../lib/pg')

// GET /api/members
router.get('/', requirePg, async (req, res) => {
  try {
    const { rows } = await pgPool.query(
      'SELECT id, username, role, display_name, is_active, created_at FROM admin_users ORDER BY created_at ASC'
    )
    res.json(rows)
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/members
router.post('/', requirePg, async (req, res) => {
  try {
    const { username, password, role, display_name } = req.body
    if (!username || !password) return res.status(400).json({ error: 'username and password required' })
    if (!['admin', 'chat', 'superadmin'].includes(role)) return res.status(400).json({ error: 'invalid role' })
    const bcrypt = require('bcryptjs')
    const hash = await bcrypt.hash(password, 12)
    const { rows } = await pgPool.query(
      'INSERT INTO admin_users (username, password, role, display_name) VALUES ($1, $2, $3, $4) RETURNING id, username, role, display_name, is_active, created_at',
      [username.trim(), hash, role, display_name || username.trim()]
    )
    res.json(rows[0])
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    if (e.code === '23505') return res.status(400).json({ error: 'ชื่อผู้ใช้นี้มีอยู่แล้ว' })
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PATCH /api/members/:id
router.patch('/:id', requirePg, async (req, res) => {
  try {
    const { id } = req.params
    const { role, display_name, is_active, password } = req.body
    if (password !== undefined) {
      const bcrypt = require('bcryptjs')
      const hash = await bcrypt.hash(password, 12)
      await pgPool.query(
        'UPDATE admin_users SET password = $1, updated_at = now() WHERE id = $2',
        [hash, id]
      )
    }
    if (role !== undefined) {
      if (!['admin', 'chat', 'superadmin'].includes(role)) return res.status(400).json({ error: 'invalid role' })
      await pgPool.query('UPDATE admin_users SET role = $1, updated_at = now() WHERE id = $2', [role, id])
    }
    if (display_name !== undefined) {
      await pgPool.query('UPDATE admin_users SET display_name = $1, updated_at = now() WHERE id = $2', [display_name, id])
    }
    if (is_active !== undefined) {
      await pgPool.query('UPDATE admin_users SET is_active = $1, updated_at = now() WHERE id = $2', [is_active, id])
    }
    res.json({ ok: true })
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/members/:id
router.delete('/:id', requirePg, async (req, res) => {
  try {
    const { id } = req.params
    // ห้ามลบ superadmin คนสุดท้าย
    const { rows } = await pgPool.query(
      "SELECT id FROM admin_users WHERE role = 'superadmin' AND is_active = true"
    )
    const target = await pgPool.query("SELECT role FROM admin_users WHERE id = $1", [id])
    if (target.rows[0]?.role === 'superadmin' && rows.length <= 1) {
      return res.status(400).json({ error: 'ไม่สามารถลบ superadmin คนสุดท้ายได้' })
    }
    await pgPool.query('DELETE FROM admin_users WHERE id = $1', [id])
    res.json({ ok: true })
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router
