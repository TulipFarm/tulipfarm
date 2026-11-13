-- An MCP integration may run an npm or PyPI package on a sandbox host instead of reaching a remote endpoint. A hosted
-- integration stores its package and network allowlist; its credential holds the encrypted environment bindings, and
-- its endpoint is a synthetic, non-resolving key derived from the package name.
ALTER TABLE {{schema}}.tf_mcp_integrations DROP CONSTRAINT tf_mcp_integrations_auth_method_check;
ALTER TABLE {{schema}}.tf_mcp_integrations
  ADD CONSTRAINT tf_mcp_integrations_auth_method_check
    CHECK (auth_method IN ('none','bearer','headers','oauth','secret-bearer','secret-headers','hosted')),
  ADD COLUMN kind text NOT NULL DEFAULT 'remote' CHECK (kind IN ('remote','hosted')),
  ADD COLUMN package jsonb CHECK (package IS NULL OR (jsonb_typeof(package) = 'object' AND octet_length(package::text) <= 16384)),
  ADD COLUMN egress jsonb CHECK (egress IS NULL OR (jsonb_typeof(egress) = 'array' AND octet_length(egress::text) <= 16384)),
  ADD CONSTRAINT tf_mcp_integrations_hosted_check
    CHECK ((kind = 'hosted') = (package IS NOT NULL AND egress IS NOT NULL) AND (kind = 'hosted') = (auth_method = 'hosted'));
GRANT UPDATE (package,egress) ON {{schema}}.tf_mcp_integrations TO {{runtime}};

-- The transport a remote integration's last discovery detected: Streamable HTTP, or the older HTTP+SSE it falls back
-- to. NULL until discovered, and reset when the endpoint changes, so the next request detects it again.
ALTER TABLE {{schema}}.tf_mcp_integrations
  ADD COLUMN transport text CHECK (transport IN ('streamable-http','sse'));
GRANT UPDATE (transport) ON {{schema}}.tf_mcp_integrations TO {{runtime}};

-- A tool revision's contract never changes, but whether TulipFarm can run it follows the current schema checker, so
-- rediscovery refreshes that verdict.
GRANT UPDATE (compatibility_reason) ON {{schema}}.tf_mcp_tool_revisions TO {{runtime}};

-- The sandbox that runs a hosted integration. A worker claims the next generation with a compare-and-swap before it
-- provisions, and every later write names the generation it observed, so two workers never both own one sandbox.
CREATE TABLE {{schema}}.tf_mcp_hosts (
  integration_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_mcp_integrations(id),
  generation integer NOT NULL DEFAULT 0 CHECK (generation >= 0),
  sandbox_id text CHECK (char_length(sandbox_id) BETWEEN 1 AND 256),
  fingerprint text CHECK (char_length(fingerprint) <= 128),
  launched jsonb CHECK (launched IS NULL OR jsonb_typeof(launched) = 'object'),
  claimed_at timestamptz,
  ready_at timestamptz
);
REVOKE ALL ON {{schema}}.tf_mcp_hosts FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON {{schema}}.tf_mcp_hosts TO {{runtime}};

-- Package builds a workspace started, for its daily build limit.
CREATE TABLE {{schema}}.tf_mcp_builds (
  id uuid PRIMARY KEY,
  integration_id uuid NOT NULL REFERENCES {{schema}}.tf_mcp_integrations(id),
  package_key text NOT NULL CHECK (char_length(package_key) BETWEEN 1 AND 512),
  outcome text NOT NULL DEFAULT 'started' CHECK (outcome IN ('started','ready','failed')),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX tf_mcp_builds_started ON {{schema}}.tf_mcp_builds (started_at);
CREATE INDEX tf_mcp_builds_package ON {{schema}}.tf_mcp_builds (package_key) WHERE outcome = 'ready';
REVOKE ALL ON {{schema}}.tf_mcp_builds FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON {{schema}}.tf_mcp_builds TO {{runtime}};

-- A secret's owner may let one hosted MCP server identity read the secret's real value. Replacing or deleting the
-- secret, or changing its destinations, removes the grant.
CREATE TABLE {{schema}}.tf_secret_reveals (
  secret_id uuid NOT NULL REFERENCES {{schema}}.tf_secrets(id),
  server_identity text NOT NULL CHECK (server_identity ~ '^[0-9a-f]{64}$'),
  granted_by uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  granted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (secret_id, server_identity)
);
REVOKE ALL ON {{schema}}.tf_secret_reveals FROM PUBLIC;
GRANT SELECT, INSERT, DELETE ON {{schema}}.tf_secret_reveals TO {{runtime}};
