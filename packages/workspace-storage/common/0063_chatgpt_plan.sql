-- One Sign in with ChatGPT connection per member, used only for that member's own chats on their ChatGPT plan.
-- `credential` holds the encrypted access, refresh and ID tokens; `generation` is part of its encryption context and
-- grows with every sign-in. Signing out clears the tokens but keeps the issued client id and ChatGPT account, so the
-- next sign-in reuses the registration and must return the same account.
CREATE TABLE {{schema}}.tf_chatgpt_connections (
  owner_membership_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_memberships(id),
  generation integer NOT NULL DEFAULT 1 CHECK (generation > 0),
  state text NOT NULL CHECK (state IN ('connected', 'plan-disabled', 'reconnect-required', 'signed-out')),
  client_id text CHECK (client_id ~ '^[A-Za-z0-9._:-]{1,200}$'),
  subject text CHECK (char_length(subject) BETWEEN 1 AND 512),
  email text CHECK (char_length(email) <= 320),
  scopes text[] NOT NULL DEFAULT '{}',
  credential jsonb,
  expires_at timestamptz,
  welcome_acknowledged_at timestamptz,
  models jsonb CHECK (models IS NULL OR (jsonb_typeof(models) = 'array' AND octet_length(models::text) <= 65536)),
  models_fetched_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((state IN ('connected', 'plan-disabled')) = (credential IS NOT NULL)),
  CHECK (credential IS NULL OR (client_id IS NOT NULL AND subject IS NOT NULL AND expires_at IS NOT NULL))
);

-- A pending sign-in. The state is stored hashed; the PKCE verifier and OIDC nonce are encrypted. Attempts are single-use
-- and expire after ten minutes.
CREATE TABLE {{schema}}.tf_chatgpt_connection_attempts (
  id uuid PRIMARY KEY,
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  state_hash text NOT NULL UNIQUE CHECK (state_hash ~ '^[a-f0-9]{64}$'),
  mode text NOT NULL CHECK (mode IN ('connect', 'reconnect', 'enable-plan')),
  client_id text NOT NULL CHECK (client_id ~ '^[A-Za-z0-9._:-]{1,200}$'),
  redirect_uri text NOT NULL CHECK (redirect_uri ~ '^http://127\.0\.0\.1:[0-9]{1,5}/auth/callback$'),
  secret jsonb,
  status text NOT NULL CHECK (status IN ('pending', 'exchanging', 'completed', 'failed')),
  error_code text CHECK (error_code ~ '^[a-z-]{1,64}$'),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((status = 'pending') = (secret IS NOT NULL)),
  CHECK ((status = 'failed') = (error_code IS NOT NULL))
);
CREATE INDEX tf_chatgpt_connection_attempts_member ON {{schema}}.tf_chatgpt_connection_attempts (membership_id, created_at DESC);

REVOKE ALL ON {{schema}}.tf_chatgpt_connections, {{schema}}.tf_chatgpt_connection_attempts FROM PUBLIC;
GRANT SELECT, INSERT ON {{schema}}.tf_chatgpt_connections, {{schema}}.tf_chatgpt_connection_attempts TO {{runtime}};
GRANT UPDATE (generation, state, client_id, subject, email, scopes, credential, expires_at, welcome_acknowledged_at,
  models, models_fetched_at, updated_at) ON {{schema}}.tf_chatgpt_connections TO {{runtime}};
GRANT UPDATE (client_id, secret, status, error_code) ON {{schema}}.tf_chatgpt_connection_attempts TO {{runtime}};
