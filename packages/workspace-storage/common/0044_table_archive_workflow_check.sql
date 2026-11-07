-- Archiving a table runs as the storage worker, which cannot read workflows. This answers only whether an enabled
-- workflow's active revision mentions the table, without exposing workflow definitions or webhook secrets.
CREATE FUNCTION {{schema}}.tf_table_workflow_active(table_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
  SELECT EXISTS(SELECT 1 FROM {{schema}}.tf_workflows w JOIN {{schema}}.tf_workflow_revisions r ON r.workflow_id=w.id AND r.id=w.active_revision
    WHERE w.enabled AND strpos(r.definition::text, table_id::text) > 0);
$function$;
REVOKE ALL ON FUNCTION {{schema}}.tf_table_workflow_active(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION {{schema}}.tf_table_workflow_active(uuid) TO {{runtime}},{{migration}},{{customOwner}};
