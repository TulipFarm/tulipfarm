# Connect Notion

One Notion internal integration powers two things: **agent tools** (search, read, and write pages)
and, optionally, **Knowledge sync** (indexing shared pages so agents can cite them). Both use the
same token — there is nothing extra to create for the second.

Notion access is **per-page**: the token you paste here grants nothing until you explicitly share
pages with the integration. That's Notion's design, and it means step 3 is not optional — without
it, every tool call comes back empty.

1. Go to https://www.notion.so/my-integrations → **New integration**. Name it "TulipFarm", pick the
   workspace it should serve, and set **Content Capabilities** to Read, Update, and Insert content.
   Leave *user information* off unless you need it — agents don't.
2. Open the integration → **Configuration** tab → copy the **Internal Integration Secret**. That's
   `NOTION_ACCESS_TOKEN` (it starts with `ntn_`, or `secret_` on older integrations).
3. Share pages with it. In Notion, open a page you want agents to work with → **•••** menu →
   **Connections** → pick TulipFarm. Everything nested under that page is shared too, so sharing one
   top-level page is usually enough. Databases are shared the same way.

That is everything the agent tools need. The next section applies only if you also want Notion
pages indexed into Knowledge.

## Optional: index pages into Knowledge

Knowledge sync makes Notion pages retrievable and citable in chat, and it enforces per-user access.
It needs two more values:

- `NOTION_WORKSPACE_ID` — your workspace identifier, used to track sync position.
- `NOTION_READER_PROPERTY` — the name of a People or email property on each page that lists who may
  read it (for example `TulipFarm Readers`).

The reader property is required because **Notion's public API does not expose effective page
sharing**. TulipFarm cannot ask Notion "who can see this page?", so it reads the property you
nominate instead. If that property is missing or unreadable on a page, the page is treated as
unverifiable and its indexed content is removed rather than shown to someone who may not be
entitled to it. Link the Notion users named there to TulipFarm users through external identity
mappings so the check resolves.

Leave both blank to skip Knowledge sync entirely; agent tools are unaffected.

## Why an internal integration and not OAuth

Notion's OAuth flow exists for public integrations that serve many workspaces, and using it means
submitting yours to Notion for review. A self-hosted TulipFarm serves one workspace, where an
internal integration is Notion's own recommended path — same API, same permissions, no review.

## What agents can do once connected

`search` finds pages and databases by title. `read_page` returns a page's properties and
`read_page_content` returns its body. `create_page`, `update_page`, and `append_page_content` write
back. `read_database_schema` and `query_database` cover databases.

Writes are approval-gated like any other mutating tool, so an agent proposes the change and you
confirm it before it reaches Notion.

## If tools return nothing

Almost always step 3. A token with no shared pages is valid — it just sees an empty workspace.
Open the page in Notion and check the **Connections** section of its ••• menu lists TulipFarm.
