-- A task owner may say why they rejected a proposal. Agents learn from the reason.
ALTER TABLE {{schema}}.tf_agent_task_decisions
  ADD COLUMN reason text CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 500);
GRANT INSERT (reason) ON {{schema}}.tf_agent_task_decisions TO {{confirmation}};

-- One row per task whose runs an agent may learn from. A status change or a decision makes it due; `learned` holds
-- the keys of evidence already learned, never the evidence itself, so nothing is learned twice.
CREATE TABLE {{schema}}.tf_agent_lesson_jobs (
  task_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_agent_tasks (id) ON DELETE CASCADE,
  agent_id uuid NOT NULL,
  due_at timestamptz,
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  learned jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(learned) = 'array')
);
CREATE INDEX tf_agent_lesson_jobs_due ON {{schema}}.tf_agent_lesson_jobs (due_at) WHERE due_at IS NOT NULL;
REVOKE ALL ON {{schema}}.tf_agent_lesson_jobs FROM PUBLIC;
GRANT SELECT, UPDATE (due_at, lease_until, attempts, learned) ON TABLE {{schema}}.tf_agent_lesson_jobs TO {{runtime}};

CREATE FUNCTION {{schema}}.tf_agent_lesson_due(task uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  INSERT INTO {{schema}}.tf_agent_lesson_jobs (task_id, agent_id, due_at)
  SELECT id, agent_id, clock_timestamp() + interval '30 seconds' FROM {{schema}}.tf_agent_tasks WHERE id = task
  ON CONFLICT (task_id) DO UPDATE SET due_at = EXCLUDED.due_at, attempts = 0;
END;
$$;
REVOKE ALL ON FUNCTION {{schema}}.tf_agent_lesson_due(uuid) FROM PUBLIC;

CREATE FUNCTION {{schema}}.tf_agent_task_lesson_due() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  PERFORM {{schema}}.tf_agent_lesson_due(NEW.id);
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION {{schema}}.tf_agent_task_lesson_due() FROM PUBLIC;
CREATE TRIGGER tf_agent_tasks_lesson_due AFTER UPDATE OF status ON {{schema}}.tf_agent_tasks
  FOR EACH ROW WHEN (NEW.status <> 'pending' AND NEW.status IS DISTINCT FROM OLD.status)
  EXECUTE FUNCTION {{schema}}.tf_agent_task_lesson_due();

CREATE FUNCTION {{schema}}.tf_agent_decision_lesson_due() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  PERFORM {{schema}}.tf_agent_lesson_due(p.task_id) FROM {{schema}}.tf_agent_task_proposals p WHERE p.id = NEW.proposal_id;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION {{schema}}.tf_agent_decision_lesson_due() FROM PUBLIC;
CREATE TRIGGER tf_agent_task_decisions_lesson_due AFTER INSERT ON {{schema}}.tf_agent_task_decisions
  FOR EACH ROW EXECUTE FUNCTION {{schema}}.tf_agent_decision_lesson_due();
