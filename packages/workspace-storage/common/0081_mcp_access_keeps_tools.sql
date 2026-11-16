-- Removing a team's access to an MCP app, or a member from such a team, cuts off only them. The app's tools stay on
-- for everyone else; the epoch bump still voids pending approvals and OAuth attempts made under the old access.
CREATE OR REPLACE FUNCTION {{schema}}.tf_mcp_invalidate_team_access()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE affected uuid;
BEGIN
  PERFORM id FROM {{schema}}.tf_authorization_lock WHERE id=1 FOR UPDATE;
  FOR affected IN SELECT integration_id FROM {{schema}}.tf_mcp_team_grants WHERE team_id=OLD.team_id ORDER BY integration_id LOOP
    UPDATE {{schema}}.tf_mcp_integrations SET authorization_epoch=authorization_epoch+1,version=version+1,grants_version=grants_version+1,refresh_claim=NULL,refresh_started_at=NULL WHERE id=affected;
    UPDATE {{schema}}.tf_mcp_oauth_attempts SET state='consumed',material=NULL WHERE integration_id=affected;
  END LOOP;
  RETURN OLD;
END $function$;

CREATE OR REPLACE FUNCTION {{schema}}.tf_mcp_invalidate_team_grant()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN
  PERFORM id FROM {{schema}}.tf_authorization_lock WHERE id=1 FOR UPDATE;
  UPDATE {{schema}}.tf_mcp_integrations SET authorization_epoch=authorization_epoch+1,version=version+1,grants_version=grants_version+1,refresh_claim=NULL,refresh_started_at=NULL WHERE id=OLD.integration_id;
  UPDATE {{schema}}.tf_mcp_oauth_attempts SET state='consumed',material=NULL WHERE integration_id=OLD.integration_id;
  RETURN OLD;
END $function$;
