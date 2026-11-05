-- The agent a workflow was created for, so archiving or restoring the agent carries its trigger workflows.
-- archived_with_agent marks workflows the agent's archive took down, so restoring the agent restores only those.
ALTER TABLE {{schema}}.tf_workflows
  ADD COLUMN agent_id uuid REFERENCES {{schema}}.tf_agents(id),
  ADD COLUMN archived_with_agent boolean NOT NULL DEFAULT false;
CREATE INDEX tf_workflows_agent_idx ON {{schema}}.tf_workflows (agent_id) WHERE agent_id IS NOT NULL;
GRANT UPDATE (archived_with_agent) ON {{schema}}.tf_workflows TO {{runtime}};
