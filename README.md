# OpenClaw API

Express.js REST API server สำหรับ OpenClaw Admin — เป็น bridge ระหว่าง Web UI และ OpenClaw config/CLI บน server

> **หมายเหตุ**: รันบน host โดยตรง (ไม่ใช่ Docker) เพราะต้องเข้าถึง OpenClaw runtime, PM2/systemd, config และ workspace files

## Release Status ล่าสุด

| ส่วน | Baseline |
| ---- | -------- |
| Runtime overlay release | `2026.6.11-erp-20260706-line-burst-fastpath` |
| Runtime overlay | `openclaw-runtime-2026.6.11-erp-line-burst-fe432925.tgz` |
| Runtime overlay SHA256 | `a26156d0440b4d6010d89c98a94cdefa8f0d51693762874bde0d607175f94a99` |
| Runtime source commits | `f608a18664`, `9976b9bbd7`, `fe432925eb` |
| openclaw-api | `b32f1f0` หรือใหม่กว่า |
| openclaw-admin | `adba0bb` หรือใหม่กว่า |

> Runtime target path คือ `/root/openclaw-runtime-2026.6.11-erp/dist/index.js`. สำหรับ production ปัจจุบันให้ใช้ base runtime 2026.6.11 จริง โดย `node ... --version` ควรแสดง `OpenClaw 2026.6.11 (fe43292)` หรือใหม่กว่า. Overlay-only บน skeleton 2026.6.8 เป็น legacy LINE-only emergency path และไม่พอสำหรับ provider ใหม่อย่าง `ollama-cloud`.

สิ่งที่ API รองรับใน baseline นี้:

- `/api/system/observability`, `/api/system/release-gate/run`, และ `/api/system/update-command` เป็น production gate สำหรับตรวจ runtime/process/git/memory ก่อน update ลูกค้า โดยไม่ยิง model provider ตอนเปิดหน้า
- LINE image + rapid follow-up text works as one generic turn in runtime; text-only LINE messages are not delayed.
- Parse LINE/runtime/media markers when available and expose safe monitor/analysis metadata without leaking local paths or tokens.
- Model admin supports runtime-verified text/image tests and provider catalog flow, including OpenRouter, Kilo, and `ollama-cloud`.
- Agent Knowledge Brain is default-deny and evidence-based: typed `terminology`, `search_hint`, `description_suggestion`, workflow/FAQ hints, and blocked facts are stored in PostgreSQL. Dynamic ERP facts such as price, stock, cost, availability, credit, and substitute products must come from MCP/SML tools, not Brain memory.
- ใช้ `OPENCLAW_BIN=/root/openclaw-runtime-2026.6.11-erp/dist/index.js` เพื่อให้ model/image tests เรียก runtime ตัวเดียวกับ gateway จริง

## ทำหน้าที่อะไร

```text
Browser (openclaw-admin UI)
    │ HTTP REST — Bearer token
    ▼
openclaw-api (port 4000)
    │
    ├── อ่าน/เขียน ~/.openclaw/openclaw.json     ← config หลัก
    ├── อ่าน/เขียน ~/.openclaw/workspace-*/
    │   └── SOUL.md                               ← system prompt ของแต่ละ agent
    ├── อ่าน/เขียน openclaw.json mcp.servers      ← MCP server URL + access mode
    ├── รัน openclaw CLI                           ← gateway restart, doctor
    └── test MCP access ผ่าน native HTTP tools endpoint

openclaw-gateway (agent runtime)
    │ Native MCP tools from openclaw.json mcp.servers
    ▼
SML MCP Connect (SSE/tools endpoint)
    │
    └── PostgreSQL ERP Database
```

> **Native MCP Integration**: Agent เรียก MCP tools ผ่าน OpenClaw native MCP registry (`openclaw.json` → `mcp.servers`) และส่งสิทธิ์ด้วย header `mcp-access-mode`

## Requirements

- Node.js 22+
- openclaw CLI (`npm install -g openclaw`) สำหรับ config helper
- openclaw-gateway รันผ่าน PM2 หรือ systemd โดยชี้ไปที่ ERP runtime overlay
- PostgreSQL 16+ (สำหรับ /api/members และ /api/webchat/* endpoints)

## ติดตั้ง

```bash
git clone https://github.com/bosocmputer/openclaw-api.git ~/openclaw-api
cd ~/openclaw-api
npm install
```

สร้าง `.env`:

```bash
cp .env.example .env
nano .env
```

ค่าใน `.env`:

```env
API_TOKEN=<random-hex>                                                   # generate ด้วย: node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
PORT=4000                                                                # port (optional, default 4000)
DATABASE_URL=postgresql://openclaw:PASSWORD@localhost:5432/openclaw_admin  # PostgreSQL (สำหรับ members + webchat)
HOOKS_TOKEN=<random-hex>                                                 # ต้องตรงกับ hooks.token ใน openclaw.json
ALLOWED_ORIGIN=http://<SERVER_IP>:3000                                   # จำกัด CORS เฉพาะ origin ของ openclaw-admin
OPENCLAW_BIN=/root/openclaw-runtime-2026.6.11-erp/dist/index.js            # runtime overlay binary สำหรับ model/image test
CONVERSATION_ANALYSIS_ENABLED=1
MEMORY_LEARNING_REVIEW_ENABLED=1
MONITOR_MEDIA_PREVIEW_ENABLED=1
OLLAMA_API_KEY=...                                                         # optional: Ollama Cloud provider
```

> `HOOKS_TOKEN` ต้องตรงกับ `hooks.token` ใน `~/.openclaw/openclaw.json` เสมอ — ใช้สำหรับ Webchat ส่งข้อความผ่าน openclaw Hooks API

## รัน

### ด้วย pm2 (แนะนำ — auto-restart เมื่อ crash หรือ reboot)

```bash
pm2 start index.js --name openclaw-api
pm2 save
pm2 startup
# copy คำสั่ง sudo ที่แสดงขึ้นมาแล้วรันทันที
```

### ด้วย node โดยตรง (dev)

```bash
node index.js
```

## อัปเดต

แนะนำให้เปิด Admin `/system` แล้วใช้ **Production Readiness → Copy Customer Update Command** เป็น source of truth สำหรับคำสั่งลูกค้า เพราะ command นี้จะ update API/Admin, install หรือ refresh runtime `2026.6.11` เมื่อยังไม่มี, ตั้ง `OPENCLAW_BIN`, recreate gateway PM2 script, restart service และ run release gate ให้ท้ายคำสั่ง

Current customer flow:

```bash
cd /root/openclaw-api
git pull --ff-only origin main
npm install
pm2 restart openclaw-api --update-env

cd /root/openclaw-admin
git pull --ff-only origin main
docker compose up -d --build openclaw-admin
```

Runtime is updated separately from API/Admin. Preferred customer flow is a full 2026.6.11 runtime build from `bosocmputer/openclaw` branch `codex/openclaw-2026.6.11-erp-line-burst`; the small overlay tarball is only for an already-correct 2026.6.11 runtime. See [`CUSTOMER_UPDATE_GUIDE.md`](./CUSTOMER_UPDATE_GUIDE.md).

Legacy updater flow:

```bash
cd ~/openclaw-api
bash scripts/update-server.sh --dry-run
bash scripts/update-server.sh --apply --mcp-url http://192.168.2.248:3515/sse --openrouter-key "$OPENROUTER_KEY"
```

Production artifact flow:

```bash
cd /Users/nontawatwongnuk/dev/openclaw-api
bash scripts/package-release-artifact.sh --runtime-dist-dir /path/to/openclaw/dist --output /tmp/openclaw-release.tgz
scp /tmp/openclaw-release.tgz bosscatdog@192.168.2.109:/tmp/
ssh bosscatdog@192.168.2.109 'cd ~/openclaw-api && bash scripts/update-server.sh --dry-run --artifact /tmp/openclaw-release.tgz'
ssh bosscatdog@192.168.2.109 'cd ~/openclaw-api && bash scripts/update-server.sh --apply --artifact /tmp/openclaw-release.tgz'
```

รายละเอียด rollback, support bundle, Telegram latency watch, และ kill switches อยู่ใน [`RUNBOOK.md`](./RUNBOOK.md)

---

## Project Structure

```text
openclaw-api/
├── index.js              ← entry point: middleware, route mounting, listen, shutdown (75 บรรทัด)
├── lib/
│   ├── config.js         ← shared constants: HOME, CONFIG_PATH, USERNAMES_PATH, execOpts
│   ├── files.js          ← readConfig, writeConfig, readUserNames, writeUserNames
│   ├── openclaw-config.js ← atomic openclaw.json reads/writes + lock + backup
│   ├── pg.js             ← pgPool init + requirePg middleware
│   └── soul-template.js  ← generateSoulTemplate (SOUL.md template per access mode/persona)
└── routes/
    ├── status.js         ← GET /api/status
    ├── system.js         ← GET /api/system/health, /api/system/support-bundle
    ├── config.js         ← GET /api/config, PUT /api/config
    ├── agents.js         ← /api/agents/* (CRUD + soul + mcp + users)
    ├── telegram.js       ← /api/telegram/* (accounts, bindings, botinfo, pairing)
    ├── line.js           ← /api/line/* (accounts, bindings, botinfo, pairing)
    ├── model.js          ← GET/PUT /api/model, GET /api/models/catalog, GET /api/models, POST /api/models/test
    ├── gateway.js        ← /api/gateway/*, /api/doctor/*, /api/usernames
    ├── members.js        ← /api/members/* (admin user CRUD, bcrypt, PostgreSQL)
    ├── webchat.js        ← /api/webchat/* (rooms, history, send+poll, PostgreSQL)
    ├── monitor.js        ← /api/monitor/events, /api/monitor/latency, /api/monitor/cost, /api/agents/:id/sessions/*
    ├── alerting.js       ← GET/PUT /api/alerting + runAlertCheck interval (60s)
    ├── webhooks.js       ← CRUD /api/webhooks (plugins.entries.webhooks.config.routes)
    ├── compaction.js     ← /api/compaction/checkpoints/:agentId, /api/compaction/restore
    └── memory.js         ← /api/memory/status, /api/memory/:agentId/memory|dreams|daily/:filename
```

---

## API Endpoints

### Core

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET | `/api/status` | gateway online/offline |
| GET | `/api/system/health?refresh=false` | bounded cached system health |
| GET | `/api/system/observability?refresh=false` | read-only release/runtime/process/memory snapshot |
| POST | `/api/system/release-gate/run` | release gate: runtime version, OPENCLAW_BIN, gateway process path, PostgreSQL, legacy memory |
| GET | `/api/system/update-command` | redacted customer update command for current target runtime |
| GET | `/api/system/support-bundle` | redacted support bundle |
| GET | `/api/monitor/latency?minutes=60&channel=telegram` | bounded Telegram latency timeline |
| GET | `/api/config` | อ่าน openclaw.json |
| PUT | `/api/config` | เขียน openclaw.json (atomic write) |

### Agents

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET | `/api/agents` | รายการ agents + soul + mcp + users |
| POST | `/api/agents` | เพิ่ม agent ใหม่ + auto-generate SOUL.md |
| DELETE | `/api/agents/:id` | ลบ agent |
| GET | `/api/agents/:id/soul` | อ่าน SOUL.md |
| PUT | `/api/agents/:id/soul` | เขียน SOUL.md |
| GET | `/api/agents/:id/soul/template` | ดึง SOUL template ตาม access mode + persona + live MCP capability contract |
| GET | `/api/agents/:id/mcp` | อ่าน openclaw.json `mcp.servers` |
| PUT | `/api/agents/:id/mcp` | เขียน openclaw.json `mcp.servers` |
| POST | `/api/agents/:id/mcp/test` | test MCP access (cached tool list, header `mcp-access-mode`) |
| GET | `/api/agents/:id/users` | รายการ users ของ agent |
| POST | `/api/agents/:id/users` | เพิ่ม user (peer binding + allowFrom อัตโนมัติ) |
| DELETE | `/api/agents/:id/users/:userId` | ลบ user |

### Telegram

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET | `/api/telegram` | อ่าน telegram config |
| PUT | `/api/telegram` | อัปเดต telegram config |
| GET | `/api/telegram/botinfo` | ชื่อ bot จาก Telegram API |
| GET | `/api/telegram/bindings` | route bindings (bot → agent) |
| PUT | `/api/telegram/bindings` | set route binding |
| POST | `/api/telegram/accounts` | เพิ่ม bot account |
| POST | `/api/telegram/set-default` | สลับ bot เป็น default |
| DELETE | `/api/telegram/accounts/:id` | ลบ bot account |
| POST | `/api/telegram/approve` | approve pairing code |

### LINE

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET | `/api/line` | อ่าน LINE config |
| GET | `/api/line/botinfo` | ชื่อ bot จาก LINE API (ทุก account) |
| GET | `/api/line/bindings` | route bindings (OA → agent) |
| PUT | `/api/line/bindings` | set route binding |
| POST | `/api/line/accounts` | เพิ่ม LINE OA |
| PATCH | `/api/line/accounts/:id` | แก้ token/secret/webhookPath |
| DELETE | `/api/line/accounts/:id` | ลบ LINE OA |
| GET | `/api/line/pending` | รายการรอ pairing (legacy) |
| POST | `/api/line/approve` | approve pairing code (legacy) |

### Model

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET | `/api/model` | get primary model |
| PUT | `/api/model` | set primary model |
| GET | `/api/models/catalog?provider=X&refresh=false` | rich live model catalog with status/cache/warnings |
| GET | `/api/models?provider=X` | legacy model array response powered by catalog |
| POST | `/api/models/test` | test API key validity |

### Gateway & Maintenance

| Method | Path | Description |
| ------ | ---- | ----------- |
| POST | `/api/gateway/restart` | restart gateway (clean stale sessions ก่อน) |
| GET | `/api/gateway/logs` | อ่าน JSONL log จาก `/tmp/openclaw/` |
| GET | `/api/doctor/status` | เช็ค config valid/invalid |
| POST | `/api/doctor/fix` | รัน `openclaw doctor --fix` |
| GET | `/api/usernames` | อ่าน usernames.json |

### Members (ต้องการ DATABASE_URL)

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET | `/api/members` | รายการ admin_users |
| POST | `/api/members` | เพิ่ม admin user (bcrypt password) |
| PATCH | `/api/members/:id` | แก้ role / display_name / is_active / password |
| DELETE | `/api/members/:id` | ลบ user (ห้ามลบ superadmin คนสุดท้าย) |

### Webchat (ต้องการ DATABASE_URL)

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET | `/api/webchat/rooms` | list rooms (กรอง policy ตาม ?username=) |
| POST | `/api/webchat/rooms` | สร้าง room |
| PUT | `/api/webchat/rooms/:id` | แก้ display_name / policy |
| DELETE | `/api/webchat/rooms/:id` | ลบ room + messages |
| POST | `/api/webchat/rooms/:id/users` | เพิ่ม user ใน allowlist |
| DELETE | `/api/webchat/rooms/:id/users/:username` | ลบ user จาก allowlist |
| GET | `/api/webchat/history/:roomId` | ดึง messages ของ user ใน room |
| POST | `/api/webchat/send` | ส่งข้อความ → hooks → poll response → บันทึก DB |
| GET | `/api/webchat/chat-users` | list users ที่มี role=chat |

### Monitor

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET | `/api/monitor/events` | real-time session state ทุก agent/channel |
| GET | `/api/monitor/cost?days=30` | daily cost aggregation แยก agent |
| GET | `/api/agents/:id/sessions` | list sessions + token metadata |
| GET | `/api/agents/:id/sessions/:sessionKey` | full conversation replay |

### Alerting

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET | `/api/alerting` | อ่าน alerting config |
| PUT | `/api/alerting` | บันทึก alerting config |

### Webhooks (ต้องการ OpenClaw v2026.4.x + webhooks plugin enabled)

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET | `/api/webhooks` | รายการ webhook routes (mask secret) |
| POST | `/api/webhooks` | เพิ่ม/อัปเดต route `{ name, path, sessionKey, secret, description? }` |
| DELETE | `/api/webhooks/:name` | ลบ route |
| PATCH | `/api/webhooks/:name` | toggle enabled / แก้ description |

> `name` ต้องเป็น lowercase `a-z0-9_-` เท่านั้น
> แก้ไขแล้วต้อง restart gateway เพื่อ reload config

### Session Checkpoints (ต้องการ OpenClaw v2026.4.5+)

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET | `/api/compaction/checkpoints/:agentId` | scan `*.jsonl.reset.*` files สำหรับ agent นั้น |
| POST | `/api/compaction/restore` | restore checkpoint `{ agentId, filename }` — backup session ปัจจุบันก่อน |

> checkpoint files อยู่ที่ `~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl.reset.<ts>`
> สร้างอัตโนมัติเมื่อ gateway ทำ compaction

### Agent Knowledge Brain / Memory & Dreams (ต้องการ OpenClaw v2026.4.5+)

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET | `/api/memory/status` | status ทุก agent: dailyMemory (fileCount, totalChars, latestDate, files[]) + MEMORY.md + dreams.md + dreaming config |
| GET | `/api/memory/:agentId/memory` | เนื้อหา MEMORY.md เต็มของ agent |
| GET | `/api/memory/:agentId/dreams` | เนื้อหา dreams.md เต็มของ agent |
| GET | `/api/memory/:agentId/daily/:filename` | เนื้อหา daily memory file เช่น `2026-04-07-session.md` |
| POST | `/api/agent-brain/evaluate-turn` | ประเมิน turn แบบ fail-open: คืน memory context ที่ relevant, search hints, description suggestions และ decision evidence |
| GET | `/api/agent-brain/items` | รายการ Agent Brain items typed เช่น `terminology`, `search_hint`, `description_suggestion`, `blocked_fact` |
| PATCH | `/api/agent-brain/items/:id` | แก้ไข status/type/content ของ Agent Brain item |
| DELETE | `/api/agent-brain/items/:id` | ลบ item และสร้าง tombstone กัน relearn ซ้ำ |
| POST | `/api/agent-brain/items/:id/block-relearn` | block item และกัน relearn ซ้ำ |
| GET/PUT | `/api/agent-brain/policies/:agentId` | policy ต่อ agent: off/observe_only/safe_auto/manual_review, context budget, chat teaching |
| GET/PUT | `/api/agent-brain/channel-policies/:channel/:accountId` | policy ต่อ LINE/Telegram/Webchat account: audience customer/staff/internal และ SML description suggestion visibility |

> `memory/*.md` อยู่ที่ `~/.openclaw/workspace-<agentId>/memory/` — เป็นสถานะ memory เดิม/เสริม ไม่ใช่สิทธิ์ tool หรือ source of truth ของ SOUL template
>
> `MEMORY.md` อยู่ที่ `~/.openclaw/workspace-<agentId>/MEMORY.md` — main session เท่านั้น. API จะ sync เฉพาะ Agent Brain active memory ที่ปลอดภัยและไม่เกิน budget เข้า managed block เพื่อให้ OpenClaw runtime ใช้ผ่าน memory-core เดิม. Runtime รุ่นที่มี Agent Brain hook สามารถเรียก `/api/agent-brain/evaluate-turn` แบบ fail-open ก่อนตอบได้เมื่อเปิด `AGENT_BRAIN_ENABLED=1`.
>
> `search_hint` ช่วยตั้งคำค้นแต่ต้อง verify ด้วย MCP/Search ทุกครั้ง. `description_suggestion` เป็นคำแนะนำให้ staff เติมช่อง `description` ใน SML ERP และไม่ถูก inject เป็น runtime truth.
>
> `dreams.md` อยู่ที่ `~/.openclaw/workspace-<agentId>/dreams.md`
>
> dreaming toggle ผ่าน `memory.dreaming.enabled` ใน `openclaw.json`

### Gateway & Maintenance (เพิ่มเติม)

| Method | Path | Description |
| ------ | ---- | ----------- |
| POST | `/api/gateway/clean-sessions` | ลบ `agent:*:main` sessions ที่มี `lastChannel=line` ค้างอยู่ |

> clean-sessions รันอัตโนมัติทุกวัน 3:00 AM ด้วย

---

## Authentication

ทุก request ต้องส่ง header:

```text
Authorization: Bearer <API_TOKEN>
```

---

## หมายเหตุสำคัญ

- **peer binding ต้องมี `accountId`** — ถ้าไม่มีจะ match ทุก bot ทำให้ user ข้าม bot ได้
- **POST /api/agents/:id/users** สร้าง peer binding พร้อม `accountId` อัตโนมัติจาก route binding
- **openclaw.json schema strict** — ไม่รองรับ unknown keys, เก็บชื่อ user แยกใน `usernames.json`
- **Config format v2026.3.13** — botToken อยู่ใน `channels.telegram.accounts.*` เสมอ
- **ไม่ใช้ Docker** — ต้องการ systemd สำหรับ `openclaw gateway restart`
- **DATABASE_URL** — ต้องตั้งใน `.env` เพื่อให้ `/api/members` และ `/api/webchat/*` ทำงาน — ถ้าไม่ set จะ return 503
- **HOOKS_TOKEN** — ต้องตรงกับ `hooks.token` ใน `~/.openclaw/openclaw.json` — ต้องเปิด `hooks.enabled=true` + `hooks.allowRequestSessionKey=true` ด้วย
- **Webchat session key format** — `agent:{agentId}:hook:webchat:uid:{username}` — prefix `uid:` ป้องกัน conflict กับ LINE accountId
- **Webchat → LINE bug** — ถ้า `agent:<id>:main` session มี `lastChannel=line` ค้างอยู่ gateway จะ reply ออก LINE แทน webchat — ดูวิธีแก้ใน INSTALL.md
- **PostgreSQL constraint** — `admin_users_role_check` รองรับ role: `superadmin`, `admin`, `chat`
- **SOUL.md template** — AI ใช้ native MCP tools ที่ register ใน `openclaw.json mcp.servers`; template สร้างจาก live MCP `/tools` ตาม `mcp-access-mode` พร้อม `OPENCLAW_SOUL_CONTRACT`; template ไม่สั่ง `curl`, `/call`, `exec tool`, `mcporter`, หรือ memory/write-tool block
- **Agent Brain** — เป็น helper/context ไม่ใช่ source of truth. ราคา สต็อก ต้นทุน availability เครดิต ราคาพิเศษ และสินค้าทดแทนต้องมาจาก MCP/SML เสมอ. Channel audience default เป็น `customer` และปิด SML description suggestions.
- **`/api/memory/status`** — คืน `dailyMemory` field พร้อม `fileCount`, `totalChars`, `latestDate`, `files[]` — ใช้ดูไฟล์ memory เดิม/เสริม ไม่ใช่ contract สิทธิ์ MCP
- **`/api/monitor/events`** — อ่าน `.jsonl` files last 50 lines ต่อ session, `ts` field = UTC (ต้อง +7h บน client เพื่อแสดงเวลาไทย)
- **LINE webhookPath ต้องไม่ซ้ำกัน** — ถ้า 2 OA ใช้ path เดียวกัน OA แรกได้ 401
- **LINE dmPolicy** — ใช้ `"open"` เสมอ — pairing ถูกลบออกแล้ว
- **cloudflared** — LINE webhook ต้องการ HTTPS — expose port 18789 ด้วย `cloudflared tunnel --url http://localhost:18789`
- **ALLOWED_ORIGIN** — ตั้งใน `.env` เพื่อจำกัด CORS — ถ้าไม่ตั้งจะเปิดทุก origin (ใช้ได้เฉพาะ LAN ที่ไม่มี public IP)
