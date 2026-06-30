#!/usr/bin/env bash
# Dev-only helper for admin user management.
# NOT included in production images — for local troubleshooting only.
#
# Reads DATABASE_URL, POSTGRES_PASSWORD, COMPOSE_PROFILES, and ADMIN_PASSWORD
# from .env / .env.local at the repo root. CLI env vars take precedence.
#
# URI resolution rules:
#   1. DATABASE_URL set and hostname is not 'postgres' (Docker-internal) → use as-is
#   2. DATABASE_URL set but hostname is 'postgres' → replace host with localhost:5432
#   3. DATABASE_URL absent / hostname is 'postgres' + COMPOSE_PROFILES=bundled
#      + POSTGRES_PASSWORD → build postgresql://tulipfarm:<pw>@localhost:5432/tulipfarm
#   4. Otherwise → error
#
# Usage:
#   ./scripts/admin-user.sh get-email
#   ./scripts/admin-user.sh set-password        # uses ADMIN_PASSWORD from .env
#   ./scripts/admin-user.sh set-password <pw>   # uses the given password
set -euo pipefail

COMMAND="${1:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
ARGON2_MODULE="$ROOT/apps/api/node_modules/@node-rs/argon2"

# Source .env then .env.local (local overrides base), skipping comments and blank lines.
# Existing env vars (set before the script runs) are NOT overwritten.
load_env() {
  local file="$1"
  [[ -f "$file" ]] || return 0
  while IFS= read -r line; do
    # Skip comments and blank lines
    [[ "$line" =~ ^\s*# ]] && continue
    [[ -z "${line// }" ]] && continue
    # Only export if not already set in the environment
    local key="${line%%=*}"
    if [[ -z "${!key+x}" ]]; then
      export "$line" 2>/dev/null || true
    fi
  done < "$file"
}
load_env "$ROOT/.env"
load_env "$ROOT/.env.local"

# Resolve the database URL from the available env vars.
resolve_db_url() {
  local url="${DATABASE_URL:-}"
  local pw="${POSTGRES_PASSWORD:-}"
  local profiles="${COMPOSE_PROFILES:-}"

  # Substitute CHANGE_ME_POSTGRES placeholder if the real password is known.
  if [[ "$url" == *"CHANGE_ME_POSTGRES"* && -n "$pw" ]]; then
    url="${url//CHANGE_ME_POSTGRES/$pw}"
  fi

  # Docker-internal hostname 'postgres' is not reachable from the host — rewrite to localhost.
  if [[ "$url" == *"@postgres:"* ]]; then
    url="${url/@postgres:/@localhost:}"
  fi

  # If still no usable URL but we have enough pieces to build one, do it.
  if [[ -z "$url" ]] || [[ "$url" == *"CHANGE_ME"* ]]; then
    if [[ "$profiles" == *"bundled"* && -n "$pw" ]]; then
      url="postgresql://tulipfarm:${pw}@localhost:5432/tulipfarm"
    else
      echo "Error: cannot resolve DATABASE_URL." >&2
      echo "  Set DATABASE_URL directly, or ensure POSTGRES_PASSWORD + COMPOSE_PROFILES=bundled are in .env." >&2
      exit 1
    fi
  fi

  echo "$url"
}

DB_URL="$(resolve_db_url)"

case "$COMMAND" in
  get-email)
    psql "$DB_URL" --tuples-only --no-align \
      -c "SELECT email FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1"
    ;;

  set-password)
    PASSWORD="${2:-${ADMIN_PASSWORD:-}}"
    if [[ -z "$PASSWORD" ]]; then
      echo "Error: no password given and ADMIN_PASSWORD is not set in .env" >&2
      echo "Usage: $0 set-password <pw>" >&2
      exit 1
    fi
    # Hash with argon2id — same @node-rs/argon2 the API uses at runtime.
    HASH=$(node --input-type=module <<EOF
import { hash } from "$ARGON2_MODULE/index.js";
process.stdout.write(await hash(${PASSWORD@Q}));
EOF
)
    # argon2id hashes contain only [A-Za-z0-9$,./+=] — no single quotes — so
    # direct interpolation into a SQL string literal is safe.
    psql "$DB_URL" -c "UPDATE users SET password_hash = '$HASH' WHERE role = 'admin'"
    ;;

  *)
    echo "Commands:"
    echo "  get-email              Print the admin email address"
    echo "  set-password [pw]      Set the admin password (reads ADMIN_PASSWORD from .env if pw omitted)"
    exit 1
    ;;
esac
