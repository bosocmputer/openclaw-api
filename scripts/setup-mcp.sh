#!/bin/bash
# ============================================================
# OpenClaw MCP Setup Script
# สำหรับ server ที่ยังไม่ได้ตั้ง MCP หรือต้องการ re-register
#
# วิธีใช้:
#   bash setup-mcp.sh <MCP_SERVER_URL>
#
# ตัวอย่าง:
#   bash setup-mcp.sh http://192.168.2.248:3515
#
# Script จะ register MCP server แยกต่อ agent โดยอัตโนมัติ
# (ดึง agent list จาก openclaw.json)
# ============================================================

set -e
BLUE='\033[0;34m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log()  { echo -e "${BLUE}[INFO]${NC} $1"; }
ok()   { echo -e "${GREEN}[OK]${NC}   $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
err()  { echo -e "${RED}[ERR]${NC}  $1"; exit 1; }

MCP_BASE=${1:-""}

if [ -z "$MCP_BASE" ]; then
  echo "Usage: bash setup-mcp.sh <MCP_SERVER_URL>"
  echo "Example: bash setup-mcp.sh http://192.168.2.248:3515"
  exit 1
fi

# ตัดท้าย /sse /call /mcp ออก ถ้ามี
MCP_BASE=$(echo "$MCP_BASE" | sed 's|/\(sse\|call\|mcp\)$||')

OPENCLAW=/usr/bin/node\ /usr/lib/node_modules/openclaw/dist/index.js
CONFIG=~/.openclaw/openclaw.json

echo ""
echo "=================================================="
echo "  OpenClaw MCP Setup"
echo "  MCP Server: $MCP_BASE"
echo "=================================================="
echo ""

# ตรวจ MCP server ก่อน
log "Testing MCP server at $MCP_BASE/tools ..."
TOOLS=$(curl -s "$MCP_BASE/tools" -H "mcp-access-mode: general" --connect-timeout 5 2>/dev/null)
if [ -z "$TOOLS" ]; then
  err "Cannot reach $MCP_BASE/tools — ตรวจสอบว่า MCP server รันอยู่"
fi
TOOL_COUNT=$(echo "$TOOLS" | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d) if isinstance(d,list) else len(d.get('tools',[])))" 2>/dev/null || echo "?")
ok "MCP server reachable — $TOOL_COUNT tools found"

echo ""

# ดึง agents list จาก openclaw.json
AGENTS=$(python3 -c "
import json
d=json.load(open('$CONFIG'))
for a in d.get('agents',{}).get('list',[]):
    print(a['id'])
" 2>/dev/null)

if [ -z "$AGENTS" ]; then
  warn "No agents found in openclaw.json"
  exit 0
fi

# Map agent → access mode
get_access_mode() {
  local agent=$1
  case $agent in
    stock*)    echo "stock" ;;
    sale_goh*) echo "sales" ;;
    sale*)     echo "sales" ;;
    purchase*) echo "purchase" ;;
    admin*)    echo "admin" ;;
    support*)  echo "general" ;;
    *)         echo "general" ;;
  esac
}

# Register MCP ต่อ agent
for AGENT in $AGENTS; do
  MODE=$(get_access_mode "$AGENT")
  log "Registering $AGENT (mode=$MODE) → $MCP_BASE/sse ..."

  # ลบ entry เก่า (ถ้ามี)
  python3 << PYEOF 2>/dev/null || true
import json
d = json.load(open('$CONFIG'))
if 'mcp' in d and 'servers' in d['mcp']:
    d['mcp']['servers'].pop('$AGENT', None)
    d['mcp']['servers'].pop('sml-$AGENT', None)
    json.dump(d, open('$CONFIG', 'w'), indent=2, ensure_ascii=False)
PYEOF

  # เพิ่ม entry ใหม่
  HOME=$HOME $OPENCLAW mcp add "$AGENT" \
    --transport sse \
    --url "$MCP_BASE/sse" \
    --header "mcp-access-mode=$MODE" \
    --no-probe 2>/dev/null

  ok "$AGENT registered"
done

echo ""

# ตรวจ MCP list
log "Verifying MCP registration..."
HOME=$HOME $OPENCLAW mcp probe 2>/dev/null | grep -E "tools|No MCP"

# Restart gateway
log "Restarting gateway..."
API_TOKEN=$(grep API_TOKEN ~/openclaw-api/.env 2>/dev/null | cut -d= -f2)
if [ -n "$API_TOKEN" ]; then
  curl -s -X POST http://localhost:4000/api/gateway/restart \
    -H "Authorization: Bearer $API_TOKEN" > /dev/null 2>&1
  ok "Gateway restarted"
else
  warn "API_TOKEN not found — restart gateway manually"
fi

echo ""
echo "=================================================="
ok "MCP setup complete!"
echo "  ทดสอบ: ส่งข้อความผ่าน Telegram แล้วดูที่ /monitor"
echo "=================================================="
echo ""
