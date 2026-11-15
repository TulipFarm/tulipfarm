-- A shared MCP integration may be shared with the whole workspace instead of listed members and teams, so members who
-- join later can use it too and removed members lose it.
ALTER TABLE {{schema}}.tf_mcp_integrations
  ADD COLUMN shared_with_workspace boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT tf_mcp_integrations_workspace_share_check CHECK (NOT shared_with_workspace OR ownership = 'shared');
GRANT UPDATE (shared_with_workspace) ON {{schema}}.tf_mcp_integrations TO {{runtime}};
