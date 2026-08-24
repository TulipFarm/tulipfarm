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
BOOT_LABEL="parity"
# shellcheck source=scripts/test/lib/boot-harness.sh
. "${REPO_ROOT}/scripts/test/lib/boot-harness.sh"

IMAGE="ghcr.io/tulipfarm/tulipfarm:ci"
PORT="${TF_PORT:-8098}"

export COMPOSE_PROJECT_NAME="tulipfarm-parity-$$"
export HOST_PORT="$PORT"
export TULIPFARM_VERSION="ci"

compose() { (cd "$TEST_DIR" && docker compose "$@"); }

# The Compose-specific half the harness delegates: only tear down what was actually brought
# up, and reach for logs the same way.
boot_capture_logs() {
  [ -f "${TEST_DIR}/docker-compose.yml" ] || return 0
  log "capturing stack logs after failure…"
  compose logs --no-color
}
boot_teardown() {
  [ -f "${TEST_DIR}/docker-compose.yml" ] || return 0
  log "tearing down stack…"
  compose down -v >/dev/null 2>&1
}

boot_make_workspace
TEST_DIR="$BOOT_WORKDIR"
boot_install_cleanup_trap

require_command docker
require_command curl
require_command openssl
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
unset JWT_SECRET POSTGRES_PASSWORD PUBLIC_API_URL PUBLIC_URL SETUP_MODE WEBHOOK_SIGNING_SECRET
unset WORKER_API_CREDENTIAL

log "booting with no .env…"
test ! -f "${TEST_DIR}/.env"
compose up -d --wait --wait-timeout 180 --pull missing

log "asserting /readyz and /livez on :${PORT}…"
boot_wait_for_http "http://localhost:${PORT}/readyz"
boot_check_http "http://localhost:${PORT}/livez"

log "asserting the public API origin follows the published host port…"
[ "$(compose exec -T app printenv PUBLIC_API_URL)" = "http://localhost:${PORT}" ] \
  || fail "PUBLIC_API_URL did not follow HOST_PORT"

# The worker publishes no port — reach its probes from inside its own container. The `--wait`
# above already gated on its healthcheck; asserting it here names the failure when the worker is
# the thing that did not come up.
log "asserting the worker booted and reports ready…"
[ "$(compose ps -q worker | wc -l)" -eq 1 ] || fail "the worker service is not running"
compose exec -T worker node -e \
  "fetch('http://localhost:4020/readyz', { signal: AbortSignal.timeout(10000) }).then(async r=>{console.log(await r.text());process.exit(r.ok?0:1)})" \
  || fail "the worker did not report ready"

# A worker that boots but holds no credential answers nothing, and says so only at the first
# turn — so assert the handoff itself, not just that the process is up.
log "asserting the app minted the worker credential…"
compose exec -T app grep -q '^WORKER_API_CREDENTIAL=tfc_' /data/worker.env \
  || fail "app did not write a worker credential to /data/worker.env"

# The bundled bucket cannot generate its own credentials — its image has no shell — so a paste-and-
# run install only stores files if the app provisioned them. `--wait` already gated on the bucket's
# healthcheck; these assert the handoff the healthcheck cannot see.
log "asserting the app provisioned the bundled bucket…"
compose exec -T app grep -q '^S3_ACCESS_KEY_ID=GK' /data/bucket.env \
  || fail "app did not provision an access key into /data/bucket.env"
compose exec -T app grep -q '^S3_SECRET_ACCESS_KEY=.' /data/bucket.env \
  || fail "app wrote an access key with no secret"
compose exec -T bucket /garage bucket info tulipfarm | grep -q 'RWO' \
  || fail "the bucket exists but its access key holds no read/write/owner grant"

log "asserting the worker reads the bucket credentials back off the volume…"
compose exec -T worker grep -q '^S3_ACCESS_KEY_ID=GK' /data/bucket.env \
  || fail "worker cannot see the provisioned bucket credentials"

log "asserting generated secrets survive a restart…"
secrets_before="$(compose exec -T app cat /data/secrets.env)"
bucket_before="$(compose exec -T app cat /data/bucket.env)"
grep -q '^ENCRYPTION_KEY=' <<<"$secrets_before"
compose down
compose up -d --wait --wait-timeout 180 --pull missing
secrets_after="$(compose exec -T app cat /data/secrets.env)"
[ "$secrets_before" = "$secrets_after" ] || fail "secrets.env changed across restart"
# A second key would leave every file already stored unreachable by the running instance.
[ "$bucket_before" = "$(compose exec -T app cat /data/bucket.env)" ] \
  || fail "bucket.env was re-provisioned across restart"

log "asserting key-loss guard refuses to orphan encrypted secrets…"
compose down
docker volume rm "${COMPOSE_PROJECT_NAME}_tulipfarm-data" >/dev/null
if compose up -d --wait --wait-timeout 90 --pull missing; then
  fail "app booted with a regenerated ENCRYPTION_KEY over existing wrapped DEKs"
fi
key_loss_logs="$(compose logs --no-color app 2>&1 || true)"
grep -Fq "already holds encrypted secrets" <<<"$key_loss_logs" \
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
boot_wait_for_http "http://localhost:${PORT}/health"
compose exec -T app sh -c '! test -f /data/secrets.env' \
  || fail "configured boot wrote /data/secrets.env"

log "PASS — zero-env, key-loss guard, and configured stack all passed"
