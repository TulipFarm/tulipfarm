#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 <archive-dir> [--execute --confirm \"DRILL\"]"
}

if [[ $# -lt 1 ]]; then
  usage
  exit 2
fi

ARCHIVE_DIR="$1"
shift

if [[ $# -eq 0 ]]; then
  "$(dirname "$0")/restore.sh" "$ARCHIVE_DIR" /tmp/tulipfarm-drill-soul \
    /tmp/tulipfarm-drill-blob /tmp/tulipfarm-drill-key-metadata
  echo "Dry drill passed archive integrity and Soul bundle checks."
  exit 0
fi

if [[ "${1:-}" != "--execute" || "${2:-}" != "--confirm" || "${3:-}" != "DRILL" ]]; then
  usage
  exit 2
fi

: "${DRILL_DATABASE_URL:?DRILL_DATABASE_URL must name an isolated, disposable database}"
DRILL_DIR="$(mktemp -d "${TMPDIR:-/tmp}/tulipfarm-restore-drill.XXXXXX")"
cleanup() {
  rm -rf "$DRILL_DIR"
}
trap cleanup EXIT

TARGET_DATABASE_URL="$DRILL_DATABASE_URL" "$(dirname "$0")/restore.sh" "$ARCHIVE_DIR" \
  "$DRILL_DIR/soul" "$DRILL_DIR/blob" "$DRILL_DIR/key-metadata" \
  --execute --confirm "RESTORE"

echo "Executing recovery drill restored all components into isolated targets."
