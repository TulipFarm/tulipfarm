#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: DATABASE_URL=... SOUL_PATH=... BLOB_PATH=... KEY_METADATA_PATH=... $0 <archive-dir>"
}

if [[ $# -ne 1 ]]; then
  usage
  exit 2
fi

ARCHIVE_DIR="$1"
if [[ -e "$ARCHIVE_DIR" ]]; then
  echo "Refusing to overwrite existing archive: $ARCHIVE_DIR" >&2
  exit 2
fi

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${SOUL_PATH:?SOUL_PATH is required}"
: "${BLOB_PATH:?BLOB_PATH is required}"
: "${KEY_METADATA_PATH:?KEY_METADATA_PATH is required}"

for command_name in pg_dump git tar; do
  command -v "$command_name" >/dev/null || {
    echo "Missing required command: $command_name" >&2
    exit 2
  }
done

for source_path in "$SOUL_PATH" "$BLOB_PATH" "$KEY_METADATA_PATH"; do
  [[ -e "$source_path" ]] || {
    echo "Backup source does not exist: $source_path" >&2
    exit 2
  }
done

mkdir -p "$ARCHIVE_DIR"
pg_dump --format=custom --file="$ARCHIVE_DIR/postgres.dump" "$DATABASE_URL"
git -C "$SOUL_PATH" bundle create "$ARCHIVE_DIR/soul.bundle" --all
tar -czf "$ARCHIVE_DIR/blob.tar.gz" -C "$BLOB_PATH" .

if [[ -d "$KEY_METADATA_PATH" ]]; then
  tar -czf "$ARCHIVE_DIR/key-metadata.tar.gz" -C "$KEY_METADATA_PATH" .
else
  tar -czf "$ARCHIVE_DIR/key-metadata.tar.gz" -C "$(dirname "$KEY_METADATA_PATH")" \
    "$(basename "$KEY_METADATA_PATH")"
fi

if command -v sha256sum >/dev/null; then
  (cd "$ARCHIVE_DIR" && sha256sum postgres.dump soul.bundle blob.tar.gz key-metadata.tar.gz) \
    > "$ARCHIVE_DIR/SHA256SUMS"
else
  (cd "$ARCHIVE_DIR" && shasum -a 256 postgres.dump soul.bundle blob.tar.gz key-metadata.tar.gz) \
    > "$ARCHIVE_DIR/SHA256SUMS"
fi

SOUL_HEAD="$(git -C "$SOUL_PATH" rev-parse HEAD)"
CREATED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
cat > "$ARCHIVE_DIR/manifest.json" <<EOF
{
  "schemaVersion": 1,
  "createdAt": "$CREATED_AT",
  "components": ["postgres", "blob", "soul", "key_metadata"],
  "soulHead": "$SOUL_HEAD",
  "checksums": "SHA256SUMS"
}
EOF

echo "Backup created at $ARCHIVE_DIR"
