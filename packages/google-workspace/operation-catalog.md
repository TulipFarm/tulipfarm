# Bounded Google operation catalog

Inspected and implemented on 30 September 2026. This catalog is a curated subset,
not coverage of every Google endpoint or resource field.

## Public contract

`@tulipfarm/google-workspace/operation-contracts` exports:

- `googleOperationSchema`, a strict Zod discriminated union on `kind`.
- `GoogleOperation`, inferred from that schema.
- `googleOperationCatalog`, a frozen array with `kind`, `service`, `effect`,
  `approvalRequired`, and `requiredScopes`. Effects are `read` or `write`.
  Every write requires approval. The scope array lists the scopes this application
  requires, not all alternative Google scopes that could authorize the endpoint.
- `isGoogleWrite(operation: GoogleOperation): boolean`.
- `GoogleOperationError`, whose `code` and message contain a fixed error code.

`@tulipfarm/google-workspace/operation-provider` exports
`dispatchGoogleOperation({ operation, accessToken, signal?, fetcher? })`.
It returns a promise of a JSON-compatible value. The injected fetcher has the
native `fetch` signature and must honor its abort signal and redirect policy.

The provider does not enforce user ownership or approval. The durable execution
layer must enforce both before supplying an access token. Tokens are not fields
in any operation schema. The provider makes one request and never retries.

## Supported kinds

Each prefix below combines with each listed suffix.

| Prefix                       | Suffixes                                                                           |
| ---------------------------- | ---------------------------------------------------------------------------------- |
| `gmail.messages`             | `list`, `get`, `modify`, `trash`, `untrash`, `send`                                |
| `gmail.drafts`               | `list`, `get`, `create`, `update`, `delete`, `send`                                |
| `gmail.labels`               | `list`, `get`, `create`, `update`, `delete`                                        |
| `calendar.calendars`         | `list`, `get`, `create`, `update`, `delete`                                        |
| `calendar.events`            | `list`, `get`, `create`, `update`, `delete`                                        |
| `drive.files`                | `list`, `get`, `create`, `update`, `copy`, `trash`, `upload`, `download`, `export` |
| `drive.permissions`          | `list`, `get`, `create`, `update`, `delete`                                        |
| `sheets.spreadsheets`        | `get`, `create`, `batchUpdate`                                                     |
| `sheets.values`              | `get`, `update`, `append`, `clear`, `batchGet`, `batchUpdate`, `batchClear`        |
| `docs.documents`             | `create`, `get`, `batchUpdate`                                                     |
| `slides.presentations`       | `create`, `get`, `batchUpdate`                                                     |
| `slides.presentations.pages` | `get`                                                                              |

There are 58 kinds. `src/operation-contracts.ts` is the field-level contract.
`test/operation-provider.test.mjs` supplies an HTTP example for each kind and
checks that its examples cover the catalog exactly once.

Calendar list reads `calendarList`. Calendar and event updates use PATCH, but
require the typed calendar or event fields. Event notifications default to
`none`. Permission notifications default to false. Permission roles are limited
to reader, commenter, and writer. Ownership transfer is not supported.

Slides reads send a fixed `fields` projection. A full presentation repeats every
master and layout with complete styling, so even a new one-slide presentation can
exceed the 96,000-character model tool result. `presentations.get` returns the
identity, `revisionId`, page size, slide IDs, element IDs, geometry, placeholders,
and text runs with their indexes. Its `view: outline` returns the identity,
`revisionId`, and slide IDs only. `presentations.pages.get` returns one slide with
the same element projection and the presentation `revisionId`. Masters, layouts,
notes, and styling are not read in the compact views. Added 8 October 2026 for #392.

Existing-file read recovery, added 14 October 2026:

- Docs `documents.get` accepts `selection: {view: "outline"}` for flattened tab
  metadata and body/header/footer/footnote end indexes. Use
  `selection: {view: "range", tabId, segmentId?, range: {startIndex, endIndex}}`
  for an excerpt of at most 10,000 UTF-16 code units. Structural ancestors and
  text styles are retained; text-run indexes use the original document
  coordinates. Table row/cell arrays contain only overlapping fragments, not a
  complete table; use their document indexes, not their array positions, for
  edits.
- Slides `presentations.pages.get` accepts `detail: {}` for full page elements,
  including text styles and nested groups, without masters/layouts/notes.
  `detail: {elementId}` selects one element and its ancestor group transforms.
  Add `cellLocation: {rowIndex, columnIndex}` to select one table cell and/or
  `range: {startIndex, endIndex}` to select at most 10,000 UTF-16 code units.
  A cell or range selection requires an element ID.
- Selected results retain the provider revision and are capped at 64,000
  serialized characters, below the 96,000-character tool-result ceiling.
  Oversized selections fail with `response-too-large`; narrower reads must use
  the same revision before proposing an edit. Missing tabs, segments, elements,
  or cells fail with `provider-rejected`, never an empty success.
- These are application-side selections, not Google server pagination. The
  unchanged 2 MiB provider response limit applies before selection; files or
  full detailed pages above that limit cannot be read through these operations.
  Report that limit rather than silently creating a replacement.

## Curated batch requests

All batch request objects reject unknown fields and unknown variants.

- Sheets supports `addSheet`, `deleteSheet`, `updateSheetProperties`, `repeatCell`,
  `insertDimension`, `deleteDimension`, `autoResizeDimensions`, `mergeCells`, and
  `unmergeCells`. Formatting supports background RGB, alignment, bold, italic,
  and font size. Field masks are restricted to the exposed fields. Sheet IDs
  accept Google's nonnegative int32 range independently of row/column limits.
- Docs supports `insertText`, `replaceAllText`, `deleteContentRange`,
  `updateTextStyle`, `updateParagraphStyle`, `createParagraphBullets`,
  `insertTable`, and `insertPageBreak`. Indexed edits can specify tab and segment
  IDs for existing headers, footers, or footnotes. Reads include tab content.
  Replace-all follows Google's default tab selection. Paragraph styles cover
  named styles, alignment, line spacing, and space above/below. Bullet presets
  cover disc/circle/square, checkbox, decimal/alpha/roman, and nested decimal.
  Arbitrary resource patches are not exposed.
- Slides supports `createSlide`, `deleteObject`, `duplicateObject`, `insertText`,
  `deleteText`, `replaceAllText`, `updateTextStyle`, `updateSlidesPosition`,
  `updatePageElementTransform`, and `createShape`. Text insertion, deletion, and
  styling accept table cell locations. Shape creation uses Google's default
  geometry; transforms accept PT/EMU and relative/absolute modes. Image URL
  fetches are not exposed.
- Docs and Slides text styles support bold, italic, underline, strikethrough,
  and font size in PT. Style masks are limited to these fields.

These operations can delete content. Batch writes require the same approval
gate as standalone writes. Google still validates resource existence, indices,
permissions, recurrence semantics, and resource-specific constraints.

## Reviewed updates to Google originals

An update to an existing Google file must not overwrite edits made after the
review. `googleWriteTarget` in `src/operation-contracts.ts` classifies each write.

- Docs `documents.batchUpdate` and Slides `presentations.batchUpdate` require
  `requiredRevisionId`. A proposal without it fails with
  `operation-revision-required`. The proposal reads the target's current
  `revisionId` and fails with `operation-target-stale` when it differs.
- Execution reads the revision again after approval and before the receipt
  claim. A changed revision fails with `operation-target-stale` and records no
  receipt. The write sends `writeControl.requiredRevisionId`, so Google rejects
  an edit that lands between the check and the write. That 400 response fails
  with `operation-target-stale` and records a `failed` receipt. TulipFarm never
  retries with a newer revision. A refreshed proposal needs a new approval.
- Sheets has no write precondition, and Drive v3 `files.update` has no
  revision precondition, so a reviewed overwrite of a Google original could
  silently replace newer edits. Sheets `values.update`, `values.batchUpdate`,
  `values.clear`, and `spreadsheets.batchUpdate` are allowed only when the
  spreadsheet ID appears in a `succeeded` receipt of `sheets.spreadsheets.create`
  (`spreadsheetId`), `drive.files.copy` (`id`), or a new `drive.files.upload`
  without `fileId` (`id`) in the same workspace. Proposal
  and execution each check the receipt. On any other spreadsheet they fail with
  `operation-unguarded-update`. Sheets `values.batchClear` and Drive
  `files.upload` with `fileId` always fail with `operation-unguarded-update`.
  Create a new file, upload without `fileId`, copy, or append rows instead.
  The agent tool error for this code carries a `message` that names these
  alternatives.
- Agent document-spec proposals always create a new file. Existing-file edits
  use operation proposals with the original ID. Skills require agreement before
  substituting a new file or copy, including large Slides redesigns; an eligible
  spreadsheet is reused rather than copied again for each edit.
- Sheets writes on a created or copied spreadsheet bind the Drive `version`
  (`files.get?fields=version`). Drive raises it on every server-side change to
  the file. `headRevisionId` exists only for blob files, and `modifiedTime` is
  coarser, so `version` is the strongest change counter Google exposes for
  Sheets. The proposal reads the version and stores it as `requiredVersion` in
  the reviewed operation. The agent tool schema
  (`googleAgentOperationSchema`) omits the field, so agents always rely on this
  binding. A direct proposal request may supply `requiredVersion`. A supplied
  version that differs from the current one fails with `operation-target-stale`.
- Drive `files.get` accepts only Drive scopes (`drive`, `drive.file`,
  `drive.readonly`, `drive.metadata`, `drive.metadata.readonly`, and others in
  that family), never `spreadsheets`. So these four versioned writes require
  both `spreadsheets` and `drive`, the Drive scope the Google Drive app grants.
  A Sheets-only integration is refused at proposal time with
  `insufficient-scope` before any Drive read. The agent tool error names the
  missing Google Drive access, and the Google Sheets integration sheet offers
  Grant Google Drive access. `sheets.values.append` reads no version and needs
  only `spreadsheets`. Added 5 October 2026 from the #506 review.
- Execution reads the version before the receipt claim. A changed version fails
  with `operation-target-stale` and records no receipt. After the claim,
  execution reads the version again immediately before the Sheets request. A
  change there fails with `operation-target-stale` and records a `failed`
  receipt without writing. After a successful write, execution reads the version
  again. The `succeeded` receipt result carries `versionGuard` with
  `requiredVersion`, `versionAfterWrite` (`null` when that read failed), and a
  `residualRace` statement. A refreshed proposal needs a new approval.
- Residual race. Sheets accepts no precondition, so an edit saved after the last
  version read and before Google applies the write is not detected. That window
  is one Drive metadata round trip plus the Sheets request. The edit and the
  write then both apply, and overlapping cells keep whichever Google applied
  last. `versionAfterWrite` cannot prove the absence of such an edit, because
  one write can raise the version by more than one. Metadata changes such as a
  rename or a sharing change also raise the version, so they refuse the write as
  stale.
- A Sheets proposal stored before versions were bound has no `requiredVersion`.
  Execution fails it with `operation-revision-required`, so it must be proposed
  again.
- Sheets `values.append` with `insertDataOption: OVERWRITE` fails with
  `operation-unguarded-update` at proposal and at execution, because `OVERWRITE`
  replaces cells after the detected table and Sheets has no write precondition.
  A proposal stored with `OVERWRITE` still loads, so its owner can review it,
  and execution refuses it before the receipt claim. The agent tool schema
  (`googleAgentOperationSchema`) accepts only `INSERT_ROWS`. The provider
  refuses an `OVERWRITE` append with `invalid-operation` before any request,
  so only `INSERT_ROWS` reaches Google.
- The receipt table allows one `failed` error code, so the receipt cannot record
  a write-time stale result. The execute call reports it, and later status reads
  show `failed`.

## Bounds and transport

Requests use fixed HTTPS Google origins. Dynamic path components are encoded.
The provider rejects redirects and uses a 15-second deadline covering response
headers and body reads. It cancels responses larger than 2 MiB while streaming,
including responses whose declared length is missing or incorrect. Serialized
request bodies are limited to 2 MiB. List calls default to 50 items and permit
at most 100. Page tokens are returned unchanged. The caller requests each page.

Batch calls accept at most 100 requests. Values calls accept at most 1,000 rows
of 100 cells each, subject to the total byte limit. Values batches accept at
most 20 ranges. String cells are limited to 50,000 characters.

Gmail send and draft bodies accept structured recipients, subject, body,
optional content type, thread ID, and In-Reply-To. They do not accept raw MIME,
arbitrary headers, or attachments. Recipients are ASCII email addresses without
display names. Each recipient list accepts at most 50 addresses. Subjects have
a 500-character limit and reject control characters. Subject encoded words
preserve UTF-8 boundaries. Bodies have a 100,000-character limit and use folded
base64. The complete MIME message uses base64url for Google's `raw` field.
Gmail chooses the authenticated sender. Thread matching still requires a matching
subject and a valid reply Message-ID.

`gmail.drafts.send` requires both `draftId` and the full structured `message`.
The send request contains `{ id, message: { raw, threadId? } }` and replaces the
draft's message during send, as documented by Google. It never sends a mutable
remote draft by ID alone or uses a separate update-then-send sequence. The
durable approval digest must cover the complete operation, including recipients
and content. Existing ID-only draft-send intentions fail validation and require
a new content-bound approval.

Drive uploads accept canonical base64 for at most 1 MiB of decoded bytes.
They use simple media upload. Supplying `fileId` replaces file content and is
refused as an unguarded update; omitting
it creates a file. Metadata changes are separate approved operations. Resumable
and multipart uploads are not supported. Download and export return
`{ contentBase64, byteLength }`, bounded by the 2 MiB response limit.

Success returns Google's JSON, or `{ success: true }` for HTTP 204. Returned
content remains untrusted external data. Error bodies, status text, and thrown
fetch errors never reach the caller. Credential reflection checks reject raw,
URL-encoded, base64, and JSON-escaped occurrences of the supplied token.

Error codes are `invalid-operation`, `invalid-credential`, `cancelled`,
`provider-unavailable`, `provider-rejected`, `reconnect-required`,
`insufficient-scope`, `rate-limited`, `response-too-large`, `invalid-response`,
and `outcome-unknown`. HTTP 403 maps conservatively to `insufficient-scope`,
although Google can also use it for resource permissions or quota.

After dispatch, transport failures, HTTP 408, redirects, HTTP 5xx, malformed
success, and oversized or credential-reflecting write responses become
`outcome-unknown`. Callers must not automatically replay these writes. A signal
already aborted before dispatch yields `cancelled` without a request.

## Official sources

Context7 was unavailable because the parent run exhausted its quota.

- [Gmail sending and MIME](https://developers.google.com/workspace/gmail/api/guides/sending).
- [Gmail draft updates during send](https://developers.google.com/workspace/gmail/api/guides/drafts#send-drafts).
- [Drive upload modes](https://developers.google.com/workspace/drive/api/guides/manage-uploads).
- [Calendar REST reference](https://developers.google.com/workspace/calendar/api/v3/reference).
- [Sheets batch requests](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/request).
- [Docs batch requests](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/request).
- [Slides pages](https://developers.google.com/workspace/slides/api/reference/rest/v1/presentations.pages).
- [Slides batch requests](https://developers.google.com/workspace/slides/api/reference/rest/v1/presentations/request).

Controlled HTTP tests do not qualify a live Google account. The [operations
runbook](../../docs/google-operations.md) records durable approval, actual runtime
composition, and PostgreSQL verification. Live service qualification remains
operator work.
