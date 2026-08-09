# Connect Google Docs

1. Create a Google OAuth client or service account with domain-wide delegation.
2. Grant read scopes for Google Docs export and Drive file permissions/metadata.
3. Paste the Workspace ID and access token into TulipFarm's Google Docs connect form.
4. Link Google permission subjects to TulipFarm users through external identity mappings.

Google Docs permissions are Drive permissions, including inherited folder permissions returned by
Drive. TulipFarm does **not** map link-sharing to everyone. Domain sharing grants access only when
the domain subject is explicitly mapped; unmapped domain permissions grant nothing.
