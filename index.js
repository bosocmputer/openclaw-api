const express = require('express')
const cors = require('cors')
const helmet = require('helmet')
require('dotenv').config()

const app = express()
const PORT = process.env.PORT || 4000
const API_TOKEN = process.env.API_TOKEN
if (!API_TOKEN) {
  console.error('ERROR: API_TOKEN env is not set. Set it in .env file.')
  process.exit(1)
}

const { pgPool } = require('./lib/pg')
const { router: alertingRouter, startAlertWatcher } = require('./routes/alerting')
const { router: gatewayRouter, usernamesRouter, doctorRouter } = require('./routes/gateway')
const { router: monitorRouter, agentSessionsRouter } = require('./routes/monitor')

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || null
app.use(helmet())
app.use(cors(ALLOWED_ORIGIN ? {
  origin: ALLOWED_ORIGIN,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Authorization', 'Content-Type'],
} : {}))
app.use(express.json({ limit: '10mb' }))

// JSON parse error handler (e.g. 413 PayloadTooLarge, malformed JSON)
app.use((err, _req, res, next) => {
  if (err.status === 413) return res.status(413).json({ error: 'Request too large' })
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' })
  next(err)
})

// Auth middleware
app.use((req, res, next) => {
  const token = req.headers['authorization']?.replace('Bearer ', '')
  if (token !== API_TOKEN) return res.status(401).json({ error: 'Unauthorized' })
  next()
})

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/api/status',    require('./routes/status'))
app.use('/api/config',    require('./routes/config'))
app.use('/api/agents',    require('./routes/agents'))
app.use('/api/telegram',  require('./routes/telegram'))
app.use('/api/line',      require('./routes/line'))
app.use('/api',           require('./routes/model'))       // mounts /api/model, /api/models, /api/models/test
app.use('/api/gateway',   gatewayRouter)
app.use('/api/usernames', usernamesRouter)
app.use('/api/doctor',    doctorRouter)
app.use('/api/members',   require('./routes/members'))
app.use('/api/webchat',   require('./routes/webchat').router)
app.use('/api/monitor',   monitorRouter)
app.use('/api/agents',    agentSessionsRouter)            // mounts /api/agents/:id/sessions/*
app.use('/api/alerting',  alertingRouter)
app.use('/api/webhooks',  require('./routes/webhooks'))
app.use('/api/compaction', require('./routes/compaction'))
app.use('/api/memory',    require('./routes/memory'))

// ─── Alert watcher ────────────────────────────────────────────────────────────
startAlertWatcher()

// ─── Server ───────────────────────────────────────────────────────────────────
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`OpenClaw API running on port ${PORT}`)
})

function shutdown(signal) {
  console.log(`${signal} received — shutting down gracefully`)
  server.close(() => {
    if (pgPool) pgPool.end(() => process.exit(0))
    else process.exit(0)
  })
  setTimeout(() => process.exit(1), 10000)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT',  () => shutdown('SIGINT'))
