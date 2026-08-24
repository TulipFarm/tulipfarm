#!/bin/bash
set -uo pipefail

# Frees the ports `pnpm dev` binds, for when a previous run left a process behind.
#
#   4000  web
#   4010  api
#   4020  worker (also docs — `pnpm dev:docs` shares this port)
#   4030  integration-worker
#
# Usage:
#   scripts/kill-dev-ports.sh            # kill listeners on all dev ports
#   scripts/kill-dev-ports.sh 4000 4010  # kill listeners on specific ports only

PORTS=("$@")
if [ ${#PORTS[@]} -eq 0 ]; then
  PORTS=(4000 4010 4020 4030)
fi

# Every listener is resolved before anything is killed: the dev servers share a
# turbo parent, so killing one collapses the rest and a later lsof would miss them.
targets=()
for port in "${PORTS[@]}"; do
  pids=$(lsof -t -i:"${port}" -sTCP:LISTEN 2>/dev/null || true)
  if [ -z "${pids}" ]; then
    echo "port ${port}: free"
    continue
  fi
  for pid in ${pids}; do
    echo "port ${port}: listener ${pid} ($(ps -p "${pid}" -o comm= 2>/dev/null || echo '?'))"
    targets+=("${pid}")
  done
done

if [ ${#targets[@]} -eq 0 ]; then
  echo "done — nothing to kill"
  exit 0
fi

killed=0
for pid in "${targets[@]}"; do
  if ! kill -0 "${pid}" 2>/dev/null; then
    echo "  ${pid}: already gone"
    continue
  fi
  if kill -9 "${pid}" 2>/dev/null; then
    echo "  ${pid}: killed"
    killed=$((killed + 1))
  else
    echo "  ${pid}: could not kill" >&2
  fi
done

echo "done — ${killed} process(es) killed"
