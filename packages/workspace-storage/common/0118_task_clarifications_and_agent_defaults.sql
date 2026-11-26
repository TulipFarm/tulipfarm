-- Structured clarification forms raised by agents working on assigned rows (Tasks, etc.).
-- Rendered inline on the task page, in Inbox, and as interactive Slack modals.
CREATE TABLE {{schema}}.tf_row_clarifications (
  id uuid PRIMARY KEY,
  table_id uuid NOT NULL,
  row_id uuid NOT NULL,
  agent_task_id uuid,
  agent_id uuid NOT NULL,
  sponsor_membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id) ON DELETE CASCADE,
  title text NOT NULL,
  summary text NOT NULL,
  fields jsonb NOT NULL,
  answers jsonb,
  status text NOT NULL CHECK (status IN ('open', 'answered', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  answered_at timestamptz,
  answered_by_membership_id uuid REFERENCES {{schema}}.tf_memberships(id) ON DELETE SET NULL,
  answered_via text CHECK (answered_via IS NULL OR answered_via IN ('web', 'slack'))
);

CREATE INDEX tf_row_clarifications_row_open_idx
  ON {{schema}}.tf_row_clarifications(table_id, row_id, created_at DESC)
  WHERE status = 'open';

CREATE INDEX tf_row_clarifications_task_idx
  ON {{schema}}.tf_row_clarifications(agent_task_id)
  WHERE agent_task_id IS NOT NULL;

REVOKE ALL ON {{schema}}.tf_row_clarifications FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON {{schema}}.tf_row_clarifications TO {{runtime}};
