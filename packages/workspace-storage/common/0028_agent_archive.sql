-- An archived agent is hidden like a deleted one but keeps its owning team, name, grants and history so it can be restored.
ALTER TABLE {{schema}}.tf_agents
  ADD COLUMN archived_at timestamptz,
  ADD CONSTRAINT tf_agent_archived_hidden CHECK (archived_at IS NULL OR deleted_at IS NOT NULL);
GRANT UPDATE(archived_at) ON {{schema}}.tf_agents TO {{runtime}};
