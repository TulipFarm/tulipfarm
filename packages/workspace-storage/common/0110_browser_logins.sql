-- Browser logins: the saved signed-in state (cookies and site storage) of one account on one site, encrypted, for
-- loading into browser sessions. Nobody can read a login back. A login is suspended while its owner's membership is
-- removed, read from tf_memberships.
CREATE TABLE {{schema}}.tf_browser_logins (
  id uuid PRIMARY KEY,
  owner_membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  site text NOT NULL CHECK (char_length(site) BETWEEN 1 AND 253),
  state jsonb,
  -- Rises with every saved state, so a session can tell whether it loaded the latest one.
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  needs_sign_in boolean NOT NULL DEFAULT false,
  status text NOT NULL CHECK (status IN ('active','deleted')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  saved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_used_at timestamptz,
  deleted_at timestamptz,
  CHECK ((status = 'active') = (state IS NOT NULL)),
  CHECK ((status = 'deleted') = (deleted_at IS NOT NULL))
);
CREATE INDEX tf_browser_logins_owner ON {{schema}}.tf_browser_logins (owner_membership_id) WHERE status = 'active';
CREATE INDEX tf_browser_logins_site ON {{schema}}.tf_browser_logins (site) WHERE status = 'active';
CREATE TABLE {{schema}}.tf_browser_login_grants (
  login_id uuid NOT NULL REFERENCES {{schema}}.tf_browser_logins(id),
  grantee text NOT NULL,
  membership_id uuid REFERENCES {{schema}}.tf_memberships(id),
  team_id uuid REFERENCES {{schema}}.tf_teams(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('use','manage')),
  granted_by uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (login_id, grantee),
  CHECK (
    (grantee = 'workspace' AND membership_id IS NULL AND team_id IS NULL)
    OR (grantee = 'member:' || membership_id::text AND team_id IS NULL)
    OR (grantee = 'team:' || team_id::text AND membership_id IS NULL)
  )
);
CREATE INDEX tf_browser_login_grants_member ON {{schema}}.tf_browser_login_grants (membership_id)
  WHERE membership_id IS NOT NULL;
CREATE INDEX tf_browser_login_grants_team ON {{schema}}.tf_browser_login_grants (team_id) WHERE team_id IS NOT NULL;
CREATE TABLE {{schema}}.tf_browser_login_events (
  id uuid PRIMARY KEY,
  login_id uuid NOT NULL REFERENCES {{schema}}.tf_browser_logins(id),
  actor_membership_id uuid REFERENCES {{schema}}.tf_memberships(id),
  operation text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX tf_browser_login_events_login ON {{schema}}.tf_browser_login_events (login_id, created_at);
REVOKE ALL ON {{schema}}.tf_browser_logins, {{schema}}.tf_browser_login_grants, {{schema}}.tf_browser_login_events
  FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON {{schema}}.tf_browser_logins TO {{runtime}};
GRANT SELECT, INSERT, DELETE ON {{schema}}.tf_browser_login_grants TO {{runtime}};
GRANT SELECT, INSERT ON {{schema}}.tf_browser_login_events TO {{runtime}};
