#!/usr/bin/env bash
# TulipFarm bootstrap secret generator — any deployment lane (compose, App Service,
# Cloud Run, k8s, bare host).
#
#   ./scripts/generate-secrets.sh              # print to terminal
#   ./scripts/generate-secrets.sh >> .env      # append to an env file
#
# Prints the generatable required secrets (ENCRYPTION_KEY, JWT_SECRET,
# WEBHOOK_SIGNING_SECRET — 32-byte base64, validated at boot by apps/api/src/env.ts)
# plus a POSTGRES_PASSWORD, and comments documenting the remaining required
# variables that depend on your environment. Stdout is pure env-file content;
# warnings go to stderr.
set -euo pipefail

die()  { printf '\033[0;31m✗\033[0m %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"; }

gen_secret() { openssl rand -base64 32; }
# URL-safe (no /+= so it embeds in DATABASE_URL without escaping).
gen_pw()     { openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 32; }

need openssl

enc="$(gen_secret)"; jwt="$(gen_secret)"; webhook="$(gen_secret)"; pw="$(gen_pw)"

cat <<EOF
# TulipFarm bootstrap secrets — generated $(date -u +%Y-%m-%dT%H:%M:%SZ)
ENCRYPTION_KEY=${enc}
JWT_SECRET=${jwt}
WEBHOOK_SIGNING_SECRET=${webhook}
POSTGRES_PASSWORD=${pw}

# Also required at boot (set for your environment — not generatable):
# DATABASE_URL=postgresql://tulipfarm:${pw}@<host>:5432/tulipfarm
# SOUL_PATH=/opt/tulipfarm/soul   # already set in the container image
EOF

printf '\033[0;33m⚠\033[0m  Keep a copy of ENCRYPTION_KEY somewhere safe — if it is lost, stored secrets are unrecoverable.\n' >&2
