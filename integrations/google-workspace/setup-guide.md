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

- `documents` for Docs reads, creation, and batch edits.
- `spreadsheets` for Sheets reads, creation, and value edits.
- `presentations` for Slides reads, creation, and batch edits.
- `drive` for Drive listing, metadata reads and writes, and blob downloads.
- `calendar.events` for Calendar event reads, creation, and edits.
- `gmail.readonly` for Gmail search and message reads.
- `gmail.send` for Gmail sending.

These scopes are shown together during consent. Google classifies some Google Workspace scopes as
sensitive or restricted. In particular, the broad Drive scope and Gmail read scope can trigger
restricted-scope requirements. An external production app can require Google verification, and a
server that stores or transmits restricted-scope data can require an annual assessment by a
Google-approved assessor. A Google Workspace administrator can also block or limit the app.

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
| Docs | `google_workspace_docs_get` | `google_workspace_docs_create`, `google_workspace_docs_batch_update` |
| Sheets | `google_workspace_sheets_get`, `google_workspace_sheets_get_values` | `google_workspace_sheets_create`, `google_workspace_sheets_update_values` |
| Slides | `google_workspace_slides_get` | `google_workspace_slides_create`, `google_workspace_slides_batch_update` |
| Drive | `google_workspace_drive_list_files`, `google_workspace_drive_get_file`, `google_workspace_drive_download_file` | `google_workspace_drive_create_file`, `google_workspace_drive_update_file` |
| Calendar | `google_workspace_calendar_list_events` | `google_workspace_calendar_create_event`, `google_workspace_calendar_update_event` |
| Gmail | `google_workspace_gmail_list_messages`, `google_workspace_gmail_get_message` | `google_workspace_gmail_send_message` |

All operations require a personal Connection. Writes are approval-gated by their OIM effects.

`google_workspace_gmail_send_message` accepts the Gmail API's `raw` field: a complete RFC 2822
message encoded as base64url. The declarative OIM HTTP profile cannot assemble MIME or attachments.

`google_workspace_drive_download_file` returns a TulipFarm File and is limited to 10 MiB by the
current OIM response schema. It downloads blob files with `alt=media`; Google Workspace-native
files require a Drive export operation, which this package does not declare.

The six services use five unique documented API origins. Drive and Calendar both use
`www.googleapis.com`; Docs, Sheets, Slides, and Gmail each use their service-specific origin. Every
operation fixes its origin in the manifest, so an argument cannot redirect a request elsewhere.

## Offline fixture coverage

The digest-pinned fixture suite covers all six services and representative read, create, edit, and
send calls through the production HTTP compiler and adapter. It also verifies a typed Google `401`
failure and a binary Drive download stored through the fixture File port. The suite uses no live
credentials or network access.

## Official sources

OAuth and policy:

- [OAuth 2.0 for web server applications](https://developers.google.com/identity/protocols/oauth2/web-server)
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

Calendar:

- [List events](https://developers.google.com/workspace/calendar/api/v3/reference/events/list)
- [Create an event](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert)
- [Patch an event](https://developers.google.com/workspace/calendar/api/v3/reference/events/patch)

Gmail:

- [List messages](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list)
- [Get a message](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get)
- [Send a message](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send)
