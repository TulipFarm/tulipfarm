-- Preview sessions for app drafts. An editor gets a one-time ticket for one preview host, and redeeming it once
-- turns the row into a session the preview cookie names. Only SHA-256 digests of the ticket and the cookie are
-- stored. A session dies with the sign-in session that requested it, so signing out ends every preview it opened.
CREATE TABLE app.app_preview_sessions (
  id uuid PRIMARY KEY,
  preview_key text NOT NULL REFERENCES app.app_preview_hosts(preview_key) ON DELETE CASCADE,
  auth_session_id uuid NOT NULL REFERENCES app.sessions(id) ON DELETE CASCADE,
  membership_id uuid NOT NULL,
  ticket_sha256 text NOT NULL UNIQUE CHECK (ticket_sha256 ~ '^[0-9a-f]{64}$'),
  ticket_expires_at timestamptz NOT NULL,
  token_sha256 text UNIQUE CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
  redeemed_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((token_sha256 IS NULL) = (redeemed_at IS NULL)),
  CHECK (ticket_expires_at <= expires_at)
);
CREATE INDEX app_preview_sessions_auth_session ON app.app_preview_sessions (auth_session_id);
CREATE INDEX app_preview_sessions_expiry ON app.app_preview_sessions (expires_at);
REVOKE ALL ON TABLE app.app_preview_sessions FROM PUBLIC;
