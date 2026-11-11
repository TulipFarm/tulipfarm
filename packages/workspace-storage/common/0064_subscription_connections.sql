-- A member's own model plan (ChatGPT, Claude or GitHub Copilot), connected once per provider. Model calls can run on it
-- for the owner and for anyone it is shared with in tf_subscription_grants. `credential` holds the encrypted
-- provider tokens; `generation` is part of its encryption context and grows with every sign-in. Signing out clears the
-- tokens but keeps the issued client id and account, so the next sign-in reuses the registration and must return the
-- same account. `disabled_models` lists model slugs the owner turned off, for themselves and everyone it is shared with.
-- `cooldown_until` skips a plan that reported a usage limit; `last_used_at` spreads use across shares.
CREATE TABLE {{schema}}.tf_subscription_connections (
  id uuid PRIMARY KEY,
  provider text NOT NULL CHECK (provider IN ('chatgpt', 'claude', 'copilot')),
  owner_membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  generation integer NOT NULL DEFAULT 1 CHECK (generation > 0),
  state text NOT NULL CHECK (state IN ('connected', 'plan-disabled', 'reconnect-required', 'signed-out')),
  client_id text CHECK (client_id ~ '^[A-Za-z0-9._:-]{1,200}$'),
  subject text CHECK (char_length(subject) BETWEEN 1 AND 512),
  email text CHECK (char_length(email) <= 320),
  plan text CHECK (char_length(plan) <= 100),
  scopes text[] NOT NULL DEFAULT '{}',
  credential jsonb,
  expires_at timestamptz,
  welcome_acknowledged_at timestamptz,
  models jsonb CHECK (models IS NULL OR (jsonb_typeof(models) = 'array' AND octet_length(models::text) <= 65536)),
  models_fetched_at timestamptz,
  disabled_models text[] NOT NULL DEFAULT '{}' CHECK (cardinality(disabled_models) <= 200),
  cooldown_until timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (owner_membership_id, provider),
  CHECK ((state IN ('connected', 'plan-disabled')) = (credential IS NOT NULL)),
  CHECK (provider <> 'chatgpt' OR credential IS NULL OR (client_id IS NOT NULL AND subject IS NOT NULL AND expires_at IS NOT NULL))
);

-- Who may use (or manage the shares of) a connection: one member, a team, or the whole workspace. A workspace grant
-- covers every active member at the time of use, and memberless runs such as Slack.
CREATE TABLE {{schema}}.tf_subscription_grants (
  connection_id uuid NOT NULL REFERENCES {{schema}}.tf_subscription_connections(id) ON DELETE CASCADE,
  grantee text NOT NULL,
  membership_id uuid REFERENCES {{schema}}.tf_memberships(id),
  team_id uuid REFERENCES {{schema}}.tf_teams(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('use', 'manage')),
  granted_by uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (connection_id, grantee),
  CHECK (
    (grantee = 'workspace' AND membership_id IS NULL AND team_id IS NULL)
    OR (grantee = 'member:' || membership_id::text AND team_id IS NULL)
    OR (grantee = 'team:' || team_id::text AND membership_id IS NULL)
  )
);
CREATE INDEX tf_subscription_grants_member ON {{schema}}.tf_subscription_grants (membership_id) WHERE membership_id IS NOT NULL;
CREATE INDEX tf_subscription_grants_team ON {{schema}}.tf_subscription_grants (team_id) WHERE team_id IS NOT NULL;

-- A pending OAuth sign-in. The state is stored hashed; the PKCE verifier and OIDC nonce are encrypted. Attempts are
-- single-use and expire after ten minutes.
CREATE TABLE {{schema}}.tf_subscription_connection_attempts (
  id uuid PRIMARY KEY,
  provider text NOT NULL CHECK (provider IN ('chatgpt', 'claude', 'copilot')),
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  state_hash text NOT NULL UNIQUE CHECK (state_hash ~ '^[a-f0-9]{64}$'),
  mode text NOT NULL CHECK (mode IN ('connect', 'reconnect', 'enable-plan')),
  client_id text NOT NULL CHECK (client_id ~ '^[A-Za-z0-9._:-]{1,200}$'),
  redirect_uri text NOT NULL CHECK (redirect_uri ~ '^(http://127\.0\.0\.1:[0-9]{1,5}/auth/callback|https://[^\s]{1,500})$'),
  secret jsonb,
  status text NOT NULL CHECK (status IN ('pending', 'exchanging', 'completed', 'failed')),
  error_code text CHECK (error_code ~ '^[a-z-]{1,64}$'),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((status = 'pending') = (secret IS NOT NULL)),
  CHECK ((status = 'failed') = (error_code IS NOT NULL))
);
CREATE INDEX tf_subscription_connection_attempts_member
  ON {{schema}}.tf_subscription_connection_attempts (membership_id, created_at DESC);

REVOKE ALL ON {{schema}}.tf_subscription_connections, {{schema}}.tf_subscription_grants,
  {{schema}}.tf_subscription_connection_attempts FROM PUBLIC;
GRANT SELECT, INSERT ON {{schema}}.tf_subscription_connections, {{schema}}.tf_subscription_connection_attempts TO {{runtime}};
GRANT SELECT, INSERT, DELETE ON {{schema}}.tf_subscription_grants TO {{runtime}};
GRANT UPDATE (generation, state, client_id, subject, email, plan, scopes, credential, expires_at, welcome_acknowledged_at,
  models, models_fetched_at, disabled_models, cooldown_until, last_used_at, updated_at) ON {{schema}}.tf_subscription_connections TO {{runtime}};
GRANT UPDATE (client_id, secret, status, error_code) ON {{schema}}.tf_subscription_connection_attempts TO {{runtime}};
