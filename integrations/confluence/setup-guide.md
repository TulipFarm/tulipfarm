# Connect Confluence

1. Create or open an Atlassian OAuth app for the Confluence site.
2. Grant read scopes that allow TulipFarm to read pages, page bodies, spaces, restrictions, groups,
   and users. The sync must resolve effective per-user page readers; if permissions cannot be read,
   the page is marked unverifiable and its indexed content is removed.
3. Copy the Atlassian **Cloud ID** for the site.
4. Paste the Cloud ID and OAuth access token into TulipFarm's Confluence connect form.
5. Link Confluence accounts to TulipFarm users through external identity mappings. Unmapped
   Confluence accounts grant no Knowledge access.

TulipFarm stores only `secret://integration.confluence.CONFLUENCE_ACCESS_TOKEN` in Soul; the live
token is sealed in the Secrets store.
