-- Table changes check their source chats as the storage worker, which cannot read chats directly.
-- A chat source now passes only while the chat is undeleted and, in a project, its owner is still a member,
-- the same rule as every other chat source check.
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
    RETURN integration_row.account_id=source->>'accountId' AND integration_row.membership_id=member_id AND integration_row.user_id=actor_user AND integration_row.generation=(source->>'generation')::integer AND integration_row.status='connected'
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
