-- Handles and IDs a person was given by hand, on any Members row. Unverified: resolution prefers verified links.
CREATE TABLE {{schema}}.tf_member_external_handles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id uuid NOT NULL REFERENCES {{schema}}.tf_system_tables(table_id),
  member_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9-]{0,31}$'),
  scope text NOT NULL CHECK (scope ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  external_id text CHECK (external_id IS NULL OR external_id ~ '^[[:graph:]]{1,128}$'),
  handle text CHECK (handle IS NULL OR handle ~ '^[^@[:space:][:cntrl:]][^[:space:][:cntrl:]]{0,127}$'),
  handle_key text GENERATED ALWAYS AS (lower(handle)) STORED,
  display_name text CHECK (display_name IS NULL OR (char_length(display_name) BETWEEN 1 AND 200 AND display_name !~ '[[:cntrl:]]')),
  created_by_membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (table_id, member_id) REFERENCES {{schema}}.tf_table_identities(table_id, row_id),
  CHECK (external_id IS NOT NULL OR handle IS NOT NULL)
);
CREATE INDEX tf_member_external_handles_member ON {{schema}}.tf_member_external_handles (member_id, provider);
CREATE INDEX tf_member_external_handles_handle ON {{schema}}.tf_member_external_handles (provider, scope, handle_key)
  WHERE handle_key IS NOT NULL;
CREATE UNIQUE INDEX tf_member_external_handles_external ON {{schema}}.tf_member_external_handles (provider, scope, external_id)
  WHERE external_id IS NOT NULL;
CREATE UNIQUE INDEX tf_member_external_handles_member_handle
  ON {{schema}}.tf_member_external_handles (member_id, provider, scope, handle_key) WHERE handle_key IS NOT NULL;

-- Every handle seen for a verified account, so a rename keeps the old handle resolvable. `current` marks the newest.
CREATE TABLE {{schema}}.tf_member_external_handle_observations (
  provider text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9-]{0,31}$'),
  scope text NOT NULL CHECK (scope ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  external_id text NOT NULL CHECK (external_id ~ '^[[:graph:]]{1,128}$'),
  handle text NOT NULL CHECK (handle ~ '^[^@[:space:][:cntrl:]][^[:space:][:cntrl:]]{0,127}$'),
  handle_key text NOT NULL CHECK (handle_key = lower(handle)),
  source text NOT NULL CHECK (source IN ('oauth', 'webhook')),
  observed_at timestamptz NOT NULL,
  current boolean NOT NULL DEFAULT false,
  PRIMARY KEY (provider, scope, external_id, handle_key)
);
CREATE UNIQUE INDEX tf_member_external_handle_current
  ON {{schema}}.tf_member_external_handle_observations (provider, scope, external_id) WHERE current;
CREATE INDEX tf_member_external_handle_by_handle
  ON {{schema}}.tf_member_external_handle_observations (provider, scope, handle_key);

CREATE INDEX tf_github_accounts_identity_id ON {{schema}}.tf_github_accounts ((identity->>'id'))
  WHERE identity IS NOT NULL;
CREATE INDEX tf_google_integrations_account ON {{schema}}.tf_google_integrations (account_id)
  WHERE account_id IS NOT NULL;
CREATE INDEX tf_atlassian_accounts_identity_id ON {{schema}}.tf_atlassian_accounts ((identity->>'id'))
  WHERE ownership = 'personal' AND identity IS NOT NULL;

CREATE VIEW {{schema}}.tf_member_verified_links WITH (security_invoker = true) AS
SELECT 'slack'::text AS provider, i.team_id AS scope, p.slack_user_id AS external_id, NULL::text AS handle,
  NULL::text AS fallback_handle, NULL::text AS display_name, a.member_id, m.id AS membership_id, m.user_id
FROM {{schema}}.tf_slack_identities p
JOIN {{schema}}.tf_slack_installations i ON i.id = p.installation_id AND i.generation = p.generation
  AND i.state IN ('active', 'scope-missing')
JOIN {{schema}}.tf_memberships m ON m.id = p.membership_id AND m.removed_at IS NULL
JOIN {{schema}}.tf_workspace_member_accounts a ON a.membership_id = m.id AND a.user_id = m.user_id
JOIN {{schema}}.tf_table_identities ti ON ti.table_id = a.table_id AND ti.row_id = a.member_id AND ti.live
WHERE p.state = 'authorized'
UNION ALL
SELECT 'github', 'github.com', g.identity->>'id', COALESCE(o.handle, g.identity->>'login'), g.identity->>'login',
  NULL, a.member_id, m.id, m.user_id
FROM {{schema}}.tf_github_accounts g
LEFT JOIN {{schema}}.tf_member_external_handle_observations o ON o.provider = 'github' AND o.scope = 'github.com'
  AND o.external_id = g.identity->>'id' AND o.current
JOIN {{schema}}.tf_memberships m ON m.id = g.owner_membership_id AND m.removed_at IS NULL
JOIN {{schema}}.tf_workspace_member_accounts a ON a.membership_id = m.id AND a.user_id = m.user_id
JOIN {{schema}}.tf_table_identities ti ON ti.table_id = a.table_id AND ti.row_id = a.member_id AND ti.live
WHERE g.state IN ('active', 'reconnect-required') AND g.identity IS NOT NULL
UNION ALL
SELECT 'google', 'accounts.google.com', gi.account_id, gi.email, NULL, NULL, a.member_id, m.id, m.user_id
FROM {{schema}}.tf_google_integrations gi
JOIN {{schema}}.tf_memberships m ON m.id = gi.membership_id AND m.removed_at IS NULL
JOIN {{schema}}.tf_workspace_member_accounts a ON a.membership_id = m.id AND a.user_id = m.user_id
JOIN {{schema}}.tf_table_identities ti ON ti.table_id = a.table_id AND ti.row_id = a.member_id AND ti.live
WHERE gi.status = 'connected' AND gi.account_id IS NOT NULL
UNION ALL
SELECT CASE WHEN atl.protocol = 'trello' THEN 'trello' ELSE 'atlassian' END,
  CASE WHEN atl.protocol = 'trello' THEN 'trello.com' ELSE 'atlassian.com' END,
  atl.identity->>'id', NULL, NULL, atl.identity->>'label', a.member_id, m.id, m.user_id
FROM {{schema}}.tf_atlassian_accounts atl
JOIN {{schema}}.tf_memberships m ON m.id = atl.owner_membership_id AND m.removed_at IS NULL
JOIN {{schema}}.tf_workspace_member_accounts a ON a.membership_id = m.id AND a.user_id = m.user_id
JOIN {{schema}}.tf_table_identities ti ON ti.table_id = a.table_id AND ti.row_id = a.member_id AND ti.live
WHERE atl.ownership = 'personal' AND atl.state IN ('active', 'refreshing', 'reconnect-required')
  AND atl.identity IS NOT NULL AND atl.identity->>'qualification' = 'verified';

REVOKE ALL ON {{schema}}.tf_member_external_handles, {{schema}}.tf_member_external_handle_observations,
  {{schema}}.tf_member_verified_links FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON {{schema}}.tf_member_external_handles TO {{runtime}};
GRANT SELECT, INSERT, UPDATE ON {{schema}}.tf_member_external_handle_observations TO {{runtime}};
GRANT SELECT ON {{schema}}.tf_member_verified_links TO {{runtime}};
GRANT SELECT ON {{schema}}.tf_member_external_handles, {{schema}}.tf_member_external_handle_observations,
  {{schema}}.tf_member_verified_links TO {{migration}};
