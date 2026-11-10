-- An MCP integration may authenticate with saved secrets. Its credential then holds only secret IDs, and
-- tf_mcp_integration_secrets lists them so a change to a secret can find the integrations that send it. Discovery
-- for these integrations runs in the worker, which alone may decrypt secrets; discovery records whether a worker job
-- is queued or failed, and status_reason says why an integration needs attention. An action records the secret
-- versions it was proposed with, so a secret replaced before dispatch stops it.
ALTER TABLE {{schema}}.tf_mcp_integrations DROP CONSTRAINT tf_mcp_integrations_auth_method_check;
ALTER TABLE {{schema}}.tf_mcp_integrations
  ADD CONSTRAINT tf_mcp_integrations_auth_method_check
    CHECK (auth_method IN ('none','bearer','headers','oauth','secret-bearer','secret-headers')),
  ADD COLUMN discovery text CHECK (discovery IN ('queued','failed')),
  ADD COLUMN status_reason text CHECK (char_length(status_reason) <= 500);
GRANT UPDATE (discovery,status_reason) ON {{schema}}.tf_mcp_integrations TO {{runtime}};

CREATE TABLE {{schema}}.tf_mcp_integration_secrets (
  integration_id uuid NOT NULL REFERENCES {{schema}}.tf_mcp_integrations(id),
  secret_id uuid NOT NULL REFERENCES {{schema}}.tf_secrets(id),
  PRIMARY KEY (integration_id, secret_id)
);
CREATE INDEX tf_mcp_integration_secrets_secret ON {{schema}}.tf_mcp_integration_secrets (secret_id);
REVOKE ALL ON {{schema}}.tf_mcp_integration_secrets FROM PUBLIC;
GRANT SELECT, INSERT, DELETE ON {{schema}}.tf_mcp_integration_secrets TO {{runtime}};
GRANT SELECT ON {{schema}}.tf_mcp_integration_secrets TO {{confirmation}};

ALTER TABLE {{schema}}.tf_mcp_actions
  ADD COLUMN secrets jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(secrets) = 'array');
