# คู่มือ Update Customer Server: MCP + OpenClaw

คู่มือนี้ใช้สำหรับเคสที่ลูกค้ามี 2 ส่วนแยกกัน:

- MCP server เช่น `/data/mcp-connect` ใช้ Docker image `ghcr.io/smlsoft/smlmcpconnect:latest`
- OpenClaw server เช่น `/root/openclaw-api` + `/root/openclaw-admin`
  - API รันด้วย PM2 process `openclaw-api`
  - Gateway รันด้วย PM2 process `openclaw-gateway`
  - Admin รันด้วย Docker Compose แบบ `build: context: .`

> ก่อนลบหรือ migrate ระบบเก่า ให้ยืนยัน path/process ให้ชัดเสมอ เพราะบางเครื่องมี stack เก่า เช่น `/data/openclaw-ai-chatbot` ที่ไม่ใช่ OpenClaw รุ่นล่าสุด

## 1. ตรวจว่าอยู่ server ถูกตัว

```bash
hostname -I

echo "== root openclaw =="
ls -la /root/openclaw-api /root/openclaw-admin 2>/dev/null || true

echo "== mcp =="
ls -la /data/mcp-connect 2>/dev/null || true

echo "== processes =="
pm2 list || true
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}' || true
```

ต้องเห็นอย่างน้อย:

- `openclaw-api` ใน PM2
- `openclaw-gateway` ใน PM2 หรือ systemd user service
- `openclaw-admin-*` container port `3000`
- `smlmcpconnect` container port `3515`

## 2. Backup ก่อน update

รันด้วย user ที่ติดตั้ง OpenClaw จริง เช่น `root`:

```bash
BACKUP_ID=$(date +%Y%m%d%H%M%S)
mkdir -p /root/openclaw-backups

tar --exclude=node_modules --exclude=.next -czf /root/openclaw-backups/openclaw-before-update-$BACKUP_ID.tgz \
  /root/openclaw-api \
  /root/openclaw-admin \
  /root/.openclaw

echo "BACKUP_ID=$BACKUP_ID"
```

## 3. Update MCP

ใช้ได้เมื่อ compose เป็น image แบบนี้:

```yaml
image: ghcr.io/smlsoft/smlmcpconnect:latest
```

คำสั่ง:

```bash
cd /data/mcp-connect

BACKUP_ID=$(date +%Y%m%d%H%M%S)
sudo cp docker-compose.yml docker-compose.yml.bak-$BACKUP_ID
sudo docker inspect -f '{{.Image}}' smlmcpconnect | sudo tee rollback-image-$BACKUP_ID.txt

sudo docker compose pull smlmcpconnect
sudo docker compose up -d smlmcpconnect

sudo docker compose ps
sleep 10
curl -fsS http://127.0.0.1:3515/health && echo
sudo docker compose logs --tail=120 smlmcpconnect
```

เช็ค Smart Search v2:

```bash
curl -sS http://127.0.0.1:3515/tools | grep -A20 search_product
```

ต้องเห็น description ประมาณ:

```text
ค้นหาสินค้าแบบ Smart Search จาก ic_inventory ด้วย keyword, รหัสสินค้า
```

ทดสอบ tool:

```bash
curl -sS -X POST http://127.0.0.1:3515/call \
  -H 'Content-Type: application/json' \
  -H 'mcp-access-mode: stock' \
  -d '{"tool":"search_product","input":{"keyword":"ปูน","intent":"stock","limit":5,"page":1}}'
```

## 4. Update OpenClaw API

ใช้กรณีไม่สามารถ copy artifact จาก Mac ได้ ให้ update ผ่าน git:

```bash
cd /root/openclaw-api

git fetch origin main
git pull --ff-only origin main
git log -1 --oneline

npm ci --omit=dev

node --check index.js
find routes lib -maxdepth 2 -type f -name '*.js' -print0 | xargs -0 -r -n1 node --check

pm2 restart openclaw-api
```

commit ล่าสุดที่ควรมี feature monitor usage:

```text
e7d8068 Restore monitor usage accounting
```

## 5. Update OpenClaw Admin

ตรวจ compose ก่อน:

```bash
sed -n '1,220p' /root/openclaw-admin/docker-compose.yml
```

ถ้าเป็น `build: context: .` ให้ใช้:

```bash
cd /root/openclaw-admin

git fetch origin main
git pull --ff-only origin main
git log -1 --oneline

docker compose up -d --build
```

commit ล่าสุดที่ควรมี UI monitor model call cost:

```text
4b37372 Clarify monitor model call costs
```

## 6. Migrate config: MCP + OpenRouter auth profiles

ขั้นนี้สำคัญมากหลัง update code เพราะจะเขียน `~/.openclaw/openclaw.json` ให้ agent ใช้ MCP native และสร้าง `auth-profiles.json` ทุก agent

```bash
cd /root/openclaw-api

KEY=$(python3 - <<'PY'
import json
try:
    d=json.load(open('/root/.openclaw/openclaw.json'))
    print((d.get('env') or {}).get('OPENROUTER_API_KEY',''))
except Exception:
    print('')
PY
)

if [ -n "$KEY" ]; then
  bash scripts/update-server.sh --apply --mcp-url http://127.0.0.1:3515/sse --openrouter-key "$KEY"
else
  echo "OPENROUTER key not found in openclaw.json"
  echo "Run manually: bash scripts/update-server.sh --apply --mcp-url http://127.0.0.1:3515/sse --openrouter-key '<KEY>'"
fi
```

ผลที่ต้องเห็น:

- `MCP config updated without legacy sml-* entries`
- `updated auth profiles: <จำนวน agent>`
- health ไม่มี critical fail

## 7. Apply SOUL template ใหม่ทุก agent

ทำหลัง MCP/auth profile พร้อมแล้ว เพื่อลบ legacy instructions เช่น `curl`, `/call`, `exec tool`

```bash
cd /root/openclaw-api
TOKEN=$(grep -E '^API_TOKEN=' /root/openclaw-api/.env | cut -d= -f2-)

TOKEN="$TOKEN" node <<'NODE'
const token = process.env.TOKEN
const base = 'http://127.0.0.1:4000'
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

async function api(path, options = {}) {
  const res = await fetch(`${base}${path}`, { headers, ...options })
  const text = await res.text()
  if (!res.ok) throw new Error(`${res.status} ${path}: ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : {}
}

const agents = await api('/api/agents')
for (const agent of agents) {
  const id = agent.id
  console.log(`Applying SOUL template: ${id}`)
  const tpl = await api(`/api/agents/${encodeURIComponent(id)}/soul/template?refreshTools=true`)
  await api(`/api/agents/${encodeURIComponent(id)}/soul`, {
    method: 'PUT',
    body: JSON.stringify({ soul: tpl.soul })
  })
  await api(`/api/agents/${encodeURIComponent(id)}/sessions/reset-active`, {
    method: 'POST',
    body: JSON.stringify({ reason: 'post-deploy-soul-contract' })
  })
}
console.log('SOUL templates applied')
NODE
```

## 8. Restart services

สำหรับ server ที่ใช้ PM2:

```bash
pm2 restart openclaw-gateway
pm2 restart openclaw-api
pm2 save
```

สำหรับ server ที่ใช้ systemd user service:

```bash
systemctl --user restart openclaw-gateway.service
pm2 restart openclaw-api
```

## 9. Verify health

```bash
TOKEN=$(grep -E '^API_TOKEN=' /root/openclaw-api/.env | cut -d= -f2-)
curl -sS -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:4000/api/system/health?refresh=true" -o /tmp/openclaw-health.json

python3 - <<'PY'
import json
d=json.load(open('/tmp/openclaw-health.json'))
print('status=', d.get('status'))
for c in d.get('checks', []):
    if c.get('status') != 'ok':
        print(c.get('id'), c.get('status'), '-', c.get('summary'))
PY
```

พร้อมใช้งานเมื่อ:

- ไม่มี `critical fail`
- `mcp.<agent>` เป็น `ok`
- `auth.<agent>` เป็น `ok`
- `soul.<agent>` ไม่เตือน legacy `curl`, `/call`, `exec tool`
- `telegram.api` เป็น `ok`

Warn ที่ยังรับได้:

- `model.fallback.*` ไม่มี fallback model
- `telemetry.telegram` หลัง restart แต่ยังไม่มี Telegram message ใหม่

## 10. Smoke test Telegram

ส่งข้อความจริงใน Telegram:

```text
/reset
ขอเช็คราคา โช๊ค jazz
เช็คยอดคงเหลือ ปูน
1
```

คาดหวัง:

- `/reset` ตอบเร็วและตอบครั้งเดียว
- stock mode ถามราคา ต้องตอบไม่มีสิทธิ์ทันที
- stock balance ต้องใช้ `search_product` และเลือก `1` ได้
- `/monitor` เห็น tool path และ token/cost model call ถูกต้อง

เช็ค monitor:

```bash
curl -I http://127.0.0.1:3000/monitor
```

## 11. Rollback

ถ้า updater สร้าง backup id เช่น `20260616163923`:

```bash
cd /root/openclaw-api
bash scripts/update-server.sh --rollback 20260616163923
pm2 restart openclaw-gateway
pm2 restart openclaw-api
pm2 save
```

ถ้าต้อง rollback manual จาก tar backup:

```bash
cd /
tar -xzf /root/openclaw-backups/openclaw-before-update-<BACKUP_ID>.tgz
pm2 restart openclaw-gateway
pm2 restart openclaw-api
cd /root/openclaw-admin && docker compose up -d --build
```

## 12. Notes

- MCP update แบบ Docker pull ใช้ได้เฉพาะ service ที่ใช้ `image:` จาก registry
- OpenClaw Admin ใน layout นี้ใช้ Docker build local จึงต้อง `git pull` แล้ว `docker compose up -d --build`
- OpenClaw API/Gateway ใน layout นี้รันด้วย PM2 จึงต้อง `pm2 restart`
- อย่าให้ secret เช่น OpenRouter key, Telegram token, API token หลุดใน log ที่ส่งต่อ
- ถ้าค้นสินค้าเริ่มช้าในฐานใหญ่ ให้ rollout PostgreSQL trigram indexes แยกต่างหาก
