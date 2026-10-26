-- When a plan next rereads a saved agent's task whose sources couldn't be checked, and since when they couldn't.
-- The step skips the task until then, waiting longer the longer the sources stay unavailable, and pauses the plan
-- for attention once they have been unavailable for too long. A successful read clears both.
ALTER TABLE {{schema}}.tf_agent_plan_attempts
  ADD COLUMN source_check_after timestamptz,
  ADD COLUMN sources_unavailable_since timestamptz;
GRANT UPDATE (source_check_after, sources_unavailable_since) ON {{schema}}.tf_agent_plan_attempts TO {{runtime}};
