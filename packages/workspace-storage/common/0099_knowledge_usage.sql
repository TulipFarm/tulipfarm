-- Running totals behind the Knowledge storage quotas, so a write checks them without reading every stored row.
-- Triggers keep them equal to the counted rows: documents, chunks, and the bytes of originals, normalized Google
-- content, publications and chunks.
CREATE TABLE {{schema}}.tf_knowledge_usage (
  id integer PRIMARY KEY CHECK (id = 1),
  documents bigint NOT NULL,
  chunks bigint NOT NULL,
  bytes bigint NOT NULL
);
REVOKE ALL ON TABLE {{schema}}.tf_knowledge_usage FROM PUBLIC, {{migration}}, {{customOwner}}, {{confirmation}};
GRANT SELECT ON TABLE {{schema}}.tf_knowledge_usage TO {{runtime}};

-- Statement triggers apply one change per statement. A row trigger would update the total once per row, and repeated
-- updates of one row in a transaction slow down with each version, so large inserts would hold their locks for longer.
CREATE FUNCTION {{schema}}.tf_knowledge_count_usage() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  document_delta bigint := 0;
  chunk_delta bigint := 0;
  byte_delta bigint := 0;
BEGIN
  IF TG_OP <> 'DELETE' THEN
    CASE TG_TABLE_NAME
      WHEN 'tf_knowledge_documents' THEN
        SELECT count(*) INTO document_delta FROM inserted_rows;
      WHEN 'tf_knowledge_revisions' THEN
        SELECT COALESCE(sum(original_bytes), 0) INTO byte_delta FROM inserted_rows;
      WHEN 'tf_knowledge_google_originals' THEN
        SELECT COALESCE(sum(octet_length(normalized_content)), 0) INTO byte_delta FROM inserted_rows;
      WHEN 'tf_knowledge_publications' THEN
        SELECT COALESCE(sum(octet_length(markdown)), 0) INTO byte_delta FROM inserted_rows;
      WHEN 'tf_knowledge_chunks' THEN
        SELECT count(*), COALESCE(sum(octet_length(passage) + octet_length(heading)), 0)
        INTO chunk_delta, byte_delta FROM inserted_rows;
    END CASE;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    CASE TG_TABLE_NAME
      WHEN 'tf_knowledge_documents' THEN
        SELECT document_delta - count(*) INTO document_delta FROM deleted_rows;
      WHEN 'tf_knowledge_revisions' THEN
        SELECT byte_delta - COALESCE(sum(original_bytes), 0) INTO byte_delta FROM deleted_rows;
      WHEN 'tf_knowledge_google_originals' THEN
        SELECT byte_delta - COALESCE(sum(octet_length(normalized_content)), 0) INTO byte_delta FROM deleted_rows;
      WHEN 'tf_knowledge_publications' THEN
        SELECT byte_delta - COALESCE(sum(octet_length(markdown)), 0) INTO byte_delta FROM deleted_rows;
      WHEN 'tf_knowledge_chunks' THEN
        SELECT chunk_delta - count(*), byte_delta - COALESCE(sum(octet_length(passage) + octet_length(heading)), 0)
        INTO chunk_delta, byte_delta FROM deleted_rows;
    END CASE;
  END IF;
  IF document_delta <> 0 OR chunk_delta <> 0 OR byte_delta <> 0 THEN
    UPDATE {{schema}}.tf_knowledge_usage
    SET documents = documents + document_delta, chunks = chunks + chunk_delta, bytes = bytes + byte_delta
    WHERE id = 1;
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION {{schema}}.tf_knowledge_count_usage() FROM PUBLIC;

-- Created before the backfill: they lock the counted tables, so no write lands between the two. Documents are counted,
-- not sized, so updating one changes nothing.
CREATE TRIGGER tf_knowledge_documents_usage_insert AFTER INSERT ON {{schema}}.tf_knowledge_documents
  REFERENCING NEW TABLE AS inserted_rows FOR EACH STATEMENT EXECUTE FUNCTION {{schema}}.tf_knowledge_count_usage();
CREATE TRIGGER tf_knowledge_documents_usage_delete AFTER DELETE ON {{schema}}.tf_knowledge_documents
  REFERENCING OLD TABLE AS deleted_rows FOR EACH STATEMENT EXECUTE FUNCTION {{schema}}.tf_knowledge_count_usage();
CREATE TRIGGER tf_knowledge_revisions_usage_insert AFTER INSERT ON {{schema}}.tf_knowledge_revisions
  REFERENCING NEW TABLE AS inserted_rows FOR EACH STATEMENT EXECUTE FUNCTION {{schema}}.tf_knowledge_count_usage();
CREATE TRIGGER tf_knowledge_revisions_usage_update AFTER UPDATE ON {{schema}}.tf_knowledge_revisions
  REFERENCING OLD TABLE AS deleted_rows NEW TABLE AS inserted_rows FOR EACH STATEMENT EXECUTE FUNCTION {{schema}}.tf_knowledge_count_usage();
CREATE TRIGGER tf_knowledge_revisions_usage_delete AFTER DELETE ON {{schema}}.tf_knowledge_revisions
  REFERENCING OLD TABLE AS deleted_rows FOR EACH STATEMENT EXECUTE FUNCTION {{schema}}.tf_knowledge_count_usage();
CREATE TRIGGER tf_knowledge_google_originals_usage_insert AFTER INSERT ON {{schema}}.tf_knowledge_google_originals
  REFERENCING NEW TABLE AS inserted_rows FOR EACH STATEMENT EXECUTE FUNCTION {{schema}}.tf_knowledge_count_usage();
CREATE TRIGGER tf_knowledge_google_originals_usage_update AFTER UPDATE ON {{schema}}.tf_knowledge_google_originals
  REFERENCING OLD TABLE AS deleted_rows NEW TABLE AS inserted_rows FOR EACH STATEMENT EXECUTE FUNCTION {{schema}}.tf_knowledge_count_usage();
CREATE TRIGGER tf_knowledge_google_originals_usage_delete AFTER DELETE ON {{schema}}.tf_knowledge_google_originals
  REFERENCING OLD TABLE AS deleted_rows FOR EACH STATEMENT EXECUTE FUNCTION {{schema}}.tf_knowledge_count_usage();
CREATE TRIGGER tf_knowledge_publications_usage_insert AFTER INSERT ON {{schema}}.tf_knowledge_publications
  REFERENCING NEW TABLE AS inserted_rows FOR EACH STATEMENT EXECUTE FUNCTION {{schema}}.tf_knowledge_count_usage();
CREATE TRIGGER tf_knowledge_publications_usage_update AFTER UPDATE ON {{schema}}.tf_knowledge_publications
  REFERENCING OLD TABLE AS deleted_rows NEW TABLE AS inserted_rows FOR EACH STATEMENT EXECUTE FUNCTION {{schema}}.tf_knowledge_count_usage();
CREATE TRIGGER tf_knowledge_publications_usage_delete AFTER DELETE ON {{schema}}.tf_knowledge_publications
  REFERENCING OLD TABLE AS deleted_rows FOR EACH STATEMENT EXECUTE FUNCTION {{schema}}.tf_knowledge_count_usage();
CREATE TRIGGER tf_knowledge_chunks_usage_insert AFTER INSERT ON {{schema}}.tf_knowledge_chunks
  REFERENCING NEW TABLE AS inserted_rows FOR EACH STATEMENT EXECUTE FUNCTION {{schema}}.tf_knowledge_count_usage();
CREATE TRIGGER tf_knowledge_chunks_usage_update AFTER UPDATE ON {{schema}}.tf_knowledge_chunks
  REFERENCING OLD TABLE AS deleted_rows NEW TABLE AS inserted_rows FOR EACH STATEMENT EXECUTE FUNCTION {{schema}}.tf_knowledge_count_usage();
CREATE TRIGGER tf_knowledge_chunks_usage_delete AFTER DELETE ON {{schema}}.tf_knowledge_chunks
  REFERENCING OLD TABLE AS deleted_rows FOR EACH STATEMENT EXECUTE FUNCTION {{schema}}.tf_knowledge_count_usage();

INSERT INTO {{schema}}.tf_knowledge_usage (id, documents, chunks, bytes)
SELECT 1,
  (SELECT count(*) FROM {{schema}}.tf_knowledge_documents),
  (SELECT count(*) FROM {{schema}}.tf_knowledge_chunks),
  (SELECT COALESCE(sum(original_bytes), 0) FROM {{schema}}.tf_knowledge_revisions) +
  (SELECT COALESCE(sum(octet_length(normalized_content)), 0) FROM {{schema}}.tf_knowledge_google_originals) +
  (SELECT COALESCE(sum(octet_length(markdown)), 0) FROM {{schema}}.tf_knowledge_publications) +
  (SELECT COALESCE(sum(octet_length(passage) + octet_length(heading)), 0) FROM {{schema}}.tf_knowledge_chunks);

-- The per-revision publication quota counts a revision's publications.
CREATE INDEX tf_knowledge_publications_revision ON {{schema}}.tf_knowledge_publications (revision_id);
