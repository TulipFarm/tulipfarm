-- Table changes recheck the workflows their chat read as the storage worker, which cannot read workflow tables.
-- Returns {"tableIds": [...]} while the member can still read the cited workflow revision, invoke every agent it runs
-- and use every provider it names, else NULL. The caller checks the returned tables in turn. It mirrors
-- requireWorkflowSource.
CREATE FUNCTION {{schema}}.tf_table_workflow_source(member_id uuid, actor_user text, source jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE definition jsonb; item jsonb; providers jsonb := '[]'::jsonb; table_ids jsonb := '[]'::jsonb;
BEGIN
  PERFORM id FROM {{schema}}.tf_authorization_lock WHERE id=1 FOR SHARE;
  IF NOT EXISTS(SELECT 1 FROM {{schema}}.tf_memberships WHERE id=member_id AND user_id=actor_user AND removed_at IS NULL) THEN RETURN NULL; END IF;
  IF source->>'kind'='workflow-provider' THEN
    providers := jsonb_build_array(jsonb_build_object('id', source->'integrationId', 'generation', source->'generation'));
  ELSIF source->>'kind'='workflow-definition' THEN
    IF NOT EXISTS(SELECT 1 FROM {{schema}}.tf_workflow_grants g WHERE g.workflow_id=(source->>'workflowId')::uuid
      AND (g.membership_id=member_id OR EXISTS(SELECT 1 FROM {{schema}}.tf_member_teams mt WHERE mt.team_id=g.team_id AND mt.membership_id=member_id)))
    THEN RETURN NULL; END IF;
    SELECT r.definition INTO definition FROM {{schema}}.tf_workflow_revisions r
      WHERE r.workflow_id=(source->>'workflowId')::uuid AND r.id=(source->>'revision')::uuid;
    IF NOT FOUND THEN RETURN NULL; END IF;
    FOR item IN SELECT value FROM jsonb_array_elements(COALESCE(definition->'triggers','[]'::jsonb) || COALESCE(definition->'steps','[]'::jsonb)) LOOP
      IF item ? 'tableId' THEN table_ids := table_ids || jsonb_build_array(item->'tableId'); END IF;
      IF item ? 'agentId' AND NOT EXISTS(SELECT 1 FROM {{schema}}.tf_agents a WHERE a.id=(item->>'agentId')::uuid
        AND a.saved_revision IS NOT NULL AND a.deleted_at IS NULL
        AND (EXISTS(SELECT 1 FROM {{schema}}.tf_agent_person_grants g WHERE g.agent_id=a.id AND g.membership_id=member_id AND g.permission='invoke')
          OR EXISTS(SELECT 1 FROM {{schema}}.tf_agent_grants g JOIN {{schema}}.tf_member_teams mt ON mt.team_id=g.team_id
            WHERE g.agent_id=a.id AND mt.membership_id=member_id AND g.permission='invoke')))
      THEN RETURN NULL; END IF;
      IF COALESCE(item->>'integrationId', item->'credential'->>'integrationId') IS NOT NULL THEN
        providers := providers || jsonb_build_array(jsonb_build_object('id', COALESCE(item->'integrationId', item->'credential'->'integrationId')));
      END IF;
    END LOOP;
  ELSE RETURN NULL;
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(providers) LOOP
    IF NOT EXISTS(SELECT 1 FROM {{schema}}.tf_workflow_provider_grants g WHERE g.integration_id=(item->>'id')::uuid AND g.permission='use'
      AND (g.membership_id=member_id OR EXISTS(SELECT 1 FROM {{schema}}.tf_member_teams mt WHERE mt.team_id=g.team_id AND mt.membership_id=member_id)))
    OR NOT EXISTS(SELECT 1 FROM {{schema}}.tf_provider_integrations c JOIN {{schema}}.tf_memberships m ON m.id=c.membership_id AND m.removed_at IS NULL
      WHERE c.id=(item->>'id')::uuid AND c.enabled AND (item->>'generation' IS NULL OR c.generation=(item->>'generation')::integer))
    THEN RETURN NULL; END IF;
  END LOOP;
  RETURN jsonb_build_object('tableIds', table_ids);
END
$$;
REVOKE ALL ON FUNCTION {{schema}}.tf_table_workflow_source(uuid,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION {{schema}}.tf_table_workflow_source(uuid,text,jsonb) TO {{runtime}},{{confirmation}},{{migration}},{{customOwner}};
