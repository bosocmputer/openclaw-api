let pgPool = null
try {
  if (process.env.DATABASE_URL) {
    const { Pool } = require('pg')
    pgPool = new Pool({ connectionString: process.env.DATABASE_URL })
    console.log('PostgreSQL connected')
  }
} catch (e) {
  console.warn('pg module not found — members API disabled', e.message)
}

function requirePg(req, res, next) {
  if (!pgPool) return res.status(503).json({ error: 'Database not configured' })
  next()
}

module.exports = { pgPool, requirePg }
