#!/bin/bash
# ============================================================
# OpenClaw Server Update Script
# ส่งให้ทีมงานรันบน server ลูกค้า
#
# วิธีใช้:
#   bash update-server.sh
#
# สิ่งที่ script นี้ทำ:
#   1. อัปเดต openclaw-api (routes + code)
#   2. อัปเดต openclaw-admin (Docker)
#   3. ลบ mcporter.json เก่าทุก workspace
#   4. ตั้ง /etc/hosts Telegram (ลด latency)
#   5. Restart openclaw-api และ gateway
# ============================================================

set -e
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log()  { echo -e "${BLUE}[INFO]${NC} $1"; }
ok()   { echo -e "${GREEN}[OK]${NC}   $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
err()  { echo -e "${RED}[ERR]${NC}  $1"; }

echo ""
echo "=================================================="
echo "  OpenClaw Server Update"
echo "  $(date '+%Y-%m-%d %H:%M:%S')"
echo "=================================================="
echo ""

# ─── 1. openclaw-api ──────────────────────────────────────
log "Step 1: Updating openclaw-api..."
if [ -d ~/openclaw-api ]; then
  cd ~/openclaw-api
  git pull origin main
  ok "openclaw-api updated"
else
  err "~/openclaw-api not found — skipping"
fi

# ─── 2. openclaw-admin (Docker) ───────────────────────────
log "Step 2: Updating openclaw-admin (Docker build)..."
if [ -d ~/openclaw-admin ]; then
  cd ~/openclaw-admin
  git pull origin main
  docker compose up -d --build
  ok "openclaw-admin updated"
else
  err "~/openclaw-admin not found — skipping"
fi

# ─── 3. ลบ mcporter.json เก่า ─────────────────────────────
log "Step 3: Removing legacy mcporter.json files..."
REMOVED=0
for f in $(find ~/.openclaw/workspace-*/config -name "mcporter.json" 2>/dev/null); do
  rm "$f"
  warn "Removed: $f"
  REMOVED=$((REMOVED+1))
done
for d in $(find ~/.openclaw/workspace-*/skills -name "mcporter" -type d 2>/dev/null); do
  rm -rf "$d"
  warn "Removed dir: $d"
done
if [ $REMOVED -eq 0 ]; then
  ok "No mcporter.json files found (already clean)"
else
  ok "Removed $REMOVED mcporter.json file(s)"
fi

# ─── 4. Telegram /etc/hosts fix ───────────────────────────
log "Step 4: Fixing Telegram DNS (testing IPs)..."
BEST_IP=""
BEST_TIME=9999

for ip in 149.154.166.110 149.154.167.110 149.154.165.110 149.154.168.110 149.154.175.110; do
  # ทดสอบ HTTPS connectivity
  result=$(curl -sk -o /dev/null -w "%{http_code}" \
    --connect-timeout 4 --resolve "api.telegram.org:443:$ip" \
    "https://api.telegram.org/bot_test/getMe" 2>/dev/null)
  if [ "$result" = "404" ] || [ "$result" = "401" ]; then
    # 404/401 = IP ทำงานได้ (token ผิดแค่ไม่มี bot token จริง)
    ping_ms=$(ping -c1 -W2 "$ip" 2>/dev/null | grep -oP 'time=\K[\d.]+' || echo "9999")
    ping_int=${ping_ms%.*}
    echo "    $ip: HTTP=$result ping=${ping_ms}ms"
    if [ "$ping_int" -lt "$BEST_TIME" ] 2>/dev/null; then
      BEST_TIME=$ping_int
      BEST_IP=$ip
    fi
  else
    echo "    $ip: unreachable (HTTP=$result)"
  fi
done

if [ -n "$BEST_IP" ]; then
  # ลบ entry เก่า แล้วเพิ่มใหม่
  sudo sed -i '/api\.telegram\.org/d' /etc/hosts 2>/dev/null || true
  sudo sed -i '/api4\.telegram\.org/d' /etc/hosts 2>/dev/null || true
  echo "$BEST_IP  api.telegram.org api4.telegram.org" | sudo tee -a /etc/hosts > /dev/null
  ok "Set api.telegram.org → $BEST_IP (${BEST_TIME}ms)"
else
  warn "Could not find a working Telegram IP — skipping hosts fix"
fi

# ─── 5. Restart openclaw-api ──────────────────────────────
log "Step 5: Restarting openclaw-api..."
PM2=~/.npm-global/bin/pm2
if [ -f "$PM2" ]; then
  $PM2 restart openclaw-api
  sleep 2
  $PM2 list | grep openclaw-api
  ok "openclaw-api restarted"
else
  err "pm2 not found at $PM2"
fi

# ─── 6. Restart gateway ───────────────────────────────────
log "Step 6: Restarting openclaw gateway..."
API_TOKEN=$(grep API_TOKEN ~/openclaw-api/.env 2>/dev/null | cut -d= -f2)
if [ -n "$API_TOKEN" ]; then
  RESULT=$(curl -s -X POST http://localhost:4000/api/gateway/restart \
    -H "Authorization: Bearer $API_TOKEN" 2>/dev/null)
  echo "    gateway restart: $RESULT"
  ok "Gateway restarted"
else
  warn "API_TOKEN not found — gateway not restarted"
fi

# ─── 7. ตรวจ MCP servers ──────────────────────────────────
log "Step 7: Checking MCP servers..."
sleep 3
HOME_DIR=$HOME /usr/bin/node /usr/lib/node_modules/openclaw/dist/index.js mcp list 2>/dev/null \
  | grep -E "sml-|No MCP" || warn "Could not list MCP servers"

echo ""
echo "=================================================="
ok "Update complete!"
echo ""
echo "  ถัดไป: ตรวจสอบในหน้า Admin > Monitor"
echo "  และทดสอบส่งข้อความผ่าน Telegram"
echo "=================================================="
echo ""
