#!/usr/bin/env bash
# OpenClaw production updater.
#
# Usage:
#   bash scripts/update-server.sh --dry-run
#   bash scripts/update-server.sh --apply --mcp-url http://192.168.2.248:3515/sse --openrouter-key "$KEY"
#   bash scripts/update-server.sh --rollback <backup-id>
#   bash scripts/update-server.sh --health-only

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

API_DIR="${API_DIR:-$HOME/openclaw-api}"
ADMIN_DIR="${ADMIN_DIR:-$HOME/openclaw-admin}"
STATE_DIR="${STATE_DIR:-$HOME/.openclaw}"
CONFIG_PATH="$STATE_DIR/openclaw.json"
API_URL="${API_URL:-http://127.0.0.1:4000}"
PM2_PROCESS="${PM2_PROCESS:-openclaw-api}"
DEFAULT_MCP_URL="http://192.168.2.248:3515/sse"

MODE="dry-run"
MCP_URL="$DEFAULT_MCP_URL"
OPENROUTER_KEY="${OPENROUTER_KEY:-}"
ROLLBACK_ID=""
BACKUP_ID="$(date +%Y%m%d%H%M%S)"
BACKUP_ROOT="$STATE_DIR/backups/openclaw-update-$BACKUP_ID"
CHANGED_API=0
CHANGED_ADMIN=0
CHANGED_STATE=0

log()  { echo -e "${BLUE}[INFO]${NC} $*"; }
ok()   { echo -e "${GREEN}[OK]${NC}   $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
err()  { echo -e "${RED}[ERR]${NC}  $*" >&2; }

usage() {
  sed -n '1,14p' "$0"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) MODE="dry-run"; shift ;;
    --apply) MODE="apply"; shift ;;
    --health-only) MODE="health-only"; shift ;;
    --rollback) MODE="rollback"; ROLLBACK_ID="${2:-}"; shift 2 ;;
    --mcp-url) MCP_URL="${2:-}"; shift 2 ;;
    --openrouter-key) OPENROUTER_KEY="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) err "Unknown option: $1"; usage; exit 2 ;;
  esac
done

if [[ "$MODE" == "rollback" && -z "$ROLLBACK_ID" ]]; then
  err "--rollback requires a backup id"
  exit 2
fi

run() {
  if [[ "$MODE" == "dry-run" ]]; then
    echo "DRY-RUN: $*"
  else
    "$@"
  fi
}

find_pm2() {
  if command -v pm2 >/dev/null 2>&1; then
    command -v pm2
    return 0
  fi
  for candidate in "$HOME/.npm-global/bin/pm2" "$HOME/.nvm/versions/node"/*/bin/pm2; do
    if [[ -x "$candidate" ]]; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}

load_api_token() {
  if [[ -n "${API_TOKEN:-}" ]]; then return 0; fi
  if [[ -f "$API_DIR/.env" ]]; then
    API_TOKEN="$(grep -E '^API_TOKEN=' "$API_DIR/.env" | tail -1 | cut -d= -f2- | tr -d '"' || true)"
    export API_TOKEN
  fi
}

health_check() {
  load_api_token
  if [[ -z "${API_TOKEN:-}" ]]; then
    err "API_TOKEN not found in env or $API_DIR/.env"
    return 1
  fi
  local response
  if ! response="$(curl -fsS "$API_URL/api/system/health?refresh=true" -H "Authorization: Bearer $API_TOKEN")"; then
    return 1
  fi
  printf '%s' "$response" | node -e '
      let data = "";
      process.stdin.on("data", d => data += d);
      process.stdin.on("end", () => {
        const j = JSON.parse(data);
        console.log(JSON.stringify(j, null, 2).replace(/sk-or-[A-Za-z0-9_-]+/g, "sk-or-<redacted>"));
        const critical = (j.checks || []).filter(c => c.severity === "critical" && c.status === "fail");
        if (critical.length) process.exit(3);
      });
    '
}

wait_for_api() {
  load_api_token
  if [[ -z "${API_TOKEN:-}" ]]; then return 1; fi
  for _ in $(seq 1 30); do
    if curl -fsS "$API_URL/api/status" -H "Authorization: Bearer $API_TOKEN" >/dev/null 2>&1; then
      ok "API is ready"
      return 0
    fi
    sleep 1
  done
  warn "API did not become ready within 30s"
  return 1
}

preflight() {
  log "Preflight"
  [[ -d "$API_DIR" ]] || { err "$API_DIR not found"; exit 1; }
  [[ -d "$ADMIN_DIR" ]] || { err "$ADMIN_DIR not found"; exit 1; }
  [[ -f "$CONFIG_PATH" ]] || { err "$CONFIG_PATH not found"; exit 1; }
  command -v git >/dev/null || { err "git not found"; exit 1; }
  command -v node >/dev/null || { err "node not found"; exit 1; }
  command -v curl >/dev/null || { err "curl not found"; exit 1; }
  find_pm2 >/dev/null || warn "pm2 not found"
  command -v docker >/dev/null || warn "docker not found in PATH"
  load_api_token
  [[ -n "${API_TOKEN:-}" ]] && ok "API token found" || warn "API token not found; health/restart checks may fail"
  node -e "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'))" "$CONFIG_PATH"
  ok "openclaw.json parses"
  curl -fsS --max-time 3 "$(echo "$MCP_URL" | sed -E 's#/(sse|mcp|call)(/.*)?$##')/tools" \
    -H "mcp-access-mode: general" >/dev/null \
    && ok "MCP reachable: $MCP_URL" \
    || warn "MCP tools endpoint not reachable during preflight: $MCP_URL"
}

backup_state() {
  log "Creating backup $BACKUP_ID"
  run mkdir -p "$BACKUP_ROOT/files"
  if [[ "$MODE" == "dry-run" ]]; then return 0; fi

  cp "$CONFIG_PATH" "$BACKUP_ROOT/openclaw.json"
  git -C "$API_DIR" rev-parse HEAD > "$BACKUP_ROOT/openclaw-api.head"
  git -C "$ADMIN_DIR" rev-parse HEAD > "$BACKUP_ROOT/openclaw-admin.head"
  git -C "$API_DIR" status --porcelain > "$BACKUP_ROOT/openclaw-api.status" || true
  git -C "$ADMIN_DIR" status --porcelain > "$BACKUP_ROOT/openclaw-admin.status" || true
  git -C "$API_DIR" diff --binary > "$BACKUP_ROOT/openclaw-api.dirty.diff" || true
  git -C "$ADMIN_DIR" diff --binary > "$BACKUP_ROOT/openclaw-admin.dirty.diff" || true

  find "$STATE_DIR/agents" -type f \( -name "auth-profiles.json" -o -name "SOUL.md" \) 2>/dev/null | while read -r file; do
    rel="${file#$HOME/}"
    mkdir -p "$BACKUP_ROOT/files/$(dirname "$rel")"
    cp "$file" "$BACKUP_ROOT/files/$rel"
  done
  ok "Backup stored at $BACKUP_ROOT"
}

restore_backup() {
  local id="$1"
  local root="$STATE_DIR/backups/openclaw-update-$id"
  [[ -d "$root" ]] || { err "Backup not found: $root"; exit 1; }
  log "Restoring backup $id"
  cp "$CONFIG_PATH" "$CONFIG_PATH.before-rollback.$(date +%Y%m%d%H%M%S)" 2>/dev/null || true
  cp "$root/openclaw.json" "$CONFIG_PATH"
  if [[ -d "$root/files" ]]; then
    (cd "$root/files" && find . -type f) | while read -r rel; do
      rel="${rel#./}"
      mkdir -p "$HOME/$(dirname "$rel")"
      cp "$root/files/$rel" "$HOME/$rel"
    done
  fi
  if [[ -f "$root/openclaw-api.head" ]]; then
    git -C "$API_DIR" checkout "$(cat "$root/openclaw-api.head")" -- .
    if [[ -s "$root/openclaw-api.dirty.diff" ]]; then
      git -C "$API_DIR" apply "$root/openclaw-api.dirty.diff" || warn "Could not re-apply openclaw-api dirty diff"
    fi
  fi
  if [[ -f "$root/openclaw-admin.head" ]]; then
    git -C "$ADMIN_DIR" checkout "$(cat "$root/openclaw-admin.head")" -- .
    if [[ -s "$root/openclaw-admin.dirty.diff" ]]; then
      git -C "$ADMIN_DIR" apply "$root/openclaw-admin.dirty.diff" || warn "Could not re-apply openclaw-admin dirty diff"
    fi
  fi
  ok "Rollback files restored"
  restart_changed "rollback"
}

update_repo() {
  local dir="$1"
  local label="$2"
  local before after
  before="$(git -C "$dir" rev-parse HEAD)"
  if [[ "$MODE" != "dry-run" ]]; then
    local dirty_files
    dirty_files="$(git -C "$dir" diff --name-only || true)"
    if [[ -n "$dirty_files" ]]; then
      warn "$label has tracked local edits; backed up dirty diff and cleaning before pull"
      while IFS= read -r file; do
        [[ -n "$file" ]] && git -C "$dir" checkout -- "$file"
      done <<< "$dirty_files"
    fi
  fi
  run git -C "$dir" pull --ff-only origin main
  if [[ "$MODE" == "dry-run" ]]; then return 0; fi
  after="$(git -C "$dir" rev-parse HEAD)"
  if [[ "$before" != "$after" ]]; then
    ok "$label updated: ${before:0:8} -> ${after:0:8}"
    [[ "$label" == "openclaw-api" ]] && CHANGED_API=1 || CHANGED_ADMIN=1
  else
    ok "$label already current"
  fi
}

atomic_write_json() {
  local file="$1"
  local tmp="$file.tmp.$$"
  node -e '
    const fs = require("fs");
    const file = process.argv[1];
    const tmp = process.argv[2];
    const input = fs.readFileSync(0, "utf8");
    JSON.parse(input);
    const fd = fs.openSync(tmp, "w", 0o600);
    fs.writeFileSync(fd, input);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(tmp, file);
  ' "$file" "$tmp"
}

configure_mcp() {
  log "Ensuring native MCP servers in openclaw.json"
  if [[ "$MODE" == "dry-run" ]]; then
    echo "DRY-RUN: configure every agent MCP URL=$MCP_URL with mcp-access-mode header"
    return 0
  fi
  node - "$CONFIG_PATH" "$MCP_URL" <<'NODE' | atomic_write_json "$CONFIG_PATH"
const fs = require('fs')
const [configPath, mcpUrl] = process.argv.slice(2)
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
const agents = config.agents?.list || []
const validModes = new Set(['admin', 'sales', 'purchase', 'stock', 'general'])
function defaultAccessMode(id) {
  const value = String(id || '').toLowerCase()
  if (validModes.has(value)) return value
  if (value === 'sale' || value.includes('sale')) return 'sales'
  if (value.includes('purchase') || value.includes('buy')) return 'purchase'
  if (value.includes('stock') || value.includes('warehouse')) return 'stock'
  if (value.includes('admin')) return 'admin'
  return 'general'
}
config.mcp ??= {}
config.mcp.servers ??= {}
for (const agent of agents) {
  const id = agent.id
  const legacy = config.mcp.servers[`sml-${id}`]
  const current = config.mcp.servers[id] || legacy || {}
  const configuredMode = current.headers?.['mcp-access-mode'] || current.env?.MCP_ACCESS_MODE
  const accessMode = validModes.has(configuredMode) ? configuredMode : defaultAccessMode(id)
  config.mcp.servers[id] = {
    url: current.url || mcpUrl,
    transport: (current.url || mcpUrl).includes('/sse') ? 'sse' : 'streamable-http',
    headers: { ...(current.headers || {}), 'mcp-access-mode': accessMode },
  }
  delete config.mcp.servers[`sml-${id}`]
}
process.stdout.write(JSON.stringify(config, null, 2))
NODE
  CHANGED_STATE=1
  ok "MCP config updated without legacy sml-* entries"
}

rotate_openrouter_key() {
  if [[ -z "$OPENROUTER_KEY" ]]; then
    warn "No --openrouter-key provided; skipping key rotation"
    return 0
  fi
  log "Rotating OpenRouter key in every agent auth profile"
  if [[ "$MODE" == "dry-run" ]]; then
    echo "DRY-RUN: update auth-profiles.json for all agents; key will not be printed"
    return 0
  fi
  OPENROUTER_KEY="$OPENROUTER_KEY" node - "$CONFIG_PATH" "$STATE_DIR" "$BACKUP_ID" <<'NODE'
const fs = require('fs')
const path = require('path')
const [configPath, stateDir, backupId] = process.argv.slice(2)
const key = process.env.OPENROUTER_KEY
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
let count = 0
for (const agent of config.agents?.list || []) {
  const authPath = path.join(stateDir, 'agents', agent.id, 'agent', 'auth-profiles.json')
  fs.mkdirSync(path.dirname(authPath), { recursive: true })
  let store = { version: 1, profiles: {} }
  try { store = JSON.parse(fs.readFileSync(authPath, 'utf8')) } catch {}
  store.version ||= 1
  store.profiles ||= {}
  const ids = Object.keys(store.profiles).filter(id => id === 'openrouter:default' || id.startsWith('openrouter:'))
  if (ids.length === 0) ids.push('openrouter:default')
  for (const id of ids) {
    const existing = store.profiles[id] || {}
    store.profiles[id] = { ...existing, type: 'api_key', provider: 'openrouter', key }
  }
  if (fs.existsSync(authPath)) fs.copyFileSync(authPath, `${authPath}.bak.${backupId}`)
  const tmp = `${authPath}.tmp.${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, authPath)
  count++
}
if (!config.env) config.env = {}
config.env.OPENROUTER_API_KEY = key
const tmpConfig = `${configPath}.tmp.${process.pid}`
fs.writeFileSync(tmpConfig, JSON.stringify(config, null, 2), { mode: 0o600 })
fs.renameSync(tmpConfig, configPath)
console.log(`updated auth profiles: ${count}`)
NODE
  CHANGED_STATE=1
}

fix_telegram_hosts() {
  log "Checking Telegram hosts pin"
  if grep -qE '149\.154\.166\.110\s+api\.telegram\.org' /etc/hosts 2>/dev/null; then
    ok "api.telegram.org already pinned to 149.154.166.110"
    return 0
  fi
  if [[ "$MODE" == "dry-run" ]]; then
    echo "DRY-RUN: sudo update /etc/hosts for api.telegram.org -> 149.154.166.110"
    return 0
  fi
  if ! sudo -n true 2>/dev/null; then
    warn "sudo without password is not available; run manually:"
    echo "  sudo sed -i '/api\\.telegram\\.org/d' /etc/hosts"
    echo "  echo '149.154.166.110 api.telegram.org api4.telegram.org' | sudo tee -a /etc/hosts"
    return 0
  fi
  sudo sed -i '/api\.telegram\.org/d' /etc/hosts 2>/dev/null || true
  sudo sed -i '/api4\.telegram\.org/d' /etc/hosts 2>/dev/null || true
  echo '149.154.166.110 api.telegram.org api4.telegram.org' | sudo tee -a /etc/hosts >/dev/null
  ok "Telegram hosts pin updated"
}

build_admin_if_needed() {
  if [[ "$MODE" == "dry-run" ]]; then
    echo "DRY-RUN: docker compose up -d --build when admin repo changed"
    return 0
  fi
  if [[ "$CHANGED_ADMIN" -eq 1 ]]; then
    run docker compose -f "$ADMIN_DIR/docker-compose.yml" up -d --build
  fi
}

restart_changed() {
  local reason="${1:-apply}"
  if [[ "$MODE" == "dry-run" ]]; then
    echo "DRY-RUN: restart $PM2_PROCESS only if code/state changed"
    echo "DRY-RUN: restart openclaw gateway if state changed"
    return 0
  fi
  load_api_token
  local pm2_bin=""
  pm2_bin="$(find_pm2 || true)"
  if [[ "$CHANGED_API" -eq 1 || "$CHANGED_STATE" -eq 1 || "$reason" == "rollback" ]]; then
    if [[ -n "$pm2_bin" ]]; then
      "$pm2_bin" restart "$PM2_PROCESS"
      ok "$PM2_PROCESS restarted"
      wait_for_api || true
    else
      warn "pm2 not found; API restart skipped"
    fi
  else
    ok "API restart skipped; no API/state change"
  fi
  if [[ -n "${API_TOKEN:-}" && ( "$CHANGED_STATE" -eq 1 || "$CHANGED_API" -eq 1 || "$reason" == "rollback" ) ]]; then
    curl -fsS -X POST "$API_URL/api/gateway/restart" -H "Authorization: Bearer $API_TOKEN" >/dev/null \
      && ok "Gateway restarted" \
      || warn "Gateway restart request failed"
  fi
}

main_apply() {
  preflight
  backup_state
  update_repo "$API_DIR" "openclaw-api"
  update_repo "$ADMIN_DIR" "openclaw-admin"
  configure_mcp
  rotate_openrouter_key
  fix_telegram_hosts
  build_admin_if_needed
  restart_changed "apply"
  log "Post-check health"
  if health_check; then
    ok "Health check passed"
  else
    err "Health check reported critical failures"
    echo "Rollback command:"
    echo "  bash $API_DIR/scripts/update-server.sh --rollback $BACKUP_ID"
    exit 3
  fi
  ok "Update complete. backup-id=$BACKUP_ID"
}

case "$MODE" in
  dry-run)
    preflight
    backup_state
    update_repo "$API_DIR" "openclaw-api"
    update_repo "$ADMIN_DIR" "openclaw-admin"
    configure_mcp
    rotate_openrouter_key
    fix_telegram_hosts
    restart_changed "dry-run"
    ok "Dry run complete; no files changed"
    ;;
  apply)
    main_apply
    ;;
  health-only)
    health_check
    ;;
  rollback)
    restore_backup "$ROLLBACK_ID"
    health_check || warn "Health still reports failures after rollback"
    ;;
esac
