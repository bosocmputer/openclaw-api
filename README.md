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
    │   └── config/mcporter.json                  ← MCP config
    ├── รัน openclaw CLI                           ← gateway restart, doctor
    └── รัน mcporter CLI                          ← test MCP access
```

## Requirements

- Node.js 22+
- openclaw CLI (`npm install -g openclaw`)
- mcporter CLI (`npm install -g mcporter`)
- openclaw-gateway รันเป็น systemd service อยู่แล้ว

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
API_TOKEN=sml-openclaw-2026    # token สำหรับ authenticate (ต้องตรงกับ openclaw-admin)
PORT=4000                      # port (optional, default 4000)
```

## รัน

### ด้วย pm2 (แนะนำ — auto-restart เมื่อ crash หรือ reboot)

```bash
# ติดตั้ง pm2 ถ้ายังไม่มี
npm install -g pm2

# รัน
pm2 start index.js --name openclaw-api

# ให้ start อัตโนมัติเมื่อ reboot
pm2 save
pm2 startup
```

### ด้วย node โดยตรง (dev)

```bash
node index.js
```

## อัปเดต

```bash
cd ~/openclaw-api
git pull
npm install
pm2 restart openclaw-api
```

---

## API Endpoints

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET | `/api/status` | gateway online/offline |
| GET | `/api/config` | อ่าน openclaw.json |
| PUT | `/api/config` | เขียน openclaw.json |
| GET | `/api/agents` | รายการ agents + soul + mcp + users |
| POST | `/api/agents` | เพิ่ม agent ใหม่ + auto-generate SOUL.md |
| DELETE | `/api/agents/:id` | ลบ agent |
| GET | `/api/agents/:id/soul` | อ่าน SOUL.md |
| PUT | `/api/agents/:id/soul` | เขียน SOUL.md |
| GET | `/api/agents/:id/soul/template` | ดึง SOUL template ตาม Access Mode |
| GET | `/api/agents/:id/mcp` | อ่าน mcporter.json |
| PUT | `/api/agents/:id/mcp` | เขียน mcporter.json |
| POST | `/api/agents/:id/mcp/test` | test MCP access (รัน mcporter list) |
| GET | `/api/agents/:id/users` | รายการ users ของ agent |
| POST | `/api/agents/:id/users` | เพิ่ม user (peer binding + allowFrom อัตโนมัติ) |
| DELETE | `/api/agents/:id/users/:userId` | ลบ user |
| GET | `/api/agents/:id/sessions` | รายการ chat sessions |
| GET | `/api/agents/:id/sessions/:sessionId` | messages ใน session |
| GET | `/api/usernames` | อ่าน usernames.json |
| GET | `/api/models` | ดึง model list จาก OpenRouter |
| POST | `/api/gateway/restart` | รัน `openclaw gateway restart` |
| GET | `/api/gateway/logs` | อ่าน JSONL log จาก `/tmp/openclaw/` |
| GET | `/api/telegram/botinfo` | ชื่อ bot จาก Telegram API |
| GET | `/api/telegram/bindings` | route bindings (bot → agent) |
| PUT | `/api/telegram/bindings` | set route binding |
| POST | `/api/telegram/accounts` | เพิ่ม bot account |
| DELETE | `/api/telegram/accounts/:id` | ลบ bot account |
| POST | `/api/telegram/set-default` | สลับ bot เป็น default |
| GET | `/api/doctor/status` | เช็ค config valid/invalid |
| POST | `/api/doctor/fix` | รัน `openclaw doctor --fix` |

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
