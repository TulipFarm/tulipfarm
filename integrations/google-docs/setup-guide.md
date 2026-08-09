# Connect Google Docs

One OAuth token powers two things: the **agent tool** (read a document's title and body) and,
optionally, **Knowledge sync** (indexing documents so agents can cite them). Both use the same
token — there is nothing extra to create for the second.

1. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials), open the project
   serving this deployment and enable both the **Google Docs API** and the **Google Drive API**.
   Docs has no permissions API of its own, so access is always read from Drive.
2. Create an OAuth client — or, to cover a whole workspace without each person authorizing, a
   **service account with domain-wide delegation**.
3. Grant the read scopes `documents.readonly` and `drive.metadata.readonly`.
4. Copy a current access token and paste it into TulipFarm's Google Docs connect form.

The tool is read-only by design. The scopes above are read scopes, and a write tool against a read
token would report edits that never happened.

`read_document` takes a document **id** — the long segment in a `/document/d/<id>/edit` URL. If an
agent only knows a document by name, connect Google Drive too and let it search first.

## Optional: index documents into Knowledge

Knowledge sync makes documents retrievable and citable in chat, and it enforces per-user access.
It needs two more things:

- `GOOGLE_WORKSPACE_ID` — your workspace/customer identifier, used to track sync position.
- Link Google permission subjects to TulipFarm users through external identity mappings.

Google Docs permissions are Drive permissions, including inherited folder permissions. TulipFarm
does **not** map link-sharing to everyone. Domain sharing grants access only when the domain
subject is explicitly mapped; unmapped domain permissions grant nothing.
