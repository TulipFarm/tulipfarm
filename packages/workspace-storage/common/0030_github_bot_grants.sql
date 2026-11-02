-- Workspace admins let a member post as the TulipFarm GitHub App bot, one repository at a time. A decision records who posts.
CREATE TABLE {{schema}}.tf_github_bot_grants (
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  repository text NOT NULL CHECK (repository ~ '^[a-z0-9][a-z0-9-]{0,38}/[a-z0-9._-]{1,100}$'),
  granted_by uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (membership_id, repository)
);
REVOKE ALL ON {{schema}}.tf_github_bot_grants FROM PUBLIC;
GRANT SELECT, INSERT, DELETE ON {{schema}}.tf_github_bot_grants TO {{runtime}};
GRANT SELECT ON {{schema}}.tf_github_bot_grants TO {{confirmation}};
ALTER TABLE {{schema}}.tf_github_batch_decisions
  ADD COLUMN author text NOT NULL DEFAULT 'member' CHECK (author IN ('member', 'bot'));
GRANT INSERT (author) ON {{schema}}.tf_github_batch_decisions TO {{confirmation}};
