#!/bin/bash
set -euo pipefail

# TulipFarm local dev RESET — the counterpart to setup-dev.sh.
#
# Wipes local runtime state so you can start completely fresh:
#   • the Postgres database (all users, secrets, encryption keys, chats, jobs)
#   • the auto-minted worker/integration-worker credentials (~/.tulipfarm/data)
#   • the soul repo (~/.tulipfarm/soul)
#   • .env.local (+ the apps/api and apps/worker symlinks)
#
# This is DESTRUCTIVE and cannot be undone. It does NOT remove the bundled Postgres
# container or its image — only the project's own data.
#
# Usage:
#   scripts/reset-dev.sh             # interactive: confirm, then full reset
#   scripts/reset-dev.sh -y          # skip the confirmation prompt
#   scripts/reset-dev.sh --db-only   # reset ONLY the database (keep soul + .env.local)
#   scripts/reset-dev.sh --keep-env  # reset DB + soul, but keep .env.local (your keys)

usage() {
  sed -n '4,18p' "$0" | sed 's/^# \{0,1\}//'
}

ASSUME_YES=false
DB_ONLY=false
KEEP_ENV=false
for arg in "${@:-}"; do
  case "$arg" in
    -y | --yes) ASSUME_YES=true ;;
    --db-only) DB_ONLY=true ;;
    --keep-env) KEEP_ENV=true ;;
    -h | --help)
      usage
      exit 0
      ;;
    "") ;;
    *)
      echo "Unknown option: $arg"
      usage
      exit 1
      ;;
  esac
done

# Always operate from the repo root, regardless of where this is invoked from.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# Resolve the actual targets from .env.local when present; else use setup-dev.sh defaults.
read_env() { [ -f ".env.local" ] && grep -E "^$1=" ".env.local" | head -1 | cut -d= -f2- || true; }

DATABASE_URL="$(read_env DATABASE_URL)"
DB_NAME="$(basename "${DATABASE_URL%%\?*}")"
DB_NAME="${DB_NAME:-tulipfarm}"

# The database always lives in the bundled pgvector container (setup-dev.sh has no native lane).
COMPOSE_ARGS=(-f docker-compose.yml -f docker-compose.dev.yml)
DOCKER_CONTAINER=""
if command -v docker &>/dev/null && docker compose "${COMPOSE_ARGS[@]}" ps -q postgres 2>/dev/null | grep -q .; then
  DOCKER_CONTAINER="$(docker compose "${COMPOSE_ARGS[@]}" ps -q postgres)"
fi

SOUL_PATH="$(read_env SOUL_PATH)"
SOUL_PATH="${SOUL_PATH:-$HOME/.tulipfarm/soul}"
SOUL_PATH="${SOUL_PATH/#\~/$HOME}" # expand a leading ~ (dotenv stores it literally)

# Safety: never rm a dangerous path.
case "$SOUL_PATH" in
  "" | "/" | "$HOME" | "$HOME/") echo "❌ refusing to delete unsafe SOUL_PATH '$SOUL_PATH'"; exit 1 ;;
esac

echo "🧹 TulipFarm local reset — this will DELETE:"
echo "   • Postgres database: $DB_NAME  (users, secrets, encryption keys, chats, jobs — all gone)"
echo "   • Data dir:          $HOME/.tulipfarm/data  (auto-minted worker credentials)"
if ! $DB_ONLY; then
  echo "   • Soul repo:         $SOUL_PATH"
  $KEEP_ENV || echo "   • Env file:          $REPO_ROOT/.env.local  (+ app symlinks)"
fi
echo ""
echo "⚠ Stop the dev server first (Ctrl-C the 'pnpm dev' process)."
echo ""

if ! $ASSUME_YES; then
  read -r -p "Type 'reset' to confirm: " reply
  [ "$reply" = "reset" ] || {
    echo "Aborted."
    exit 1
  }
fi

# 1) Database — drop, then recreate empty so the next boot migrates from scratch.
if [ -n "$DOCKER_CONTAINER" ]; then
  echo "🗄  Dropping database '$DB_NAME' in the Docker container..."
  # Run inside the container over its local Unix socket (trust auth) as the tulipfarm superuser —
  # bare native dropdb/createdb can't authenticate against the container's password-auth TCP
  # listener without credentials, and silently no-op on failure, leaving stale data (and a stale
  # DEK wrap) behind while setup-dev.sh still writes a fresh ENCRYPTION_KEY.
  if docker exec -i "$DOCKER_CONTAINER" psql -U tulipfarm -d postgres \
      -c "DROP DATABASE IF EXISTS \"$DB_NAME\" WITH (FORCE);" &>/dev/null \
    && docker exec -i "$DOCKER_CONTAINER" psql -U tulipfarm -d postgres \
      -c "CREATE DATABASE \"$DB_NAME\" OWNER tulipfarm;" &>/dev/null; then
    echo "✅ Recreated empty database '$DB_NAME'"
  else
    echo "   (could not reset database in container — is it healthy? \`docker ps\`)"
  fi
else
  echo "⚠ Bundled Postgres container is not running — start it, then re-run:"
  echo "    docker compose ${COMPOSE_ARGS[*]} up -d postgres"
fi

# 1b) Data dir — worker/integration-worker credentials the API auto-mints on first boot
# (apps/api/src/setup/worker-credential.ts) and persists here for local dev
# (TF_DATA_DIR, set by setup-dev.sh). These name API client rows in the database just dropped
# above, so leaving the files behind after ANY database reset (including --db-only) hands the next
# `pnpm dev` a credential that reads back as "present" but no longer authenticates — the API
# re-mints a fresh one on its own next boot, but only after this stale file is gone.
DATA_DIR="$HOME/.tulipfarm/data"
if [ -d "$DATA_DIR" ]; then
  echo "🔑 Removing stale worker credentials at $DATA_DIR..."
  rm -rf "$DATA_DIR"
  echo "✅ Data dir removed"
fi

if $DB_ONLY; then
  echo ""
  echo "✨ Database reset. Start the app — a fresh admin is bootstrapped from .env.local:"
  echo "   pnpm dev"
  exit 0
fi

# 2) Soul repo
if [ -d "$SOUL_PATH" ]; then
  echo "📁 Removing soul repo at $SOUL_PATH..."
  rm -rf "$SOUL_PATH"
  echo "✅ Soul repo removed"
fi

# 3) .env.local + app symlinks (+ any web env override)
if ! $KEEP_ENV; then
  [ -f "$REPO_ROOT/.env.local" ] && rm -f "$REPO_ROOT/.env.local" && echo "✅ Removed .env.local"
  [ -L "apps/api/.env.local" ] && rm -f "apps/api/.env.local" && echo "✅ Removed apps/api/.env.local symlink"
  [ -L "apps/worker/.env.local" ] && rm -f "apps/worker/.env.local" && echo "✅ Removed apps/worker/.env.local symlink"
  [ -f "apps/web/.env.local" ] && rm -f "apps/web/.env.local" && echo "✅ Removed apps/web/.env.local"
fi

echo ""
echo "✨ Reset complete. Start fresh:"
$KEEP_ENV || echo "   scripts/setup-dev.sh   # recreates DB, soul repo, and .env.local with new keys"
echo "   pnpm dev"
