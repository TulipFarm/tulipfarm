-- Secrets: values members store for agents to send to allowed destinations, never shown back. A secret is suspended
-- while its owner's membership is removed and expired once expires_at passes; both are read from other columns.
CREATE TABLE {{schema}}.tf_secrets (
  id uuid PRIMARY KEY,
  owner_membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  kind text NOT NULL CHECK (kind IN ('api-key','token','password','username-password','header')),
  placement jsonb NOT NULL CHECK (placement->>'kind' IN ('bearer','basic','header','cookie','query','body')),
  placement_source text NOT NULL CHECK (placement_source IN ('agent','member')),
  lifetime text NOT NULL CHECK (lifetime IN ('conversation','saved')),
  origin jsonb CHECK (origin->>'kind' IN ('chat','task')),
  expires_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  policy_version integer NOT NULL DEFAULT 1 CHECK (policy_version > 0),
  credential jsonb,
  status text NOT NULL CHECK (status IN ('active','deleted')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  replaced_at timestamptz,
  deleted_at timestamptz,
  last_used_at timestamptz,
  CHECK ((lifetime = 'conversation') = (origin IS NOT NULL)),
  CHECK (lifetime <> 'conversation' OR expires_at IS NOT NULL),
  CHECK ((status = 'active') = (credential IS NOT NULL)),
  CHECK ((status = 'deleted') = (deleted_at IS NOT NULL))
);
CREATE INDEX tf_secrets_owner ON {{schema}}.tf_secrets (owner_membership_id) WHERE status = 'active';
CREATE INDEX tf_secrets_expiry ON {{schema}}.tf_secrets (expires_at) WHERE status = 'active' AND expires_at IS NOT NULL;
CREATE INDEX tf_secrets_origin ON {{schema}}.tf_secrets ((origin->>'conversationId'), (origin->>'runId'))
  WHERE status = 'active' AND lifetime = 'conversation';
CREATE TABLE {{schema}}.tf_secret_destinations (
  secret_id uuid NOT NULL REFERENCES {{schema}}.tf_secrets(id),
  kind text NOT NULL CHECK (kind IN ('host','endpoint')),
  value text NOT NULL CHECK (char_length(value) BETWEEN 1 AND 4096),
  PRIMARY KEY (secret_id, kind, value)
);
CREATE TABLE {{schema}}.tf_secret_grants (
  secret_id uuid NOT NULL REFERENCES {{schema}}.tf_secrets(id),
  grantee text NOT NULL,
  membership_id uuid REFERENCES {{schema}}.tf_memberships(id),
  team_id uuid REFERENCES {{schema}}.tf_teams(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('use','manage')),
  granted_by uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (secret_id, grantee),
  CHECK (
    (grantee = 'workspace' AND membership_id IS NULL AND team_id IS NULL)
    OR (grantee = 'member:' || membership_id::text AND team_id IS NULL)
    OR (grantee = 'team:' || team_id::text AND membership_id IS NULL)
  )
);
CREATE INDEX tf_secret_grants_member ON {{schema}}.tf_secret_grants (membership_id) WHERE membership_id IS NOT NULL;
CREATE INDEX tf_secret_grants_team ON {{schema}}.tf_secret_grants (team_id) WHERE team_id IS NOT NULL;
CREATE TABLE {{schema}}.tf_secret_requests (
  id uuid PRIMARY KEY,
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  origin jsonb NOT NULL CHECK (origin->>'kind' IN ('chat','task')),
  purpose text NOT NULL CHECK (char_length(purpose) BETWEEN 1 AND 500),
  fields jsonb NOT NULL CHECK (jsonb_typeof(fields) = 'array'),
  destinations jsonb NOT NULL CHECK (jsonb_typeof(destinations) = 'array'),
  status text NOT NULL CHECK (status IN ('waiting','provided','declined','expired','cancelled')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  decline_reason text CHECK (char_length(decline_reason) <= 500),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  settled_at timestamptz,
  CHECK ((status = 'waiting') = (settled_at IS NULL))
);
CREATE INDEX tf_secret_requests_waiting ON {{schema}}.tf_secret_requests (expires_at) WHERE status = 'waiting';
CREATE TABLE {{schema}}.tf_secret_references (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES {{schema}}.tf_secret_requests(id),
  field_id text NOT NULL,
  secret_id uuid NOT NULL REFERENCES {{schema}}.tf_secrets(id),
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  origin jsonb NOT NULL CHECK (origin->>'kind' IN ('chat','task')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (request_id, field_id)
);
CREATE INDEX tf_secret_references_secret ON {{schema}}.tf_secret_references (secret_id);
CREATE TABLE {{schema}}.tf_secret_events (
  id uuid PRIMARY KEY,
  secret_id uuid NOT NULL REFERENCES {{schema}}.tf_secrets(id),
  actor_membership_id uuid REFERENCES {{schema}}.tf_memberships(id),
  operation text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX tf_secret_events_secret ON {{schema}}.tf_secret_events (secret_id, created_at);
CREATE TABLE {{schema}}.tf_secret_commands (
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  request_id uuid NOT NULL,
  kind text NOT NULL,
  digest text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (membership_id, request_id)
);
REVOKE ALL ON {{schema}}.tf_secrets, {{schema}}.tf_secret_destinations, {{schema}}.tf_secret_grants,
  {{schema}}.tf_secret_requests, {{schema}}.tf_secret_references, {{schema}}.tf_secret_events,
  {{schema}}.tf_secret_commands FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON {{schema}}.tf_secrets, {{schema}}.tf_secret_requests TO {{runtime}};
GRANT SELECT, INSERT, DELETE ON {{schema}}.tf_secret_destinations, {{schema}}.tf_secret_grants TO {{runtime}};
GRANT SELECT, INSERT ON {{schema}}.tf_secret_references, {{schema}}.tf_secret_events, {{schema}}.tf_secret_commands
  TO {{runtime}};
