# Connect Google Drive

1. Create a Google OAuth client or service account with domain-wide delegation.
2. Grant read scopes for Drive files, permissions, metadata, and export.
3. Paste the Workspace ID and access token into TulipFarm's Google Drive connect form.
4. Link Google permission subjects (user emails, group emails, or domains when you explicitly want
   that domain to grant a Tulip principal) through external identity mappings.

TulipFarm does **not** treat "anyone with the link" as everyone. Link-sharing names no Tulip
principal, so it grants no Knowledge access. Domain sharing grants access only when that domain
subject is explicitly mapped; otherwise it grants nothing.
