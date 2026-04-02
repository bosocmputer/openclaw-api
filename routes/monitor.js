const router = require('express').Router()
const agentSessionsRouter = require('express').Router()
const fs = require('fs')
const path = require('path')
const { HOME, CONFIG_PATH } = require('../lib/config')
const { readUserNames } = require('../lib/files')
const { pgPool } = require('../lib/pg')
const { stripGatewayMetadata } = require('./webchat')

// GET /api/monitor/events — real-time session state across all agents and channels
router.get('/events', async (_req, res) => {
  try {
    // Read agents from openclaw.json
    let config = {}
    try { config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) } catch { config = {} }
    const agentList = (config.agents && config.agents.list) ? config.agents.list : []

    // Load existing webchat rooms from DB grouped by agent_id
    // Key: agentId → Set of usernames that still have active rooms
    const webchatRoomsByAgent = {}
    let webchatDbAvailable = false
    if (pgPool) {
      try {
        const r = await pgPool.query('SELECT agent_id FROM webchat_rooms')
        webchatDbAvailable = true
        for (const row of r.rows) {
          if (!webchatRoomsByAgent[row.agent_id]) webchatRoomsByAgent[row.agent_id] = true
        }
      } catch { /* DB unavailable — skip filter */ }
    }

    const today = new Date().toISOString().slice(0, 10)
    let totalMessages = 0
    let totalCostToday = 0
    let activeNow = 0
    let errors = 0
    let responseTimes = []
    const globalEvents = []

    const agentsResult = []

    for (const agent of agentList) {
      const agentId = agent.id
      const sessionsPath = path.join(HOME, `.openclaw/agents/${agentId}/sessions/sessions.json`)

      let sessionsMap = {}
      try { sessionsMap = JSON.parse(fs.readFileSync(sessionsPath, 'utf8')) } catch { continue }

      const channels = {}

      for (const [key, sessionInfo] of Object.entries(sessionsMap)) {
        // Skip heartbeat sessions
        if (key.includes(':main')) continue

        let channel = null
        let user = null

        if (key.includes('hook:webchat')) {
          channel = 'webchat'
          const parts = key.split(':')
          user = parts[parts.length - 1]
          // Skip if no webchat rooms exist for this agent in DB
          if (webchatDbAvailable && !webchatRoomsByAgent[agentId]) continue
        } else if (key.includes('telegram')) {
          channel = 'telegram'
          // key format e.g. agent:sale:telegram:botname:userId
          const parts = key.split(':')
          const telegramIdx = parts.findIndex(p => p === 'telegram')
          user = parts.slice(telegramIdx + 1).join(':')
        } else if (key.includes(':line:')) {
          channel = 'line'
          // key format: agent:sale:line:direct:uXXXX
          const parts = key.split(':')
          const lineIdx = parts.findIndex(p => p === 'line')
          user = parts.slice(lineIdx + 1).join(':')
        } else {
          continue
        }

        if (!sessionInfo) continue
        // sessionFile may be absent for webchat sessions — derive from sessionId
        const sessionFile = sessionInfo.sessionFile
          || (sessionInfo.sessionId ? path.join(HOME, `.openclaw/agents/${agentId}/sessions/${sessionInfo.sessionId}.jsonl`) : null)
        if (!sessionFile) continue
        if (!channels[channel]) channels[channel] = []

        // Read last 50 lines of the .jsonl file
        let lines = []
        try {
          const content = fs.readFileSync(sessionFile, 'utf8')
          const allLines = content.split('\n').filter(l => l.trim())
          lines = allLines.slice(-50)
        } catch { continue }

        // Parse JSONL events
        const parsedLines = []
        for (const line of lines) {
          try { parsedLines.push(JSON.parse(line)) } catch { /* skip */ }
        }

        // Normalize: jsonl entries may be {role,content,timestamp} or {type,timestamp,message:{role,content}}
        const normalized = parsedLines.map(entry => {
          if (!entry) return null
          if (entry.message && entry.message.role) {
            // wrapped format: {type, id, timestamp, message:{role,content,usage}}
            return { role: entry.message.role, content: entry.message.content, timestamp: entry.timestamp, usage: entry.message.usage ?? entry.usage, model: entry.message.model, stopReason: entry.message.stopReason }
          }
          // flat format: {role, content, timestamp}
          return entry
        }).filter(Boolean)

        // Filter out HEARTBEAT_OK messages
        const filtered = normalized.filter(msg => {
          if (!msg) return false
          const content = msg.content
          if (Array.isArray(content)) {
            return !content.some(c => typeof c === 'object' && c.type === 'tool_result' &&
              Array.isArray(c.content) && c.content.some(x => typeof x.text === 'string' && x.text.includes('HEARTBEAT_OK')))
          }
          if (typeof content === 'string' && content.includes('HEARTBEAT_OK')) return false
          return true
        })

        let lastUserMsg = null
        let lastAssistantMsg = null
        for (const msg of filtered) {
          if (msg.role === 'user') lastUserMsg = msg
          if (msg.role === 'assistant') lastAssistantMsg = msg
        }

        const lastMsg = filtered.length ? filtered[filtered.length - 1] : null
        const lastMsgRole = lastMsg ? lastMsg.role : null
        const lastMsgTs = lastMsg ? (lastMsg.timestamp || lastMsg.ts || null) : null
        const lastMsgTime = lastMsgTs ? new Date(lastMsgTs) : null
        const nowMs = Date.now()
        const elapsedSec = lastMsgTime ? Math.floor((nowMs - lastMsgTime.getTime()) / 1000) : null

        // Determine state
        let state = 'idle'
        if (lastMsgRole === 'user' && elapsedSec !== null && elapsedSec < 300) {
          state = 'thinking'
        } else if (lastMsgRole === 'assistant' && elapsedSec !== null && elapsedSec < 120) {
          // Check for error in last assistant message
          const hasError = (() => {
            if (!lastMsg) return false
            const c = lastMsg.content
            if (Array.isArray(c)) return c.some(x => x.type === 'error' || (typeof x.text === 'string' && x.text.toLowerCase().includes('error')))
            if (typeof c === 'string') return c.toLowerCase().includes('error')
            return false
          })()
          state = hasError ? 'error' : 'replied'
        } else if (lastMsgRole === 'assistant') {
          const hasError = (() => {
            if (!lastMsg) return false
            const c = lastMsg.content
            if (Array.isArray(c)) return c.some(x => x.type === 'error')
            return false
          })()
          if (hasError) state = 'error'
        }

        if (state === 'thinking' || state === 'replied') activeNow++
        if (state === 'error') errors++

        // Extract last user text
        let lastUserText = null
        if (lastUserMsg) {
          const c = lastUserMsg.content
          if (typeof c === 'string') lastUserText = stripGatewayMetadata(c).slice(0, 300)
          else if (Array.isArray(c)) {
            const textItem = c.find(x => x.type === 'text')
            if (textItem) lastUserText = stripGatewayMetadata(textItem.text).slice(0, 300)
          }
        }

        // Extract last reply text
        let lastReplyText = null
        if (lastAssistantMsg) {
          const c = lastAssistantMsg.content
          if (typeof c === 'string') lastReplyText = c.slice(0, 300)
          else if (Array.isArray(c)) {
            const textItem = c.find(x => x.type === 'text')
            if (textItem) lastReplyText = textItem.text.slice(0, 300)
          }
        }

        // Count cost and today messages
        let sessionCost = 0
        let sessionInputTokens = 0
        let sessionOutputTokens = 0
        for (const msg of filtered) {
          if (msg.usage) {
            const u = msg.usage
            const inp = u.input || u.input_tokens || 0
            const out = u.output || u.output_tokens || 0
            sessionInputTokens += inp
            sessionOutputTokens += out
            sessionCost += u.cost?.total ? u.cost.total : ((inp / 1000000) * 3 + (out / 1000000) * 15)
          }
          // Count today's messages
          const ts = msg.timestamp || msg.ts
          if (ts && ts.slice(0, 10) === today) {
            totalMessages++
          }
        }
        totalCostToday += sessionCost

        // Calculate response time (time between last user msg and last assistant msg)
        if (lastUserMsg && lastAssistantMsg) {
          const userTs = lastUserMsg.timestamp || lastUserMsg.ts
          const assistantTs = lastAssistantMsg.timestamp || lastAssistantMsg.ts
          if (userTs && assistantTs) {
            const diff = (new Date(assistantTs).getTime() - new Date(userTs).getTime()) / 1000
            if (diff > 0 && diff < 3600) responseTimes.push(diff)
          }
        }

        // Build events array from messages (with latency, token usage, and tool result pairing)
        const events = []
        let lastUserTsMs = null
        for (const msg of filtered) {
          const msgTs = msg.timestamp || msg.ts
          const tsFormatted = msgTs ? new Date(msgTs).toISOString().slice(11, 19) : null
          const usage = msg.usage
          if (msg.role === 'user') {
            lastUserTsMs = msgTs ? new Date(msgTs).getTime() : null
            const c = msg.content
            let text = ''
            if (typeof c === 'string') text = stripGatewayMetadata(c)
            else if (Array.isArray(c)) {
              const t = c.find(x => x.type === 'text')
              if (t) text = stripGatewayMetadata(t.text)
            }
            if (text) events.push({ ts: tsFormatted, type: 'message', text })
          } else if (msg.role === 'assistant') {
            const c = msg.content
            if (Array.isArray(c)) {
              for (const item of c) {
                if (item.type === 'thinking') {
                  events.push({ ts: tsFormatted, type: 'thinking', text: (item.thinking || '') })
                } else if (item.type === 'tool_use' || item.type === 'toolCall') {
                  const toolName = item.name || ''
                  const toolText = toolName + (item.input ? ': ' + JSON.stringify(item.input, null, 2) : '')
                  events.push({ ts: tsFormatted, type: 'tool', text: toolText, toolName })
                } else if (item.type === 'text' && item.text) {
                  const lower = item.text.toLowerCase()
                  if (lower.includes('bash') || lower.includes('exec')) {
                    events.push({ ts: tsFormatted, type: 'tool', text: item.text })
                  } else {
                    const ev = { ts: tsFormatted, type: 'reply', text: item.text }
                    if (lastUserTsMs && msgTs) {
                      const diff = (new Date(msgTs).getTime() - lastUserTsMs) / 1000
                      if (diff > 0 && diff < 3600) ev.latency = Math.round(diff * 10) / 10
                    }
                    if (usage) {
                      ev.inputTokens = usage.input || usage.input_tokens || 0
                      ev.outputTokens = usage.output || usage.output_tokens || 0
                      ev.cost = usage.cost?.total ?? 0
                    }
                    events.push(ev)
                    lastUserTsMs = null
                  }
                } else if (item.type === 'error') {
                  events.push({ ts: tsFormatted, type: 'error', text: (item.text || JSON.stringify(item, null, 2)).slice(0, 5000) })
                }
              }
            } else if (typeof c === 'string') {
              const ev = { ts: tsFormatted, type: 'reply', text: c }
              if (lastUserTsMs && msgTs) {
                const diff = (new Date(msgTs).getTime() - lastUserTsMs) / 1000
                if (diff > 0 && diff < 3600) ev.latency = Math.round(diff * 10) / 10
              }
              if (usage) {
                ev.inputTokens = usage.input || usage.input_tokens || 0
                ev.outputTokens = usage.output || usage.output_tokens || 0
                ev.cost = usage.cost?.total ?? 0
              }
              events.push(ev)
              lastUserTsMs = null
            }
          } else if (msg.role === 'toolResult') {
            // Pair tool result with last unmatched tool event
            const c = msg.content
            if (Array.isArray(c)) {
              const text = c.find(x => x.type === 'text')?.text || ''
              if (text) {
                for (let i = events.length - 1; i >= 0; i--) {
                  if (events[i].type === 'tool' && events[i].toolResult === undefined) {
                    events[i].toolResult = text.slice(0, 3000)
                    break
                  }
                }
              }
            }
          }
        }

        // Skip stale sessions (no activity in last 3 days)
        if (lastMsgTs) {
          const age = (Date.now() - new Date(lastMsgTs).getTime()) / 1000
          if (age > 259200) continue
        }

        if (!channels[channel]) channels[channel] = []

        const sessionEntry = {
          sessionKey: key,
          user,
          state,
          lastMessageAt: lastMsgTs || null,
          lastUserText,
          lastReplyText,
          elapsed: elapsedSec,
          cost: Math.round(sessionCost * 100000) / 100000,
          inputTokens: sessionInputTokens,
          outputTokens: sessionOutputTokens,
          events
        }
        channels[channel].push(sessionEntry)

        // Add to globalEvents
        for (const ev of events) {
          globalEvents.push({ ts: ev.ts, agentId, channel, user, type: ev.type, text: ev.text })
        }
      }

      agentsResult.push({ id: agentId, channels })
    }

    // Sort globalEvents by ts descending and limit to last 50
    globalEvents.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''))
    const limitedGlobalEvents = globalEvents.slice(0, 50)

    // Read gateway log from /tmp/openclaw/ — latest file, last 100 lines
    const gatewayEvents = []
    try {
      const logDir = '/tmp/openclaw'
      const logFiles = fs.readdirSync(logDir)
        .filter(f => f.endsWith('.log') || f.endsWith('.jsonl'))
        .map(f => ({ name: f, mtime: fs.statSync(path.join(logDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)

      if (logFiles.length > 0) {
        const latestLog = path.join(logDir, logFiles[0].name)
        const logContent = fs.readFileSync(latestLog, 'utf8')
        const logLines = logContent.split('\n').filter(l => l.trim()).slice(-100)
        for (const line of logLines) {
          try {
            const obj = JSON.parse(line)
            const subsystem = typeof obj['0'] === 'string' ? (() => { try { return JSON.parse(obj['0']) } catch { return obj['0'] } })() : obj['0']
            const message = obj['1'] || obj.message || ''
            const ts = obj.time ? new Date(obj.time).toISOString().slice(11, 19) : null
            gatewayEvents.push({ ts, subsystem, message })
          } catch { /* skip */ }
        }
      }
    } catch { /* skip if /tmp/openclaw doesn't exist */ }

    const avgResponseTime = responseTimes.length
      ? Math.round((responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length) * 10) / 10
      : 0

    res.json({
      agents: agentsResult,
      globalEvents: limitedGlobalEvents,
      gatewayEvents,
      stats: {
        totalAgents: agentList.length,
        activeNow,
        todayMessages: totalMessages,
        avgResponseTime,
        totalCostToday: Math.round(totalCostToday * 100000) / 100000,
        errors
      }
    })
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/agents/:id/sessions — list sessions with token metadata
agentSessionsRouter.get('/:id/sessions', (req, res) => {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    const agent = config.agents?.list?.find(a => a.id === req.params.id)
    if (!agent) return res.status(404).json({ error: 'Agent not found' })

    const sessionsPath = path.join(HOME, `.openclaw/agents/${req.params.id}/sessions/sessions.json`)
    if (!fs.existsSync(sessionsPath)) return res.json([])

    const sessionsMap = JSON.parse(fs.readFileSync(sessionsPath, 'utf8'))
    const userNames = readUserNames()
    const result = []

    for (const [key, info] of Object.entries(sessionsMap)) {
      if (!info || !info.sessionId || key.includes(':main')) continue
      const sessionFile = info.sessionFile
        || path.join(HOME, `.openclaw/agents/${req.params.id}/sessions/${info.sessionId}.jsonl`)
      if (!fs.existsSync(sessionFile)) continue

      let inputTokens = 0, outputTokens = 0
      try {
        const lines = fs.readFileSync(sessionFile, 'utf8').trim().split('\n').filter(Boolean)
        for (const line of lines) {
          try {
            const entry = JSON.parse(line)
            const usage = entry.message?.usage ?? entry.usage
            if (usage) {
              inputTokens += usage.input || usage.input_tokens || 0
              outputTokens += usage.output || usage.output_tokens || 0
            }
          } catch {}
        }
      } catch {}

      let userLabel = key.replace(/^agent:[^:]+:/, '')
      let userFrom = 'unknown'
      if (key.includes('telegram')) userFrom = 'telegram'
      else if (key.includes(':line:')) userFrom = 'line'
      else if (key.includes('hook:webchat')) userFrom = 'webchat'

      const peerId = info.deliveryContext?.to || info.lastTo
      if (peerId && userNames[peerId]) userLabel = userNames[peerId]

      result.push({
        sessionId: info.sessionId,
        sessionKey: key,
        userLabel,
        userFrom,
        updatedAt: info.updatedAt || 0,
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
      })
    }

    result.sort((a, b) => b.updatedAt - a.updatedAt)
    res.json(result)
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/agents/:id/sessions/:sessionKey(*) — full session replay
// :sessionKey can be a UUID filename OR a sessions.json key like "agent:sale:telegram:direct:123"
agentSessionsRouter.get('/:id/sessions/:sessionKey(*)', (req, res) => {
  try {
    const { id, sessionKey } = req.params

    // Try to resolve sessionKey → actual .jsonl file path
    let sessionFile = path.join(HOME, `.openclaw/agents/${id}/sessions/${sessionKey}.jsonl`)
    if (!fs.existsSync(sessionFile)) {
      // Look up in sessions.json for sessionFile field
      const sessionsJsonPath = path.join(HOME, `.openclaw/agents/${id}/sessions/sessions.json`)
      if (fs.existsSync(sessionsJsonPath)) {
        try {
          const sessionsData = JSON.parse(fs.readFileSync(sessionsJsonPath, 'utf8'))
          const entry = sessionsData[sessionKey]
          if (entry?.sessionFile) {
            sessionFile = entry.sessionFile
          } else if (entry?.sessionId) {
            sessionFile = path.join(HOME, `.openclaw/agents/${id}/sessions/${entry.sessionId}.jsonl`)
          }
        } catch {}
      }
    }
    if (!fs.existsSync(sessionFile)) return res.status(404).json({ error: 'Session not found' })

    const lines = fs.readFileSync(sessionFile, 'utf8').trim().split('\n').filter(Boolean)
    const messages = []
    let totalInput = 0, totalOutput = 0, totalCost = 0
    let lastUserTsMs = null
    const latencies = []

    for (const line of lines) {
      try {
        const entry = JSON.parse(line)
        if (entry.type !== 'message' || !entry.message) continue
        const msg = entry.message
        const usage = msg.usage ?? entry.usage
        const ts = entry.timestamp

        if (msg.role === 'user') {
          lastUserTsMs = ts ? new Date(ts).getTime() : null
          const c = msg.content
          let text = ''
          if (typeof c === 'string') text = stripGatewayMetadata(c)
          else if (Array.isArray(c)) text = stripGatewayMetadata(c.find(x => x.type === 'text')?.text || '')
          messages.push({ role: 'user', timestamp: ts, text })
        } else if (msg.role === 'assistant') {
          const c = msg.content || []
          const thinking = Array.isArray(c) ? (c.find(x => x.type === 'thinking')?.thinking || null) : null
          const textParts = Array.isArray(c) ? c.filter(x => x.type === 'text').map(x => x.text) : (typeof c === 'string' ? [c] : [])
          const toolCalls = Array.isArray(c) ? c.filter(x => x.type === 'toolCall' || x.type === 'tool_use').map(x => ({ name: x.name, input: x.input })) : []

          let latency = null
          if (lastUserTsMs && ts) {
            const diff = (new Date(ts).getTime() - lastUserTsMs) / 1000
            if (diff > 0 && diff < 3600) { latency = Math.round(diff * 10) / 10; latencies.push(latency) }
          }

          if (usage) {
            totalInput += usage.input || usage.input_tokens || 0
            totalOutput += usage.output || usage.output_tokens || 0
            totalCost += usage.cost?.total || 0
          }

          if (textParts.length > 0 || toolCalls.length > 0 || thinking) {
            messages.push({
              role: 'assistant',
              timestamp: ts,
              thinking,
              text: textParts.join('\n'),
              toolCalls,
              model: msg.model,
              stopReason: msg.stopReason,
              usage: usage ? {
                input: usage.input || usage.input_tokens || 0,
                output: usage.output || usage.output_tokens || 0,
                cost: usage.cost?.total || 0,
              } : null,
              latency,
            })
            if (textParts.length > 0) lastUserTsMs = null
          }
        } else if (msg.role === 'toolResult') {
          const c = msg.content
          const text = Array.isArray(c) ? (c.find(x => x.type === 'text')?.text || '') : ''
          for (let i = messages.length - 1; i >= 0; i--) {
            const prev = messages[i]
            if (prev.role === 'assistant' && prev.toolCalls?.length > 0) {
              const lastTool = prev.toolCalls[prev.toolCalls.length - 1]
              if (lastTool.result === undefined) { lastTool.result = text.slice(0, 3000); break }
            }
          }
        }
      } catch {}
    }

    const avgLatency = latencies.length
      ? Math.round((latencies.reduce((a, b) => a + b, 0) / latencies.length) * 10) / 10 : 0

    res.json({
      sessionId: sessionKey,
      agentId: id,
      messages,
      stats: {
        turns: messages.filter(m => m.role === 'user').length,
        inputTokens: totalInput,
        outputTokens: totalOutput,
        totalCost: Math.round(totalCost * 100000) / 100000,
        avgLatency,
      },
    })
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/monitor/cost — aggregate cost per agent per day (last N days)
router.get('/cost', (req, res) => {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    const agentList = config.agents?.list || []
    const days = parseInt(req.query.days || '30')
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - days)

    // dayData[date][agentId] = { cost, inputTokens, outputTokens, turns }
    const dayData = {}

    for (const agent of agentList) {
      const sessionsDir = path.join(HOME, `.openclaw/agents/${agent.id}/sessions`)
      if (!fs.existsSync(sessionsDir)) continue

      const files = fs.readdirSync(sessionsDir)
        .filter(f => f.endsWith('.jsonl') && !f.includes('.reset.'))

      for (const file of files) {
        try {
          const content = fs.readFileSync(path.join(sessionsDir, file), 'utf8')
          const lines = content.trim().split('\n').filter(Boolean)
          for (const line of lines) {
            try {
              const entry = JSON.parse(line)
              if (entry.message?.role !== 'assistant') continue
              const usage = entry.message?.usage ?? entry.usage
              if (!usage) continue
              const ts = entry.timestamp
              if (!ts || new Date(ts) < cutoff) continue

              const date = ts.slice(0, 10)
              if (!dayData[date]) dayData[date] = {}
              if (!dayData[date][agent.id]) dayData[date][agent.id] = { cost: 0, inputTokens: 0, outputTokens: 0, turns: 0 }

              const inp = usage.input || usage.input_tokens || 0
              const out = usage.output || usage.output_tokens || 0
              dayData[date][agent.id].cost += usage.cost?.total ? usage.cost.total : ((inp / 1000000) * 3 + (out / 1000000) * 15)
              dayData[date][agent.id].inputTokens += inp
              dayData[date][agent.id].outputTokens += out
              dayData[date][agent.id].turns++
            } catch {}
          }
        } catch {}
      }
    }

    const sortedDates = Object.keys(dayData).sort()
    const resultDays = sortedDates.map(date => {
      const agents = Object.entries(dayData[date]).map(([agentId, s]) => ({
        agentId,
        cost: Math.round(s.cost * 100000) / 100000,
        inputTokens: s.inputTokens,
        outputTokens: s.outputTokens,
        turns: s.turns,
      })).sort((a, b) => b.cost - a.cost)
      const total = agents.reduce((s, a) => s + a.cost, 0)
      return { date, agents, total: Math.round(total * 100000) / 100000 }
    })

    const summaryByAgent = {}
    for (const day of resultDays) {
      for (const a of day.agents) {
        summaryByAgent[a.agentId] = Math.round(((summaryByAgent[a.agentId] || 0) + a.cost) * 100000) / 100000
      }
    }

    res.json({
      days: resultDays,
      summary: {
        totalCost: Math.round(Object.values(summaryByAgent).reduce((a, b) => a + b, 0) * 100000) / 100000,
        byAgent: summaryByAgent,
      },
    })
  } catch (e) {
    console.error('[openclaw-api]', req.method, req.path, e.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router

module.exports = { router, agentSessionsRouter }
