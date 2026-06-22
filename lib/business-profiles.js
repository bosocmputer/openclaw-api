const crypto = require('crypto')
const { pgPool } = require('./pg')

const SOUL_BLOCK_MAX_CHARS = 1500
const SECRET_PATTERN = /\b(api[_-]?key|authorization|bearer\s+[a-z0-9._-]+|password|bot[_-]?token|token\s*[:=]|sk-[a-z0-9_-]+)\b/i

const templates = [
  {
    templateId: 'automotive-parts-retail-service',
    name: 'Automotive Parts Retail & Service',
    nameTh: 'ธุรกิจอะไหล่และบริการยานยนต์',
    businessType: 'automotive_parts',
    summary: 'ร้านขายอะไหล่และบริการยานยนต์ที่ลูกค้ามักถามด้วยชื่ออะไหล่ร่วมกับยี่ห้อ รุ่นรถ ปีรถ หรือรหัสสินค้า',
    customerQuestionPatterns: [
      'เช็คยอดคงเหลือหรือมีสินค้าไหมจากชื่ออะไหล่ + รุ่นรถ',
      'ถามราคาจากรหัสสินค้า ชื่ออะไหล่ หรือรูปสินค้า',
      'ถามสินค้าเทียบแทนเมื่อสะกดชื่ออะไหล่หรือรุ่นรถไม่ตรงกัน',
    ],
    mainCategories: ['อะไหล่เครื่องยนต์', 'ช่วงล่าง', 'เบรก', 'ระบบไฟ', 'ตัวถัง', 'ของเหลวและอุปกรณ์สิ้นเปลือง'],
    synonyms: ['โช็ค/โช๊ค/โช้คอัพ', 'ลูกหมาก/ลูกหมากปีกนก/ลูกหมากคันชัก', 'ผ้าเบรก/ผ้าดิสเบรก', 'จานเบรก/จานดิสเบรก'],
    safetyRules: [
      'ห้ามเดารุ่นรถ สเปกสินค้า ราคา หรือยอดคงเหลือถ้า tool ไม่ยืนยัน',
      'ถ้าข้อมูลรุ่นรถหรือรหัสไม่ชัด ให้ถามกลับสั้น ๆ ก่อน',
    ],
    soulBlock: `## Business Profile
ธุรกิจ: ธุรกิจอะไหล่และบริการยานยนต์

ลูกค้ามักถามด้วยชื่ออะไหล่ร่วมกับยี่ห้อ รุ่นรถ ปีรถ หรือรหัสสินค้า เช่น ต้องการเช็คยอดคงเหลือ ราคา หรือรายการทดแทน

แนวทางตอบ:
- ใช้คำค้นหลักจากชื่ออะไหล่ รุ่นรถ ยี่ห้อรถ หรือรหัสสินค้า
- คำสะกดใกล้เคียงให้ตีความอย่างระมัดระวัง เช่น โช็ค/โช๊ค/โช้คอัพ
- ถ้าพบสินค้าเดียวและ intent ชัด ให้ตรวจยอดหรือราคาต่อทันทีตามสิทธิ์ของ agent
- ถ้าพบหลายรายการ ให้แสดงตัวเลือกสั้น ๆ และให้ลูกค้าเลือกรหัสหรือเลขรายการ
- ห้ามเดารุ่นรถ สินค้า ราคา หรือยอดคงเหลือถ้า tool ไม่ยืนยัน`,
  },
  {
    templateId: 'restaurant-food-service',
    name: 'Restaurant & Food Service',
    nameTh: 'ธุรกิจร้านอาหารและบริการอาหาร',
    businessType: 'restaurant_food_service',
    summary: 'ร้านอาหารหรือบริการอาหารที่ลูกค้ามักถามเมนู ราคา โปรโมชัน เวลาเปิดร้าน สถานะโต๊ะ และคำสั่งซื้อ',
    customerQuestionPatterns: [
      'ถามเมนู ราคา ส่วนผสม หรือความเผ็ด',
      'ถามโปรโมชัน เวลาเปิดร้าน การจองโต๊ะ หรือช่องทางเดลิเวอรี',
      'ถามสถานะออเดอร์หรือขอแก้ไขรายการอาหาร',
    ],
    mainCategories: ['อาหารจานเดียว', 'กับข้าว', 'เครื่องดื่ม', 'ของหวาน', 'ชุดอาหาร', 'โปรโมชัน'],
    synonyms: ['เมนู/รายการอาหาร', 'เผ็ดน้อย/ไม่เผ็ด/เผ็ดมาก', 'จองโต๊ะ/จองที่นั่ง', 'เดลิเวอรี/ส่งอาหาร'],
    safetyRules: [
      'ห้ามเดาราคา ส่วนผสม แพ้อาหาร หรือสถานะออเดอร์ถ้า tool ไม่ยืนยัน',
      'ถ้าคำถามเกี่ยวกับสารก่อภูมิแพ้ต้องตอบอย่างระมัดระวังและยึดข้อมูลระบบเท่านั้น',
    ],
    soulBlock: `## Business Profile
ธุรกิจ: ธุรกิจร้านอาหารและบริการอาหาร

ลูกค้ามักถามเรื่องเมนู ราคา โปรโมชัน เวลาเปิดร้าน การจองโต๊ะ เดลิเวอรี หรือสถานะออเดอร์

แนวทางตอบ:
- ใช้ชื่อเมนู หมวดอาหาร รสชาติ ขนาด หรือรหัสรายการเป็น keyword
- ถ้าถามราคา เมนูว่าง หรือสถานะออเดอร์ ให้ยึดผลจาก tool เท่านั้น
- ถ้าลูกค้าพูดถึงความเผ็ด ตัวเลือกเสริม หรือการแพ้อาหาร ให้ถามยืนยันเมื่อข้อมูลไม่ครบ
- ถ้าพบหลายเมนู ให้แสดงตัวเลือกสั้น ๆ และถามให้เลือกรายการ
- ห้ามเดาส่วนผสม ราคา โปรโมชัน หรือเวลาจัดส่งถ้า tool ไม่ยืนยัน`,
  },
  {
    templateId: 'construction-materials-hardware-retail',
    name: 'Construction Materials & Hardware Retail',
    nameTh: 'ธุรกิจวัสดุก่อสร้างและอุปกรณ์งานช่าง',
    businessType: 'construction_materials_hardware',
    summary: 'ร้านวัสดุก่อสร้างและอุปกรณ์งานช่างที่ลูกค้ามักถามด้วยประเภทสินค้า ขนาด หน่วย ยี่ห้อ และจำนวนที่ต้องใช้',
    customerQuestionPatterns: [
      'ถามยอดคงเหลือหรือราคาจากชื่อวัสดุ + ขนาด/หน่วย',
      'ถามสินค้าใกล้เคียง เช่น สกรู พุก สี ปูน ท่อ สายไฟ',
      'ถามจำนวนที่ต้องใช้หรือสินค้าเหมาะกับงานประเภทใด',
    ],
    mainCategories: ['ปูนและคอนกรีต', 'เหล็ก', 'สีและเคมีภัณฑ์', 'ประปา', 'ไฟฟ้า', 'เครื่องมือช่าง', 'ฮาร์ดแวร์'],
    synonyms: ['สกรู/น็อต/ตะปู', 'พุก/พุกเหล็ก/พุกพลาสติก', 'ปูน/ปูนกาว/ปูนซีเมนต์', 'ท่อ/ข้อต่อ/ข้องอ'],
    safetyRules: [
      'ห้ามคำนวณปริมาณงานหรือแนะนำสเปกความปลอดภัยแบบฟันธงถ้าข้อมูลไม่ครบ',
      'ต้องถามขนาด หน่วย หรือประเภทงานเพิ่มเมื่อสินค้าอาจมีหลายสเปก',
    ],
    soulBlock: `## Business Profile
ธุรกิจ: ธุรกิจวัสดุก่อสร้างและอุปกรณ์งานช่าง

ลูกค้ามักถามด้วยชื่อวัสดุ ขนาด หน่วย ยี่ห้อ หรือประเภทงาน เช่น ต้องการเช็คยอด ราคา หรือสินค้าใกล้เคียง

แนวทางตอบ:
- ใช้ชื่อสินค้า ขนาด หน่วย ยี่ห้อ และประเภทงานเป็น keyword
- ให้ความสำคัญกับหน่วย เช่น เส้น ถุง กล่อง แกลลอน เมตร นิ้ว มม.
- ถ้าสินค้ามีหลายขนาดหรือหลายสเปก ให้ถามเพิ่มหรือให้เลือกรายการ
- ห้ามเดาปริมาณใช้งาน สเปกความปลอดภัย ราคา หรือยอดคงเหลือถ้า tool ไม่ยืนยัน
- ถ้าข้อมูลไม่ครบ ให้ถามกลับหนึ่งข้อที่ช่วยระบุขนาดหรือประเภทงาน`,
  },
  {
    templateId: 'general-retail-consumer-goods',
    name: 'General Retail & Consumer Goods',
    nameTh: 'ธุรกิจค้าปลีกทั่วไปและสินค้าอุปโภคบริโภค',
    businessType: 'general_retail_consumer_goods',
    summary: 'ร้านค้าปลีกทั่วไปที่ลูกค้ามักถามสินค้า ราคา โปรโมชัน ยอดคงเหลือ บาร์โค้ด และตัวเลือกขนาดหรือรสชาติ',
    customerQuestionPatterns: [
      'ถามมีสินค้าไหมจากชื่อสินค้า ยี่ห้อ รสชาติ ขนาด หรือบาร์โค้ด',
      'ถามราคา โปรโมชัน และจำนวนคงเหลือ',
      'ถามสินค้าใกล้เคียงเมื่อไม่มีสินค้าที่ต้องการ',
    ],
    mainCategories: ['อาหารแห้ง', 'เครื่องดื่ม', 'ขนม', 'ของใช้ในบ้าน', 'ของใช้ส่วนตัว', 'สินค้าอุปโภคบริโภค'],
    synonyms: ['บาร์โค้ด/รหัสสินค้า', 'แพ็ก/ลัง/ชิ้น', 'รสชาติ/สูตร/ขนาด', 'โปรโมชัน/ส่วนลด'],
    safetyRules: [
      'ห้ามเดาราคา โปรโมชัน หรือสต็อกถ้า tool ไม่ยืนยัน',
      'ถ้าสินค้ามีหลายรสชาติหรือหลายขนาดให้ถามเพิ่มหรือให้เลือกรายการ',
    ],
    soulBlock: `## Business Profile
ธุรกิจ: ธุรกิจค้าปลีกทั่วไปและสินค้าอุปโภคบริโภค

ลูกค้ามักถามด้วยชื่อสินค้า ยี่ห้อ ขนาด รสชาติ บาร์โค้ด หรือรหัสสินค้า เพื่อเช็คยอด ราคา หรือโปรโมชัน

แนวทางตอบ:
- ใช้ชื่อสินค้า ยี่ห้อ ขนาด รสชาติ บาร์โค้ด หรือรหัสสินค้าเป็น keyword
- ถ้าพบหลายขนาด หลายสูตร หรือหลายรสชาติ ให้แสดงตัวเลือกสั้น ๆ
- ถ้าลูกค้าถามราคา โปรโมชัน หรือยอดคงเหลือ ให้ยึดผลจาก tool เท่านั้น
- ถ้าคำค้นกว้างเกินไป ให้ถามเพิ่มหนึ่งข้อ เช่น ยี่ห้อ ขนาด หรือรสชาติ
- ห้ามเดาราคา โปรโมชัน สต็อก หรือสินค้าทดแทนถ้า tool ไม่ยืนยัน`,
  },
]

function soulBlockHash(soulBlock) {
  return crypto.createHash('sha256').update(String(soulBlock || ''), 'utf8').digest('hex').slice(0, 16)
}

function normalizeArray(value) {
  if (Array.isArray(value)) return value.map(v => String(v || '').trim()).filter(Boolean).slice(0, 80)
  if (typeof value === 'string') return value.split('\n').map(v => v.trim()).filter(Boolean).slice(0, 80)
  return []
}

function normalizeProfileInput(body = {}) {
  const soulBlock = String(body.soulBlock || '').trim()
  const profile = {
    name: String(body.name || '').trim(),
    nameTh: String(body.nameTh || '').trim(),
    businessType: String(body.businessType || '').trim(),
    summary: String(body.summary || '').trim(),
    customerQuestionPatterns: normalizeArray(body.customerQuestionPatterns),
    mainCategories: normalizeArray(body.mainCategories),
    synonyms: normalizeArray(body.synonyms),
    safetyRules: normalizeArray(body.safetyRules),
    soulBlock,
  }
  validateProfile(profile)
  return profile
}

function validateProfile(profile) {
  if (!profile.name) throw Object.assign(new Error('name is required'), { status: 400 })
  if (!profile.nameTh) throw Object.assign(new Error('nameTh is required'), { status: 400 })
  if (!profile.businessType) throw Object.assign(new Error('businessType is required'), { status: 400 })
  if (!profile.soulBlock) throw Object.assign(new Error('soulBlock is required'), { status: 400 })
  if (profile.soulBlock.length > SOUL_BLOCK_MAX_CHARS) {
    throw Object.assign(new Error(`soulBlock must be <= ${SOUL_BLOCK_MAX_CHARS} characters`), { status: 400 })
  }
  const rawText = [
    profile.name,
    profile.nameTh,
    profile.businessType,
    profile.summary,
    profile.soulBlock,
    ...profile.customerQuestionPatterns,
    ...profile.mainCategories,
    ...profile.synonyms,
    ...profile.safetyRules,
  ].join('\n')
  if (SECRET_PATTERN.test(rawText)) {
    throw Object.assign(new Error('profile contains a secret-like value'), { status: 400 })
  }
}

function serializeProfile(row) {
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    nameTh: row.name_th,
    businessType: row.business_type,
    summary: row.summary || '',
    customerQuestionPatterns: row.customer_question_patterns || [],
    mainCategories: row.main_categories || [],
    synonyms: row.synonyms || [],
    safetyRules: row.safety_rules || [],
    soulBlock: row.soul_block || '',
    soulBlockHash: row.soul_block_hash || soulBlockHash(row.soul_block || ''),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function serializeLink(row) {
  if (!row) return null
  return {
    profileId: row.profile_id,
    agentId: row.agent_id,
    lastAppliedHash: row.last_applied_hash || null,
    lastAppliedAt: row.last_applied_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

async function ensureBusinessProfileSchema() {
  if (!pgPool) throw Object.assign(new Error('Database not configured'), { status: 503 })
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS business_profiles (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      name_th TEXT NOT NULL,
      business_type TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      customer_question_patterns JSONB NOT NULL DEFAULT '[]'::jsonb,
      main_categories JSONB NOT NULL DEFAULT '[]'::jsonb,
      synonyms JSONB NOT NULL DEFAULT '[]'::jsonb,
      safety_rules JSONB NOT NULL DEFAULT '[]'::jsonb,
      soul_block TEXT NOT NULL,
      soul_block_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS business_profile_agent_links (
      profile_id UUID NOT NULL REFERENCES business_profiles(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL,
      last_applied_hash TEXT,
      last_applied_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (agent_id)
    )
  `)
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_business_profiles_type ON business_profiles(business_type)')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_business_profile_links_profile ON business_profile_agent_links(profile_id)')
}

function getTemplates() {
  return templates.map(t => ({
    ...t,
    soulBlockHash: soulBlockHash(t.soulBlock),
    soulBlockChars: t.soulBlock.length,
  }))
}

async function listProfiles() {
  await ensureBusinessProfileSchema()
  const { rows } = await pgPool.query(`
    SELECT p.*, COALESCE(json_agg(l.agent_id ORDER BY l.agent_id) FILTER (WHERE l.agent_id IS NOT NULL), '[]') AS agent_ids
    FROM business_profiles p
    LEFT JOIN business_profile_agent_links l ON l.profile_id = p.id
    GROUP BY p.id
    ORDER BY p.updated_at DESC, p.name ASC
  `)
  return rows.map(row => ({ ...serializeProfile(row), agentIds: row.agent_ids || [] }))
}

async function getProfile(id) {
  await ensureBusinessProfileSchema()
  const { rows } = await pgPool.query('SELECT * FROM business_profiles WHERE id = $1', [id])
  return serializeProfile(rows[0])
}

async function createProfile(input) {
  await ensureBusinessProfileSchema()
  const profile = normalizeProfileInput(input)
  const hash = soulBlockHash(profile.soulBlock)
  const { rows } = await pgPool.query(`
    INSERT INTO business_profiles (
      name, name_th, business_type, summary, customer_question_patterns,
      main_categories, synonyms, safety_rules, soul_block, soul_block_hash
    )
    VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10)
    RETURNING *
  `, [
    profile.name,
    profile.nameTh,
    profile.businessType,
    profile.summary,
    JSON.stringify(profile.customerQuestionPatterns),
    JSON.stringify(profile.mainCategories),
    JSON.stringify(profile.synonyms),
    JSON.stringify(profile.safetyRules),
    profile.soulBlock,
    hash,
  ])
  return serializeProfile(rows[0])
}

async function updateProfile(id, input) {
  await ensureBusinessProfileSchema()
  const profile = normalizeProfileInput(input)
  const hash = soulBlockHash(profile.soulBlock)
  const { rows } = await pgPool.query(`
    UPDATE business_profiles
    SET name = $2,
        name_th = $3,
        business_type = $4,
        summary = $5,
        customer_question_patterns = $6::jsonb,
        main_categories = $7::jsonb,
        synonyms = $8::jsonb,
        safety_rules = $9::jsonb,
        soul_block = $10,
        soul_block_hash = $11,
        updated_at = now()
    WHERE id = $1
    RETURNING *
  `, [
    id,
    profile.name,
    profile.nameTh,
    profile.businessType,
    profile.summary,
    JSON.stringify(profile.customerQuestionPatterns),
    JSON.stringify(profile.mainCategories),
    JSON.stringify(profile.synonyms),
    JSON.stringify(profile.safetyRules),
    profile.soulBlock,
    hash,
  ])
  return serializeProfile(rows[0])
}

async function deleteProfile(id) {
  await ensureBusinessProfileSchema()
  const linked = await pgPool.query('SELECT agent_id FROM business_profile_agent_links WHERE profile_id = $1 ORDER BY agent_id', [id])
  if (linked.rows.length) {
    throw Object.assign(new Error(`profile is linked to agents: ${linked.rows.map(r => r.agent_id).join(', ')}`), { status: 409 })
  }
  const result = await pgPool.query('DELETE FROM business_profiles WHERE id = $1', [id])
  return result.rowCount > 0
}

async function linkProfileToAgent(profileId, agentId) {
  await ensureBusinessProfileSchema()
  const profile = await getProfile(profileId)
  if (!profile) throw Object.assign(new Error('Profile not found'), { status: 404 })
  const { rows } = await pgPool.query(`
    INSERT INTO business_profile_agent_links (profile_id, agent_id)
    VALUES ($1, $2)
    ON CONFLICT (agent_id) DO UPDATE
      SET profile_id = EXCLUDED.profile_id,
          updated_at = now(),
          last_applied_hash = NULL,
          last_applied_at = NULL
    RETURNING *
  `, [profileId, agentId])
  return serializeLink(rows[0])
}

async function unlinkProfileFromAgent(profileId, agentId) {
  await ensureBusinessProfileSchema()
  const result = await pgPool.query(
    'DELETE FROM business_profile_agent_links WHERE profile_id = $1 AND agent_id = $2',
    [profileId, agentId]
  )
  return result.rowCount > 0
}

async function getAgentBusinessProfile(agentId) {
  await ensureBusinessProfileSchema()
  const { rows } = await pgPool.query(`
    SELECT p.*, l.agent_id, l.last_applied_hash, l.last_applied_at, l.created_at AS link_created_at, l.updated_at AS link_updated_at
    FROM business_profile_agent_links l
    JOIN business_profiles p ON p.id = l.profile_id
    WHERE l.agent_id = $1
  `, [agentId])
  if (!rows[0]) return null
  const profile = serializeProfile(rows[0])
  const link = {
    profileId: rows[0].id,
    agentId,
    lastAppliedHash: rows[0].last_applied_hash || null,
    lastAppliedAt: rows[0].last_applied_at || null,
    createdAt: rows[0].link_created_at,
    updatedAt: rows[0].link_updated_at,
  }
  return {
    profile,
    link,
    isApplied: Boolean(link.lastAppliedHash && link.lastAppliedHash === profile.soulBlockHash),
  }
}

async function getAgentBusinessProfileSafe(agentId) {
  if (!pgPool) return null
  try {
    return await getAgentBusinessProfile(agentId)
  } catch (err) {
    if (err.code === '42P01') return null
    throw err
  }
}

async function markAgentBusinessProfileApplied(agentId, hash) {
  if (!pgPool || !hash) return null
  try {
    await ensureBusinessProfileSchema()
    const { rows } = await pgPool.query(`
      UPDATE business_profile_agent_links
      SET last_applied_hash = $2,
          last_applied_at = now(),
          updated_at = now()
      WHERE agent_id = $1
      RETURNING *
    `, [agentId, hash])
    return serializeLink(rows[0])
  } catch {
    return null
  }
}

function buildBusinessProfileSoulBlock(profile) {
  if (!profile) return ''
  const hash = profile.soulBlockHash || soulBlockHash(profile.soulBlock)
  return `<!-- OPENCLAW_BUSINESS_PROFILE {"id":"${profile.id}","hash":"${hash}"} -->\n${profile.soulBlock.trim()}`
}

function extractBusinessProfileHashFromSoul(soul) {
  const match = String(soul || '').match(/OPENCLAW_BUSINESS_PROFILE\s+({[\s\S]*?})\s*-->/)
  if (!match) return null
  try {
    const parsed = JSON.parse(match[1])
    return typeof parsed.hash === 'string' ? parsed.hash : null
  } catch {
    return null
  }
}

module.exports = {
  SOUL_BLOCK_MAX_CHARS,
  buildBusinessProfileSoulBlock,
  createProfile,
  deleteProfile,
  ensureBusinessProfileSchema,
  extractBusinessProfileHashFromSoul,
  getAgentBusinessProfile,
  getAgentBusinessProfileSafe,
  getProfile,
  getTemplates,
  linkProfileToAgent,
  listProfiles,
  markAgentBusinessProfileApplied,
  normalizeProfileInput,
  soulBlockHash,
  unlinkProfileFromAgent,
  updateProfile,
  validateProfile,
  _internal: {
    SECRET_PATTERN,
    templates,
  },
}
