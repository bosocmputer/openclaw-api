# OpenClaw API

Express.js REST API server สำหรับ OpenClaw Admin — เป็น bridge ระหว่าง Web UI และ OpenClaw config/CLI บน server

> **หมายเหตุ**: รันบน host โดยตรง (ไม่ใช่ Docker) เพราะต้องการ systemd และ openclaw CLI

## ทำหน้าที่อะไร

```text
Browser (openclaw-admin UI)
    │ HTTP REST — Bearer token
    ▼
openclaw-api (port 4000)
    │
    ├── อ่าน/เขียน ~/.openclaw/openclaw.json     ← config หลัก
    ├── อ่าน/เขียน ~/.openclaw/workspace-*/
    │   ├── SOUL.md                               ← system prompt ของแต่ละ agent
    │   └── config/mcporter.json                  ← MCP server URL + access mode
    ├── รัน openclaw CLI                           ← gateway restart, doctor
    └── รัน mcporter CLI                          ← test MCP access (list tools เท่านั้น)

openclaw-gateway (agent runtime)
    │ HTTP POST /call — direct (ไม่ผ่าน mcporter exec)
    ▼
SML MCP Connect (port 3002 by default)
    │
    └── PostgreSQL ERP Database
```

> **v2 Integration**: Agent เรียก MCP tools ผ่าน `curl POST /call` โดยตรง แทน mcporter exec
> ทำให้ response time ลดจาก ~48 วินาที เหลือ ~1-3 วินาที

## Requirements

- Node.js 22+
- openclaw CLI (`npm install -g openclaw`)
- mcporter CLI (`npm install -g mcporter`)
- openclaw-gateway รันเป็น systemd service อยู่แล้ว
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

```bash
cd ~/openclaw-api
git fetch origin && git reset --hard origin/main
npm install
pm2 restart openclaw-api --update-env
```

---

## Project Structure

```text
openclaw-api/
├── index.js              ← entry point: middleware, route mounting, listen, shutdown (75 บรรทัด)
├── lib/
│   ├── config.js         ← shared constants: HOME, CONFIG_PATH, USERNAMES_PATH, execOpts
│   ├── files.js          ← readConfig, writeConfig, readUserNames, writeUserNames
│   ├── pg.js             ← pgPool init + requirePg middleware
│   └── soul-template.js  ← generateSoulTemplate (SOUL.md template per access mode/persona)
└── routes/
    ├── status.js         ← GET /api/status
    ├── config.js         ← GET /api/config, PUT /api/config
    ├── agents.js         ← /api/agents/* (CRUD + soul + mcp + users)
    ├── telegram.js       ← /api/telegram/* (accounts, bindings, botinfo, pairing)
    ├── line.js           ← /api/line/* (accounts, bindings, botinfo, pairing)
    ├── model.js          ← GET/PUT /api/model, GET /api/models, POST /api/models/test
    ├── gateway.js        ← /api/gateway/*, /api/doctor/*, /api/usernames
    ├── members.js        ← /api/members/* (admin user CRUD, bcrypt, PostgreSQL)
    ├── webchat.js        ← /api/webchat/* (rooms, history, send+poll, PostgreSQL)
    ├── monitor.js        ← /api/monitor/events, /api/monitor/cost, /api/agents/:id/sessions/*
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
| GET | `/api/agents/:id/soul/template` | ดึง SOUL template ตาม access mode + persona |
| GET | `/api/agents/:id/mcp` | อ่าน mcporter.json |
| PUT | `/api/agents/:id/mcp` | เขียน mcporter.json |
| POST | `/api/agents/:id/mcp/test` | test MCP access (list tools) |
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
| GET | `/api/models?provider=X` | list models (openrouter/anthropic/google/openai/mistral/groq/kilocode) |
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

### Memory & Dreams (ต้องการ OpenClaw v2026.4.5+)

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET | `/api/memory/status` | status ทุก agent: dailyMemory (fileCount, totalChars, latestDate, files[]) + MEMORY.md + dreams.md + dreaming config |
| GET | `/api/memory/:agentId/memory` | เนื้อหา MEMORY.md เต็มของ agent |
| GET | `/api/memory/:agentId/dreams` | เนื้อหา dreams.md เต็มของ agent |
| GET | `/api/memory/:agentId/daily/:filename` | เนื้อหา daily memory file เช่น `2026-04-07-session.md` |

> `memory/*.md` อยู่ที่ `~/.openclaw/workspace-<agentId>/memory/` — ระบบหลักที่ AI ใช้งานจริง
>
> `MEMORY.md` อยู่ที่ `~/.openclaw/workspace-<agentId>/MEMORY.md` — main session เท่านั้น
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
- **SOUL.md template (v2)** — AI เรียก MCP ผ่าน `curl POST /call` โดยตรง ไม่ใช้ mcporter exec — URL derive จาก mcporter.json อัตโนมัติ (แทนที่ `/sse` ด้วย `/call`) — ทุก template มี `## ความจำระหว่าง Session` ให้ AI บันทึกชื่อ user ลง `memory/YYYY-MM-DD.md` ทันที
- **`/api/memory/status`** — คืน `dailyMemory` field พร้อม `fileCount`, `totalChars`, `latestDate`, `files[]` — สะท้อน `memory/*.md` จริงที่ AI สร้างขึ้น
- **`/api/monitor/events`** — อ่าน `.jsonl` files last 50 lines ต่อ session, `ts` field = UTC (ต้อง +7h บน client เพื่อแสดงเวลาไทย)
- **LINE webhookPath ต้องไม่ซ้ำกัน** — ถ้า 2 OA ใช้ path เดียวกัน OA แรกได้ 401
- **LINE dmPolicy** — ใช้ `"open"` เสมอ — pairing ถูกลบออกแล้ว
- **cloudflared** — LINE webhook ต้องการ HTTPS — expose port 18789 ด้วย `cloudflared tunnel --url http://localhost:18789`
- **ALLOWED_ORIGIN** — ตั้งใน `.env` เพื่อจำกัด CORS — ถ้าไม่ตั้งจะเปิดทุก origin (ใช้ได้เฉพาะ LAN ที่ไม่มี public IP)
