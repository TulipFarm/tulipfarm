#!/usr/bin/env bash
# Smoke test for the OCI installer (scripts/install.sh) — the real AC-001 path,
# exercised hermetically: build the app image locally as :ci, run the installer against
# this repo (TF_LOCAL_SRC) into a throwaway dir on a throwaway port, and assert /health.
#
# Mirrors the Compose parity workflow: no GHCR pull of the not-yet-published app image,
# only the bundled postgres base is pulled. Used both locally and by the Installer smoke workflow.
#
# Env:
#   SMOKE_REBUILD=1   force `docker build` even if ghcr.io/tulipfarm/tulipfarm:ci already exists
#   TF_PORT=<port>    host port to bind (default 8099, off the usual 8080 to dodge clashes)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE="ghcr.io/tulipfarm/tulipfarm:ci"
PORT="${TF_PORT:-8099}"
INSTALL_DIR="$(mktemp -d)"
LLM_MOCK_PID=""

# Isolate the smoke's compose project + named volumes from any real `tulipfarm` install
# on this host, so teardown's `down -v` can never wipe real data. Both COMPOSE_PROJECT_NAME
# and `-p` override the compose file's top-level `name: tulipfarm`; exporting it scopes the
# installer's `compose up` AND this harness's `compose down -v` to a throwaway project.
export COMPOSE_PROJECT_NAME="tulipfarm-smoke-$$"

log() { printf '\033[0;36m[smoke]\033[0m %s\n' "$*"; }
fail() { printf '\033[0;31m[smoke] FAIL:\033[0m %s\n' "$*" >&2; exit 1; }

cleanup() {
  if [ -n "$LLM_MOCK_PID" ]; then kill "$LLM_MOCK_PID" >/dev/null 2>&1 || true; fi
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
grep -qx "managed-by=tulipfarm-installer" "${INSTALL_DIR}/.tulipfarm-install" \
  || fail "installer ownership marker was not written"
grep -qx "compose-project=${COMPOSE_PROJECT_NAME}" "${INSTALL_DIR}/.tulipfarm-install" \
  || fail "installer marker did not record the Compose project"

# 3. Re-assert /health on the host port (the installer already gates on this).
log "asserting /health on :${PORT}…"
curl -fsS --retry 5 --retry-connrefused --retry-delay 2 \
  "http://localhost:${PORT}/health" >/dev/null \
  || fail "/health did not return 200 on :${PORT}"

# 4. Assert idempotency: a second run preserves the generated .env (update mode).
env_before="$(sha256sum "${INSTALL_DIR}/.env" | awk '{print $1}')"
secrets_before="$(grep -E '^(POSTGRES_PASSWORD|ENCRYPTION_KEY|JWT_SECRET|WEBHOOK_SIGNING_SECRET)=' \
  "${INSTALL_DIR}/.env")"
log "re-running installer (idempotency check)…"
TF_LOCAL_SRC="$REPO_ROOT" TF_VERSION="ci" TF_RUNTIME="docker" \
TF_INSTALL_DIR="$INSTALL_DIR" TF_PORT="$PORT" \
  bash "${REPO_ROOT}/scripts/install.sh" >/dev/null 2>&1 \
  || fail "installer re-run exited non-zero"
env_after="$(sha256sum "${INSTALL_DIR}/.env" | awk '{print $1}')"
[ "$env_before" = "$env_after" ] || fail "re-run mutated .env (secrets not preserved)"

# 5. A deliberate port override updates runtime settings without rotating secrets.
UPDATED_PORT=$((PORT + 1))
log "moving existing install to port ${UPDATED_PORT}…"
TF_LOCAL_SRC="$REPO_ROOT" TF_VERSION="ci" TF_RUNTIME="docker" \
TF_INSTALL_DIR="$INSTALL_DIR" TF_PORT="$UPDATED_PORT" \
  bash "${REPO_ROOT}/scripts/install.sh" >/dev/null 2>&1 \
  || fail "installer port override exited non-zero"
grep -qx "HOST_PORT=${UPDATED_PORT}" "${INSTALL_DIR}/.env" \
  || fail "port override did not update HOST_PORT"
[ "$secrets_before" = \
  "$(grep -E '^(POSTGRES_PASSWORD|ENCRYPTION_KEY|JWT_SECRET|WEBHOOK_SIGNING_SECRET)=' \
    "${INSTALL_DIR}/.env")" ] \
  || fail "port override changed generated secrets"
curl -fsS --retry 5 --retry-connrefused --retry-delay 2 \
  "http://localhost:${UPDATED_PORT}/health" >/dev/null \
  || fail "/health did not move to :${UPDATED_PORT}"

# 6. Drive the shipped SPA in a real browser at the installer's own PUBLIC_URL.
#    /health only proves the API process is alive — it never loads the bundle. This step is the
#    only thing in CI that executes the shipped JS, and it must use PUBLIC_URL verbatim: it is a
#    LAN IP (⇒ a NON-secure context, where secure-context-only APIs vanish) and CORS_ORIGIN is
#    pinned to it, so any other origin would be rejected before the app could boot.
if [ "${SMOKE_SKIP_BROWSER:-0}" = "1" ]; then
  log "skipping browser smoke (SMOKE_SKIP_BROWSER=1)"
else
  public_url="$(grep -E '^PUBLIC_URL=' "${INSTALL_DIR}/.env" | head -1 | cut -d= -f2-)"
  [ -n "$public_url" ] || fail "could not read PUBLIC_URL from ${INSTALL_DIR}/.env"

  # Locally the installer may fall back to localhost (a secure context by spec carve-out), which
  # would silently make the run cover less than it claims. In CI a LAN IP is always detected, so
  # demand it there rather than accept a weaker pass.
  require_insecure=""
  if [ "${CI:-}" = "true" ]; then
    require_insecure="--require-insecure"
  fi

  # Agentic E2E turns use a local OpenAI-compatible server. No provider credentials or external
  # LLM network is permitted in this harness; the app still performs the real tool dispatch.
  mock_port="${E2E_LLM_PORT:-4899}"
  node "${REPO_ROOT}/scripts/test/mock-llm.mjs" >/tmp/tulipfarm-e2e-llm.log 2>&1 &
  LLM_MOCK_PID=$!
  sleep 1
  mock_host="$(printf '%s' "$public_url" | sed -E 's#^https?://([^:/]+).*$#\1#')"
  export E2E_LLM_BASE_URL="http://${mock_host}:${mock_port}/v1"

  log "running browser smoke against ${public_url}…"
  node "${REPO_ROOT}/scripts/test/browser-smoke.mjs" "$public_url" $require_insecure \
    || fail "browser smoke failed against ${public_url}"
fi

log "PASS — stack healthy, re-runs preserved secrets, host port changed cleanly, SPA boots"
