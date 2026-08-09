# Connect Notion

1. Create a Notion internal integration and grant it read access to the pages/databases to index.
2. Paste the Workspace ID and token into TulipFarm's Notion connect form.
3. Configure a People/email property such as `TulipFarm Readers` that lists the Notion users who
   may read each page, then enter that property name as `NOTION_READER_PROPERTY`.
4. Link those Notion user ids or emails to TulipFarm users through external identity mappings.

The Notion public API does not expose effective page-sharing ACLs. If TulipFarm cannot read the
configured reader property for a page, the page is marked unverifiable and its indexed content is
removed rather than exposed.
