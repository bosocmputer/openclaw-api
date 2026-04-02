const router = require('express').Router()
const fs = require('fs')
const path = require('path')
const { HOME, CONFIG_PATH } = require('../lib/config')

// ─── Error Alerting Watcher ────────────────────────────────────────────────────
const alertState = {}

async function sendTelegramAlert(botToken, chatId, text) {
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
      signal: AbortSignal.timeout(5000),
    })
  } catch {}
}

function runAlertCheck() {
  let config = {}
  try { config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) } catch { return }
  const alertConfig = config.alerting?.telegram
  if (!alertConfig?.enabled || !alertConfig?.chatId) return

  const botToken = config.channels?.telegram?.accounts?.default?.botToken
    || Object.values(config.channels?.telegram?.accounts || {})[0]?.botToken
    || config.channels?.telegram?.botToken
  if (!botToken) return

  const agentList = config.agents?.list || []
  for (const agent of agentList) {
    const sessionsPath = path.join(HOME, `.openclaw/agents/${agent.id}/sessions/sessions.json`)
    let sessionsMap = {}
    try { sessionsMap = JSON.parse(fs.readFileSync(sessionsPath, 'utf8')) } catch { continue }

    for (const [key, info] of Object.entries(sessionsMap)) {
      if (!info || key.includes(':main')) continue
      const stateKey = `${agent.id}:${key}`
      if (!alertState[stateKey]) alertState[stateKey] = {}
      const now = Date.now()
      const cooldown = 300000 // 5 min per session

      // Check abortedLastRun
      if (info.abortedLastRun === true && alertState[stateKey].aborted !== true) {
        if (now - (alertState[stateKey].lastAlert || 0) > cooldown) {
          const label = key.replace(/^agent:[^:]+:/, '')
          sendTelegramAlert(botToken, alertConfig.chatId,
            `⚠️ <b>OpenClaw Alert</b>\n\nAgent: <code>${agent.id}</code>\nSession: <code>${label}</code>\n\nสถานะ: Session ถูกยกเลิกกลางคัน`)
          alertState[stateKey].lastAlert = now
        }
      }
      alertState[stateKey].aborted = info.abortedLastRun === true

      // Check stopReason of last assistant message
      const sessionFile = info.sessionFile
        || (info.sessionId ? path.join(HOME, `.openclaw/agents/${agent.id}/sessions/${info.sessionId}.jsonl`) : null)
      if (!sessionFile || !fs.existsSync(sessionFile)) continue

      try {
        const lines = fs.readFileSync(sessionFile, 'utf8').trim().split('\n').filter(Boolean)
        for (let i = lines.length - 1; i >= 0; i--) {
          const entry = JSON.parse(lines[i])
          if (entry.type === 'message' && entry.message?.role === 'assistant' && entry.message?.stopReason) {
            const stopReason = entry.message.stopReason
            if (stopReason !== 'stop' && stopReason !== 'end_turn') {
              if (alertState[stateKey].stopReason !== stopReason) {
                if (now - (alertState[stateKey].lastAlert || 0) > cooldown) {
                  const label = key.replace(/^agent:[^:]+:/, '')
                  sendTelegramAlert(botToken, alertConfig.chatId,
                    `⚠️ <b>OpenClaw Alert</b>\n\nAgent: <code>${agent.id}</code>\nSession: <code>${label}</code>\n\nหยุดผิดปกติ: <code>${stopReason}</code>`)
                  alertState[stateKey].lastAlert = now
                }
                alertState[stateKey].stopReason = stopReason
              }
            } else {
              alertState[stateKey].stopReason = null
            }
            break
          }
        }
      } catch {}
    }
  }
}

function startAlertWatcher() {
  setInterval(() => {
    try { runAlertCheck() } catch (e) { console.error('[alert-check]', e.message) }
  }, 60000)
}

// GET /api/alerting — get alerting config
router.get('/', (req, res) => {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    res.json(config.alerting || { telegram: { enabled: false, chatId: '' } })
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT /api/alerting — save alerting config
router.put('/', (req, res) => {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    config.alerting = req.body
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
    res.json({ ok: true })
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = { router, startAlertWatcher }
