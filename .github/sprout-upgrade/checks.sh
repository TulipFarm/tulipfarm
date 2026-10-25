#!/usr/bin/env bash
# Runs the checks that gate a Sprout pull request and writes a Markdown table of
# the results to $1. Exits non-zero if any check fails.
set -uo pipefail

results=${1:?usage: checks.sh <results.md>}
printf '| Check | Result |\n| --- | --- |\n' > "$results"
status=0

check() {
  local name=$1
  shift
  echo "::group::$name"
  if "$@"; then
    echo "| \`$name\` | ✅ passed |" >> "$results"
  else
    echo "| \`$name\` | ❌ failed |" >> "$results"
    status=1
  fi
  echo "::endgroup::"
}

check 'pnpm install --frozen-lockfile' pnpm install --frozen-lockfile
check 'pnpm lint' pnpm lint
check 'turbo run typecheck build test --filter=@tulipfarm/web' \
  pnpm exec turbo run typecheck build test --filter=@tulipfarm/web

exit "$status"
