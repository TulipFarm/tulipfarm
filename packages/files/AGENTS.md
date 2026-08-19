# @tulipfarm/files

The File entity: what may be uploaded, what its bytes really are, and who may read them.

## Read on / Skip

Read this for upload limits, the accepted-type allowlist, magic-byte sniffing, filename
normalisation, image bounding, the `files` table, the ordered upload pipeline, or which Files a
Turn may send to a model. Skip it for Chat routes
(`apps/api/src/files`), the blob substrate (`packages/storage/src/ports/blob.ts`), or Run outputs —
an **Artifact** is a Run output and is a different entity that lives in `packages/storage`.

## Map

| Path | Owns |
| --- | --- |
| `src/limits.ts` | `MAX_FILE_BYTES`, `MAX_FILES_PER_MESSAGE`, the type allowlist, inline-render rule |
| `src/sniff.ts` | Magic-byte signatures and `resolveMediaType` — the only type worth serving |
| `src/filename.ts` | Turning a client filename into something safe to store and to echo |
| `src/dimensions.ts` | Header-only pixel size for PNG/GIF/JPEG/WebP — no decode |
| `src/bound.ts` | `boundImage` — the refuse-or-downscale policy and `DEFAULT_MAX_IMAGE_DIMENSION` |
| `src/turn-attachments.ts` | Which Files a Turn may send, and the two-gate read of their bytes |
| `src/repo.ts` | `FileRecord`, `FileRepo`, `PgFileRepo`, the table statements, the paging cursor |
| `src/service.ts` | The ordered upload pipeline, the authorized read, `listPage`, `noteSentIn` |
| `src/http.ts` | `FILE_WIRE_SCHEMA`, `serializeFile`, refusal statuses, download headers |

## Rules

- **The upload order is load-bearing**: authorize → reject on declared length → stream → sniff →
  reject → bound the image → write the row. Reordering it either costs a storage write per rejected
  upload or admits a half-uploaded row.
- **Images are bounded at upload, not at prompt assembly.** The person who chose the file is
  present here and absent there, and the stored bytes are then exactly the bytes the model gets —
  so what is served back can never diverge from what was analysed. Default is to refuse an
  oversized image; `soul.yaml` `files.downscaleImages` opts a business into jimp downscaling
  instead. jimp cannot encode WebP, so only PNG and JPEG downscale.
- **Unreadable dimensions are accepted, not refused.** A valid JPEG can hide its frame header
  behind large EXIF, and the byte cap already bounds anything unparseable.
- **A Turn's attachment rule has one home.** The Context manifest and the Worker's later byte fetch
  must agree about which Files a Turn attached; `turn-attachments.ts` holds both so they cannot
  drift. Scoping is by `turnId`, which is what stops a File being re-sent on every later Turn.
- **A row is written only after its bytes land.** There is no `pending` state and no soft delete.
- **Never derive a storage key from a filename.** The key is the content hash; the filename is
  display only.
- **The allowlist is an allowlist.** Do not add a blocklist branch beside it. SVG stays out.
- **Storage is content-addressed**, so identical bytes share one object. Ask
  `anyReferencesBlob` before deleting any object.
- **Paging is keyset on `(created_at, id)`, never OFFSET** — an upload mid-paging would shift rows.
  `created_at` is `timestamptz(3)` because a cursor carries a JS `Date`, and precision the cursor
  cannot express silently skips rows at a page boundary.
- **`sourceConversationId` is the *first* Chat a File was sent in**, not the latest; and the wire
  calls it `sourceChatId`, which is the one place that rename happens.
- Serve the sniffed type, never the claimed one, and inline only for images.
