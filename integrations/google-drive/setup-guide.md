# Connect Google Drive

One OAuth token powers two things: **agent tools** (search files, read a file's details) and,
optionally, **Knowledge sync** (indexing files so agents can cite them). Both use the same token —
there is nothing extra to create for the second.

1. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials), open the project
   serving this deployment and enable the **Google Drive API**.
2. Create an OAuth client — or, to cover a whole workspace without each person authorizing, a
   **service account with domain-wide delegation**.
3. Grant the read scopes `drive.metadata.readonly` and `drive.readonly`.
4. Copy a current access token and paste it into TulipFarm's Google Drive connect form.

The tools are read-only by design. The scopes above are read scopes, and a write tool against a
read token would fail at call time — worse than no tool, because an agent would report an edit that
never happened.

Drive tools return file **metadata**, not file contents. For a Google Doc's body, connect the
Google Docs integration too; `search_files` is how an agent turns a filename into the id that
integration needs.

## Optional: index files into Knowledge

Knowledge sync makes Drive files retrievable and citable in chat, and it enforces per-user access.
It needs two more things:

- `GOOGLE_WORKSPACE_ID` — your workspace/customer identifier, used to track sync position.
- Link Google permission subjects — user emails, group emails, or a domain when you explicitly want
  that domain to grant a Tulip principal — through external identity mappings.

TulipFarm does **not** treat "anyone with the link" as everyone. Link-sharing names no Tulip
principal, so it grants no Knowledge access. Domain sharing grants access only when that domain
subject is explicitly mapped; otherwise it grants nothing.
