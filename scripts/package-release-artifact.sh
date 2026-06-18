#!/usr/bin/env bash
# Build an OpenClaw customer-server release artifact without copying secrets.
#
# Usage:
#   bash scripts/package-release-artifact.sh
#   bash scripts/package-release-artifact.sh --runtime-dist-dir /path/to/openclaw/dist --output /tmp/openclaw-release.tgz
#   bash scripts/package-release-artifact.sh --no-runtime

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_DIR="$ROOT_DIR"
ADMIN_DIR="${ADMIN_DIR:-$(cd "$ROOT_DIR/../openclaw-admin" 2>/dev/null && pwd || true)}"
RUNTIME_DIST_DIR="${RUNTIME_DIST_DIR:-$(cd "$ROOT_DIR/../openclaw/dist" 2>/dev/null && pwd || true)}"
BUILD_ID="$(date -u +%Y%m%dT%H%M%SZ)"
OUTPUT="${OUTPUT:-/tmp/openclaw-release-$BUILD_ID.tgz}"
STAGE_DIR="${STAGE_DIR:-/tmp/openclaw-release-$BUILD_ID}"
INCLUDE_RUNTIME=1
KEEP_STAGE=0

log() { printf '[INFO] %s\n' "$*"; }
ok() { printf '[OK]   %s\n' "$*"; }
warn() { printf '[WARN] %s\n' "$*" >&2; }
err() { printf '[ERR]  %s\n' "$*" >&2; }

usage() {
  sed -n '1,10p' "$0"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --api-dir) API_DIR="$(cd "${2:-}" && pwd)"; shift 2 ;;
    --admin-dir) ADMIN_DIR="$(cd "${2:-}" && pwd)"; shift 2 ;;
    --runtime-dist-dir) RUNTIME_DIST_DIR="$(cd "${2:-}" && pwd)"; shift 2 ;;
    --output) OUTPUT="${2:-}"; shift 2 ;;
    --stage-dir) STAGE_DIR="${2:-}"; shift 2 ;;
    --no-runtime) INCLUDE_RUNTIME=0; shift ;;
    --keep-stage) KEEP_STAGE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) err "Unknown option: $1"; usage; exit 2 ;;
  esac
done

require_dir() {
  local label="$1"
  local dir="$2"
  [[ -n "$dir" && -d "$dir" ]] || { err "$label directory not found: ${dir:-<empty>}"; exit 1; }
}

require_cmd() {
  command -v "$1" >/dev/null || { err "$1 not found"; exit 1; }
}

require_cmd git
require_cmd node
require_cmd rsync
require_cmd tar
require_dir "openclaw-api" "$API_DIR"
require_dir "openclaw-admin" "$ADMIN_DIR"

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

runtime_require_glob() {
  local label="$1"
  local pattern="$2"
  if ! find "$RUNTIME_DIST_DIR" -maxdepth 1 -type f -name "$pattern" | grep -q .; then
    err "No $label runtime file found in $RUNTIME_DIST_DIR (pattern: $pattern)"
    err "Build openclaw runtime first, pass --runtime-dist-dir, or use --no-runtime for API/Admin-only releases."
    exit 1
  fi
}

if [[ "$INCLUDE_RUNTIME" -eq 1 ]]; then
  require_dir "runtime dist" "$RUNTIME_DIST_DIR"
  runtime_require_glob "CLI entry" "index.js"
  runtime_require_glob "agent runner" "agent-runner.runtime*.js"
  runtime_require_glob "Telegram/send path" "send*.js"
  runtime_require_glob "delivery path" "delivery*.js"
fi

rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR/openclaw-api" "$STAGE_DIR/openclaw-admin"

COMMON_EXCLUDES=(
  --exclude .git
  --exclude .github
  --exclude .claude
  --exclude node_modules
  --exclude '.env'
  --exclude '.env.*'
  --exclude '*.log'
  --exclude '*.tsbuildinfo'
  --exclude '.DS_Store'
  --exclude '._*'
  --exclude '.graphifyignore'
  --exclude graphify-out
  --exclude MCP-SML-QUICKREF.md
)

log "Copying openclaw-api source"
rsync -a "${COMMON_EXCLUDES[@]}" \
  --exclude backups \
  "$API_DIR"/ "$STAGE_DIR/openclaw-api"/

log "Copying openclaw-admin source"
rsync -a "${COMMON_EXCLUDES[@]}" \
  --exclude .next \
  "$ADMIN_DIR"/ "$STAGE_DIR/openclaw-admin"/

if [[ "$INCLUDE_RUNTIME" -eq 1 ]]; then
  log "Copying runtime dist files"
  mkdir -p "$STAGE_DIR/openclaw-dist"
  rsync -a "$RUNTIME_DIST_DIR"/ "$STAGE_DIR/openclaw-dist"/
fi

log "Running syntax checks on artifact"
while IFS= read -r -d '' file; do
  node --check "$file"
done < <(find "$STAGE_DIR/openclaw-api/routes" "$STAGE_DIR/openclaw-api/lib" -maxdepth 2 -type f -name '*.js' -print0)
bash -n "$STAGE_DIR/openclaw-api/scripts/update-server.sh"
if [[ "$INCLUDE_RUNTIME" -eq 1 ]]; then
  while IFS= read -r file; do
    node --check "$file"
  done < <(runtime_check_files "$STAGE_DIR/openclaw-dist")
fi

log "Writing release manifest"
node - "$STAGE_DIR" "$API_DIR" "$ADMIN_DIR" "${RUNTIME_DIST_DIR:-}" "$BUILD_ID" <<'NODE'
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execFileSync } = require('child_process')

const [stageDir, apiDir, adminDir, runtimeDistDir, buildId] = process.argv.slice(2)

function sha(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function git(cwd, args) {
  try { return execFileSync('git', args, { cwd, timeout: 2000 }).toString().trim() } catch { return null }
}

function packageRelevantStatus(status) {
  const ignoredPathPrefixes = ['.github/', '.claude/', 'graphify-out/']
  const ignoredExactPaths = new Set(['.graphifyignore', 'MCP-SML-QUICKREF.md'])
  return status.filter(line => {
    const file = line.replace(/^[ MARCUD?!]{1,2}\s+/, '')
    if (ignoredExactPaths.has(file)) return false
    return !ignoredPathPrefixes.some(prefix => file === prefix.slice(0, -1) || file.startsWith(prefix))
  })
}

function repo(cwd) {
  const status = (git(cwd, ['status', '--porcelain']) || '').split('\n').filter(Boolean).slice(0, 80)
  const artifactRelevantStatus = packageRelevantStatus(status)
  return {
    path: cwd,
    branch: git(cwd, ['branch', '--show-current']),
    head: git(cwd, ['rev-parse', 'HEAD']),
    dirty: Boolean(artifactRelevantStatus.length),
    status: artifactRelevantStatus,
    ignoredWorkspaceStatus: status.filter(line => !artifactRelevantStatus.includes(line)),
  }
}

function walk(dir, base = dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full, base))
    else if (entry.isFile()) out.push(path.relative(base, full))
  }
  return out
}

const files = walk(stageDir)
  .filter(rel => rel !== 'release-manifest.json')
  .sort()
  .map(rel => {
    const file = path.join(stageDir, rel)
    const stat = fs.statSync(file)
    return { path: rel, bytes: stat.size, sha256: sha(file) }
  })

const runtimeFiles = files.filter(f => f.path.startsWith('openclaw-dist/'))

const manifest = {
  schemaVersion: 1,
  buildId,
  generatedAt: new Date().toISOString(),
  generatedBy: process.env.USER || process.env.LOGNAME || null,
  host: require('os').hostname(),
  inputs: {
    openclawApi: repo(apiDir),
    openclawAdmin: repo(adminDir),
    runtimeDistDir: runtimeDistDir || null,
  },
  runtime: {
    included: runtimeFiles.length > 0,
    files: runtimeFiles,
  },
  files,
}

fs.writeFileSync(path.join(stageDir, 'release-manifest.json'), JSON.stringify(manifest, null, 2))
NODE

mkdir -p "$(dirname "$OUTPUT")"
TAR_ARGS=(-czf "$OUTPUT" -C "$STAGE_DIR" .)
tar_supports_option() {
  local option="$1"
  local tmp_dir
  tmp_dir="$(mktemp -d)"
  printf 'ok\n' > "$tmp_dir/probe.txt"
  if tar "$option" -czf "$tmp_dir/probe.tgz" -C "$tmp_dir" probe.txt >/dev/null 2>&1; then
    rm -rf "$tmp_dir"
    return 0
  fi
  rm -rf "$tmp_dir"
  return 1
}

for option in --disable-copyfile --no-mac-metadata --no-xattrs --no-acls --no-fflags; do
  if tar_supports_option "$option"; then
    TAR_ARGS=("$option" "${TAR_ARGS[@]}")
  fi
done

log "Packing $OUTPUT"
COPYFILE_DISABLE=1 tar "${TAR_ARGS[@]}"

if command -v shasum >/dev/null 2>&1; then
  SHA="$(shasum -a 256 "$OUTPUT" | awk '{print $1}')"
else
  SHA="$(sha256sum "$OUTPUT" | awk '{print $1}')"
fi

ok "Artifact: $OUTPUT"
ok "SHA256: $SHA"
ok "Deploy dry-run: bash scripts/update-server.sh --dry-run --artifact $OUTPUT"
ok "Deploy apply:   bash scripts/update-server.sh --apply --artifact $OUTPUT"

if [[ "$KEEP_STAGE" -eq 0 ]]; then
  rm -rf "$STAGE_DIR"
else
  ok "Stage kept: $STAGE_DIR"
fi
