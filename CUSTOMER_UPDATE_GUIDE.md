# Customer Update Package: MCP + OpenClaw ERP Chatbot

คู่มือนี้ใช้สำหรับ rollout server ลูกค้าที่มี MCP, OpenClaw runtime, `openclaw-api`, และ `openclaw-admin`.
เป้าหมายคือ update ซ้ำได้, rollback ได้, และ smoke test ได้โดยไม่ต้อง patch `dist` มือ.

## Current Release Baseline

- OpenClaw runtime source commit: `1c81b77460` (`Add generic LINE burst coalescing`)
- Runtime version expected after update: `OpenClaw 2026.6.8 (1c81b77)`
- Runtime artifact: `releases/2026.6.8-erp-20260624-line-burst-coalescing/openclaw-runtime-2026.6.8-erp-latest.tar.gz`
- Runtime SHA256: `1f4ca1e96d6ea84b7e26da1091f323a50c39e023c18c1e36a100966d55e291e7`
- `openclaw-api` minimum feature commit: `645f116` (`Track LINE burst telemetry`)
- `openclaw-admin` minimum feature commit: `bbfe324` (`Update runtime artifact install URL`)
- MCP image: `ghcr.io/smlsoft/smlmcpconnect:latest` with `search_product` Smart Search v2

The exact API/Admin commits inside a generated artifact are recorded in `release-manifest.json` when an artifact package is used. For the current customer flow, API/Admin are usually updated by `git pull --ff-only`, while the runtime is updated from the pinned runtime artifact URL below.

Important runtime behavior:

- LINE image + rapid follow-up text is coalesced into one generic turn. This uses timing, sender, chat, and media/text presence only; no business keyword or question text is hardcoded.
- LINE text-only messages still dispatch immediately.
- LINE `/reset`, `/new`, and control commands bypass/cancel pending bursts.
- `/monitor` should show `LINE grouped` or `line_burst_flush` when an image and follow-up text are grouped.
- Set `OPENCLAW_LINE_COALESCING=0` and restart gateway to disable this feature quickly.
- Telegram must not show `This message is not supported on the web version of Telegram`.
- Telegram must not show `↪️ Model Fallback...` to end users.
- `/monitor` should show recovered fallback turns as `model_timeout_recovered`, not a hard failure.
- `/model` should validate primary, fallback, and image understanding models before save.

## Server Layouts Supported

Common root install:

- API: `/root/openclaw-api`, PM2 process `openclaw-api`, port `4000`
- Admin: `/root/openclaw-admin`, Docker Compose service `openclaw-admin`, port `3000`
- Runtime state: `/root/.openclaw`
- Gateway: PM2 process `openclaw-gateway` or `systemctl --user restart openclaw-gateway.service`
- MCP: `/data/mcp-connect`, Docker Compose service `smlmcpconnect`, port `3515`

Common non-root dev install:

- API: `$HOME/openclaw-api`
- Admin: `$HOME/openclaw-admin`
- Runtime state: `$HOME/.openclaw`
- Runtime dist: auto-detected from `npm root -g`, `$HOME/.npm-global`, `/usr/lib`, or `RUNTIME_DIST_DIR`

Always confirm paths before update:

```bash
hostname -I
whoami

echo "== openclaw dirs =="
ls -la /root/openclaw-api /root/openclaw-admin /root/.openclaw 2>/dev/null || true
ls -la ~/openclaw-api ~/openclaw-admin ~/.openclaw 2>/dev/null || true

echo "== runtime =="
which openclaw || true
openclaw --version || true
npm root -g 2>/dev/null || true

echo "== processes =="
pm2 list || true
systemctl --user status openclaw-gateway.service --no-pager || true
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}' || true
```

## 0. Recommended Customer Update Path For 2026-06-24 Release

Use this path when the customer server already has git checkouts at `/root/openclaw-api` and `/root/openclaw-admin`. It matches the current Chang168 rollout style.

### Update API and Admin

```bash
cd /root/openclaw-api
git fetch origin main
git pull --ff-only origin main
npm install

grep -q '^OPENCLAW_BIN=' .env \
  && sed -i 's#^OPENCLAW_BIN=.*#OPENCLAW_BIN=/root/openclaw-runtime-2026.6.8-erp/dist/index.js#' .env \
  || echo 'OPENCLAW_BIN=/root/openclaw-runtime-2026.6.8-erp/dist/index.js' >> .env

pm2 restart openclaw-api --update-env

cd /root/openclaw-admin
git fetch origin main
git pull --ff-only origin main
docker compose up -d --build openclaw-admin
```

### Update Runtime Artifact

```bash
cd /root
RUNTIME_URL="https://raw.githubusercontent.com/bosocmputer/openclaw-runtime-artifacts/3ede1322c6651657dee4546bcade6efb9e4f7fcd/releases/2026.6.8-erp-20260624-line-burst-coalescing/openclaw-runtime-2026.6.8-erp-latest.tar.gz"
SHA="1f4ca1e96d6ea84b7e26da1091f323a50c39e023c18c1e36a100966d55e291e7"

BACKUP_ID=$(date +%Y%m%d%H%M%S)
mkdir -p /root/openclaw-backups/$BACKUP_ID
cp -a /root/openclaw-runtime-2026.6.8-erp /root/openclaw-backups/$BACKUP_ID/openclaw-runtime-2026.6.8-erp 2>/dev/null || true
cp -a /root/start-openclaw-gateway.sh /root/openclaw-backups/$BACKUP_ID/start-openclaw-gateway.sh 2>/dev/null || true

curl -fL -o openclaw-runtime-2026.6.8-erp-latest.tar.gz "$RUNTIME_URL"
echo "$SHA  openclaw-runtime-2026.6.8-erp-latest.tar.gz" | sha256sum -c -

rm -rf /root/openclaw-runtime-2026.6.8-erp
tar -xzf openclaw-runtime-2026.6.8-erp-latest.tar.gz -C /root --no-same-owner

node /root/openclaw-runtime-2026.6.8-erp/dist/index.js --version
pm2 restart openclaw-gateway --update-env
pm2 restart openclaw-api --update-env
pm2 save
ss -ltnp | grep 18789 || true
```

Expected version:

```text
OpenClaw 2026.6.8 (1c81b77)
```

### Smoke Test Current Release

Telegram:

1. `/reset`
2. `สวัสดี`
3. Search/stock/price prompt relevant to the customer
4. Product image if image understanding is enabled

LINE:

1. `สวัสดี`
2. Send one image
3. Within 3 seconds, send one or more follow-up text messages
4. Open `/monitor`; expected marker/badge: `LINE grouped` or `line_burst_flush`

If LINE grouping causes unexpected behavior, disable only this feature and restart gateway:

```bash
grep -q '^export OPENCLAW_LINE_COALESCING=' /root/start-openclaw-gateway.sh \
  || sed -i '/export PATH=/a export OPENCLAW_LINE_COALESCING=0' /root/start-openclaw-gateway.sh

pm2 restart openclaw-gateway --update-env
pm2 save
```

When the issue is resolved, remove the `OPENCLAW_LINE_COALESCING=0` line and restart gateway.

## 1. Legacy Artifact Package Flow

Use the following sections only when preparing a full API/Admin/runtime tarball with `release-manifest.json`. The current preferred customer path is the pinned runtime artifact plus API/Admin git pull flow above.

### Build Artifact On Dev Mac

Build OpenClaw runtime first so `dist/` contains the source commit above.
Use the gateway/runtime profile for customer packages; it is much faster than the full UI/SDK build and includes the Telegram gateway files this release needs:

```bash
cd /Users/nontawatwongnuk/dev/openclaw
PATH=/Users/nontawatwongnuk/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH \
  node scripts/build-all.mjs gatewayWatch
```

If you are preparing a full upstream npm package, use `pnpm build` instead. For this ERP customer artifact, `gatewayWatch` is the intended build gate.

Create the customer package:

```bash
cd /Users/nontawatwongnuk/dev/openclaw-api

bash scripts/package-release-artifact.sh \
  --runtime-dist-dir /Users/nontawatwongnuk/dev/openclaw/dist \
  --output /tmp/openclaw-erp-customer-$(date -u +%Y%m%dT%H%M%SZ).tgz
```

For API/Admin-only releases:

```bash
bash scripts/package-release-artifact.sh \
  --no-runtime \
  --output /tmp/openclaw-api-admin-$(date -u +%Y%m%dT%H%M%SZ).tgz
```

Inspect the artifact before upload:

```bash
ARTIFACT=/tmp/openclaw-erp-customer-YYYYMMDDTHHMMSSZ.tgz
tar -tzf "$ARTIFACT" | sed -n '1,80p'
tar -xOf "$ARTIFACT" ./release-manifest.json | python3 -m json.tool | sed -n '1,160p'
shasum -a 256 "$ARTIFACT"
```

The artifact excludes `.env`, `.env.*`, `.git`, `.github`, `node_modules`, `.next`, `.claude`, `.DS_Store`, `._*`, `*.tsbuildinfo`, `.graphifyignore`, `graphify-out`, and local quick-reference scratch files.

## 2. Upload Artifact

If the customer server allows SSH/SCP:

```bash
scp "$ARTIFACT" changaliyon@CUSTOMER_IP:/tmp/
```

If root-owned paths are used, upload to `/tmp` as the login user, then switch to root on the server:

```bash
sudo -i
ls -lh /tmp/openclaw-erp-customer-*.tgz
```

If AnyDesk cannot copy files to root, copy to the normal user desktop or `/tmp`, then move with `sudo mv`.

## 3. Update MCP First

Use this when MCP compose uses:

```yaml
image: ghcr.io/smlsoft/smlmcpconnect:latest
```

Commands:

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
curl -fsS http://127.0.0.1:3515/tools | grep -A30 search_product
```

Expected `search_product` description should mention Smart Search or keyword search from `ic_inventory`.

Quick MCP call smoke:

```bash
curl -sS -X POST http://127.0.0.1:3515/call \
  -H 'Content-Type: application/json' \
  -H 'mcp-access-mode: stock' \
  -d '{"tool":"search_product","input":{"keyword":"ปูน","intent":"stock","limit":5,"page":1}}' \
  | python3 -m json.tool | sed -n '1,120p'
```

## 4. Stage The New Updater From Artifact

Do not rely on the old updater already installed on the customer server. Extract the artifact to `/tmp` and run the updater from there:

```bash
ARTIFACT=/tmp/openclaw-erp-customer-YYYYMMDDTHHMMSSZ.tgz
STAGE=/tmp/openclaw-release-stage

rm -rf "$STAGE"
mkdir -p "$STAGE"
tar -xf "$ARTIFACT" -C "$STAGE"
bash "$STAGE/openclaw-api/scripts/update-server.sh" --help
```

Set paths explicitly if the install is root-owned:

```bash
export API_DIR=/root/openclaw-api
export ADMIN_DIR=/root/openclaw-admin
export STATE_DIR=/root/.openclaw
export API_URL=http://127.0.0.1:4000
```

If runtime dist is not auto-detected:

```bash
export RUNTIME_DIST_DIR="$(npm root -g)/openclaw/dist"
# or:
export RUNTIME_DIST_DIR=/usr/lib/node_modules/openclaw/dist
# or:
export RUNTIME_DIST_DIR=/root/.npm-global/lib/node_modules/openclaw/dist
```

## 5. Dry Run

```bash
bash "$STAGE/openclaw-api/scripts/update-server.sh" \
  --dry-run \
  --artifact "$ARTIFACT" \
  --mcp-url http://127.0.0.1:3515/sse
```

Dry run should confirm:

- `openclaw.json` parses
- API token found, or a clear warning if missing
- MCP reachable, or a clear warning if networking is still being fixed
- Runtime dist is detected if artifact includes `openclaw-dist`
- No files are changed

If runtime dist requires sudo:

```bash
read -rsp "sudo password: " SUDO_PASSWORD; echo
export SUDO_PASSWORD
```

## 6. Apply Update

If the OpenRouter key is already in `openclaw.json`, extract it safely:

```bash
OPENROUTER_KEY=$(python3 - <<'PY'
import json, os
p=os.environ.get("STATE_DIR","/root/.openclaw") + "/openclaw.json"
try:
    d=json.load(open(p))
    print((d.get("env") or {}).get("OPENROUTER_API_KEY",""))
except Exception:
    print("")
PY
)
```

Apply:

```bash
bash "$STAGE/openclaw-api/scripts/update-server.sh" \
  --apply \
  --artifact "$ARTIFACT" \
  --mcp-url http://127.0.0.1:3515/sse \
  ${OPENROUTER_KEY:+--openrouter-key "$OPENROUTER_KEY"}
```

Write down the `backup-id` printed at the end. It is required for rollback.

The updater will:

- create one backup id for config, state files, runtime dist, API/Admin git head/status/diff
- copy runtime, API, and Admin from artifact
- validate JS syntax for API and runtime entry/chunks
- migrate MCP config to `openclaw.json mcp.servers`
- rotate OpenRouter auth profiles if key is provided
- rebuild Admin Docker only when Admin changed
- restart API/gateway only when changed
- write `~/.openclaw/deploy-metadata.json`
- run health and print rollback command on critical failure

## 7. Apply SOUL Templates

Run after MCP/auth config is ready:

```bash
cd "$API_DIR"
TOKEN=$(grep -E '^API_TOKEN=' "$API_DIR/.env" | tail -1 | cut -d= -f2- | tr -d '"')

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
    body: JSON.stringify({ reason: 'post-customer-update-soul-contract' })
  })
}
console.log('SOUL templates applied')
NODE
```

Restart gateway once more after SOUL apply:

```bash
pm2 restart openclaw-gateway 2>/dev/null || systemctl --user restart openclaw-gateway.service
pm2 restart openclaw-api 2>/dev/null || true
pm2 save 2>/dev/null || true
```

## 8. Verify Health And Model Readiness

```bash
TOKEN=$(grep -E '^API_TOKEN=' "$API_DIR/.env" | tail -1 | cut -d= -f2- | tr -d '"')

curl -fsS -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:4000/api/system/health?refresh=true" \
  | python3 -m json.tool | sed -n '1,180p'

curl -fsS -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:4000/api/models/readiness?refresh=true" \
  | python3 -m json.tool | sed -n '1,180p'
```

Ready state:

- health has no critical fail
- MCP per agent is ok
- SOUL has no legacy `curl`, `/call`, `exec tool`
- model readiness has no blocking issues
- fallback and image model warnings are gone after `/model` settings are saved

## 9. Smoke Test Admin And Monitor

```bash
curl -fsS -I http://127.0.0.1:3000/ | head

curl -fsS -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:4000/api/monitor/conversations?minutes=240&agent=stock&channel=telegram&limit=5" \
  | python3 -m json.tool | sed -n '1,220p'
```

Open the Admin UI:

- `/` dashboard
- `/model` model readiness
- `/monitor` latest conversation
- `/system` health

## 10. Telegram Regression Smoke

Test with the real customer bot:

1. `/reset`
2. `สวัสดี`
3. `ขอเช็คราคา โช๊ค jazz`
4. `ขอเช็คยอด โช๊ค jazz`
5. `ขอเช็คยอดคงเหลือ ปูน หน่อย`
6. `รายการ 1`
7. send one product image if image model is configured

Pass criteria:

- `/reset` replies once
- no `This message is not supported on the web version of Telegram`
- no `↪️ Model Fallback...` shown to user
- price denial is immediate for stock mode
- stock query either returns stock, no-stock with code/name, or asks user to choose/refine
- `/monitor` shows model/tool chain, model used, token/cost only for model calls
- if primary model times out but fallback succeeds, monitor shows recovered warning, not a hard failed turn

## 10.1 LINE Regression Smoke

Test with the real LINE OA on a mobile client when possible:

1. `สวัสดี`
2. Send one image without caption
3. Within 3 seconds, send one or more follow-up text messages
4. Send `/reset`
5. Send another normal text message

Pass criteria:

- normal text replies without extra delay
- image + rapid text is handled as one conversational turn
- `/monitor` shows `LINE grouped` or `line_burst_flush`
- loading animation may appear on LINE mobile while the agent works
- no session remains stuck after the image turn
- `/reset` bypasses any pending burst and responds quickly

## 11. Rollback

Use the backup id from apply output:

```bash
bash "$STAGE/openclaw-api/scripts/update-server.sh" --rollback <backup-id>
```

If sudo was required for runtime files:

```bash
read -rsp "sudo password: " SUDO_PASSWORD; echo
export SUDO_PASSWORD
bash "$STAGE/openclaw-api/scripts/update-server.sh" --rollback <backup-id>
unset SUDO_PASSWORD
```

Verify after rollback:

```bash
bash "$STAGE/openclaw-api/scripts/update-server.sh" --health-only
pm2 list || true
systemctl --user is-active openclaw-gateway.service || true
cd "$ADMIN_DIR" && docker compose ps
```

## 12. When Git Pull Is Acceptable

For the current 2026-06-24 release, git pull is the preferred API/Admin update path when all are true:

- customer server has clean repos
- latest commits are pushed
- runtime is updated separately from the pinned ERP artifact URL in section 0
- no root-owned copy barrier blocks deploy

Commands:

```bash
cd "$API_DIR"
git fetch origin main
git pull --ff-only origin main
node --check index.js
find routes lib -maxdepth 2 -type f -name '*.js' -print0 | xargs -0 -n1 node --check
pm2 restart openclaw-api

cd "$ADMIN_DIR"
git fetch origin main
git pull --ff-only origin main
docker compose up -d --build openclaw-admin
```

For this release, do not use the legacy generated tarball unless git pull is blocked. Keep API/Admin and runtime in sync by using section 0, then run both Telegram and LINE regression smoke tests.
