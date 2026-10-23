-- Feature flag targeting reads a workspace's slug, name and creation time. The worker's authoring login cannot read
-- those columns, so it calls this narrow routine instead of gaining broader access to app.workspaces.
CREATE FUNCTION app.workspace_flag_context(workspace uuid)
RETURNS TABLE(slug text, name text, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT w.slug, w.name, w.created_at FROM app.workspaces w WHERE w.id = workspace
$$;
REVOKE ALL ON FUNCTION app.workspace_flag_context(uuid) FROM PUBLIC;
