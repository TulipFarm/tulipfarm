-- Requests that the app gateway is serving to a public app's server right now. The gateway hands the app an opaque
-- handle for each one, and the app presents it to act for that request. Only the SHA-256 digest of the handle is
-- stored. A row lives for a minute unless the gateway renews it, and closing the request deletes it. The rows are
-- worthless after a crash, so the table skips the write-ahead log.
CREATE UNLOGGED TABLE app.app_live_requests (
  handle_sha256 bytea PRIMARY KEY CHECK (octet_length(handle_sha256) = 32),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  app_id uuid NOT NULL,
  release_id uuid NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX app_live_requests_expiry ON app.app_live_requests (expires_at);
REVOKE ALL ON TABLE app.app_live_requests FROM PUBLIC;
