# Connect Notion

Notion's permission model is share-based: an integration sees **nothing** until you explicitly
share a page or database with it. That makes the connection safe by default and quiet by default —
if a search returns no results, the usual cause is that nothing has been shared yet.

## Create the integration

1. Open <https://www.notion.so/profile/integrations> and choose **New integration**.
2. Pick the workspace, name it (for example `TulipFarm`), and create it.
3. Under **Capabilities**, leave *Read content* on. Add *Update content* only if agents should
   write.
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

`notion_search` is paginated by the runtime: an agent receives an opaque `page_token` and hands it
back, never Notion's own cursor.

## Rotating the secret

Regenerate it on the integration's page, then paste the new value over the Connection. Sharing is
unaffected.
