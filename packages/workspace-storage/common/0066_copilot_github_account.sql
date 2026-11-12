-- A Copilot connection can use the member's personal GitHub account instead of a token of its own, so one GitHub
-- sign-in serves both. Such a connection stores no credential: GitHub refresh tokens are single use, so the token is
-- always read, and renewed, through tf_github_accounts.
ALTER TABLE {{schema}}.tf_subscription_connections
  ADD COLUMN github_account_id uuid REFERENCES {{schema}}.tf_github_accounts(id),
  ADD CONSTRAINT tf_subscription_connections_github_account_check CHECK (
    github_account_id IS NULL OR (provider = 'copilot' AND credential IS NULL)
  ),
  DROP CONSTRAINT tf_subscription_connections_check,
  ADD CONSTRAINT tf_subscription_connections_check CHECK (
    github_account_id IS NOT NULL OR (state IN ('connected', 'plan-disabled')) = (credential IS NOT NULL)
  );
CREATE INDEX tf_subscription_connections_github_account ON {{schema}}.tf_subscription_connections (github_account_id)
  WHERE github_account_id IS NOT NULL;
GRANT UPDATE (github_account_id) ON {{schema}}.tf_subscription_connections TO {{runtime}};
