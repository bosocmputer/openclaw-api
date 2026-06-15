const assert = require('node:assert/strict')
const test = require('node:test')

const { buildLatencyFromLines, redactChatId } = require('../lib/monitor-latency')

function jsonLine(time, message) {
  return JSON.stringify({ time, 1: message })
}

test('latency parser joins Telegram markers by turnId', () => {
  const lines = [
    jsonLine('2026-06-15T12:00:00.000Z', 'telegram_inbound_received agent=stock turnId=tg_test chat=7548005041 media=0'),
    jsonLine('2026-06-15T12:00:00.120Z', 'telegram_context_ready agent=stock turnId=tg_test chat=7548005041 media=0 elapsedMs=120'),
    jsonLine('2026-06-15T12:00:00.900Z', 'telegram_ack_sent agent=stock turnId=tg_test key=k latencyMs=805'),
    jsonLine('2026-06-15T12:00:01.000Z', 'telegram_model_start agent=stock turnId=tg_test chat=7548005041 elapsedMs=1000'),
    jsonLine('2026-06-15T12:00:02.000Z', 'telegram_tool_call agent=stock turnId=tg_test chat=7548005041 count=1 elapsedMs=2000'),
    jsonLine('2026-06-15T12:00:03.000Z', 'telegram_final_sent agent=stock turnId=tg_test chat=7548005041 elapsedMs=3000 ackSent=true'),
  ]

  const data = buildLatencyFromLines(lines, { minutes: 1440 })

  assert.equal(data.summary.count, 1)
  assert.equal(data.turns[0].turnId, 'tg_test')
  assert.equal(data.turns[0].agentId, 'stock')
  assert.equal(data.turns[0].chatIdRedacted, '75…41')
  assert.equal(data.turns[0].ackMs, 805)
  assert.equal(data.turns[0].contextMs, 120)
  assert.equal(data.turns[0].modelMs, 1000)
  assert.equal(data.turns[0].finalMs, 3000)
  assert.equal(data.turns[0].status, 'ok')
  assert.equal(data.turns[0].rootCause, 'completed')
  assert.equal(data.turns[0].toolCalls.length, 1)
})

test('latency parser warns when marker has no turnId', () => {
  const data = buildLatencyFromLines([
    jsonLine('2026-06-15T12:00:00.000Z', 'telegram_ack_sent agent=stock key=k latencyMs=805'),
  ], { minutes: 1440 })

  assert.equal(data.turns.length, 0)
  assert.equal(data.warnings[0].type, 'missing_turn_id')
})

test('latency parser accepts legacy space-separated Telegram markers', () => {
  const data = buildLatencyFromLines([
    jsonLine('2026-06-15T12:00:00.000Z', 'telegram queue_coalesced scheduled turnId=tg_old key=k'),
    jsonLine('2026-06-15T12:00:00.050Z', 'telegram stale_reply_suppressed agent=stock turnId=tg_old source=dispatch'),
    jsonLine('2026-06-15T12:00:00.060Z', 'telegram reply_quality_warning agent=stock turnId=tg_old issues=cjk_text_repaired'),
  ], { minutes: 1440 })

  assert.equal(data.summary.count, 1)
  assert.equal(data.turns[0].turnId, 'tg_old')
  assert.equal(data.turns[0].status, 'ok')
  assert.equal(data.turns[0].rootCause, 'queue_coalesced')
})

test('redactChatId keeps support payload safe', () => {
  assert.equal(redactChatId('7548005041'), '75…41')
  assert.equal(redactChatId('123'), '<redacted>')
})
