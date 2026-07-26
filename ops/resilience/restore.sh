#!/usr/bin/env bash
set -euo pipefail

# Execute only with: --confirm "RESTORE"
usage() {
  echo "Usage: TARGET_DATABASE_URL=... $0 <archive-dir> <target-soul> <target-blob> <target-key-metadata> [--execute --confirm \"RESTORE\"]"
}

if [[ $# -lt 4 ]]; then
  usage
  exit 2
fi

ARCHIVE_DIR="$1"
TARGET_SOUL="$2"
TARGET_BLOB="$3"
TARGET_KEY_METADATA="$4"
shift 4

EXECUTE=false
CONFIRM=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --execute)
      EXECUTE=true
      shift
      ;;
    --confirm)
      CONFIRM="${2:-}"
      shift 2
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

for archive_file in postgres.dump soul.bundle blob.tar.gz key-metadata.tar.gz SHA256SUMS manifest.json; do
  [[ -f "$ARCHIVE_DIR/$archive_file" ]] || {
    echo "Archive is incomplete: missing $archive_file" >&2
    exit 2
  }
done

if command -v sha256sum >/dev/null; then
  (cd "$ARCHIVE_DIR" && sha256sum --check SHA256SUMS)
else
  (cd "$ARCHIVE_DIR" && shasum -a 256 --check SHA256SUMS)
fi
git bundle verify "$ARCHIVE_DIR/soul.bundle"

if ! $EXECUTE; then
  echo "Restore preflight passed. Re-run with --execute --confirm \"RESTORE\"."
  exit 0
fi

if [[ "$CONFIRM" != "RESTORE" ]]; then
  echo "Restore requires the exact confirmation: --confirm \"RESTORE\"" >&2
  exit 2
fi

: "${TARGET_DATABASE_URL:?TARGET_DATABASE_URL is required for an executing restore}"
for target_path in "$TARGET_SOUL" "$TARGET_BLOB" "$TARGET_KEY_METADATA"; do
  [[ ! -e "$target_path" ]] || {
    echo "Refusing to overwrite existing restore target: $target_path" >&2
    exit 2
  }
done

pg_restore --clean --if-exists --no-owner --dbname="$TARGET_DATABASE_URL" \
  "$ARCHIVE_DIR/postgres.dump"
git clone "$ARCHIVE_DIR/soul.bundle" "$TARGET_SOUL"
mkdir -p "$TARGET_BLOB" "$TARGET_KEY_METADATA"
tar -xzf "$ARCHIVE_DIR/blob.tar.gz" -C "$TARGET_BLOB"
tar -xzf "$ARCHIVE_DIR/key-metadata.tar.gz" -C "$TARGET_KEY_METADATA"

echo "Restore completed. Run the recovery evidence and denied-access smoke checks before cutover."
