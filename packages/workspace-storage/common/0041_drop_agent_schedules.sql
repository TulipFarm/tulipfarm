-- Agent schedules are gone; a cron or interval Workflow with an agent step replaces them.
-- Scheduled runs stay as history, but none is left running and no new one can start.
UPDATE {{schema}}.tf_agent_tool_calls c SET status = 'blocked'
FROM {{schema}}.tf_agent_runs r
WHERE r.id = c.run_id AND r.kind = 'scheduled' AND c.status IN ('pending', 'waiting');
UPDATE {{schema}}.tf_agent_runs SET status = 'cancelled'
WHERE kind = 'scheduled' AND status IN ('ready', 'running', 'waiting');

-- Dropping schedule_id also drops its foreign keys, index and the run kind check that named it.
ALTER TABLE {{schema}}.tf_agent_tasks DROP COLUMN schedule_id;
ALTER TABLE {{schema}}.tf_agent_runs DROP COLUMN schedule_id;
ALTER TABLE {{schema}}.tf_agent_runs ADD CONSTRAINT tf_agent_run_kind CHECK (
  (kind = 'delegated' AND user_id IS NOT NULL AND membership_id IS NOT NULL)
  OR (kind = 'scheduled' AND user_id IS NULL AND membership_id IS NULL AND status IN ('completed', 'blocked', 'cancelled'))
);

DROP TABLE {{schema}}.tf_agent_schedule_audience;
DROP TABLE {{schema}}.tf_agent_schedules;
