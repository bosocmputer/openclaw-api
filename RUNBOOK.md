# OpenClaw Production Runbook

Runbook นี้ใช้กับ customer/server layout ปัจจุบัน. Dev server อาจใช้ `$HOME`, ส่วน customer ส่วนใหญ่ใช้ `/root`; ตรวจ path จริงก่อน copy/paste ทุกครั้ง.

- Dev server: `192.168.2.109`
- Customer example: `chang168.thddns.net`
- API: `/root/openclaw-api` or `~/openclaw-api`, PM2 process `openclaw-api`, port `4000`
- Admin: `/root/openclaw-admin` or `~/openclaw-admin`, Docker Compose service `openclaw-admin`, port `3000`
- Runtime gateway: PM2 process `openclaw-gateway` using `/root/openclaw-runtime-2026.6.11-erp/dist/index.js`
- Config: `/root/.openclaw/openclaw.json` or `~/.openclaw/openclaw.json`
- MCP: `http://192.168.2.248:3515/sse`

## Current Release Status

| Component | Expected release / commit | Notes |
| --------- | ------------------------- | ----- |
| Runtime overlay release | `2026.6.11-erp-20260706-line-burst-fastpath` | Generic LINE image/text coalescing and text-only fast path |
| Runtime overlay SHA256 | `a26156d0440b4d6010d89c98a94cdefa8f0d51693762874bde0d607175f94a99` | Verify before install |
| Runtime overlay commits | `f608a18664`, `9976b9bbd7`, `fe432925eb` | sidebar export fix, LINE media burst, no delay for standalone text |
| openclaw-api | `b32f1f0` or newer on `main` | Provider/model, memory, analysis, health, media support |
| openclaw-admin | `adba0bb` or newer on `main` | Current Admin UX and docs |

Runtime gate:

- Production gateway should run a real 2026.6.11 runtime built from `bosocmputer/openclaw` branch `codex/openclaw-2026.6.11-erp-line-burst`.
- `node /root/openclaw-runtime-2026.6.11-erp/dist/index.js --version` should print `OpenClaw 2026.6.11 (fe43292)` or newer.
- Overlay-only installs are acceptable only on an already-correct 2026.6.11 base runtime, or as a legacy LINE-only emergency patch.
- If `ollama-cloud` or another newer provider is enabled, `/model` runtime test must report `runtimeVersion: OpenClaw 2026.6.11 (fe43292)` or newer.

Release behavior to watch:

- LINE image + quick follow-up text should be grouped into one turn. `/monitor` should show the latest turn; structured `line_burst_*` markers are useful but not the sole release gate.
- LINE text-only messages should not be delayed.
- LINE control commands such as `/reset` and `/new` bypass pending burst grouping.
- Telegram behavior should remain unchanged; still run Telegram regression after runtime updates.
- Auto-Learn must not memorize dynamic ERP facts. Price, stock, cost, availability, credit, and substitute products must come from MCP/SML tools.

## Golden Rules

- ห้าม patch `/usr/lib/node_modules/openclaw/dist` โดยไม่มี source/build trace และ deploy metadata
- ทุก deploy ต้องมี backup id เดียวที่ rollback ได้
- ห้าม print หรือ copy token/key ลง log, support bundle, หรือ chat
- ก่อนลูกค้าใช้งานจริง ถ้า health ไม่มี critical fail ให้หลีกเลี่ยง runtime change ที่ไม่จำเป็น

## Build Release Artifact

ทำบนเครื่อง dev หรือ build host ที่มี `openclaw-api`, `openclaw-admin`, และ runtime dist ที่ build แล้ว:

```bash
cd /Users/nontawatwongnuk/dev/openclaw-api
bash scripts/package-release-artifact.sh \
  --runtime-dist-dir /path/to/openclaw/dist \
  --output /tmp/openclaw-release-$(date -u +%Y%m%dT%H%M%SZ).tgz
```

ถ้า release มีเฉพาะ API/Admin docs/scripts และไม่ต้องแตะ gateway runtime:

```bash
bash scripts/package-release-artifact.sh --no-runtime --output /tmp/openclaw-api-admin-release.tgz
```

Artifact จะมี:

- `openclaw-api/`
- `openclaw-admin/`
- `openclaw-dist/` ถ้า include runtime
- `release-manifest.json` พร้อม git head/status และ checksum

ไฟล์ secret เช่น `.env`, `.env.*`, `node_modules`, `.git`, `.next`, `.claude` จะไม่ถูก package

## Upload Artifact

```bash
scp /tmp/openclaw-release-*.tgz bosscatdog@192.168.2.109:/tmp/
```

หรือใช้ `rsync` ถ้าต้องการส่งเป็น directory:

```bash
rsync -az /tmp/openclaw-release-dir/ bosscatdog@192.168.2.109:/tmp/openclaw-release-dir/
```

## Dry Run

บน server:

```bash
cd ~/openclaw-api
bash scripts/update-server.sh --dry-run --artifact /tmp/openclaw-release-YYYYMMDDTHHMMSSZ.tgz
```

Dry-run ต้องเห็น:

- API token found
- `openclaw.json` parses
- MCP reachable
- sudo available ถ้า artifact มี `openclaw-dist`
- ไม่มีการเขียนไฟล์จริง

ถ้า runtime dist เป็น root-owned และ sudo ต้องใช้ password:

```bash
read -rsp "sudo password: " SUDO_PASSWORD; echo
export SUDO_PASSWORD
bash scripts/update-server.sh --dry-run --artifact /tmp/openclaw-release-YYYYMMDDTHHMMSSZ.tgz
unset SUDO_PASSWORD
```

## Apply

```bash
cd ~/openclaw-api
read -rsp "sudo password: " SUDO_PASSWORD; echo
export SUDO_PASSWORD
bash scripts/update-server.sh --apply --artifact /tmp/openclaw-release-YYYYMMDDTHHMMSSZ.tgz
unset SUDO_PASSWORD
```

จด `backup-id` จาก output ทันที เช่น:

```text
Update complete. backup-id=20260615202939
```

สิ่งที่ updater ทำ:

- preflight path, git, node, docker, pm2, API token, JSON config, MCP reachability
- backup `openclaw.json`, `SOUL.md`, `auth-profiles.json`, runtime dist, deploy metadata, git head/status/diff
- copy artifact โดยไม่ลบไฟล์อื่นใน repo
- validate JS syntax ก่อน restart
- migrate MCP config ไปที่ `openclaw.json mcp.servers`
- pin Telegram hosts ถ้าจำเป็น
- rebuild Admin Docker เฉพาะเมื่อ Admin files changed
- restart API/gateway เฉพาะเมื่อ file/state changed
- write `~/.openclaw/deploy-metadata.json`
- run health check และพิมพ์ rollback command ถ้ามี critical fail

## Verify

```bash
cd ~/openclaw-api
bash scripts/update-server.sh --health-only
```

Critical fail ต้องเป็น `0`:

```bash
API_TOKEN=$(grep -E '^API_TOKEN=' ~/openclaw-api/.env | tail -1 | cut -d= -f2- | tr -d '"')
curl -fsS "http://127.0.0.1:4000/api/system/health?refresh=true" \
  -H "Authorization: Bearer $API_TOKEN" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s); console.log(JSON.stringify({ok:j.ok,status:j.status,criticalFails:(j.checks||[]).filter(c=>c.severity==="critical"&&c.status==="fail").length,warns:(j.checks||[]).filter(c=>c.status==="warn").map(c=>c.id)},null,2))})'
```

ตรวจ process:

```bash
/home/bosscatdog/.npm-global/lib/node_modules/pm2/bin/pm2 ls
systemctl --user is-active openclaw-gateway.service
cd ~/openclaw-admin && docker compose ps
curl -fsS -I http://127.0.0.1:3000/monitor
```

ตรวจ release metadata:

```bash
cat ~/.openclaw/deploy-metadata.json
```

## Telegram Latency Watch

หลังลูกค้าส่งข้อความจริง ให้ดู latency:

```bash
API_TOKEN=$(grep -E '^API_TOKEN=' ~/openclaw-api/.env | tail -1 | cut -d= -f2- | tr -d '"')
curl -fsS "http://127.0.0.1:4000/api/monitor/latency?minutes=60&channel=telegram" \
  -H "Authorization: Bearer $API_TOKEN" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s); console.log(JSON.stringify({count:j.summary.count,ackP95:j.summary.ackP95Ms,finalP95:j.summary.finalP95Ms,byStatus:j.summary.byStatus,warnings:j.warnings.slice(0,5)},null,2))})'
```

SLO เริ่มต้น:

- ack p95 < 1.5s
- normal text final p95 < 10s
- image final p95 < 30s
- cached health < 200ms

ถ้า `telemetry.telegram` warn หลัง restart แต่ยังไม่มีข้อความใหม่ ถือว่าปกติ ให้ทดสอบหลังมี Telegram turn จริง

## LINE Burst Watch

ใช้หลัง update runtime overlay `fe432925` หรือหลังลูกค้ารายงานว่า LINE ส่งรูปแล้ว bot ไม่ตอบ:

1. เปิด LINE mobile แล้วส่งรูป 1 รูป
2. พิมพ์ข้อความตามมาภายใน 3 วินาที 1-3 ข้อความ
3. เปิด Admin `/monitor`
4. ควรได้คำตอบที่ใช้ทั้งรูปและข้อความตามหลังเป็นบริบทเดียวกัน และ `/reset` ต้องตอบเร็ว

ตรวจ log จาก gateway:

```bash
pm2 logs openclaw-gateway --lines 240 --nostream 2>/dev/null \
  | grep -E "line_burst_|line_delivery_|line_loading_" || true

journalctl --user -u openclaw-gateway.service -n 240 --no-pager 2>/dev/null \
  | grep -E "line_burst_|line_delivery_|line_loading_" || true
```

Marker ที่คาดหวัง:

- `line_burst_start` = runtime เริ่มรอข้อความตามหลัง media
- `line_burst_append` = มีข้อความ/media เพิ่มใน burst เดียวกัน
- `line_burst_flush` = runtime รวม burst แล้วส่งเข้า agent
- `line_burst_bypass` = command/control หรือ event ที่ไม่ควรรวมถูกปล่อยผ่าน

ถ้าไม่มี marker หลังทดสอบ แต่ behavior ผ่าน:

- ถือว่า deploy ผ่านได้ แต่ให้จดไว้ว่า telemetry marker ยังไม่ครบ
- ตรวจ `/analysis/conversations` ว่ามี turn ล่าสุดและ media metadata สำหรับ export

ถ้าไม่มี marker และ behavior ไม่ผ่าน:

- ตรวจว่า gateway process ใช้ `/root/openclaw-runtime-2026.6.11-erp/dist/index.js`
- ตรวจ overlay markers: `grep -R "textWindowMs.*0\\|line_burst_preflight\\|line_delivery_attempt" -n /root/openclaw-runtime-2026.6.11-erp/dist | head -30`
- ถ้า `node ... --version` ยังแสดง `OpenClaw 2026.6.8` แปลว่ายังไม่ใช่ full 2026.6.11 runtime. ใช้ได้เฉพาะ legacy LINE-only emergency patch; ถ้าเปิด `ollama-cloud` หรือ provider ใหม่ให้ติดตั้ง full runtime 2026.6.11 ก่อน
- ตรวจว่า API/Admin อัปเดตแล้ว และ `/monitor` แสดง turn ล่าสุด

Kill switch เฉพาะ LINE coalescing:

```bash
grep -q '^export OPENCLAW_LINE_COALESCING=' /root/start-openclaw-gateway.sh \
  || sed -i '/export PATH=/a export OPENCLAW_LINE_COALESCING=0' /root/start-openclaw-gateway.sh

pm2 restart openclaw-gateway --update-env
pm2 save
```

ลบบรรทัด `OPENCLAW_LINE_COALESCING=0` แล้ว restart gateway เพื่อเปิดกลับ

## Support Bundle

```bash
API_TOKEN=$(grep -E '^API_TOKEN=' ~/openclaw-api/.env | tail -1 | cut -d= -f2- | tr -d '"')
curl -fsS "http://127.0.0.1:4000/api/system/support-bundle" \
  -H "Authorization: Bearer $API_TOKEN" \
  > /tmp/openclaw-support-bundle.json
```

ก่อนส่งต่อให้ตรวจว่าไม่มี secret:

```bash
grep -E 'sk-or-|bot[0-9]{6,}:' /tmp/openclaw-support-bundle.json && echo "SECRET FOUND" || echo "clean"
```

## Rollback

ใช้ backup id จาก deploy output:

```bash
cd ~/openclaw-api
read -rsp "sudo password: " SUDO_PASSWORD; echo
export SUDO_PASSWORD
bash scripts/update-server.sh --rollback <backup-id>
unset SUDO_PASSWORD
```

Rollback จะ restore:

- `openclaw.json`
- previous deploy metadata
- runtime dist
- `SOUL.md`
- `auth-profiles.json`
- `openclaw-api`/`openclaw-admin` tracked files ไปยัง git head ที่ backup ไว้ และ re-apply dirty diff เท่าที่ทำได้

หลัง rollback ต้องรัน:

```bash
bash scripts/update-server.sh --health-only
```

## Guardrail Kill Switches

ถ้า Telegram behavior ผิดปกติหลัง deploy สามารถปิด guardrail เฉพาะส่วนแล้ว restart gateway แทน rollback ทั้งระบบ:

```bash
systemctl --user edit openclaw-gateway.service
```

เพิ่ม env ที่ต้องการปิด:

```ini
[Service]
Environment=OPENCLAW_TELEGRAM_VISIBLE_ACK=0
Environment=OPENCLAW_TELEGRAM_LOW_INTENT_COALESCE=0
Environment=OPENCLAW_TELEGRAM_STOCK_PRICE_DENIAL=0
Environment=OPENCLAW_TELEGRAM_FOLLOWUP_RESOLVER=0
Environment=OPENCLAW_TELEGRAM_REPLY_QUALITY_GATE=0
Environment=OPENCLAW_LINE_COALESCING=0
```

จากนั้น:

```bash
systemctl --user daemon-reload
systemctl --user restart openclaw-gateway.service
```

## MCP Re-register

Default MCP:

```bash
MCP_URL=http://192.168.2.248:3515/sse
cd ~/openclaw-api
bash scripts/update-server.sh --apply --mcp-url "$MCP_URL"
```

Access mode ต้องส่งผ่าน header:

```text
mcp-access-mode: stock
```

## Telegram Hosts Fix

ถ้า Telegram timeout 60+ วินาที:

```bash
sudo sed -i '/api\.telegram\.org/d' /etc/hosts
sudo sed -i '/api4\.telegram\.org/d' /etc/hosts
echo '149.154.166.110 api.telegram.org api4.telegram.org' | sudo tee -a /etc/hosts
getent hosts api.telegram.org
```

## SOUL Hygiene

SOUL production template ต้องไม่มี:

- `curl`
- `/call`
- `exec tool`
- `mcporter`

ใช้หน้า Admin `/agents/<id>` กด `Load Template`; UI จะแสดง confirm/diff ก่อนทับ textarea และ API จะ backup `SOUL.md` เดิมตอน Save ถ้า content เปลี่ยนเยอะ

## Tomorrow Customer Watch Checklist

เมื่อมีลูกค้าถามจริง:

1. เปิด Admin `/monitor`
2. ดู `Telegram latency` ว่ามี count เพิ่ม
3. ถ้า user บอก bot ช้า ให้ดู `ack p95`, `final p95`, `rootCause`
4. ถ้า rootCause เป็น `queue_or_context_pending` ให้ดู gateway startup/channel/connect
5. ถ้า rootCause เป็น `model_latency` ให้ benchmark model/fallback
6. ถ้า rootCause เป็น `tool_or_mcp_latency` ให้เช็ก MCP `/tools` และ tool endpoint
7. ถ้าคำตอบมีภาษาปนหรือ placeholder ให้ดู `reply_quality_warning`
8. ถ้าเกิด critical fail ให้ rollback ด้วย backup id ล่าสุดก่อน debug ลึก
