# Google file reads

Backend contract inspected and fixture-tested on 4 October 2026. This slice has no mutations or live Google credential proof. [Save a copy](../../apps/api/src/files-google-copy.ts) composes these reads with Files; see the [Files storage amendment](../../docs/files-storage-delivery.md#verified-publication-amendment-4-october-2026).

## HTTP contract

All routes are `POST` below `/v1/workspaces/:workspaceId/google-workspace/operations/files`. They require the owner's session cookie and trusted web Origin. A workspace administrator cannot borrow another member's Google integration.

| Suffix      | Body                                                                                                   | Success                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `/list`     | `expectedIntegration`, optional `parentId`, `sharedWithMe`, `name`, `pageToken`, `pageSize`, `orderBy` | `GoogleFilePage` JSON                                                                                |
| `/metadata` | `GoogleFileReference`                                                                                  | `GoogleFileMetadata` JSON                                                                            |
| `/content`  | `GoogleFileContentRequest`                                                                             | Raw binary for `download`, `pdf`, or `export`. `{kind: 'sheet-range', data}` JSON for a sheet range. |

[Public contracts](src/public-contracts.ts) export the named types and runtime schemas from [file contracts](src/file-contracts.ts). `GoogleFileReference` contains a native `fileId` and required `expectedIntegration` with `integrationId`, `accountId`, and `generation`. No credentials, provider URLs, user IDs, or workspace IDs are accepted in the body. Workspace and user identity come from the route and session.

`GoogleFileContent` is the service result union. Its binary branch contains `Uint8Array` bytes, `mimeType`, and `byteLength`. HTTP sends those bytes directly, not this object or base64. The UI can fetch a Blob for its viewer or a later explicit copy. Binary responses have attachment disposition, `nosniff`, a sandbox CSP, and no-store caching. Opening the POST URL directly in an iframe is not supported.

`download` supports ordinary Drive blob files. `pdf` supports native Google Docs and Slides through Drive export. `export` takes a `format` from `googleExportFormats`: `pdf` for Docs, Sheets, and Slides, `docx` for Docs, `xlsx` and `csv` for Sheets, and `pptx` for Slides. Drive exports only the first sheet as CSV. Native folders, shortcuts, and other native Google formats reject binary delivery. `sheet-range` takes `sheetName`, `startRow`, `rowCount`, `startColumn`, and `columnCount`. It returns formatted values in rows, capped at 1,000 rows, 100 columns, and 2 MiB of provider JSON. Sheet tabs remain available through the existing `sheets.spreadsheets.get` generic read operation. Charts, pivots, and editing remain in Google.

The list defaults to 50 entries and caps pages at 100. It uses `corpora=user`, `spaces=drive`, excludes trash, and supports folder and name filters. `parentId=root` browses My Drive. `sharedWithMe=true` selects shared files. Omitting both searches the supported user corpus. `orderBy` is `folder,name_natural` or `folder,modifiedTime desc`. Empty pages can still carry `nextPageToken`; callers must not infer completion from an empty array. `incompleteSearch` remains visible. A list entry that fails the metadata schema is dropped and counted in `skipped`, so one malformed entry no longer rejects its page. A malformed page envelope still returns `invalid-response`. Metadata includes Google's `webViewLink` as an unvalidated string; the web viewer renders it only as a plain `https` link on a `google.com` host. Dedicated shared-drive navigation and shortcut resolution are excluded.

## Authorization and limits

The slice uses existing app consent scopes. Drive list, metadata, download, and PDF export require `https://www.googleapis.com/auth/drive`. Sheet ranges require `https://www.googleapis.com/auth/spreadsheets`. A Docs-only integration does not grant Drive access. Google independently enforces the connected user's file ACL. Readonly-scope alternatives are not added to the existing consent model here.

[Operations](src/operations.ts) resolve the current member and compare the required account binding. [The credential service](src/service.ts) refreshes tokens under its existing authorization transaction. File reads then release that transaction before provider I/O. They buffer the result and repeat credential, membership-incarnation, scope, status, account, and generation checks before returning it. HTTP rechecks the session before sending. No provider stream escapes this lifetime. Google can revoke source access after its response, and the service cannot recall bytes already delivered.

Binary content is capped at 10 MiB, including unknown-length and compressed responses after fetch decoding. Google imposes its own export limit, documented as 10 MB, which can reject an export before the local cap. Four file reads can run per operations instance. HTTP additionally reserves four transfers per registered API instance until response completion. There is no waiting queue or fleet-wide admission counter. Each provider operation has a 15-second deadline. HTTP has a 20-second total response deadline and propagates client disconnect cancellation. Slow transfers do not extend either deadline.

Buffering delays first-byte delivery and briefly holds source chunks plus the combined buffer. It avoids a long database transaction and permits a final authorization check. A later streaming design needs a separate authorization lifetime and explicit resource accounting. This slice does not provide HTTP ranges, resumable downloads, or downloads beyond the cap.

## Recovery codes

| Code                                      | Meaning                                                                                                    |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `integration-required`                    | No connected account for this member.                                                                      |
| `reconnect-required`, `stale-integration` | OAuth has expired or the expected binding is no longer current.                                            |
| `insufficient-scope`                      | Stored scopes or Google's explicit scope error deny this operation.                                        |
| `source-not-found`                        | Google returned 404 or the content target is trashed. Missing and concealed files are not distinguishable. |
| `source-access-denied`                    | Google denied the file or its download capability. Unknown 403 reasons do not imply missing OAuth scope.   |
| `export-rejected`                         | Google rejected exportability, export size, or download support.                                           |

`GoogleFileError.detail` carries `download-restricted` for `cannotDownloadFile` or `canDownload: false`, and `not-exportable` for `fileNotExportable`. HTTP responses send only the code. Chat file references use the detail to tell the model why content was not read.
| `unsupported-representation` | The requested representation does not apply to this native file type. |
| `response-too-large` | The local byte cap was exceeded. |
| `rate-limited`, `provider-unavailable` | Transient provider or quota failure. No automatic retries occur. |
| `transfer-busy`, `transfer-timeout`, `cancelled` | Local capacity, deadline, or cancellation. |
| `invalid-response` | Google returned malformed typed data or reflected a credential. |

The existing generic read endpoint and its 2 MiB base64 behavior remain unchanged. New file errors use 409 except local busy at 429 and timeout at 504. Boundary errors retain the existing session, origin, and validation status codes.

## Verification

[Provider tests](test/file-provider.test.mjs) exercise exact URLs, query escaping, projections, pagination, typed parsing, PDF exports, formatted sheet ranges, 3 MiB output, exact 10 MiB acceptance, overflow, cancellation, and error categories.

[Database tests](test/files.integration.mjs) exercise owner selection, missing scopes, refresh failure, the actual deadline, capacity, and delivery denial after disconnect, account change, generation change, scope loss, or membership removal. [HTTP tests](../../apps/api/test/google-files.integration.mjs) run real Fastify and provider fixture sockets with PostgreSQL. They prove binary output, rejection, session revocation, client cancellation, and disconnect during transfer. Authentication uses synthetic sessions, not a live Better Auth login or Google account.

The disposable runner is `node tooling/verify-knowledge-storage.mjs`. The aggregate stream contains 69 receipts through `0093_knowledge_search.sql`. Three existing Google upgrade tests fail on unchanged baseline `19ed51c7`, asserting old prefix counts of 32, 35, and 37 against actual counts of 31, 34, and 36. No migration or fixture repair is included.

Provider semantics were checked against current [Drive downloads](https://developers.google.com/workspace/drive/api/guides/manage-downloads), [file search](https://developers.google.com/workspace/drive/api/guides/search-files), and [error handling](https://developers.google.com/workspace/drive/api/guides/handle-errors) documentation through Context7.
