-- A workflow can have several GitHub triggers, each listing repositories or naming one account whose repositories it
-- covers, including ones created later. One subscription row is kept per trigger, with its repositories in a child
-- table, so the GitHub intake still finds the workspaces to notify without opening every workspace schema. The
-- generation fence is unchanged. A subscription written before triggers had IDs belongs to the trigger with ID github.
ALTER TABLE app.github_workflow_subscriptions
  ADD COLUMN trigger_id text CHECK (trigger_id ~ '^[a-z][a-z0-9_]{0,47}$'),
  ADD COLUMN organization_id text CHECK (organization_id ~ '^[1-9][0-9]{0,19}$'),
  ADD COLUMN include_future boolean NOT NULL DEFAULT false,
  ADD COLUMN events jsonb;

CREATE TABLE app.github_workflow_subscription_repositories (
  workspace_id uuid NOT NULL,
  workflow_id uuid NOT NULL,
  trigger_id text NOT NULL,
  repository_id text NOT NULL CHECK (repository_id ~ '^[1-9][0-9]{0,19}$'),
  PRIMARY KEY (workspace_id,workflow_id,trigger_id,repository_id)
);
CREATE INDEX github_workflow_subscription_repositories_repository_idx
  ON app.github_workflow_subscription_repositories (repository_id);
REVOKE ALL ON TABLE app.github_workflow_subscription_repositories FROM PUBLIC;

UPDATE app.github_workflow_subscriptions SET trigger_id='github',
  events=jsonb_build_array(jsonb_build_object('event',event)
    || CASE WHEN actions IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('actions',to_jsonb(actions)) END);
INSERT INTO app.github_workflow_subscription_repositories (workspace_id,workflow_id,trigger_id,repository_id)
SELECT workspace_id,workflow_id,trigger_id,repository_id FROM app.github_workflow_subscriptions;

DROP INDEX app.github_workflow_subscriptions_event_idx;
ALTER TABLE app.github_workflow_subscriptions
  DROP CONSTRAINT github_workflow_subscriptions_pkey,
  DROP COLUMN repository_id,
  DROP COLUMN event,
  DROP COLUMN actions,
  ALTER COLUMN trigger_id SET NOT NULL,
  ALTER COLUMN events SET NOT NULL,
  ADD CONSTRAINT github_workflow_subscriptions_events_check
    CHECK (jsonb_typeof(events)='array' AND jsonb_array_length(events) BETWEEN 1 AND 8),
  ADD CONSTRAINT github_workflow_subscriptions_account_check CHECK (include_future = (organization_id IS NOT NULL)),
  ADD PRIMARY KEY (workspace_id,workflow_id,trigger_id);
ALTER TABLE app.github_workflow_subscription_repositories
  ADD FOREIGN KEY (workspace_id,workflow_id,trigger_id)
  REFERENCES app.github_workflow_subscriptions (workspace_id,workflow_id,trigger_id) ON DELETE CASCADE;
CREATE INDEX github_workflow_subscriptions_account_idx ON app.github_workflow_subscriptions (organization_id)
  WHERE organization_id IS NOT NULL;
