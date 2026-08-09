# Connect Confluence

One Atlassian OAuth token powers two things: **agent tools** (search pages, read a page, list
spaces) and, optionally, **Knowledge sync** (indexing pages so agents can cite them). Both use the
same token — there is nothing extra to create for the second.

1. Go to https://developer.atlassian.com/console/myapps/ → **Create** → **OAuth 2.0 integration**.
   Name it "TulipFarm".
2. Open **Permissions** → add the **Confluence API** → **Configure**, and grant the read scopes:
   `read:page:confluence`, `read:space:confluence`, and `read:content-details:confluence`.
3. Authorize the app against your site and copy a current **access token**.
4. Copy your site's **Cloud ID**: sign in to Confluence and open
   `https://<your-site>.atlassian.net/_edgeAuth/tenantInfo` — the `cloudId` field is the value.
   TulipFarm needs it because every API call is addressed to
   `https://api.atlassian.com/ex/confluence/<cloud id>/...`.
5. Paste the Cloud ID and access token into TulipFarm's Confluence connect form.

That is everything the agent tools need. The next section applies only if you also want Confluence
pages indexed into Knowledge.

## Optional: index pages into Knowledge

Knowledge sync makes pages retrievable and citable in chat, and it enforces per-user access rather
than flattening it. It needs broader read scopes so the sync can resolve who may read each page:
add `read:group:confluence`, `read:user:confluence`, and restriction read access alongside the
scopes above.

Then link Confluence accounts to TulipFarm users through external identity mappings. An unmapped
Confluence account names no Tulip principal, so it grants no Knowledge access.

If permissions cannot be read for a page, TulipFarm marks it unverifiable and **removes** its
indexed content rather than serving content whose audience it cannot confirm.

TulipFarm stores only `secret://integration.confluence.CONFLUENCE_ACCESS_TOKEN` in Soul; the live
token is sealed in the Secrets store.
