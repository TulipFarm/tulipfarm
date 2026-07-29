#!/usr/bin/env bash
# Smoke test for the OCI installer (scripts/install.sh) — the real AC-001 path,
# exercised hermetically: build the app image locally as :ci, run the installer against
# this repo (TF_LOCAL_SRC) into a throwaway dir on a throwaway port, and assert /health.
#
# Mirrors ci.yml's compose-parity: no GHCR pull of the not-yet-published app image, only
# the bundled postgres base is pulled. Used both locally and by the CI `installer-smoke` job.
#
# Env:
#   SMOKE_REBUILD=1   force `docker build` even if ghcr.io/tulipfarm/tulipfarm:ci already exists
#   TF_PORT=<port>    host port to bind (default 8099, off the usual 8080 to dodge clashes)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE="ghcr.io/tulipfarm/tulipfarm:ci"
PORT="${TF_PORT:-8099}"
INSTALL_DIR="$(mktemp -d)"

# Isolate the smoke's compose project + named volumes from any real `tulipfarm` install
# on this host, so teardown's `down -v` can never wipe real data. Both COMPOSE_PROJECT_NAME
# and `-p` override the compose file's top-level `name: tulipfarm`; exporting it scopes the
# installer's `compose up` AND this harness's `compose down -v` to a throwaway project.
export COMPOSE_PROJECT_NAME="tulipfarm-smoke-$$"

log() { printf '\033[0;36m[smoke]\033[0m %s\n' "$*"; }
fail() { printf '\033[0;31m[smoke] FAIL:\033[0m %s\n' "$*" >&2; exit 1; }

cleanup() {
  if [ -f "${INSTALL_DIR}/docker-compose.yml" ]; then
    log "tearing down stack…"
    ( cd "$INSTALL_DIR" && docker compose down -v ) >/dev/null 2>&1 || true
  fi
  rm -rf "$INSTALL_DIR"
}
trap cleanup EXIT

# Fail fast (and meaningfully) before the slow image build when the script is absent.
[ -f "${REPO_ROOT}/scripts/install.sh" ] \
  || fail "scripts/install.sh not found — implement the installer (AW-002)"
command -v docker >/dev/null 2>&1 || fail "docker not on PATH"
docker compose version >/dev/null 2>&1 || fail "docker compose v2 plugin required"

# 1. Build the app image as :ci (reuse if already present, e.g. from compose-parity).
if [ "${SMOKE_REBUILD:-0}" = "1" ] || ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  log "building ${IMAGE} (can take a few minutes)…"
  docker build -t "$IMAGE" "$REPO_ROOT"
else
  log "reusing existing ${IMAGE} (SMOKE_REBUILD=1 to force a rebuild)"
fi

# 2. Run the installer hermetically: local source, pinned :ci image, temp dir + port.
#    User-writable INSTALL_DIR ⇒ the installer runs without sudo.
log "running installer into ${INSTALL_DIR} on port ${PORT}…"
TF_LOCAL_SRC="$REPO_ROOT" \
TF_VERSION="ci" \
TF_RUNTIME="docker" \
TF_INSTALL_DIR="$INSTALL_DIR" \
TF_PORT="$PORT" \
  bash "${REPO_ROOT}/scripts/install.sh" \
  || fail "installer exited non-zero"

# 3. Re-assert /health on the host port (the installer already gates on this).
log "asserting /health on :${PORT}…"
curl -fsS --retry 5 --retry-connrefused --retry-delay 2 \
  "http://localhost:${PORT}/health" >/dev/null \
  || fail "/health did not return 200 on :${PORT}"

# 4. Assert idempotency: a second run preserves the generated .env (update mode).
env_before="$(sha256sum "${INSTALL_DIR}/.env" | awk '{print $1}')"
log "re-running installer (idempotency check)…"
TF_LOCAL_SRC="$REPO_ROOT" TF_VERSION="ci" TF_RUNTIME="docker" \
TF_INSTALL_DIR="$INSTALL_DIR" TF_PORT="$PORT" \
  bash "${REPO_ROOT}/scripts/install.sh" >/dev/null 2>&1 \
  || fail "installer re-run exited non-zero"
env_after="$(sha256sum "${INSTALL_DIR}/.env" | awk '{print $1}')"
[ "$env_before" = "$env_after" ] || fail "re-run mutated .env (secrets not preserved)"

log "PASS — stack healthy and re-run preserved secrets"
