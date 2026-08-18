# @tulipfarm/files

The File entity: what may be uploaded, what its bytes really are, and who may read them.

## Read on / Skip

Read this for upload limits, the accepted-type allowlist, magic-byte sniffing, filename
normalisation, the `files` table, or the ordered upload pipeline. Skip it for Chat routes
(`apps/api/src/files`), the blob substrate (`packages/storage/src/ports/blob.ts`), or Run outputs —
an **Artifact** is a Run output and is a different entity that lives in `packages/storage`.

## Map

| Path | Owns |
| --- | --- |
| `src/limits.ts` | `MAX_FILE_BYTES`, `MAX_FILES_PER_MESSAGE`, the type allowlist, inline-render rule |
| `src/sniff.ts` | Magic-byte signatures and `resolveMediaType` — the only type worth serving |
| `src/filename.ts` | Turning a client filename into something safe to store and to echo |
| `src/repo.ts` | `FileRecord`, `FileRepo`, `PgFileRepo`, `FILE_STORAGE_STATEMENTS` |
| `src/service.ts` | The ordered upload pipeline and the authorized read |

## Rules

- **The upload order is load-bearing**: authorize → reject on declared length → stream → sniff →
  reject → write the row. Reordering it either costs a storage write per rejected upload or admits
  a half-uploaded row.
- **A row is written only after its bytes land.** There is no `pending` state and no soft delete.
- **Never derive a storage key from a filename.** The key is the content hash; the filename is
  display only.
- **The allowlist is an allowlist.** Do not add a blocklist branch beside it. SVG stays out.
- **Storage is content-addressed**, so identical bytes share one object. Ask
  `anyReferencesBlob` before deleting any object.
- Serve the sniffed type, never the claimed one, and inline only for images.
