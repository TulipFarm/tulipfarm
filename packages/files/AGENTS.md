# @tulipfarm/files

The File entity: what may be uploaded, what an Agent may write, what its bytes really are, and who
may read them.

## Read on / Skip

Read this for upload limits, the type allowlist, magic-byte sniffing, filename normalisation, image
bounding, the `files` table, rendering an Agent-authored document, which Files a Turn may send to a
model, how an Agent reads one back, or who else may read or destroy a File. Skip it for Chat routes
(`apps/api/src/files`), the blob substrate (`packages/storage/src/ports/blob.ts`), or Run outputs —
an **Artifact** is a different entity, in `packages/storage`.

## Map

| Path | Owns |
| --- | --- |
| `src/limits.ts` | Byte/count caps, type allowlist, textual split, read caps, `BUSINESS_PRINCIPAL_ID` |
| `src/sniff.ts` · `src/filename.ts` | Magic-byte `resolveMediaType`; safe-to-store filenames |
| `src/dimensions.ts` · `src/bound.ts` | Header-only pixel size; `boundImage` refuse-or-downscale |
| `src/extract.ts` | The one answer to "what is the text of this File". Lazy-loads the PDF parser. |
| `src/office-preview.ts` · `src/delimited-preview.ts` | Reading OOXML and separated-value files back into `PreviewBlock`s for the viewer |
| `src/render.ts` | Markdown → PDF, safe structured-text validation/serialization, pass-through formats, and render bounds |
| `src/turn-attachments.ts` | Which Files a Turn may send, and the two-gate read of their bytes |
| `src/tools.ts` | `file_list` / `file_read` / `file_create` — the whole Agent-facing surface |
| `src/repo.ts` | Stable Files, nested folders, immutable versions, lifecycle CAS, durable blob cleanup, shares |
| `src/audience.ts` | Who may read a File an Agent just wrote: the requester, plus the Agent's Roles |
| `src/service.ts` | Upload/generate/replace, archive/restore/delete, authorized reads and sharing |
| `src/http.ts` | `FILE_WIRE_SCHEMA`, `serializeFile`, refusal statuses, download headers |

## Rules

- **Extraction must not consume its caller's bytes.** The same `Uint8Array` is screened here and
  then attached to a model request, and pdf.js takes ownership of any array it is handed, leaving
  the caller a detached, zero-length buffer. `extractPdf` copies before parsing for exactly this
  reason. Any future parser added to `extract.ts` gets the same treatment.

- `extract.ts` is the only place that decides what a File's text is. `file_read` and Knowledge
  indexing both go through it, because a passage shown in chat that search cannot find looks like
  a bug from neither side. Images are refused there on purpose, not by omission. A Chat attachment
  is a third caller: for every type a provider will not take as a binary part, the text this
  returns *is* how the File reaches the model, so anything on the upload allowlist that yields no
  text here cannot be asked about at all.

- **Office text is read with the viewer's parser.** `extractOffice` calls `previewOffice`, so a
  `.docx` says the same thing to a model as it shows a person, and it inherits that module's
  zip-bomb bounds. Keep `isExtractableMediaType` in step with what `extract.ts` actually handles —
  the browser reads it to decide whether to offer "add to knowledge".

- **A CSV is a grid, not text.** `delimited-preview.ts` parses separated values into the same
  `PreviewBlock` table `.xlsx` produces, so both render through one path. Showing a CSV as raw text
  is a regression, not a simplification.

- **Uploading never indexes.** Putting a File into Knowledge is a separate, owner-only act, because
  attaching a document to one Chat and publishing it to every Agent's retrieval are different
  decisions. `readers()` answers the reader set that indexing must carry; this package knows
  nothing else about Knowledge, and may not import it — `apps/api/src/files/knowledge-bridge.ts`
  is the only thing that sees both. `knowledge_requested_at` is the durable half of that opt-in:
  indexing runs on a queue, so a Page's existence cannot answer "is this wanted" during the window
  before the worker writes one. Set it before enqueueing and clear it before removing a Page.

- **Upload order is load-bearing**: authorize → reject on declared length → stream → sniff → reject
  → bound → write the row. Reordering costs a storage write per rejected upload, or admits a
  half-uploaded row. Images are bounded here, not at prompt assembly, so stored bytes are the bytes
  the model got; default refuses, `soul.yaml` `files.downscaleImages` opts into jimp (no WebP).
- **A File row is stable and its content lives in immutable File Versions.** Version 1 lands in the
  same statement as the File and becomes `current_version_id`; storage is content-addressed, so ask
  `anyReferencesBlob` across every version before deleting an object. Replacement is same-format
  and compare-and-swap on `revision`; restoring old content appends a version that reuses its blob.
- **Archived Files remain readable by current readers but are absent from lists, search and new
  attachments.** They are otherwise read-only. Archive/restore and permanent deletion are
  owner-only compare-and-swap mutations; deletion requires Archived and queues every version blob
  in `file_blob_cleanup`. Cleanup is leased, retried with backoff, and rechecks all version
  references before deleting content-addressed bytes.
- **Folders organize; they do not authorize.** Each folder belongs to one Principal, may have one
  parent owned by that same Principal, and a File has at most one `folder_id`. Moving a File changes
  only its location and revision. File shares remain the complete access answer until folder
  permission inheritance is designed separately.
- **`generate` renders before it writes and shares last**, so a refusal costs no compensating
  delete. It does not sniff — this process authored the bytes. `render.ts` takes Markdown, never
  HTML, uses no headless browser, and is bounded four ways (input chars, output bytes, pages,
  deadline) because pagination turns finite input into unbounded output. It runs in `apps/worker`,
  never the API: model-authored content is untrusted input.
- **Chat generation creates a 24-hour draft; Routine generation creates a File.** The distinction
  comes only from server-supplied `routineContext`. Drafts are private to the requester and become
  Files only through the authenticated Save File route. Expiry moves unsaved blobs onto the same
  durable cleanup queue as deleted versions.
- **Generation is idempotent on `(Run, Tool call)`.** A retry returns the same draft or File and
  may only re-apply idempotent audience shares. The Tool schema cannot supply either identity.
- **A generated File is owned by `BUSINESS_PRINCIPAL_ID`; the caller only gets a share**, so a
  Routine's report outlives the offboarding of whoever scheduled it. The Tool schema cannot name an
  owner, and a ratchet keeps it that way.
- **A generated File is also shared with every Role the authoring Agent holds** (`audience.ts`).
  An HR Agent's report readable only by whoever triggered the Run is one the rest of HR has to ask
  for by hand, and the asking is the part that does not happen. The Roles come from the Agent's own
  Principal — `rolesOf`, the same port and the same live answer used for a person — so the audience
  widens only where an admin deliberately assigned one, never where an Agent asked: the Tool schema
  cannot name an audience either. An Agent holding no Role behaves exactly as it did before. The
  audience is resolved *before* the blob and the row, so a failed Role lookup costs no compensating
  delete and can never strand a File nobody may read.
- **`FileService.read` is the only read gate**, `presentFor` its batched form. Absent means
  destroyed *or* unshared — telling those apart is the existence oracle the identical 404 denies.
  Sharing is not an `AuthorityLayer`. A Role share resolves on every read via the `rolesOf` port,
  whose one implementation is `collectHeldRoleIds`; absent means no Role sharing, never all Roles.
  Team ownership is projected through the optional `FileOwnershipPort` into this same gate; exact
  owner-Team admins reach the existing edit/owner paths, and membership is resolved live.
  Listings, search and share counts carry that same Team answer, but ask it the other way round —
  which Files a Principal's Teams reach, and which of a page's Files they do not — because there is
  no index from a Principal to its Teams. Those three answers are `FileOwnershipPort`'s
  `teamReadableFileIds`, `teamGrantCounts` and `unreadableAmong`, all decided in
  `AssetOwnershipAccessService` (`packages/authz`) so this package never grows a second Team
  evaluator that could disagree with the gate.
- **Only an owner may share or delete, and no Tool may do either** (`readAsOwner`, plus
  `apps/api/src/tools/contract-coverage.test.ts`). An Agent reads attachments from untrusted
  sources, so either Tool is one a crafted PDF can aim. `sharedWithCount` is absent, never `0`, for
  a File the caller does not own.
- **The Agent surface is `file_list`, `file_read` and `file_create`. Reads are bound to the
  caller's `principalId`, never the Agent's** — an Agent reads attachments from untrusted sources,
  so a File the person could not open stays closed however the Agent asks. `FileToolContext.agentId`
  is the deliberate asymmetry beside that rule and not an exception to it: it is read only when the
  Agent *writes*, to widen who may read bytes the Agent itself just authored, and it widens no read.
  A text File returns capped characters; anything else is re-attached to the Turn by the loop,
  because a Tool result is JSON with no binary channel.
- **A Turn's attachment rule has one home**, `turn-attachments.ts`. Scoping by `turnId` stops a File
  being re-sent every later Turn; `file_read` makes that a saving rather than forgetting, so neither
  may be removed without the other.
- **Paging is keyset on `(created_at, id)`, never OFFSET.** `created_at` is `timestamptz(3)` because
  a cursor carries a JS `Date`, and precision it cannot express silently skips rows at a boundary.
- Serve the sniffed type, never the claimed one, and inline only for images. The allowlist is an
  allowlist — no blocklist branch beside it, and SVG stays out.
- **`sourceConversationId` is the *first* Chat a File was sent in**, not the latest; the wire calls
  it `sourceChatId`, the one place that rename happens. `sourceRunId` is its generated-File twin —
  set from `FileToolContext.runId`, always null for an upload, and deliberately not a foreign key so
  a retention sweep over Runs cannot take a File's provenance with it.
- **`isImageMediaType` in `limits.ts` is the shared first step**, not a shared answer: bounding,
  inline rendering and extraction each keep their own predicate, because they diverge past that
  test.
