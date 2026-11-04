-- Deployment-wide identifiers that are generated once and never change, such as the host id this deployment sends to
-- Sign in with ChatGPT. They identify the deployment only, never a user.
CREATE TABLE app.deployment_identity (
  name text PRIMARY KEY CHECK (name ~ '^[a-z][a-z0-9-]{0,63}$'),
  value text NOT NULL CHECK (char_length(value) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON TABLE app.deployment_identity FROM PUBLIC;
