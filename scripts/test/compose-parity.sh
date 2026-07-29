#!/usr/bin/env bash
# End-to-end parity test for the bundled production Compose stack.
#
# The harness runs in a throwaway directory and Compose project so it is safe to
# execute on a development machine with an existing TulipFarm installation.
#
# Env:
#   PARITY_REBUILD=1  force a local image build even when the :ci image exists
#   TF_PORT=<port>    host port to bind (default: 8098)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE="ghcr.io/tulipfarm/tulipfarm:ci"
PORT="${TF_PORT:-8098}"
TEST_DIR="$(mktemp -d)"

export COMPOSE_PROJECT_NAME="tulipfarm-parity-$$"
export HOST_PORT="$PORT"
export TULIPFARM_VERSION="ci"

log() { printf '\033[0;36m[parity]\033[0m %s\n' "$*"; }
fail() { printf '\033[0;31m[parity] FAIL:\033[0m %s\n' "$*" >&2; exit 1; }
compose() { (cd "$TEST_DIR" && docker compose "$@"); }

cleanup() {
  local status=$?
  if [ -f "${TEST_DIR}/docker-compose.yml" ]; then
    if [ "$status" -ne 0 ]; then
      log "capturing stack logs after failure…"
      compose logs --no-color || true
    fi
    log "tearing down stack…"
    compose down -v >/dev/null 2>&1 || true
  fi
  rm -rf "$TEST_DIR"
  return "$status"
}
trap cleanup EXIT

command -v docker >/dev/null 2>&1 || fail "docker not on PATH"
command -v curl >/dev/null 2>&1 || fail "curl not on PATH"
command -v openssl >/dev/null 2>&1 || fail "openssl not on PATH"
docker compose version >/dev/null 2>&1 || fail "docker compose v2 plugin required"

cp "${REPO_ROOT}/docker-compose.yml" "${TEST_DIR}/docker-compose.yml"

if [ "${PARITY_REBUILD:-0}" = "1" ] || ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  log "building ${IMAGE} (can take a few minutes)…"
  docker build -t "$IMAGE" "$REPO_ROOT"
else
  log "reusing existing ${IMAGE} (PARITY_REBUILD=1 to force a rebuild)"
fi

# Prevent ambient developer or runner variables from weakening the zero-env phase.
unset COMPOSE_FILE COMPOSE_PROFILES CORS_ORIGIN DATABASE_URL ENCRYPTION_KEY
unset JWT_SECRET POSTGRES_PASSWORD PUBLIC_URL SETUP_MODE WEBHOOK_SIGNING_SECRET

log "booting with no .env…"
test ! -f "${TEST_DIR}/.env"
compose up -d --wait --wait-timeout 180 --pull missing

log "asserting /readyz and /livez on :${PORT}…"
curl -fsS --retry 5 --retry-connrefused --retry-delay 3 \
  "http://localhost:${PORT}/readyz" >/dev/null
curl -fsS "http://localhost:${PORT}/livez" >/dev/null

# The worker publishes no port — reach its probes from inside its own container. The `--wait`
# above already gated on its healthcheck; asserting it here names the failure when the worker is
# the thing that did not come up.
log "asserting the worker booted and reports ready…"
[ "$(compose ps -q worker | wc -l)" -eq 1 ] || fail "the worker service is not running"
compose exec -T worker node -e \
  "fetch('http://localhost:4020/readyz').then(async r=>{console.log(await r.text());process.exit(r.ok?0:1)})" \
  || fail "the worker did not report ready"

log "asserting generated secrets survive a restart…"
secrets_before="$(compose exec -T app cat /data/secrets.env)"
grep -q '^ENCRYPTION_KEY=' <<<"$secrets_before"
compose down
compose up -d --wait --wait-timeout 180 --pull missing
secrets_after="$(compose exec -T app cat /data/secrets.env)"
[ "$secrets_before" = "$secrets_after" ] || fail "secrets.env changed across restart"

log "asserting key-loss guard refuses to orphan encrypted secrets…"
compose down
docker volume rm "${COMPOSE_PROJECT_NAME}_tulipfarm-data" >/dev/null
if compose up -d --wait --wait-timeout 90 --pull missing; then
  fail "app booted with a regenerated ENCRYPTION_KEY over existing wrapped DEKs"
fi
compose logs --no-color app | grep -q "already holds encrypted secrets" \
  || fail "app did not report the encrypted-secret key-loss guard"
compose down -v

log "booting with installer-style configured secrets…"
cat >"${TEST_DIR}/.env" <<EOF
POSTGRES_PASSWORD=ci-postgres-pw
ENCRYPTION_KEY=$(openssl rand -base64 32)
JWT_SECRET=$(openssl rand -base64 32)
WEBHOOK_SIGNING_SECRET=$(openssl rand -base64 32)
HOST_PORT=${PORT}
SETUP_MODE=wizard
EOF
compose up -d --wait --wait-timeout 180 --pull missing

log "asserting /health and environment-supplied secret behavior…"
curl -fsS --retry 5 --retry-connrefused --retry-delay 3 \
  "http://localhost:${PORT}/health" >/dev/null
compose exec -T app sh -c '! test -f /data/secrets.env' \
  || fail "configured boot wrote /data/secrets.env"

log "PASS — zero-env, key-loss guard, and configured stack all passed"
