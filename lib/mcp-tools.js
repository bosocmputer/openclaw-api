const crypto = require('crypto')

const DEFAULT_MCP_URL = 'http://192.168.2.248:3515/sse'
const MCP_TOOL_TIMEOUT_MS = 2500
const MCP_TOOL_CACHE_TTL_MS = 30_000
const SOUL_CONTRACT_VERSION = 'capability-v1'

const mcpToolCache = new Map()

// These MCP tools either produce generic fallback text or mutate ERP state.
// Keep default SOUL templates capability-driven and read-only unless a
// dedicated operator flow explicitly enables write actions.
const DEFAULT_SOUL_EXCLUDED_TOOLS = new Set([
  'create_sale_reserve',
  'fallback_response',
])

const FALLBACK_TOOL_DESCRIPTIONS = {
  create_sale_reserve: 'บันทึกใบสั่งจองหลังผู้ใช้ยืนยันรายการ',
  fallback_response: 'แจ้งเมื่อไม่มี tool รองรับคำขอ',
  get_account_incoming: 'ตรวจยอดสินค้าค้างรับ',
  get_account_outstanding: 'ตรวจยอดสินค้าค้างส่ง',
  get_ar_document_detail: 'ดูรายละเอียดเอกสารลูกหนี้',
  get_ar_outstanding: 'ตรวจลูกหนี้คงค้าง',
  get_ar_overdue: 'ตรวจลูกหนี้เกินกำหนด',
  get_bookout_balance: 'ตรวจยอดสินค้าค้างจอง',
  get_customer_activity_status: 'ดูสถานะการซื้อของลูกค้า',
  get_customer_credit_status: 'ดูสถานะเครดิตลูกค้า',
  get_customer_profitability: 'วิเคราะห์กำไรต่อลูกค้า',
  get_customer_purchase_frequency: 'วิเคราะห์ความถี่การซื้อของลูกค้า',
  get_customer_rfm: 'วิเคราะห์ RFM ของลูกค้า',
  get_customer_segment_summary: 'สรุป segment ลูกค้า',
  get_customer_top_items: 'ดูสินค้าที่ลูกค้าซื้อบ่อยหรือซื้อสูงสุด',
  get_document_summary: 'สรุปเอกสารขาย',
  get_dso_analysis: 'วิเคราะห์ DSO ระยะเวลาเก็บเงิน',
  get_item_top_buyers: 'ดูลูกค้าที่ซื้อสินค้านั้นมากที่สุด',
  get_new_customer_trend: 'ดูแนวโน้มลูกค้าใหม่',
  get_product_price: 'ตรวจราคาขายสินค้า',
  get_sales_by_area: 'ยอดขายแยกตามพื้นที่',
  get_sales_by_branch: 'ยอดขายแยกตามสาขา',
  get_sales_by_customer: 'ยอดขายแยกตามลูกค้า',
  get_sales_by_dimension: 'ยอดขายแยกตามมิติธุรกิจ',
  get_sales_by_item: 'ยอดขายแยกตามสินค้า',
  get_sales_by_salesman: 'ยอดขายแยกตามพนักงานขาย',
  get_sales_conversion_rate: 'วิเคราะห์ conversion จาก quotation ไป invoice',
  get_sales_item_detail: 'รายละเอียดสินค้าในเอกสารขายและกำไร',
  get_sales_summary: 'สรุปยอดขายตามช่วงเวลา',
  get_salesman_crm_kpi: 'ดู KPI CRM ของพนักงานขาย',
  get_stock_balance: 'ตรวจยอดคงเหลือสินค้า',
  get_version: 'ตรวจเวอร์ชัน MCP server',
  search_customer: 'ค้นหาลูกค้า',
  search_product: 'ค้นหาสินค้า',
  search_supplier: 'ค้นหาผู้จำหน่าย',
}

const FALLBACK_REQUIRED_ARGS = {
  create_sale_reserve: ['contact_name', 'contact_phone', 'items'],
  search_customer: ['keyword'],
  search_product: ['keyword'],
  search_supplier: ['keyword'],
  get_stock_balance: ['item_code'],
  get_product_price: ['item_code'],
  get_account_incoming: ['item_code'],
  get_account_outstanding: ['item_code'],
  get_bookout_balance: ['item_code'],
}

const FALLBACK_TOOLS_BY_MODE = {
  admin: [
    'get_account_incoming',
    'get_account_outstanding',
    'get_ar_document_detail',
    'get_ar_outstanding',
    'get_ar_overdue',
    'get_bookout_balance',
    'get_customer_activity_status',
    'get_customer_credit_status',
    'get_customer_profitability',
    'get_customer_purchase_frequency',
    'get_customer_rfm',
    'get_customer_segment_summary',
    'get_customer_top_items',
    'get_document_summary',
    'get_dso_analysis',
    'get_item_top_buyers',
    'get_new_customer_trend',
    'get_product_price',
    'get_sales_by_area',
    'get_sales_by_branch',
    'get_sales_by_customer',
    'get_sales_by_dimension',
    'get_sales_by_item',
    'get_sales_by_salesman',
    'get_sales_conversion_rate',
    'get_sales_item_detail',
    'get_sales_summary',
    'get_salesman_crm_kpi',
    'get_stock_balance',
    'get_version',
    'search_customer',
    'search_product',
    'search_supplier',
  ],
  sales: [
    'get_account_outstanding',
    'get_bookout_balance',
    'get_product_price',
    'get_stock_balance',
    'get_version',
    'search_customer',
    'search_product',
  ],
  purchase: [
    'get_account_incoming',
    'get_stock_balance',
    'get_version',
    'search_product',
    'search_supplier',
  ],
  stock: [
    'get_account_incoming',
    'get_account_outstanding',
    'get_bookout_balance',
    'get_stock_balance',
    'get_version',
    'search_product',
  ],
  general: [
    'get_product_price',
    'get_stock_balance',
    'get_version',
    'search_product',
  ],
}

const CAPABILITY_DEFINITIONS = [
  {
    id: 'product_search',
    label: 'ค้นหาสินค้า',
    description: 'ค้นหารายการสินค้าและรหัสสินค้า',
    toolNames: ['search_product'],
    deniedSummary: 'ไม่มีเครื่องมือค้นหาสินค้า',
  },
  {
    id: 'stock_balance',
    label: 'ตรวจสต็อก',
    description: 'ตรวจยอดคงเหลือสินค้า',
    toolNames: ['get_stock_balance'],
    deniedSummary: 'ไม่มีสิทธิ์ตรวจสต็อก',
  },
  {
    id: 'price_lookup',
    label: 'ตรวจราคา',
    description: 'ตรวจราคาขายสินค้า',
    toolNames: ['get_product_price'],
    deniedSummary: 'ไม่มีสิทธิ์ตรวจราคา',
  },
  {
    id: 'customer_lookup',
    label: 'ค้นหาลูกค้า',
    description: 'ค้นหาและตรวจข้อมูลลูกค้า',
    toolNames: ['search_customer'],
    deniedSummary: 'ไม่มีสิทธิ์ค้นหาลูกค้า',
  },
  {
    id: 'supplier_lookup',
    label: 'ค้นหาผู้จำหน่าย',
    description: 'ค้นหาและตรวจข้อมูลผู้จำหน่าย',
    toolNames: ['search_supplier'],
    deniedSummary: 'ไม่มีสิทธิ์ค้นหาผู้จำหน่าย',
  },
  {
    id: 'inventory_flow',
    label: 'ค้างรับ/ค้างส่ง/ค้างจอง',
    description: 'ตรวจยอดค้างรับ ค้างส่ง หรือค้างจอง',
    toolNames: ['get_account_incoming', 'get_account_outstanding', 'get_bookout_balance'],
    anyTool: true,
    deniedSummary: 'ไม่มีสิทธิ์ตรวจยอดค้างรับ ค้างส่ง หรือค้างจอง',
  },
  {
    id: 'sales_analytics',
    label: 'วิเคราะห์ยอดขาย',
    description: 'ดูยอดขาย แยกมิติ และ KPI ฝ่ายขาย',
    toolNames: [
      'get_sales_summary',
      'get_sales_by_customer',
      'get_sales_by_salesman',
      'get_sales_by_branch',
      'get_sales_by_item',
      'get_sales_by_area',
      'get_sales_by_dimension',
    ],
    anyTool: true,
    deniedSummary: 'ไม่มีสิทธิ์ดูรายงานยอดขาย',
  },
  {
    id: 'ar_credit',
    label: 'ลูกหนี้/เครดิต',
    description: 'ดูยอดลูกหนี้ เกินกำหนด เครดิต และ DSO',
    toolNames: ['get_ar_outstanding', 'get_ar_overdue', 'get_customer_credit_status', 'get_dso_analysis'],
    anyTool: true,
    deniedSummary: 'ไม่มีสิทธิ์ดูข้อมูลลูกหนี้หรือเครดิต',
  },
  {
    id: 'sale_reserve',
    label: 'บันทึกใบสั่งจอง',
    description: 'สร้างใบสั่งจองเมื่อผู้ใช้ยืนยันข้อมูลครบ',
    toolNames: ['create_sale_reserve'],
    deniedSummary: 'ไม่มีเครื่องมือบันทึกใบสั่งจอง',
  },
]

function sanitizeError(err) {
  return String(err?.message || err || 'unknown error')
    .replace(/bot[0-9]{6,}:[A-Za-z0-9_-]+/g, 'bot<redacted>')
    .replace(/sk-or-[A-Za-z0-9_-]+/g, 'sk-or-<redacted>')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer <redacted>')
    .slice(0, 240)
}

function normalizeAccessMode(accessMode) {
  const raw = String(accessMode || 'general').toLowerCase()
  const mode = raw === 'sale' || raw === 'sale_goh' ? 'sales' : raw
  return FALLBACK_TOOLS_BY_MODE[mode] ? mode : 'general'
}

function mcpToolsUrl(mcpUrl = DEFAULT_MCP_URL) {
  return String(mcpUrl || DEFAULT_MCP_URL).replace(/\/(call|sse|mcp)(\/.*)?$/, '') + '/tools'
}

function shortenDescription(value, max = 120) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  if (text.length <= max) return text
  return text.slice(0, max - 1).trimEnd() + '…'
}

function normalizeTool(raw) {
  const inputSchema = raw?.inputSchema || raw?.schema || raw?.parameters || {}
  const required = Array.isArray(inputSchema.required) ? inputSchema.required.filter(Boolean) : []
  const properties = inputSchema.properties && typeof inputSchema.properties === 'object'
    ? Object.keys(inputSchema.properties)
    : []
  return {
    name: String(raw?.name || '').trim(),
    description: shortenDescription(raw?.description || ''),
    required,
    args: properties,
  }
}

function normalizeTools(list) {
  const seen = new Set()
  return (Array.isArray(list) ? list : [])
    .map(normalizeTool)
    .filter(tool => {
      if (!tool.name || seen.has(tool.name) || DEFAULT_SOUL_EXCLUDED_TOOLS.has(tool.name)) return false
      seen.add(tool.name)
      return true
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

function fallbackTool(name) {
  return {
    name,
    description: FALLBACK_TOOL_DESCRIPTIONS[name] || '',
    required: FALLBACK_REQUIRED_ARGS[name] || [],
    args: FALLBACK_REQUIRED_ARGS[name] || [],
  }
}

function getFallbackTools(accessMode) {
  return (FALLBACK_TOOLS_BY_MODE[normalizeAccessMode(accessMode)] || FALLBACK_TOOLS_BY_MODE.general)
    .map(fallbackTool)
    .sort((a, b) => a.name.localeCompare(b.name))
}

function hashToolNames(toolNames) {
  const names = [...new Set(toolNames || [])].filter(Boolean).sort()
  return crypto.createHash('sha256').update(names.join('\n')).digest('hex').slice(0, 16)
}

function deriveCapabilities(tools) {
  const names = new Set((tools || []).map(t => t.name))
  const capabilities = []
  const deniedCapabilities = []
  for (const cap of CAPABILITY_DEFINITIONS) {
    const hasCapability = cap.anyTool
      ? cap.toolNames.some(name => names.has(name))
      : cap.toolNames.every(name => names.has(name))
    const item = {
      id: cap.id,
      label: cap.label,
      description: cap.description,
      toolNames: cap.toolNames.filter(name => names.has(name)),
      missingToolNames: cap.toolNames.filter(name => !names.has(name)),
      summary: hasCapability ? cap.description : cap.deniedSummary,
    }
    if (hasCapability) capabilities.push(item)
    else deniedCapabilities.push(item)
  }
  return { capabilities, deniedCapabilities }
}

async function getMcpTools(options = {}) {
  const accessMode = normalizeAccessMode(options.accessMode)
  const mcpUrl = options.mcpUrl || DEFAULT_MCP_URL
  const timeoutMs = options.timeoutMs || MCP_TOOL_TIMEOUT_MS
  const cacheTtlMs = options.cacheTtlMs || MCP_TOOL_CACHE_TTL_MS
  const cacheKey = `${mcpToolsUrl(mcpUrl)}|${accessMode}`
  const cached = mcpToolCache.get(cacheKey)

  if (!options.refresh && cached && Date.now() - cached.createdAt < cacheTtlMs) {
    return {
      ...cached.payload,
      cache: {
        hit: true,
        ttlSeconds: Math.ceil((cacheTtlMs - (Date.now() - cached.createdAt)) / 1000),
      },
    }
  }

  const warnings = []
  try {
    const res = await fetch(mcpToolsUrl(mcpUrl), {
      headers: { 'mcp-access-mode': accessMode },
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await res.text()
    let json = null
    try { json = text ? JSON.parse(text) : null } catch {}
    if (!res.ok) throw new Error(`HTTP ${res.status} from MCP tools`)
    const rawTools = Array.isArray(json) ? json : (json?.tools || [])
    const tools = normalizeTools(rawTools)
    const { capabilities, deniedCapabilities } = deriveCapabilities(tools)
    const payload = {
      ok: true,
      accessMode,
      mcpUrl,
      toolSource: 'live',
      tools,
      capabilities,
      deniedCapabilities,
      warnings,
      error: null,
      generatedAt: new Date().toISOString(),
    }
    mcpToolCache.set(cacheKey, { createdAt: Date.now(), payload })
    return { ...payload, cache: { hit: false, ttlSeconds: cacheTtlMs / 1000 } }
  } catch (err) {
    const tools = getFallbackTools(accessMode)
    const { capabilities, deniedCapabilities } = deriveCapabilities(tools)
    warnings.push(`MCP /tools unavailable, using fallback snapshot: ${sanitizeError(err)}`)
    return {
      ok: false,
      accessMode,
      mcpUrl,
      toolSource: 'fallback',
      tools,
      capabilities,
      deniedCapabilities,
      warnings,
      error: sanitizeError(err),
      generatedAt: new Date().toISOString(),
      cache: { hit: false, ttlSeconds: 0 },
    }
  }
}

function buildSoulContract({ accessMode, toolSource, tools, generatedAt }) {
  const allowedTools = normalizeTools(tools).map(t => t.name)
  return {
    version: SOUL_CONTRACT_VERSION,
    accessMode: normalizeAccessMode(accessMode),
    toolSource: toolSource || 'fallback',
    generatedAt: generatedAt || new Date().toISOString(),
    allowedTools,
    allowedToolsHash: hashToolNames(allowedTools),
  }
}

function serializeSoulContract(contract) {
  return `<!-- OPENCLAW_SOUL_CONTRACT ${JSON.stringify(contract)} -->`
}

function parseSoulContract(soul) {
  const match = String(soul || '').match(/OPENCLAW_SOUL_CONTRACT\s+({[^]*?})\s*-->/)
  if (!match) return null
  try { return JSON.parse(match[1]) } catch { return null }
}

function compareSoulContractToTools(contract, tools) {
  if (!contract) {
    return {
      status: 'warn',
      warnings: ['SOUL missing OPENCLAW_SOUL_CONTRACT marker'],
      allowedToolsHash: hashToolNames((tools || []).map(t => t.name)),
    }
  }

  const liveToolNames = normalizeTools(tools).map(t => t.name)
  const liveHash = hashToolNames(liveToolNames)
  const warnings = []
  if (contract.version !== SOUL_CONTRACT_VERSION) {
    warnings.push(`SOUL contract version is ${contract.version || 'unknown'}, expected ${SOUL_CONTRACT_VERSION}`)
  }
  if (contract.allowedToolsHash !== liveHash) {
    warnings.push(`SOUL allowed tools hash mismatch: ${contract.allowedToolsHash || 'missing'} != ${liveHash}`)
  }
  const staleMs = Date.now() - Date.parse(contract.generatedAt || 0)
  if (Number.isFinite(staleMs) && staleMs > 7 * 24 * 60 * 60 * 1000) {
    warnings.push('SOUL template contract is older than 7 days')
  }
  if (contract.toolSource === 'fallback') {
    warnings.push('SOUL was generated from fallback MCP tools, not live /tools')
  }
  return {
    status: warnings.length ? 'warn' : 'ok',
    warnings,
    allowedToolsHash: liveHash,
  }
}

module.exports = {
  DEFAULT_MCP_URL,
  MCP_TOOL_TIMEOUT_MS,
  MCP_TOOL_CACHE_TTL_MS,
  SOUL_CONTRACT_VERSION,
  CAPABILITY_DEFINITIONS,
  deriveCapabilities,
  getFallbackTools,
  getMcpTools,
  hashToolNames,
  mcpToolsUrl,
  normalizeAccessMode,
  normalizeTools,
  parseSoulContract,
  compareSoulContractToTools,
  buildSoulContract,
  serializeSoulContract,
  sanitizeError,
}
