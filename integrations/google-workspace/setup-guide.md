# Connect Google Workspace

This package uses one user OAuth connection for Google Docs, Sheets, Slides, Drive, Calendar, and
Gmail. It is declarative: it contains no Google SDK and no provider-specific TypeScript.

## Before connecting

In the Google Cloud project owned by your deployment:

1. Enable the Google Docs API, Google Sheets API, Google Slides API, Google Drive API, Google
   Calendar API, and Gmail API.
2. Configure the OAuth consent screen and its audience.
3. Create an OAuth client with application type **Web application**.
4. Add the exact callback URL shown by TulipFarm as an authorized redirect URI.
5. Copy the client ID and client secret into the first TulipFarm setup step.
6. Start the OAuth step and approve the requested scopes with the Google user whose data the
   Connection should use.

The package declares Google's `access_type=offline`, `prompt=consent`, and
`include_granted_scopes=true` authorization parameters. Google returns a refresh token during
initial authorization and reconnection, so TulipFarm can refresh access after the user leaves. If
Google does not return the required refresh token, the Connection remains pending instead of
appearing ready for unattended work. During renewal, TulipFarm keeps the existing refresh token
when Google does not rotate it.

## Scopes and review gates

The package requests:

- `openid`, `profile`, and `email` to identify the exact Google account behind the OAuth grant.
- `documents` for Docs reads, creation, and batch edits.
- `spreadsheets` for Sheets reads, creation, and value edits.
- `presentations` for Slides reads, creation, and batch edits.
- `drive` for My Drive and Shared Drive discovery, metadata, bounded byte uploads, downloads,
  and native-file export.
- `calendar.events` for Calendar event reads, creation, and edits.
- `calendar.calendarlist.readonly` for discovering calendars and their access roles.
- `gmail.readonly` for Gmail search and message reads.
- `gmail.send` for Gmail sending.
- `gmail.compose` for creating, replacing, reading, and sending drafts.

Upgrading from 2.0 requires renewed consent for Calendar discovery and Gmail drafts. Existing
access tokens cannot gain scopes through refresh alone. Reconnect the personal Connection through
the UI; never paste tokens or edit the Soul. These declarations depend on the production OIM OAuth
host correctly providing every configured credential to verification; this provider package does
not repair that host.

These scopes are shown together during consent. Google classifies some Google Workspace scopes as
sensitive or restricted. In particular, the broad Drive scope and Gmail read scope can trigger
restricted-scope requirements. An external production app can require Google verification, and a
server that stores or transmits restricted-scope data can require an annual assessment by a
Google-approved assessor. A Google Workspace administrator can also block or limit the app.

The identity check uses the OpenID Connect `sub` value. The optional `hd` value is only a hosted
domain hint; it is not treated as an organization or tenant identifier.

An external app in **Testing** is limited to configured test users. Google states that test-user
authorizations, including refresh tokens obtained for offline access, expire after seven days for
requests beyond basic identity scopes. An **Internal** app is limited to users in its Google Cloud
organization and can qualify for verification exceptions, but organization policy still applies.

This package has only offline manifest and fixture validation. It does not claim live readiness.
Live use remains gated by API enablement, redirect URI accuracy, consent-screen configuration,
Workspace administrator policy, and any Google verification or security assessment that applies.

## Operation inventory

| Service | Read operations | Write operations |
| --- | --- | --- |
| Identity | `google_workspace_current_user` | — |
| Docs | `google_workspace_docs_get` | `google_workspace_docs_create`, `google_workspace_docs_batch_update` |
| Sheets | `google_workspace_sheets_get`, `google_workspace_sheets_get_values` | `google_workspace_sheets_create`, `google_workspace_sheets_update_values` |
| Slides | `google_workspace_slides_get` | `google_workspace_slides_create`, `google_workspace_slides_batch_update` |
| Drive | `google_workspace_drive_list_files`, `google_workspace_drive_list_drives`, `google_workspace_drive_list_shared_drive_files`, `google_workspace_drive_get_file`, `google_workspace_drive_download_file`, `google_workspace_drive_export_file` | `google_workspace_drive_create_file`, `google_workspace_drive_update_file`, `google_workspace_drive_upload_file` |
| Calendar | `google_workspace_calendar_list_calendars`, `google_workspace_calendar_list_events`, `google_workspace_calendar_get_event` | `google_workspace_calendar_create_event`, `google_workspace_calendar_update_event` |
| Gmail | `google_workspace_gmail_list_messages`, `google_workspace_gmail_get_message`, `google_workspace_gmail_list_drafts`, `google_workspace_gmail_get_draft` | `google_workspace_gmail_send_message`, `google_workspace_gmail_compose_send_message`, `google_workspace_gmail_create_draft`, `google_workspace_gmail_update_draft`, `google_workspace_gmail_send_draft` |

All operations require a personal Connection. Writes are approval-gated by their OIM effects.

### Sending mail and working with drafts

Ask in Chat to compose a message or draft with `to`, `subject`, and `text`, `html`, or both.
The composed Tools build UTF-8 MIME, multipart alternatives, and base64url in the host. Recipients
are ASCII mailbox lists; the subject supports Unicode. Header control characters are rejected.
Up to ten existing TulipFarm File IDs may be attached. The effective user's File ACL and the
Run's explicit File-read authority must both permit every attachment, before any bytes are opened
or sent. Use the UI upload or File Tools to create Files; local paths, URLs, and Drive IDs are not
TulipFarm File IDs.

The complete encoded JSON request is capped at 10 MiB, including MIME and both base64 encodings
for attachments. This means the total attachment bytes must be substantially smaller than 10 MiB.
Oversized requests fail before sending; they are not truncated. Replacing a draft replaces its
entire message, including attachments. Sending a draft is a separate approval-gated action.

The original `google_workspace_gmail_send_message` still accepts Gmail's `raw` field for callers
that already have a complete RFC 2822 message. Composed sends create new messages, not threaded
replies. Replies needing `In-Reply-To`, `References`, and `threadId` must use the raw operation.
Gmail reads still return provider MIME structure/base64url body data; attachment download and
automatic incoming MIME-to-text decoding are not declared.

### Drive discovery and transfer bounds

`drive_list_files` pins the `user` corpus. It includes Shared Drive files the user has accessed,
but is not a complete inventory of every Shared Drive. Discover drive IDs with `drive_list_drives`,
then use `drive_list_shared_drive_files` with a required `driveId` and a pinned `drive` corpus.
List/get/create/update/download and upload declare Shared Drive opt-ins where Google supports them.
Neither operation permits the ambiguous `allDrives` corpus. The provider still enforces membership,
file permissions, and download restrictions; `supportsAllDrives` does not grant access.

List results are bounded pages. Follow the host's `next_page_token` using the same search arguments
until absent. An empty page may still have a continuation. A response with
`incompleteSearch: true` fails with `invalid_output`, rather than returning a seemingly complete
result; retry a narrower query in a single drive. Reaching a host pagination limit while Google
still supplies a continuation fails with `pagination_bound_exceeded`. Narrow the search instead
of interpreting that error as an empty or complete result.

`drive_create_file` remains metadata-only. `drive_upload_file` sends authorized TulipFarm File
bytes with metadata using Google's multipart/related upload protocol. Set `metadata.parents` to
a Shared Drive folder ID to upload there. Combined metadata and bytes are capped at 5 MiB,
checked before dispatch; resumable uploads and byte replacement of existing files are not supported.

`google_workspace_drive_download_file` returns a TulipFarm File and is limited to 10 MiB by the
current OIM response schema. It downloads blob files with `alt=media`; Google Workspace-native
files use `google_workspace_drive_export_file`, also capped at 10 MiB. Supported export choices
are plain text for Docs, CSV for the first sheet of a spreadsheet, and PDF for Docs/Sheets/Slides.
The provider decides which format a file supports. `files.export` does not accept
`supportsAllDrives`; it works by file ID with the same personal credential.

Downloads reject oversized declared lengths and streams before storing a File. They never return
partial file bytes as a success. The normal File host still applies its format allowlist, sniffing,
ownership, and download ACLs. A missing or unusable content type can therefore cause a safe refusal.

### Events and Knowledge are not available

This package declares neither ingress nor automatic Knowledge indexing. Ordinary read Tools and
bounded downloads are not evidence of either capability.

- **Drive changes:** needs an initial `changes.getStartPageToken` call, page-token traversal, then
  promotion of `newStartPageToken` only after the final page is durable. The current declarative
  polling cursor has one response pointer and one request parameter, no bootstrap operation or
  final-page cursor selection. It cannot safely express this lifecycle.
- **Gmail history / Calendar incremental sync:** needs history-ID or sync-token bootstrap, paging,
  and recovery from expired history (404) or sync tokens (410). Gmail history IDs are decimal
  strings, not the polling profile's safe-integer item IDs. The profile cannot express these
  provider-specific bootstrap/reset and terminal-cursor rules.
- **Drive Knowledge:** exported content is a File reference, while Knowledge content mapping
  reads strings from JSON pointers or one flat array join. There is no declarative File-to-text
  extraction stage. Docs have nested heterogeneous document content, not a flat string field.
  Drive permissions also require inherited Shared Drive/group/domain ACL resolution and
  trustworthy identity mapping. `capabilities.canDownload` is about the connection user, not a
  live authorization answer for an arbitrary retrieving principal. Those missing mechanisms must
  be implemented before advertising ACL-preserving Drive Knowledge.

The separate legacy catalog key `google` remains Coming soon. It is not this OIM package
(`google-workspace`), and its code-backed adapter is not a substitute for this package's setup.

The six services use five unique documented API origins. Drive and Calendar both use
`www.googleapis.com`; Docs, Sheets, Slides, and Gmail each use their service-specific origin. Every
operation fixes its origin in the manifest, so an argument cannot redirect a request elsewhere.

## Offline fixture coverage

The digest-pinned fixture suite covers all six services and representative read, create, edit, and
send calls through the production HTTP compiler and adapter. It includes Shared Drive discovery,
an incomplete-search refusal, native export, composed MIME send/drafts, and Google's empty Gmail
search shape. Transport regressions exercise FetchEgressHttp serialization, multipart/related
bytes, headers, empty bodies, UTF-8 MIME, attachment authorization, and byte ceilings. The suite
uses no live credentials or provider network access.

## Official sources

OAuth and policy:

- [OAuth 2.0 for web server applications](https://developers.google.com/identity/protocols/oauth2/web-server)
- [OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect)
- [Google OAuth scope catalog](https://developers.google.com/identity/protocols/oauth2/scopes)
- [Restricted-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)
- [OAuth audience and publishing status](https://support.google.com/cloud/answer/15549945)

Docs:

- [Get a document](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/get)
- [Create a document](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/create)
- [Batch update a document](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/batchUpdate)

Sheets:

- [Get a spreadsheet](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/get)
- [Create a spreadsheet](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/create)
- [Get values](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/get)
- [Update values](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/update)

Slides:

- [Get a presentation](https://developers.google.com/workspace/slides/api/reference/rest/v1/presentations/get)
- [Create a presentation](https://developers.google.com/workspace/slides/api/reference/rest/v1/presentations/create)
- [Batch update a presentation](https://developers.google.com/workspace/slides/api/reference/rest/v1/presentations/batchUpdate)

Drive:

- [List files](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list)
- [Get a file](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/get)
- [Create a file](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/create)
- [Update a file](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/update)
- [Download files](https://developers.google.com/workspace/drive/api/guides/manage-downloads)
- [Shared Drives support](https://developers.google.com/workspace/drive/api/guides/enable-shareddrives)
- [Upload files](https://developers.google.com/workspace/drive/api/guides/manage-uploads)
- [Export files](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/export)

Calendar:

- [List events](https://developers.google.com/workspace/calendar/api/v3/reference/events/list)
- [Create an event](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert)
- [Patch an event](https://developers.google.com/workspace/calendar/api/v3/reference/events/patch)
- [List calendars](https://developers.google.com/workspace/calendar/api/v3/reference/calendarList/list)
- [Get an event](https://developers.google.com/workspace/calendar/api/v3/reference/events/get)

Gmail:

- [List messages](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list)
- [Get a message](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get)
- [Send a message](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send)
- [Create a draft](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.drafts/create)
