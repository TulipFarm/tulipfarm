-- One row for each enabled workflow whose active revision starts from a GitHub event, so the GitHub intake finds
-- the workspaces to notify without opening every workspace schema. NULL actions means every action of the event.
-- Generation fences a late delete from an older disable against a newer activation.
CREATE TABLE app.github_workflow_subscriptions (
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  workflow_id uuid NOT NULL,
  revision uuid NOT NULL,
  generation integer NOT NULL CHECK (generation > 0),
  repository_id text NOT NULL CHECK (repository_id ~ '^[1-9][0-9]{0,15}$'),
  event text NOT NULL CHECK (event ~ '^[a-z_]{1,64}$'),
  actions text[] CHECK (cardinality(actions) BETWEEN 1 AND 16),
  PRIMARY KEY (workspace_id,workflow_id)
);
CREATE INDEX github_workflow_subscriptions_event_idx ON app.github_workflow_subscriptions (repository_id,event);
REVOKE ALL ON TABLE app.github_workflow_subscriptions FROM PUBLIC;
