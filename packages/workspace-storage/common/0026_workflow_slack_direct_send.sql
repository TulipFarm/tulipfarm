-- Workflow Slack steps post without a per-send approval; actions already waiting for approval keep it.
CREATE OR REPLACE FUNCTION {{schema}}.tf_slack_action_origin() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM {{schema}}.tf_agent_tool_calls WHERE id=NEW.id AND run_id=NEW.run_id AND call=NEW.action)
     AND NOT EXISTS (SELECT 1 FROM {{schema}}.tf_slack_conversation_actions WHERE id=NEW.id AND turn_id=NEW.run_id AND action=NEW.action)
     AND NOT EXISTS (
       SELECT 1 FROM {{schema}}.tf_slack_workflow_actions o
       JOIN {{schema}}.tf_workflow_runs r ON r.id=o.run_id AND r.workflow_id=o.workflow_id AND r.revision=o.revision
       JOIN {{schema}}.tf_workflow_revisions d ON d.workflow_id=r.workflow_id AND d.id=r.revision
       JOIN {{schema}}.tf_workflow_steps s ON s.run_id=r.id AND s.step_id=o.step_id
       WHERE o.id=NEW.id AND o.run_id=NEW.run_id AND o.action=NEW.action
         AND NEW.action->>'tool'='slack.message.send'
         AND r.membership_id=NEW.membership_id AND s.status='waiting'
         AND EXISTS (SELECT 1 FROM jsonb_array_elements(d.definition->'steps') step
           WHERE step->>'id'=o.step_id AND step->>'kind'='slack-message'
             AND step->>'destinationId'=NEW.action->>'destinationId')
     ) THEN
    RAISE EXCEPTION 'Slack action requires an exact persisted origin';
  END IF;
  RETURN NEW;
END
$$;
