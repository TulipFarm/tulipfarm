#!/usr/bin/env bash
# Guard against secure-context-only browser APIs in the web client.
#
# The prod SPA is served over plain http from a LAN IP, which browsers treat as a NON-secure
# context. The APIs below are `undefined` there, so touching one throws and takes the app down —
# a class of bug that is invisible to both local dev (localhost is a secure context by spec
# carve-out) and the jsdom test suite (always a secure context, never enforces CSP).
#
# Call the guarded helpers instead; they degrade to an equivalent that works on insecure origins.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# Overridable so the guard can be exercised against a fixture in its own test.
SCAN_DIR="${SECURE_CONTEXT_SCAN_DIR:-${REPO_ROOT}/apps/web/app}"

NO_FALLBACK='no fallback exists — reconsider the approach or require https'

# `pattern::advice`. Not `|`-separated: some patterns contain an alternation.
PATTERNS=(
  "crypto\\.randomUUID::use randomUUID() from ~/lib/uuid"
  "crypto\\.subtle::${NO_FALLBACK}"
  "navigator\\.clipboard::use copyText() from ~/lib/clipboard"
  "navigator\\.credentials::${NO_FALLBACK}"
  "navigator\\.mediaDevices::${NO_FALLBACK}"
  "navigator\\.geolocation::${NO_FALLBACK}"
  "navigator\\.serviceWorker::${NO_FALLBACK}"
  "navigator\\.storage::${NO_FALLBACK}"
  "navigator\\.locks::${NO_FALLBACK}"
  "navigator\\.wakeLock::${NO_FALLBACK}"
  "navigator\\.(bluetooth|usb|serial|hid)::${NO_FALLBACK}"
  "new Notification\\(::${NO_FALLBACK}"
)

# The helpers themselves must call the real API, and tests must be able to stub it.
is_exempt() {
  case "$1" in
    */app/lib/uuid.ts | */app/lib/clipboard.ts) return 0 ;;
    *.test.ts | *.test.tsx) return 0 ;;
    *) return 1 ;;
  esac
}

failed=0
for entry in "${PATTERNS[@]}"; do
  pattern="${entry%%::*}"
  advice="${entry##*::}"
  while IFS=: read -r file line _; do
    [ -n "$file" ] || continue
    is_exempt "$file" && continue
    if [ "$failed" -eq 0 ]; then
      printf '\033[0;31mSecure-context-only browser APIs found in apps/web:\033[0m\n\n'
    fi
    printf '  %s:%s\n    %s\n' "${file#"${REPO_ROOT}/"}" "$line" "$advice"
    failed=1
  done < <(grep -rnE "$pattern" "$SCAN_DIR" --include='*.ts' --include='*.tsx' || true)
done

if [ "$failed" -eq 1 ]; then
  printf '\nThese are undefined when the app is served over plain http from a LAN IP.\n'
  printf 'See apps/web/app/lib/uuid.ts and apps/web/app/lib/clipboard.ts for the pattern.\n'
  exit 1
fi

echo "[secure-context] ok — no unguarded secure-context-only APIs in apps/web"
