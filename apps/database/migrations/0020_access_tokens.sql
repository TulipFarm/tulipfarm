-- External access: personal access tokens that let a member's own tools call the public API and the MCP server.
--
-- A workspace admin first turns external access on; until then no token for that workspace is accepted. A token
-- belongs to one member in one workspace and acts as that member, narrowed by its scopes and, optionally, a list of
-- tables. Only the SHA-256 digest of the token's secret is stored; the secret is shown once when it is created.
CREATE TABLE app.workspace_external_access (
  workspace_id uuid PRIMARY KEY REFERENCES app.workspaces(id) ON DELETE CASCADE,
  enabled boolean NOT NULL,
  changed_by uuid NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
REVOKE ALL ON TABLE app.workspace_external_access FROM PUBLIC;

CREATE TABLE app.access_tokens (
  id uuid PRIMARY KEY,
  secret_sha256 bytea NOT NULL UNIQUE CHECK (octet_length(secret_sha256) = 32),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  scopes text[] NOT NULL CHECK (
    cardinality(scopes) BETWEEN 1 AND 6
    AND scopes <@ ARRAY['tables:read', 'tables:write', 'files:read', 'files:write', 'agents:run', 'webhooks:manage']
  ),
  table_ids uuid[] CHECK (table_ids IS NULL OR cardinality(table_ids) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at timestamptz CHECK (expires_at IS NULL OR expires_at > created_at),
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid,
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
CREATE INDEX access_tokens_workspace ON app.access_tokens (workspace_id, created_at DESC);
CREATE INDEX access_tokens_owner ON app.access_tokens (workspace_id, user_id, created_at DESC);
REVOKE ALL ON TABLE app.access_tokens FROM PUBLIC;
