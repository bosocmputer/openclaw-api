const assert = require('node:assert/strict')
const test = require('node:test')

const { buildLatencyFromLines, redactChatId } = require('../lib/monitor-latency')

function jsonLine(time, message) {
  return JSON.stringify({ time, 1: message })
}

const BASE_TIME_MS = Date.now() - 60_000
function recentTime(offsetMs = 0) {
  return new Date(BASE_TIME_MS + offsetMs).toISOString()
}

test('latency parser joins Telegram markers by turnId', () => {
  const lines = [
    jsonLine(recentTime(0), 'telegram_inbound_received agent=stock turnId=tg_test chat=7548005041 media=0'),
    jsonLine(recentTime(120), 'telegram_context_ready agent=stock turnId=tg_test chat=7548005041 media=0 elapsedMs=120'),
    jsonLine(recentTime(900), 'telegram_ack_sent agent=stock turnId=tg_test key=k latencyMs=805'),
    jsonLine(recentTime(1000), 'telegram_model_start agent=stock turnId=tg_test chat=7548005041 elapsedMs=1000'),
    jsonLine(recentTime(2000), 'telegram_tool_call agent=stock turnId=tg_test chat=7548005041 count=1 elapsedMs=2000'),
    jsonLine(recentTime(3000), 'telegram_final_sent agent=stock turnId=tg_test chat=7548005041 elapsedMs=3000 ackSent=true'),
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
    jsonLine(recentTime(), 'telegram_ack_sent agent=stock key=k latencyMs=805'),
  ], { minutes: 1440 })

  assert.equal(data.turns.length, 0)
  assert.equal(data.warnings[0].type, 'missing_turn_id')
})

test('latency parser accepts legacy space-separated Telegram markers', () => {
  const data = buildLatencyFromLines([
    jsonLine(recentTime(0), 'telegram queue_coalesced scheduled turnId=tg_old key=k'),
    jsonLine(recentTime(50), 'telegram stale_reply_suppressed agent=stock turnId=tg_old source=dispatch'),
    jsonLine(recentTime(60), 'telegram reply_quality_warning agent=stock turnId=tg_old issues=cjk_text_repaired'),
  ], { minutes: 1440 })

  assert.equal(data.summary.count, 1)
  assert.equal(data.turns[0].turnId, 'tg_old')
  assert.equal(data.turns[0].status, 'ok')
  assert.equal(data.turns[0].rootCause, 'queue_coalesced')
})

test('latency parser warns when stock price denial sees stock intent', () => {
  const data = buildLatencyFromLines([
    jsonLine(
      recentTime(),
      'telegram_stock_price_denied agent=stock turnId=tg_denied chat=7548005041 stockIntent=true ambiguousPrice=true'
    ),
  ], { minutes: 1440 })

  assert.equal(data.summary.count, 1)
  assert.equal(data.turns[0].rootCause, 'stock_price_denial')
  assert.equal(data.turns[0].guardrail, 'stock_price_denial')
  assert.equal(data.turns[0].stockIntent, true)
  assert.equal(data.turns[0].ambiguousPrice, true)
  assert.equal(data.warnings[0].type, 'stock_price_denial_stock_intent')
  assert.equal(data.warnings[0].turnId, 'tg_denied')
  assert.equal(data.warnings[0].chatIdRedacted, '75…41')
})

test('latency parser does not warn for explicit stock price denial without stock intent', () => {
  const data = buildLatencyFromLines([
    jsonLine(
      recentTime(),
      'telegram_stock_price_denied agent=stock turnId=tg_price chat=7548005041 stockIntent=false ambiguousPrice=false'
    ),
  ], { minutes: 1440 })

  assert.equal(data.summary.count, 1)
  assert.equal(data.turns[0].rootCause, 'stock_price_denial')
  assert.deepEqual(data.warnings, [])
})

test('latency parser classifies generic tool router turns', () => {
  const data = buildLatencyFromLines([
    jsonLine(recentTime(0), 'telegram_context_ready agent=stock turnId=tg_tool chat=7548005041 media=0 elapsedMs=20'),
    jsonLine(recentTime(10), 'telegram_ack_scheduled agent=stock turnId=tg_tool key=k delayMs=800 timeoutMs=1500'),
    jsonLine(recentTime(30), 'telegram_intent_routed agent=stock turnId=tg_tool intent=stock_balance accessMode=stock'),
    jsonLine(recentTime(180), 'telegram_tool_path agent=stock turnId=tg_tool intent=stock_balance tools=search_product->get_stock_balance searchMs=40 balanceMs=80'),
    jsonLine(recentTime(300), 'telegram_final_sent agent=stock turnId=tg_tool chat=7548005041 elapsedMs=300 ackSent=false'),
  ], { minutes: 1440 })

  assert.equal(data.summary.count, 1)
  assert.equal(data.turns[0].rootCause, 'tool_path_used')
  assert.equal(data.turns[0].guardrail, 'generic_tool_router')
  assert.deepEqual(data.turns[0].toolPath, ['search_product', 'get_stock_balance'])
  assert.equal(data.turns[0].mcpSearchMs, 40)
  assert.equal(data.turns[0].mcpBalanceMs, 80)
  assert.equal(data.turns[0].ackDelayMs, 800)
})

test('latency parser surfaces generic tool router failures', () => {
  const data = buildLatencyFromLines([
    jsonLine(recentTime(0), 'telegram_intent_routed agent=stock turnId=tg_fail intent=stock_balance accessMode=stock'),
    jsonLine(recentTime(120), 'telegram_tool_path_failed agent=stock turnId=tg_fail tool=search_product elapsedMs=120 error=timeout'),
    jsonLine(recentTime(1000), 'telegram_model_start agent=stock turnId=tg_fail elapsedMs=1000'),
  ], { minutes: 1440 })

  assert.equal(data.summary.count, 1)
  assert.equal(data.turns[0].rootCause, 'tool_path_failed_model_running')
  assert.equal(data.turns[0].guardrail, 'generic_tool_router')
  assert.equal(data.turns[0].failedTool, 'search_product')
  assert.equal(data.warnings[0].type, 'generic_tool_router_tool_path_failed')
  assert.equal(data.warnings[0].tool, 'search_product')
})

test('redactChatId keeps support payload safe', () => {
  assert.equal(redactChatId('7548005041'), '75…41')
  assert.equal(redactChatId('123'), '<redacted>')
})
