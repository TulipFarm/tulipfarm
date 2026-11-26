-- Security-definer routines so the worker's authoring login can keep app.github_workflow_subscriptions
-- in sync when activating or archiving GitHub-triggered agents and workflows from chat.
CREATE FUNCTION app.replace_github_workflow_subscriptions(
  p_workspace_id uuid,
  p_workflow_id uuid,
  p_revision uuid,
  p_generation integer,
  p_triggers jsonb
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  item jsonb;
  account_id text;
  repo_ids text[];
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('github-workflow-subscriptions:' || p_workspace_id::text || ':' || p_workflow_id::text, 0)
  );
  IF EXISTS (
    SELECT 1 FROM app.github_workflow_subscriptions
    WHERE workspace_id = p_workspace_id AND workflow_id = p_workflow_id AND generation > p_generation
    LIMIT 1
  ) THEN
    RETURN;
  END IF;
  DELETE FROM app.github_workflow_subscriptions
  WHERE workspace_id = p_workspace_id AND workflow_id = p_workflow_id;
  FOR item IN SELECT value FROM pg_catalog.jsonb_array_elements(p_triggers)
  LOOP
    account_id := CASE
      WHEN pg_catalog.jsonb_typeof(item->'repositories') = 'object' THEN item->'repositories'->>'organizationId'
      ELSE NULL
    END;
    INSERT INTO app.github_workflow_subscriptions (
      workspace_id, workflow_id, trigger_id, revision, generation, organization_id, include_future, events
    ) VALUES (
      p_workspace_id,
      p_workflow_id,
      item->>'id',
      p_revision,
      p_generation,
      account_id,
      account_id IS NOT NULL,
      item->'events'
    );
    IF pg_catalog.jsonb_typeof(item->'repositories') = 'array' THEN
      SELECT pg_catalog.array_agg(r) INTO repo_ids
      FROM pg_catalog.jsonb_array_elements_text(item->'repositories') AS r;
      IF repo_ids IS NOT NULL THEN
        INSERT INTO app.github_workflow_subscription_repositories (workspace_id, workflow_id, trigger_id, repository_id)
        SELECT p_workspace_id, p_workflow_id, item->>'id', unnest(repo_ids);
      END IF;
    END IF;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION app.replace_github_workflow_subscriptions(uuid, uuid, uuid, integer, jsonb) FROM PUBLIC;

CREATE FUNCTION app.remove_github_workflow_subscriptions(
  p_workspace_id uuid,
  p_workflow_id uuid,
  p_generation integer
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  DELETE FROM app.github_workflow_subscriptions
  WHERE workspace_id = p_workspace_id AND workflow_id = p_workflow_id AND generation <= p_generation;
END;
$$;
REVOKE ALL ON FUNCTION app.remove_github_workflow_subscriptions(uuid, uuid, integer) FROM PUBLIC;
