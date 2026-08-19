# @tulipfarm/files

The File entity: what may be uploaded, what its bytes really are, and who may read them.

## Read on / Skip

Read this for upload limits, the accepted-type allowlist, magic-byte sniffing, filename
normalisation, image bounding, the `files` table, the ordered upload pipeline, or which Files a
Turn may send to a model, or who else may read a File. Skip it for Chat routes
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
| `src/repo.ts` | `FileRecord`, `FileShare`, `PgFileRepo`, the table statements, the paging cursor |
| `src/service.ts` | The ordered upload pipeline, the authorized read, paging, sharing |
| `src/http.ts` | `FILE_WIRE_SCHEMA`, `serializeFile`, refusal statuses, download headers |

## Rules

- **The upload order is load-bearing**: authorize → reject on declared length → stream → sniff →
  reject → bound the image → write the row. Reordering it either costs a storage write per rejected
  upload or admits a half-uploaded row.
- **Images are bounded at upload, not at prompt assembly**, so the stored bytes are exactly the
  bytes the model got. Default is to refuse an oversized image; `soul.yaml` `files.downscaleImages`
  opts into jimp downscaling, which cannot encode WebP. Unreadable dimensions are accepted, not
  refused — the byte cap already bounds anything unparseable.
- **A Turn's attachment rule has one home**, `turn-attachments.ts`, holding both the Context
  manifest and the Worker's later byte fetch so they cannot drift. Scoping is by `turnId`, which is
  what stops a File being re-sent on every later Turn.
- **A row is written only after its bytes land.** There is no `pending` state and no soft delete.
- **Never derive a storage key from a filename.** The key is the content hash.
- **The allowlist is an allowlist.** Do not add a blocklist branch beside it. SVG stays out.
- **Storage is content-addressed**, so identical bytes share one object. Ask `anyReferencesBlob`
  before deleting any object.
- **Paging is keyset on `(created_at, id)`, never OFFSET** — an upload mid-paging would shift rows.
  `created_at` is `timestamptz(3)` because a cursor carries a JS `Date`, and precision the cursor
  cannot express silently skips rows at a page boundary.
- **`sourceConversationId` is the *first* Chat a File was sent in**, not the latest; and the wire
  calls it `sourceChatId`, which is the one place that rename happens.
- Serve the sniffed type, never the claimed one, and inline only for images.
- **`FileService.read` is the only read gate.** Sharing is not an `AuthorityLayer`: layers are
  consumed only by `authorizeToolIntent`, and a File read never passes the Tool gate.
- **A Role share resolves on every read, never expanded at share time** — expansion goes stale in
  the direction that matters, leaving a File readable to someone the Role no longer contains.
- **`rolesOf` is a port with one implementation**, `collectHeldRoleIds` in `@tulipfarm/tool-host`.
  Never write a second answer to it. An absent port means no Role sharing, never all Roles.
- **Only an owner may share**, so every mutating share path goes through `readAsOwner`, not `read`.
  `sharedWithCount` is absent, never `0`, for a File the caller does not own.
- **No Tool can share a File**, enforced by `apps/api/src/tools/contract-coverage.test.ts`: an
  Agent reads attachments from untrusted sources, so a sharing Tool is one a crafted PDF can aim.
