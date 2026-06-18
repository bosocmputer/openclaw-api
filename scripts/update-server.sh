#!/usr/bin/env bash
# OpenClaw production updater.
#
# Usage:
#   bash scripts/update-server.sh --dry-run
#   bash scripts/update-server.sh --apply --artifact /path/to/artifact
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
detect_runtime_dist_dir() {
  local npm_root=""
  if command -v npm >/dev/null 2>&1; then
    npm_root="$(npm root -g 2>/dev/null || true)"
  fi
  for candidate in \
    "$npm_root/openclaw/dist" \
    "$HOME/.npm-global/lib/node_modules/openclaw/dist" \
    /usr/lib/node_modules/openclaw/dist \
    /usr/local/lib/node_modules/openclaw/dist \
    /opt/openclaw/lib/node_modules/openclaw/dist; do
    [[ -n "$candidate" && -d "$candidate" ]] && { echo "$candidate"; return 0; }
  done
  return 1
}
RUNTIME_DIST_DIR="${RUNTIME_DIST_DIR:-$(detect_runtime_dist_dir || true)}"
DEPLOY_METADATA="$STATE_DIR/deploy-metadata.json"
DEFAULT_MCP_URL="http://192.168.2.248:3515/sse"

MODE="dry-run"
MCP_URL="$DEFAULT_MCP_URL"
ARTIFACT_PATH=""
OPENROUTER_KEY="${OPENROUTER_KEY:-}"
ROLLBACK_ID=""
BACKUP_ID="$(date +%Y%m%d%H%M%S)"
BACKUP_ROOT="$STATE_DIR/backups/openclaw-update-$BACKUP_ID"
ARTIFACT_RESOLVED_DIR=""
CHANGED_RUNTIME=0
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
    --artifact) ARTIFACT_PATH="${2:-}"; shift 2 ;;
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
  for candidate in "$HOME/.npm-global/lib/node_modules/pm2/bin/pm2" /usr/local/lib/node_modules/pm2/bin/pm2; do
    if [[ -x "$candidate" ]]; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}

sudo_available() {
  sudo -n true >/dev/null 2>&1 || [[ -n "${SUDO_PASSWORD:-}" ]]
}

run_sudo() {
  if sudo -n true >/dev/null 2>&1; then
    sudo "$@"
  elif [[ -n "${SUDO_PASSWORD:-}" ]]; then
    printf '%s\n' "$SUDO_PASSWORD" | sudo -S "$@"
  else
    return 1
  fi
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
  [[ -z "$ARTIFACT_PATH" || -e "$ARTIFACT_PATH" ]] || { err "Artifact not found: $ARTIFACT_PATH"; exit 1; }
  if [[ -n "$ARTIFACT_PATH" ]]; then
    command -v rsync >/dev/null || { err "rsync not found"; exit 1; }
    [[ ! -f "$ARTIFACT_PATH" ]] || command -v tar >/dev/null || { err "tar not found"; exit 1; }
    if [[ -z "$RUNTIME_DIST_DIR" ]]; then
      warn "Runtime dist was not auto-detected; set RUNTIME_DIST_DIR if artifact contains openclaw-dist"
    fi
    if [[ -d "$RUNTIME_DIST_DIR" && ! -w "$RUNTIME_DIST_DIR" ]]; then
      sudo_available \
        && ok "sudo available for runtime dist writes" \
        || warn "Runtime dist is not writable and sudo is unavailable; artifact runtime deploy will stop if openclaw-dist is included"
    fi
  fi
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
  run mkdir -p "$BACKUP_ROOT/files" "$BACKUP_ROOT/runtime-dist"
  if [[ "$MODE" == "dry-run" ]]; then return 0; fi

  cp "$CONFIG_PATH" "$BACKUP_ROOT/openclaw.json"
  [[ -f "$DEPLOY_METADATA" ]] && cp "$DEPLOY_METADATA" "$BACKUP_ROOT/deploy-metadata.json" || true
  if [[ -d "$RUNTIME_DIST_DIR" ]]; then
    find "$RUNTIME_DIST_DIR" -maxdepth 1 -type f \( -name '*.js' -o -name '*.map' -o -name '*.json' \) -print0 \
      | xargs -0 -r cp -t "$BACKUP_ROOT/runtime-dist"
  fi
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
  if [[ -f "$root/deploy-metadata.json" ]]; then cp "$root/deploy-metadata.json" "$DEPLOY_METADATA"; fi
  if [[ -d "$root/runtime-dist" && -d "$RUNTIME_DIST_DIR" ]]; then
    copy_runtime_glob_from_dir "$root/runtime-dist"
    CHANGED_RUNTIME=1
  fi
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

checksum_file() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  else
    shasum -a 256 "$file" | awk '{print $1}'
  fi
}

runtime_check_files() {
  local dir="$1"
  find "$dir" -maxdepth 1 -type f \( \
    -name 'index.js' -o \
    -name 'agent-runner.runtime*.js' -o \
    -name 'send*.js' -o \
    -name 'delivery*.js' -o \
    -name 'bot*.js' -o \
    -name 'openclaw-tools*.js' \
  \) | sort
}

copy_runtime_file() {
  local src="$1"
  local dest="$RUNTIME_DIST_DIR/$(basename "$src")"
  if [[ -w "$RUNTIME_DIST_DIR" ]]; then
    cp "$src" "$dest"
  elif sudo_available; then
    run_sudo cp "$src" "$dest"
    run_sudo chmod 0644 "$dest" || true
  else
    err "Cannot write runtime dist: $RUNTIME_DIST_DIR. Re-run with passwordless sudo, set SUDO_PASSWORD, or deploy runtime manually."
    exit 1
  fi
}

copy_runtime_glob_from_dir() {
  local src_dir="$1"
  if [[ -w "$RUNTIME_DIST_DIR" ]]; then
    rsync -a "$src_dir"/ "$RUNTIME_DIST_DIR"/
    return 0
  fi
  if sudo_available; then
    run_sudo rsync -a "$src_dir"/ "$RUNTIME_DIST_DIR"/
    run_sudo find "$RUNTIME_DIST_DIR" -type f -exec chmod 0644 {} + || true
    run_sudo find "$RUNTIME_DIST_DIR" -type d -exec chmod 0755 {} + || true
    return 0
  fi
  find "$src_dir" -type f -print0 | while IFS= read -r -d '' file; do
    local rel="${file#$src_dir/}"
    local dest="$RUNTIME_DIST_DIR/$rel"
    mkdir -p "$(dirname "$dest")"
    cp "$file" "$dest"
  done
}

write_deploy_metadata() {
  if [[ "$MODE" == "dry-run" ]]; then
    echo "DRY-RUN: write deploy metadata to $DEPLOY_METADATA"
    return 0
  fi
  node - "$DEPLOY_METADATA" "$BACKUP_ID" "$ARTIFACT_PATH" "$ARTIFACT_RESOLVED_DIR" "$CONFIG_PATH" "$RUNTIME_DIST_DIR" <<'NODE'
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const [metadataPath, backupId, artifactPath, artifactResolvedDir, configPath, distDir] = process.argv.slice(2)
function sha(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') } catch { return null }
}
function readArtifactManifest() {
  const candidates = []
  if (artifactResolvedDir) candidates.push(path.join(artifactResolvedDir, 'release-manifest.json'))
  if (artifactPath) {
    try {
      if (fs.existsSync(artifactPath) && fs.statSync(artifactPath).isDirectory()) {
        candidates.push(path.join(artifactPath, 'release-manifest.json'))
      }
    } catch {}
  }
  for (const file of candidates) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
  }
  return null
}
const distFiles = {}
  let names = []
  try {
    names = fs.readdirSync(distDir)
      .filter(name =>
        name === 'index.js' ||
        /^agent-runner\.runtime.*\.js$/.test(name) ||
        /^send.*\.js$/.test(name) ||
        /^delivery.*\.js$/.test(name) ||
        /^bot.*\.js$/.test(name) ||
        /^openclaw-tools.*\.js$/.test(name)
      )
      .sort()
  } catch {}
  for (const name of names) {
    const file = path.join(distDir, name)
    const hash = sha(file)
    if (hash) distFiles[name] = { sha256: hash }
  }
const metadata = {
  generatedAt: new Date().toISOString(),
  backupId,
  artifactPath: artifactPath || null,
  artifact: readArtifactManifest(),
  config: { sha256: sha(configPath) },
  distFiles,
}
fs.mkdirSync(require('path').dirname(metadataPath), { recursive: true })
fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), { mode: 0o600 })
NODE
  ok "Deploy metadata written: $DEPLOY_METADATA"
}

deploy_artifact() {
  [[ -n "$ARTIFACT_PATH" ]] || return 0
  log "Applying artifact $ARTIFACT_PATH"
  if [[ "$MODE" == "dry-run" ]]; then
    echo "DRY-RUN: copy artifact runtime/API/Admin files and run remote syntax checks"
    return 0
  fi

  local artifact_dir="$ARTIFACT_PATH"
  local tmp_dir=""
  if [[ -f "$ARTIFACT_PATH" ]]; then
    tmp_dir="$STATE_DIR/tmp-artifact-$BACKUP_ID"
    rm -rf "$tmp_dir"
    mkdir -p "$tmp_dir"
    tar -xf "$ARTIFACT_PATH" -C "$tmp_dir"
    artifact_dir="$tmp_dir"
  fi
  ARTIFACT_RESOLVED_DIR="$artifact_dir"

  if [[ -d "$artifact_dir/openclaw-dist" ]]; then
    [[ -n "$RUNTIME_DIST_DIR" && -d "$RUNTIME_DIST_DIR" ]] || { err "Runtime dist not found. Set RUNTIME_DIST_DIR=/path/to/openclaw/dist"; exit 1; }
    copy_runtime_glob_from_dir "$artifact_dir/openclaw-dist"
    runtime_check_files "$artifact_dir/openclaw-dist" | while IFS= read -r file; do
      node --check "$RUNTIME_DIST_DIR/$(basename "$file")"
    done
    CHANGED_RUNTIME=1
  fi
  if [[ -d "$artifact_dir/openclaw-api" ]]; then
    rsync -a --exclude node_modules --exclude .git "$artifact_dir/openclaw-api"/ "$API_DIR"/
    find "$API_DIR/routes" "$API_DIR/lib" -maxdepth 2 -type f -name '*.js' -print0 | while IFS= read -r -d '' file; do
      node --check "$file"
    done
    CHANGED_API=1
  fi
  if [[ -d "$artifact_dir/openclaw-admin" ]]; then
    rsync -a --exclude node_modules --exclude .git --exclude .next "$artifact_dir/openclaw-admin"/ "$ADMIN_DIR"/
    CHANGED_ADMIN=1
  fi
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
  if ! sudo_available; then
    warn "sudo without password is not available; run manually:"
    echo "  sudo sed -i '/api\\.telegram\\.org/d' /etc/hosts"
    echo "  echo '149.154.166.110 api.telegram.org api4.telegram.org' | sudo tee -a /etc/hosts"
    return 0
  fi
  run_sudo sed -i '/api\.telegram\.org/d' /etc/hosts 2>/dev/null || true
  run_sudo sed -i '/api4\.telegram\.org/d' /etc/hosts 2>/dev/null || true
  echo '149.154.166.110 api.telegram.org api4.telegram.org' | run_sudo tee -a /etc/hosts >/dev/null
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
    echo "DRY-RUN: restart openclaw gateway if runtime/API/state changed"
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
  if [[ "$CHANGED_RUNTIME" -eq 1 ]]; then
    systemctl --user restart openclaw-gateway.service \
      && ok "Gateway service restarted" \
      || warn "systemctl gateway restart failed"
  elif [[ -n "${API_TOKEN:-}" && ( "$CHANGED_STATE" -eq 1 || "$CHANGED_API" -eq 1 || "$reason" == "rollback" ) ]]; then
    curl -fsS -X POST "$API_URL/api/gateway/restart" -H "Authorization: Bearer $API_TOKEN" >/dev/null \
      && ok "Gateway restarted" \
      || warn "Gateway restart request failed"
  fi
}

main_apply() {
  preflight
  backup_state
  deploy_artifact
  if [[ -z "$ARTIFACT_PATH" ]]; then
    update_repo "$API_DIR" "openclaw-api"
    update_repo "$ADMIN_DIR" "openclaw-admin"
  else
    ok "Git pull skipped; artifact is the deploy source for this run"
  fi
  configure_mcp
  rotate_openrouter_key
  fix_telegram_hosts
  build_admin_if_needed
  restart_changed "apply"
  write_deploy_metadata
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
    deploy_artifact
    if [[ -z "$ARTIFACT_PATH" ]]; then
      update_repo "$API_DIR" "openclaw-api"
      update_repo "$ADMIN_DIR" "openclaw-admin"
    else
      ok "Git pull skipped; artifact is the deploy source for this run"
    fi
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
