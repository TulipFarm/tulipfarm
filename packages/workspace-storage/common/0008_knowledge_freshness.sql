-- When a connected Knowledge source last finished a full sync, so search and retrieval can say "indexed as of".
-- NULL until the source's next completed sync after this migration; notes and Files never sync.
ALTER TABLE {{schema}}.tf_knowledge_sources ADD COLUMN synced_at timestamptz;
GRANT UPDATE (synced_at) ON {{schema}}.tf_knowledge_sources TO {{runtime}};

-- Every provider marks a completed sync by moving to sync_state 'ready' and advancing reconciliation.
CREATE FUNCTION {{schema}}.tf_knowledge_source_synced() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  UPDATE {{schema}}.tf_knowledge_sources SET synced_at=clock_timestamp() WHERE id=NEW.source_id;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION {{schema}}.tf_knowledge_source_synced() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION {{schema}}.tf_knowledge_source_synced() TO {{runtime}};

CREATE TRIGGER tf_knowledge_google_synced
AFTER UPDATE OF sync_state ON {{schema}}.tf_knowledge_google_sources
FOR EACH ROW WHEN (NEW.sync_state='ready' AND NEW.reconciliation>OLD.reconciliation)
EXECUTE FUNCTION {{schema}}.tf_knowledge_source_synced();
CREATE TRIGGER tf_knowledge_slack_synced
AFTER UPDATE OF sync_state ON {{schema}}.tf_knowledge_slack_sources
FOR EACH ROW WHEN (NEW.sync_state='ready' AND NEW.reconciliation>OLD.reconciliation)
EXECUTE FUNCTION {{schema}}.tf_knowledge_source_synced();
CREATE TRIGGER tf_knowledge_github_synced
AFTER UPDATE OF sync_state ON {{schema}}.tf_knowledge_github_sources
FOR EACH ROW WHEN (NEW.sync_state='ready' AND NEW.reconciliation>OLD.reconciliation)
EXECUTE FUNCTION {{schema}}.tf_knowledge_source_synced();
CREATE TRIGGER tf_knowledge_atlassian_synced
AFTER UPDATE OF sync_state ON {{schema}}.tf_knowledge_atlassian_sources
FOR EACH ROW WHEN (NEW.sync_state='ready' AND NEW.reconciliation>OLD.reconciliation)
EXECUTE FUNCTION {{schema}}.tf_knowledge_source_synced();
