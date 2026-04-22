const router = require('express').Router()
const { pgPool, requirePg } = require('../lib/pg')

const SML_URL = process.env.SML_SALE_RESERVE_URL || 'http://192.168.2.213:3248/api/sale_reserve'

// Parse SSE/JSONRPC response จาก SML
function parseSmlResponse(text) {
  const match = text.match(/^data:\s*(.+)$/m)
  if (!match) return { success: false, error: 'no data line in response' }
  try {
    const jsonrpc = JSON.parse(match[1])
    const textContent = jsonrpc?.result?.content?.[0]?.text
    if (!textContent) return { success: false, error: 'no text content in response' }
    return JSON.parse(textContent)
  } catch (e) {
    return { success: false, error: e.message }
  }
}

// POST /api/sale-orders — รับจาก AI, forward → SML, บันทึก DB
router.post('/', requirePg, async (req, res) => {
  const agentId = req.headers['x-agent-id'] || null
  const source  = req.headers['x-source'] || 'line'
  const args    = req.body?.params?.arguments || {}

  const contactName  = args.contact_name  || null
  const contactPhone = args.contact_phone || null
  const items        = Array.isArray(args.items) ? args.items : []
  const totalAmount  = items.reduce((sum, it) => sum + ((it.qty || 0) * (it.price || 0)), 0)

  // 1. บันทึก DB pending
  let orderId
  try {
    const { rows } = await pgPool.query(
      `INSERT INTO sale_orders
         (source, agent_id, contact_name, contact_phone, items, total_amount, raw_request)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id`,
      [source, agentId, contactName, contactPhone,
       JSON.stringify(items), totalAmount || null, JSON.stringify(req.body)]
    )
    orderId = rows[0].id
  } catch (e) {
    console.error('[sale-orders] DB insert error:', e.message)
    return res.status(500).json({ error: 'Database error' })
  }

  // 2. Forward ไป SML
  let smlBody
  try {
    const smlRes = await fetch(SML_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'mcp-access-mode': req.headers['mcp-access-mode'] || 'sales',
      },
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(30000),
    })
    smlBody = await smlRes.text()
  } catch (e) {
    console.error('[sale-orders] SML request error:', e.message)
    await pgPool.query(
      `UPDATE sale_orders SET status='failed', error_message=$1, updated_at=now() WHERE id=$2`,
      [e.message, orderId]
    )
    return res.status(502).json({ error: 'SML unreachable', message: e.message })
  }

  // 3. Parse + update DB
  const parsed = parseSmlResponse(smlBody)
  if (parsed.success) {
    await pgPool.query(
      `UPDATE sale_orders SET status='success', doc_no=$1, raw_response=$2, updated_at=now() WHERE id=$3`,
      [parsed.doc_no || null, JSON.stringify(parsed), orderId]
    )
  } else {
    await pgPool.query(
      `UPDATE sale_orders SET status='failed', error_message=$1, raw_response=$2, updated_at=now() WHERE id=$3`,
      [parsed.error || 'Unknown error', JSON.stringify(parsed), orderId]
    )
  }

  // 4. ส่ง SML response กลับไปให้ AI (ตรงๆ ไม่เปลี่ยน format)
  res.setHeader('Content-Type', 'text/event-stream')
  res.status(200).send(smlBody)
})

// GET /api/sale-orders — list (สำหรับ admin UI)
router.get('/', requirePg, async (req, res) => {
  try {
    const { status, source, agent_id, limit = 50, offset = 0 } = req.query

    const conditions = []
    const params = []

    if (status) {
      params.push(status)
      conditions.push(`status = $${params.length}`)
    }
    if (source) {
      params.push(source)
      conditions.push(`source = $${params.length}`)
    }
    if (agent_id) {
      params.push(agent_id)
      conditions.push(`agent_id = $${params.length}`)
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    params.push(Math.min(Number(limit) || 50, 200))
    params.push(Number(offset) || 0)

    const { rows } = await pgPool.query(
      `SELECT id, doc_no, source, agent_id, contact_name, contact_phone,
              items, total_amount, status, error_message, retry_count,
              created_at, updated_at
       FROM sale_orders
       ${where}
       ORDER BY created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    )

    const { rows: countRows } = await pgPool.query(
      `SELECT COUNT(*)::int AS total FROM sale_orders ${where}`,
      conditions.length ? params.slice(0, -2) : []
    )

    res.json({ orders: rows, total: countRows[0].total })
  } catch (e) {
    console.error('[sale-orders] GET list error:', e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/sale-orders/:id — detail
router.get('/:id', requirePg, async (req, res) => {
  try {
    const { rows } = await pgPool.query(
      'SELECT * FROM sale_orders WHERE id = $1',
      [req.params.id]
    )
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json(rows[0])
  } catch (e) {
    console.error('[sale-orders] GET detail error:', e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/sale-orders/:id/resend — ส่งซ้ำ (failed orders)
router.post('/:id/resend', requirePg, async (req, res) => {
  try {
    const { rows } = await pgPool.query(
      'SELECT * FROM sale_orders WHERE id = $1',
      [req.params.id]
    )
    const order = rows[0]
    if (!order) return res.status(404).json({ error: 'Not found' })

    // อัพ status → pending ก่อน
    await pgPool.query(
      `UPDATE sale_orders SET status='pending', error_message=null, doc_no=null,
       retry_count=retry_count+1, updated_at=now() WHERE id=$1`,
      [order.id]
    )

    // Forward raw_request เดิมไป SML
    let smlBody
    try {
      const smlRes = await fetch(SML_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          'mcp-access-mode': 'sales',
        },
        body: JSON.stringify(order.raw_request),
        signal: AbortSignal.timeout(30000),
      })
      smlBody = await smlRes.text()
    } catch (e) {
      await pgPool.query(
        `UPDATE sale_orders SET status='failed', error_message=$1, updated_at=now() WHERE id=$2`,
        [e.message, order.id]
      )
      return res.status(502).json({ error: 'SML unreachable', message: e.message })
    }

    const parsed = parseSmlResponse(smlBody)
    if (parsed.success) {
      await pgPool.query(
        `UPDATE sale_orders SET status='success', doc_no=$1, raw_response=$2, updated_at=now() WHERE id=$3`,
        [parsed.doc_no || null, JSON.stringify(parsed), order.id]
      )
    } else {
      await pgPool.query(
        `UPDATE sale_orders SET status='failed', error_message=$1, raw_response=$2, updated_at=now() WHERE id=$3`,
        [parsed.error || 'Unknown error', JSON.stringify(parsed), order.id]
      )
    }

    res.json({ ok: true, success: parsed.success, doc_no: parsed.doc_no || null, error: parsed.error || null })
  } catch (e) {
    console.error('[sale-orders] resend error:', e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router
