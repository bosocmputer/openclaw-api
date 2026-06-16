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

if [[ "$INCLUDE_RUNTIME" -eq 1 ]]; then
  require_dir "runtime dist" "$RUNTIME_DIST_DIR"
  find "$RUNTIME_DIST_DIR" -maxdepth 1 -type f -name 'bot-*.js' | grep -q . || {
    err "No bot-*.js runtime entry found in $RUNTIME_DIST_DIR"
    err "Build openclaw runtime first, pass --runtime-dist-dir, or use --no-runtime for API/Admin-only releases."
    exit 1
  }
  find "$RUNTIME_DIST_DIR" -maxdepth 1 -type f -name 'openclaw-tools-*.js' | grep -q . || {
    err "No openclaw-tools-*.js runtime entry found in $RUNTIME_DIST_DIR"
    err "Build openclaw runtime first, pass --runtime-dist-dir, or use --no-runtime for API/Admin-only releases."
    exit 1
  }
fi

rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR/openclaw-api" "$STAGE_DIR/openclaw-admin"

COMMON_EXCLUDES=(
  --exclude .git
  --exclude node_modules
  --exclude '.env'
  --exclude '.env.*'
  --exclude '*.log'
  --exclude '.DS_Store'
  --exclude '._*'
  --exclude graphify-out
)

log "Copying openclaw-api source"
rsync -a "${COMMON_EXCLUDES[@]}" \
  --exclude backups \
  "$API_DIR"/ "$STAGE_DIR/openclaw-api"/

log "Copying openclaw-admin source"
rsync -a "${COMMON_EXCLUDES[@]}" \
  --exclude .next \
  --exclude .claude \
  "$ADMIN_DIR"/ "$STAGE_DIR/openclaw-admin"/

if [[ "$INCLUDE_RUNTIME" -eq 1 ]]; then
  log "Copying runtime dist files"
  mkdir -p "$STAGE_DIR/openclaw-dist"
  rsync -a "$RUNTIME_DIST_DIR"/ "$STAGE_DIR/openclaw-dist"/
fi

log "Running syntax checks on artifact"
find "$STAGE_DIR/openclaw-api/routes" "$STAGE_DIR/openclaw-api/lib" -maxdepth 2 -type f -name '*.js' -print0 \
  | xargs -0 -r -n1 node --check
bash -n "$STAGE_DIR/openclaw-api/scripts/update-server.sh"
if [[ "$INCLUDE_RUNTIME" -eq 1 ]]; then
  find "$STAGE_DIR/openclaw-dist" -maxdepth 1 -type f \( -name 'bot-*.js' -o -name 'openclaw-tools-*.js' \) -print0 \
    | xargs -0 -r -n1 node --check
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

function repo(cwd) {
  return {
    path: cwd,
    branch: git(cwd, ['branch', '--show-current']),
    head: git(cwd, ['rev-parse', 'HEAD']),
    dirty: Boolean(git(cwd, ['status', '--porcelain'])),
    status: (git(cwd, ['status', '--porcelain']) || '').split('\n').filter(Boolean).slice(0, 80),
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
if tar --help 2>&1 | grep -q -- '--disable-copyfile'; then
  TAR_ARGS=(--disable-copyfile "${TAR_ARGS[@]}")
fi

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
