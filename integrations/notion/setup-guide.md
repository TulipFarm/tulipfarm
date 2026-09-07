# Connect Notion

Notion's permission model is share-based: an integration sees **nothing** until you explicitly
share a page or database with it. That makes the connection safe by default and quiet by default —
if a search returns no results, the usual cause is that nothing has been shared yet.

## Create the integration

1. Open <https://www.notion.so/profile/integrations> and choose **New integration**.
2. Pick the workspace, name it (for example `TulipFarm`), and create it.
3. Under **Capabilities**, leave *Read content* on. Add *Insert content* only if agents should
   create pages or append blocks.
4. Copy the **Internal Integration Secret**.

## Share what agents may see

For each page or database: open it → **⋯ → Connections → Connect to →** your integration.
Sharing a parent page shares everything beneath it.

## Connect it

Open **Integrations → Notion → Connect** and paste the secret.

## What agents can do

| Tool | What it does |
| --- | --- |
| `notion_search` | Searches shared pages and databases by title |
| `notion_get_page` | Reads one page's properties by id |
| `notion_list_users` | Lists workspace members |
| `notion_get_block_children` | Reads the first-level content blocks under a page or block |
| `notion_query_database` | Queries pages in a database |
| `notion_create_page` | Creates a page under a shared page or database |
| `notion_append_block_children` | Appends up to 100 blocks to a page or block |

Search, database queries, page blocks, and users are paginated by the runtime: an agent receives an
opaque `page_token` and hands it back, never Notion's own cursor.

This package pins `Notion-Version: 2022-06-28`. At that version, the query endpoint is called
**Query a database**. Notion renamed that operation to **Query a data source** in the
`2025-09-03` API version.

## Rotating the secret

Regenerate it on the integration's page, then paste the new value over the Connection. Sharing is
unaffected.
