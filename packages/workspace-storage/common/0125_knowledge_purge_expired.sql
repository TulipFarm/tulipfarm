-- Removing a source, narrowing a selection or deleting a note tombstones its documents and keeps them for 30 days
-- (`retain_until`), so a sync that sees the item again can revive them. Nothing deleted them afterwards, so every
-- removed document stayed in the workspace forever. This purges, in one small batch, tombstoned documents whose
-- retention has passed, with their revisions, originals, publications, chunks and provider item rows, and then
-- removed sources that have no documents left.
--
-- A document is skipped while Keep holds it (when Keep is live) or has it leased, and while a sync of its source holds
-- the source's lease. Provider source rows are share-locked before documents are chosen, so a sync that takes the
-- lease meanwhile waits for this transaction, and a revival in flight keeps its document row locked, so the purge
-- skips it. Deleting the provider item rows lets a later sync of the same item start again as a new document.
CREATE INDEX tf_knowledge_documents_expired ON {{schema}}.tf_knowledge_documents (retain_until)
  WHERE tombstoned_at IS NOT NULL;

CREATE FUNCTION {{schema}}.tf_knowledge_purge_expired(batch integer, keep_live boolean) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  candidates uuid[];
  quiet uuid[];
  locked uuid[];
  victims uuid[] := '{}';
  revs uuid[];
  pubs uuid[];
  removed uuid[];
BEGIN
  IF batch IS NULL OR batch < 1 OR batch > 1000 OR keep_live IS NULL THEN
    RAISE EXCEPTION 'invalid purge batch' USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(array_agg(DISTINCT e.source_id), '{}') INTO candidates FROM (
    SELECT d.source_id FROM {{schema}}.tf_knowledge_documents d
    WHERE d.tombstoned_at IS NOT NULL AND d.retain_until <= clock_timestamp()
      AND NOT EXISTS (SELECT 1 FROM {{schema}}.tf_keep_knowledge k WHERE k.document_id = d.id
        AND ((keep_live AND k.held) OR k.lease_until > clock_timestamp()))
    ORDER BY d.retain_until LIMIT batch
  ) e;

  IF cardinality(candidates) > 0 THEN
    SELECT COALESCE(array_agg(s.id), '{}') INTO quiet FROM {{schema}}.tf_knowledge_sources s
    WHERE s.id = ANY(candidates)
      AND NOT EXISTS (SELECT 1 FROM {{schema}}.tf_knowledge_github_sources p WHERE p.source_id = s.id)
      AND NOT EXISTS (SELECT 1 FROM {{schema}}.tf_knowledge_google_sources p WHERE p.source_id = s.id)
      AND NOT EXISTS (SELECT 1 FROM {{schema}}.tf_knowledge_slack_sources p WHERE p.source_id = s.id)
      AND NOT EXISTS (SELECT 1 FROM {{schema}}.tf_knowledge_atlassian_sources p WHERE p.source_id = s.id);
    SELECT COALESCE(array_agg(source_id), '{}') INTO locked FROM (
      SELECT source_id FROM {{schema}}.tf_knowledge_github_sources
      WHERE source_id = ANY(candidates) AND (lease_until IS NULL OR lease_until <= clock_timestamp())
      FOR SHARE SKIP LOCKED) p;
    quiet := quiet || locked;
    SELECT COALESCE(array_agg(source_id), '{}') INTO locked FROM (
      SELECT source_id FROM {{schema}}.tf_knowledge_google_sources
      WHERE source_id = ANY(candidates) AND (lease_until IS NULL OR lease_until <= clock_timestamp())
      FOR SHARE SKIP LOCKED) p;
    quiet := quiet || locked;
    SELECT COALESCE(array_agg(source_id), '{}') INTO locked FROM (
      SELECT source_id FROM {{schema}}.tf_knowledge_slack_sources
      WHERE source_id = ANY(candidates) AND (lease_until IS NULL OR lease_until <= clock_timestamp())
      FOR SHARE SKIP LOCKED) p;
    quiet := quiet || locked;
    SELECT COALESCE(array_agg(source_id), '{}') INTO locked FROM (
      SELECT source_id FROM {{schema}}.tf_knowledge_atlassian_sources
      WHERE source_id = ANY(candidates) AND (lease_until IS NULL OR lease_until <= clock_timestamp())
      FOR SHARE SKIP LOCKED) p;
    quiet := quiet || locked;

    SELECT COALESCE(array_agg(v.id), '{}') INTO victims FROM (
      SELECT d.id FROM {{schema}}.tf_knowledge_documents d
      WHERE d.source_id = ANY(quiet) AND d.tombstoned_at IS NOT NULL AND d.retain_until <= clock_timestamp()
        AND NOT EXISTS (SELECT 1 FROM {{schema}}.tf_keep_knowledge k WHERE k.document_id = d.id
          AND ((keep_live AND k.held) OR k.lease_until > clock_timestamp()))
      ORDER BY d.retain_until LIMIT batch
      FOR UPDATE OF d SKIP LOCKED
    ) v;
  END IF;

  IF cardinality(victims) > 0 THEN
    SELECT COALESCE(array_agg(id), '{}') INTO revs FROM {{schema}}.tf_knowledge_revisions
    WHERE document_id = ANY(victims);
    SELECT COALESCE(array_agg(id), '{}') INTO pubs FROM {{schema}}.tf_knowledge_publications
    WHERE revision_id = ANY(revs);
    UPDATE {{schema}}.tf_knowledge_documents SET observed_revision_id = NULL, lexical_publication_id = NULL
    WHERE id = ANY(victims) AND (observed_revision_id IS NOT NULL OR lexical_publication_id IS NOT NULL);
    -- The same dependents tf_knowledge_prune_revisions deletes for a revision, plus local and conversation revisions.
    DELETE FROM {{schema}}.tf_knowledge_coverage_gaps WHERE publication_id = ANY(pubs);
    DELETE FROM {{schema}}.tf_knowledge_parse_profiles WHERE publication_id = ANY(pubs);
    DELETE FROM {{schema}}.tf_knowledge_chunks WHERE publication_id = ANY(pubs);
    DELETE FROM {{schema}}.tf_knowledge_publications WHERE id = ANY(pubs);
    DELETE FROM {{schema}}.tf_knowledge_work WHERE revision_id = ANY(revs);
    DELETE FROM {{schema}}.tf_knowledge_recognition_retries WHERE revision_id = ANY(revs);
    DELETE FROM {{schema}}.tf_knowledge_github_originals WHERE revision_id = ANY(revs);
    DELETE FROM {{schema}}.tf_knowledge_google_originals WHERE revision_id = ANY(revs);
    DELETE FROM {{schema}}.tf_knowledge_slack_originals WHERE revision_id = ANY(revs);
    DELETE FROM {{schema}}.tf_knowledge_atlassian_originals WHERE revision_id = ANY(revs);
    DELETE FROM {{schema}}.tf_knowledge_conversation_revisions WHERE revision_id = ANY(revs);
    DELETE FROM {{schema}}.tf_knowledge_jobs WHERE revision_id = ANY(revs);
    DELETE FROM {{schema}}.tf_knowledge_commands WHERE revision_id = ANY(revs);
    DELETE FROM {{schema}}.tf_knowledge_note_originals WHERE revision_id = ANY(revs);
    DELETE FROM {{schema}}.tf_knowledge_local_revisions WHERE revision_id = ANY(revs);
    DELETE FROM {{schema}}.tf_knowledge_revisions WHERE id = ANY(revs);
    DELETE FROM {{schema}}.tf_knowledge_access_proofs WHERE document_id = ANY(victims);
    DELETE FROM {{schema}}.tf_knowledge_google_proof_bindings WHERE document_id = ANY(victims);
    DELETE FROM {{schema}}.tf_knowledge_google_proof_fences WHERE document_id = ANY(victims);
    DELETE FROM {{schema}}.tf_knowledge_github_items WHERE document_id = ANY(victims);
    DELETE FROM {{schema}}.tf_knowledge_slack_items WHERE document_id = ANY(victims);
    DELETE FROM {{schema}}.tf_knowledge_atlassian_access a USING {{schema}}.tf_knowledge_atlassian_items i
    WHERE i.document_id = ANY(victims) AND a.source_id = i.source_id AND a.native_id = i.native_id;
    DELETE FROM {{schema}}.tf_knowledge_atlassian_items WHERE document_id = ANY(victims);
    DELETE FROM {{schema}}.tf_knowledge_google_items i USING {{schema}}.tf_knowledge_documents d
    WHERE d.id = ANY(victims) AND i.source_id = d.source_id AND i.native_id = d.native_id AND i.document_id = d.id;
    -- A row Keep still holds stays so Keep can forget the document; it no longer needs the document row for that.
    DELETE FROM {{schema}}.tf_keep_knowledge WHERE document_id = ANY(victims) AND NOT held AND lease_token IS NULL;
    DELETE FROM {{schema}}.tf_knowledge_documents WHERE id = ANY(victims);
  END IF;

  SELECT COALESCE(array_agg(r.id), '{}') INTO removed FROM (
    SELECT s.id FROM {{schema}}.tf_knowledge_sources s
    WHERE s.state = 'removed' AND s.retain_until <= clock_timestamp()
      AND NOT EXISTS (SELECT 1 FROM {{schema}}.tf_knowledge_documents d WHERE d.source_id = s.id)
      AND NOT EXISTS (SELECT 1 FROM {{schema}}.tf_knowledge_github_sources p
        WHERE p.source_id = s.id AND p.lease_until > clock_timestamp())
      AND NOT EXISTS (SELECT 1 FROM {{schema}}.tf_knowledge_google_sources p
        WHERE p.source_id = s.id AND p.lease_until > clock_timestamp())
      AND NOT EXISTS (SELECT 1 FROM {{schema}}.tf_knowledge_slack_sources p
        WHERE p.source_id = s.id AND p.lease_until > clock_timestamp())
      AND NOT EXISTS (SELECT 1 FROM {{schema}}.tf_knowledge_atlassian_sources p
        WHERE p.source_id = s.id AND p.lease_until > clock_timestamp())
    ORDER BY s.retain_until LIMIT LEAST(batch, 10)
    FOR UPDATE OF s SKIP LOCKED
  ) r;
  IF cardinality(removed) > 0 THEN
    DELETE FROM {{schema}}.tf_knowledge_github_access WHERE source_id = ANY(removed);
    DELETE FROM {{schema}}.tf_knowledge_github_items WHERE source_id = ANY(removed);
    DELETE FROM {{schema}}.tf_knowledge_github_repositories WHERE source_id = ANY(removed);
    DELETE FROM {{schema}}.tf_knowledge_github_members WHERE source_id = ANY(removed);
    DELETE FROM {{schema}}.tf_knowledge_github_commands WHERE source_id = ANY(removed);
    DELETE FROM {{schema}}.tf_knowledge_github_sources WHERE source_id = ANY(removed);
    DELETE FROM {{schema}}.tf_knowledge_google_items WHERE source_id = ANY(removed);
    DELETE FROM {{schema}}.tf_knowledge_google_members WHERE source_id = ANY(removed);
    DELETE FROM {{schema}}.tf_knowledge_google_commands WHERE source_id = ANY(removed);
    DELETE FROM {{schema}}.tf_knowledge_google_refresh WHERE source_id = ANY(removed);
    DELETE FROM {{schema}}.tf_knowledge_google_sources WHERE source_id = ANY(removed);
    DELETE FROM {{schema}}.tf_knowledge_slack_access WHERE source_id = ANY(removed);
    DELETE FROM {{schema}}.tf_knowledge_slack_items WHERE source_id = ANY(removed);
    DELETE FROM {{schema}}.tf_knowledge_slack_conversations WHERE source_id = ANY(removed);
    DELETE FROM {{schema}}.tf_knowledge_slack_members WHERE source_id = ANY(removed);
    DELETE FROM {{schema}}.tf_knowledge_slack_commands WHERE source_id = ANY(removed);
    DELETE FROM {{schema}}.tf_knowledge_slack_sources WHERE source_id = ANY(removed);
    DELETE FROM {{schema}}.tf_knowledge_atlassian_access WHERE source_id = ANY(removed);
    DELETE FROM {{schema}}.tf_knowledge_atlassian_items WHERE source_id = ANY(removed);
    DELETE FROM {{schema}}.tf_knowledge_atlassian_targets WHERE source_id = ANY(removed);
    DELETE FROM {{schema}}.tf_knowledge_atlassian_members WHERE source_id = ANY(removed);
    DELETE FROM {{schema}}.tf_knowledge_atlassian_commands WHERE source_id = ANY(removed);
    DELETE FROM {{schema}}.tf_knowledge_atlassian_sources WHERE source_id = ANY(removed);
    DELETE FROM {{schema}}.tf_knowledge_sources WHERE id = ANY(removed);
  END IF;

  RETURN cardinality(victims) + cardinality(removed);
END
$$;
REVOKE ALL ON FUNCTION {{schema}}.tf_knowledge_purge_expired(integer, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION {{schema}}.tf_knowledge_purge_expired(integer, boolean) TO {{runtime}};
