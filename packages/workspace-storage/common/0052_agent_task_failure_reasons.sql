-- Why a task failed, so its owner sees the reason and telemetry can tell designed refusals from faults.
ALTER TABLE {{schema}}.tf_agent_tasks
  ADD COLUMN failure_reason text CHECK (failure_reason IN ('authority-revoked', 'internal'));

GRANT UPDATE (failure_reason) ON {{schema}}.tf_agent_tasks TO {{runtime}};

CREATE FUNCTION {{schema}}.tf_clear_task_failure_reason() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.status <> 'failed' THEN
    NEW.failure_reason := NULL;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION {{schema}}.tf_clear_task_failure_reason() FROM PUBLIC;

CREATE TRIGGER tf_clear_task_failure_reason
BEFORE INSERT OR UPDATE OF status, failure_reason ON {{schema}}.tf_agent_tasks
FOR EACH ROW EXECUTE FUNCTION {{schema}}.tf_clear_task_failure_reason();

-- A task whose model keeps choosing steps it cannot take pauses for the owner instead of failing.
ALTER TABLE {{schema}}.tf_agent_tasks
  DROP CONSTRAINT tf_agent_tasks_pause_reason_check,
  ADD CONSTRAINT tf_agent_tasks_pause_reason_check CHECK (pause_reason IN (
    'user', 'limit.toolCalls', 'limit.activeTime', 'limit.credits',
    'limit.steps', 'limit.workspaceCredits', 'model', 'context', 'file', 'plan', 'approval', 'decision'
  ));
