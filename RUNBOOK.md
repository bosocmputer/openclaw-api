# OpenClaw Production Runbook

## Health Check

```bash
cd ~/openclaw-api
bash scripts/update-server.sh --health-only
```

`GET /api/system/health?refresh=true` ต้องไม่คืน secret และต้องแยก `critical`, `warn`, `info` ให้ operator อ่านได้ทันที

## Update

```bash
cd ~/openclaw-api
bash scripts/update-server.sh --dry-run
bash scripts/update-server.sh --apply \
  --mcp-url http://192.168.2.248:3515/sse \
  --openrouter-key "$OPENROUTER_KEY"
```

สิ่งที่ script ทำ:

- preflight path, git, docker, pm2, API token, JSON config, MCP reachability
- backup `openclaw.json`, `SOUL.md`, `auth-profiles.json`, และ git head ด้วย backup id เดียวกัน
- update `openclaw-api` และ `openclaw-admin`
- migrate MCP ไปที่ `openclaw.json mcp.servers` และลบ legacy `sml-*` หลังสร้าง entry ใหม่แล้ว
- rotate OpenRouter key ทุก agent โดยไม่ print key
- ตั้ง `/etc/hosts` สำหรับ `api.telegram.org` ถ้ามี sudo non-interactive
- restart เฉพาะเมื่อ code/state เปลี่ยน
- post-check health และพิมพ์ rollback command ถ้ามี critical fail

## Rollback

ใช้ backup id จาก output ของ update:

```bash
cd ~/openclaw-api
bash scripts/update-server.sh --rollback <backup-id>
```

Rollback จะกู้ `openclaw.json`, `SOUL.md`, `auth-profiles.json`, และ restore repo files ของ `openclaw-api`/`openclaw-admin` ไป git head ที่ backup ไว้

## Rotate OpenRouter Key

```bash
export OPENROUTER_KEY='sk-or-...'
cd ~/openclaw-api
bash scripts/update-server.sh --apply \
  --mcp-url http://192.168.2.248:3515/sse \
  --openrouter-key "$OPENROUTER_KEY"
unset OPENROUTER_KEY
```

ตรวจหลังทำ:

```bash
bash scripts/update-server.sh --health-only
```

## Re-register MCP

Default customer MCP:

```bash
MCP_URL=http://192.168.2.248:3515/sse
cd ~/openclaw-api
bash scripts/update-server.sh --apply --mcp-url "$MCP_URL"
```

Admin UI ต้องแสดง MCP URL เดียวกัน และ access mode ต้องส่งเป็น header:

```text
mcp-access-mode: stock
```

## Telegram Hosts Fix

ถ้า Telegram timeout 60+ วินาที ให้ pin IP ที่เคยทำงานได้:

```bash
sudo sed -i '/api\.telegram\.org/d' /etc/hosts
sudo sed -i '/api4\.telegram\.org/d' /etc/hosts
echo '149.154.166.110 api.telegram.org api4.telegram.org' | sudo tee -a /etc/hosts
```

ตรวจ:

```bash
getent hosts api.telegram.org
bash scripts/update-server.sh --health-only
```

## SOUL Hygiene

SOUL production template ต้องไม่มี:

- `curl`
- `/call`
- `exec tool`
- `mcporter`

ใช้หน้า Admin `/agents/<id>` กด `Load Template`; UI จะแสดง confirm/diff ก่อนทับ textarea และ API จะ backup `SOUL.md` เดิมตอน Save ถ้า content เปลี่ยน
