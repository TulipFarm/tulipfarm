-- Multiple personal and shared Google Workspace accounts with explicit use/manage grants.
ALTER TABLE {{schema}}.tf_google_integrations
  DROP CONSTRAINT tf_google_integrations_membership_id_key;

ALTER TABLE {{schema}}.tf_google_integrations
  ADD COLUMN ownership text NOT NULL DEFAULT 'personal' CHECK (ownership IN ('personal', 'shared')),
  ADD COLUMN grants_version integer NOT NULL DEFAULT 1 CHECK (grants_version > 0),
  ADD COLUMN label text CHECK (label IS NULL OR (char_length(label) BETWEEN 1 AND 120 AND label !~ '[[:cntrl:]]'));

CREATE INDEX tf_google_integrations_member ON {{schema}}.tf_google_integrations (membership_id, ownership);
CREATE INDEX tf_google_integrations_ownership ON {{schema}}.tf_google_integrations (ownership, status);

CREATE TABLE {{schema}}.tf_google_grants (
  integration_id uuid NOT NULL REFERENCES {{schema}}.tf_google_integrations(id) ON DELETE CASCADE,
  grantee text NOT NULL,
  membership_id uuid REFERENCES {{schema}}.tf_memberships(id) ON DELETE CASCADE,
  team_id uuid REFERENCES {{schema}}.tf_teams(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('use', 'manage')),
  granted_by uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (integration_id, grantee),
  CHECK (
    (grantee = 'workspace' AND membership_id IS NULL AND team_id IS NULL)
    OR (grantee = 'member:' || membership_id::text AND team_id IS NULL)
    OR (grantee = 'team:' || team_id::text AND membership_id IS NULL)
  )
);
CREATE INDEX tf_google_grants_member ON {{schema}}.tf_google_grants (membership_id) WHERE membership_id IS NOT NULL;
CREATE INDEX tf_google_grants_team ON {{schema}}.tf_google_grants (team_id) WHERE team_id IS NOT NULL;

REVOKE ALL ON {{schema}}.tf_google_grants FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON {{schema}}.tf_google_grants TO {{runtime}};
GRANT SELECT ON {{schema}}.tf_google_grants TO {{confirmation}};
GRANT SELECT ON {{schema}}.tf_google_grants TO {{migration}};
GRANT SELECT (ownership, grants_version, label) ON {{schema}}.tf_google_integrations TO {{confirmation}};
GRANT UPDATE (ownership, grants_version, label) ON {{schema}}.tf_google_integrations TO {{runtime}};

CREATE OR REPLACE VIEW {{schema}}.tf_member_verified_links WITH (security_invoker = true) AS
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
WHERE gi.ownership = 'personal' AND gi.status = 'connected' AND gi.account_id IS NOT NULL
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

CREATE OR REPLACE FUNCTION {{schema}}.tf_table_source_allowed(member_id uuid, actor_user text, source jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE integration_row record; source_row record;
BEGIN
  PERFORM id FROM {{schema}}.tf_authorization_lock WHERE id=1 FOR SHARE;
  IF NOT EXISTS(SELECT 1 FROM {{schema}}.tf_memberships WHERE id=member_id AND user_id=actor_user AND removed_at IS NULL) THEN RETURN false; END IF;
  CASE source->>'kind'
  WHEN 'private-conversation' THEN
    RETURN EXISTS(SELECT 1 FROM {{schema}}.tf_conversations c WHERE c.id=(source->>'conversationId')::uuid
      AND c.kind='private' AND c.owner_user_id=actor_user AND c.owner_membership_id=member_id AND c.deleted_at IS NULL
      AND (c.project_id IS NULL OR EXISTS(SELECT 1 FROM {{schema}}.tf_projects p JOIN {{schema}}.tf_project_members pm ON pm.project_id=p.id
        WHERE p.id=c.project_id AND p.archived_at IS NULL AND pm.membership_id=member_id AND pm.removed_at IS NULL)));
  WHEN 'github-source','integration-source' THEN
    SELECT * INTO integration_row FROM {{schema}}.tf_integrations WHERE id=(source->>'integrationId')::uuid FOR SHARE;
    IF NOT FOUND OR NOT integration_row.enabled OR integration_row.deleted_at IS NOT NULL THEN RETURN false; END IF;
    IF source->>'kind'='github-source' AND (integration_row.generation<>(source->>'generation')::integer OR integration_row.grants_version<>(source->>'grantsVersion')::integer) THEN RETURN false; END IF;
    RETURN EXISTS(SELECT 1 FROM {{schema}}.tf_integration_sources WHERE id=(source->>'sourceId')::uuid AND integration_id=integration_row.id)
      AND NOT EXISTS(SELECT permission FROM (VALUES ('read'),('use')) p(permission) WHERE NOT (
        EXISTS(SELECT 1 FROM {{schema}}.tf_integration_person_grants g WHERE g.integration_id=integration_row.id AND g.membership_id=member_id AND g.permission=p.permission)
        OR EXISTS(SELECT 1 FROM {{schema}}.tf_integration_grants g JOIN {{schema}}.tf_member_teams mt ON mt.team_id=g.team_id WHERE mt.membership_id=member_id AND g.integration_id=integration_row.id AND g.permission=p.permission)))
      AND (EXISTS(SELECT 1 FROM {{schema}}.tf_integration_source_person_grants g WHERE g.source_id=(source->>'sourceId')::uuid AND g.membership_id=member_id)
        OR EXISTS(SELECT 1 FROM {{schema}}.tf_integration_source_grants g JOIN {{schema}}.tf_member_teams mt ON mt.team_id=g.team_id WHERE mt.membership_id=member_id AND g.source_id=(source->>'sourceId')::uuid AND g.permission='github.issue.read'));
  WHEN 'google-integration' THEN
    IF source->>'membershipId'<>member_id::text THEN RETURN false; END IF;
    SELECT * INTO integration_row FROM {{schema}}.tf_google_integrations WHERE id=(source->>'integrationId')::uuid FOR SHARE;
    IF NOT FOUND THEN RETURN false; END IF;
    RETURN integration_row.account_id=source->>'accountId' AND integration_row.generation=(source->>'generation')::integer AND integration_row.status='connected'
      AND (
        (integration_row.ownership='personal' AND integration_row.membership_id=member_id AND integration_row.user_id=actor_user)
        OR (integration_row.ownership='shared' AND EXISTS(
          SELECT 1 FROM {{schema}}.tf_google_grants g
          WHERE g.integration_id=integration_row.id
            AND (
              g.grantee='workspace'
              OR g.membership_id=member_id
              OR EXISTS(SELECT 1 FROM {{schema}}.tf_member_teams mt WHERE mt.team_id=g.team_id AND mt.membership_id=member_id)
            )
        ))
      )
      AND to_jsonb(integration_row.scopes) @> (source->'scopes') AND (source->'scopes') @> to_jsonb(integration_row.scopes) AND to_jsonb(integration_row.scopes) @> (source->'requiredScopes');
  WHEN 'atlassian-source' THEN
    IF source->>'membershipId'<>member_id::text THEN RETURN false; END IF;
    SELECT * INTO integration_row FROM {{schema}}.tf_atlassian_accounts WHERE id=(source->>'accountId')::uuid FOR SHARE;
    IF NOT FOUND THEN RETURN false; END IF;
    SELECT * INTO source_row FROM {{schema}}.tf_atlassian_sources WHERE id=(source->>'sourceId')::uuid FOR SHARE;
    IF NOT FOUND THEN RETURN false; END IF;
    RETURN source_row.account_id=integration_row.id AND source_row.membership_id=member_id AND source_row.enabled AND source_row.binding=(source->>'binding')::jsonb AND integration_row.state='active'
      AND integration_row.generation=(source->>'generation')::integer AND integration_row.grants_version=(source->>'grantsVersion')::integer AND integration_row.expires_at>clock_timestamp()
      AND ((integration_row.ownership='personal' AND integration_row.owner_membership_id=member_id) OR (integration_row.ownership='business' AND (
        EXISTS(SELECT 1 FROM {{schema}}.tf_atlassian_account_member_grants g WHERE g.account_id=integration_row.id AND g.membership_id=member_id)
        OR EXISTS(SELECT 1 FROM {{schema}}.tf_atlassian_account_team_grants g JOIN {{schema}}.tf_member_teams mt ON mt.team_id=g.team_id WHERE g.account_id=integration_row.id AND mt.membership_id=member_id))));
  ELSE RETURN false;
  END CASE;
END $function$;
