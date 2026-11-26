-- A synced document (GitHub, Google, Slack, Confluence, Jira) gets a new revision every time its source changes, and
-- the per-document revision limit used to stop a frequently changed file from ever indexing again. The provider can
-- always fetch the content again, so before a new revision is observed this deletes every older revision except the
-- observed one and the newest superseded one, which may still have work in flight. Local notes, files and
-- conversations keep their history.
CREATE FUNCTION {{schema}}.tf_knowledge_prune_revisions(target uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  victims uuid[];
BEGIN
  SELECT COALESCE(array_agg(r.id), '{}') INTO victims
  FROM {{schema}}.tf_knowledge_revisions r
  JOIN {{schema}}.tf_knowledge_documents d ON d.id = r.document_id
  JOIN {{schema}}.tf_knowledge_sources s ON s.id = d.source_id
  WHERE r.document_id = target
    AND s.provider IN ('github', 'google', 'slack', 'confluence', 'jira')
    AND r.id IS DISTINCT FROM d.observed_revision_id
    AND r.id <> (
      SELECT o.id FROM {{schema}}.tf_knowledge_revisions o
      WHERE o.document_id = target AND o.id IS DISTINCT FROM d.observed_revision_id
      ORDER BY o.created_at DESC, o.id DESC LIMIT 1
    );
  IF cardinality(victims) = 0 THEN RETURN 0; END IF;
  DELETE FROM {{schema}}.tf_knowledge_coverage_gaps WHERE publication_id IN
    (SELECT id FROM {{schema}}.tf_knowledge_publications WHERE revision_id = ANY(victims));
  DELETE FROM {{schema}}.tf_knowledge_parse_profiles WHERE publication_id IN
    (SELECT id FROM {{schema}}.tf_knowledge_publications WHERE revision_id = ANY(victims));
  DELETE FROM {{schema}}.tf_knowledge_chunks WHERE publication_id IN
    (SELECT id FROM {{schema}}.tf_knowledge_publications WHERE revision_id = ANY(victims));
  DELETE FROM {{schema}}.tf_knowledge_publications WHERE revision_id = ANY(victims);
  DELETE FROM {{schema}}.tf_knowledge_work WHERE revision_id = ANY(victims);
  DELETE FROM {{schema}}.tf_knowledge_recognition_retries WHERE revision_id = ANY(victims);
  DELETE FROM {{schema}}.tf_knowledge_github_originals WHERE revision_id = ANY(victims);
  DELETE FROM {{schema}}.tf_knowledge_google_originals WHERE revision_id = ANY(victims);
  DELETE FROM {{schema}}.tf_knowledge_slack_originals WHERE revision_id = ANY(victims);
  DELETE FROM {{schema}}.tf_knowledge_atlassian_originals WHERE revision_id = ANY(victims);
  DELETE FROM {{schema}}.tf_knowledge_revisions WHERE id = ANY(victims);
  RETURN cardinality(victims);
END
$$;
REVOKE ALL ON FUNCTION {{schema}}.tf_knowledge_prune_revisions(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION {{schema}}.tf_knowledge_prune_revisions(uuid) TO {{runtime}};
