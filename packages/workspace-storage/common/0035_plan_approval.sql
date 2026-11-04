-- Plan approval: a plan's reviewable content carries its own revision, separate from the progress version. Each content
-- revision keeps an allowlisted snapshot and its digest, and a starter approves one exact revision. A plan saved before
-- this migration gets its revision-1 snapshot when it is next changed or approved.
ALTER TABLE {{schema}}.tf_agent_plans
  ADD COLUMN content_revision integer NOT NULL DEFAULT 1 CHECK (content_revision > 0),
  ADD COLUMN content_sections jsonb CHECK (content_sections IS NULL OR jsonb_typeof(content_sections) = 'object');
CREATE TABLE {{schema}}.tf_agent_plan_revisions (
  plan_id uuid NOT NULL REFERENCES {{schema}}.tf_agent_plans(id),
  revision integer NOT NULL CHECK (revision > 0),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  change_kind text NOT NULL CHECK (change_kind IN ('starter','runtime')),
  created_by_membership_id uuid REFERENCES {{schema}}.tf_memberships(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (plan_id, revision)
);
CREATE TABLE {{schema}}.tf_agent_plan_approvals (
  plan_id uuid NOT NULL,
  revision integer NOT NULL,
  approved_by_membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  approved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  time_zone text NOT NULL CHECK (char_length(time_zone) BETWEEN 1 AND 64),
  request_id uuid NOT NULL UNIQUE,
  FOREIGN KEY (plan_id, revision) REFERENCES {{schema}}.tf_agent_plan_revisions(plan_id, revision)
);
CREATE INDEX tf_agent_plan_approvals_plan ON {{schema}}.tf_agent_plan_approvals (plan_id, approved_at DESC);
REVOKE ALL ON {{schema}}.tf_agent_plan_revisions, {{schema}}.tf_agent_plan_approvals FROM PUBLIC;
GRANT SELECT, INSERT ON {{schema}}.tf_agent_plan_revisions, {{schema}}.tf_agent_plan_approvals TO {{runtime}};
GRANT UPDATE (content_revision, content_sections) ON {{schema}}.tf_agent_plans TO {{runtime}};
