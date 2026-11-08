-- Table changes recheck cited knowledge documents as the storage worker, which cannot read knowledge tables.
-- Returns the document revision's own sources while the member can read the document now, else NULL. It mirrors the
-- knowledge gate: the document and its source, the cited revision and publication, the original file and the
-- provider's access proof. The caller checks the returned sources in turn.
CREATE FUNCTION {{schema}}.tf_table_knowledge_sources(member_id uuid, actor_user text, source jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE doc record; origin record; revision record; allowed boolean;
BEGIN
  PERFORM id FROM {{schema}}.tf_authorization_lock WHERE id=1 FOR SHARE;
  IF source->>'kind' IS DISTINCT FROM 'knowledge-document' THEN RETURN NULL; END IF;
  IF NOT EXISTS(SELECT 1 FROM {{schema}}.tf_memberships WHERE id=member_id AND user_id=actor_user AND removed_at IS NULL) THEN RETURN NULL; END IF;
  SELECT * INTO doc FROM {{schema}}.tf_knowledge_documents WHERE id=(source->>'documentId')::uuid;
  IF NOT FOUND OR doc.tombstoned_at IS NOT NULL THEN RETURN NULL; END IF;
  SELECT * INTO origin FROM {{schema}}.tf_knowledge_sources WHERE id=doc.source_id;
  IF NOT FOUND OR origin.state IN ('removed','disconnected') THEN RETURN NULL; END IF;
  -- Notes and files belong to their owner; a chat or provider source admits its current readers.
  allowed := CASE origin.provider
    WHEN 'note' THEN origin.owner_membership_id=member_id
    WHEN 'file' THEN origin.owner_membership_id=member_id
    WHEN 'conversation' THEN EXISTS(SELECT 1 FROM {{schema}}.tf_knowledge_conversation_readers r
      WHERE r.source_id=origin.id AND r.membership_id=member_id AND r.user_id=actor_user)
    WHEN 'google' THEN EXISTS(SELECT 1 FROM {{schema}}.tf_knowledge_google_readers r
      WHERE r.source_id=origin.id AND r.membership_id=member_id AND r.user_id=actor_user)
    WHEN 'slack' THEN EXISTS(SELECT 1 FROM {{schema}}.tf_knowledge_slack_readers r
      WHERE r.source_id=origin.id AND r.membership_id=member_id AND r.user_id=actor_user)
    WHEN 'github' THEN EXISTS(SELECT 1 FROM {{schema}}.tf_knowledge_github_readers r
      WHERE r.source_id=origin.id AND r.membership_id=member_id AND r.user_id=actor_user)
    WHEN 'confluence' THEN EXISTS(SELECT 1 FROM {{schema}}.tf_knowledge_atlassian_readers r
      WHERE r.source_id=origin.id AND r.membership_id=member_id AND r.user_id=actor_user)
    WHEN 'jira' THEN EXISTS(SELECT 1 FROM {{schema}}.tf_knowledge_atlassian_readers r
      WHERE r.source_id=origin.id AND r.membership_id=member_id AND r.user_id=actor_user)
    ELSE false END;
  IF NOT allowed THEN RETURN NULL; END IF;
  IF origin.id IS DISTINCT FROM (source->>'sourceId')::uuid OR origin.access_epoch IS DISTINCT FROM (source->>'accessEpoch')::integer
    OR doc.observed_revision_id IS DISTINCT FROM (source->>'revisionId')::uuid
    OR doc.lexical_publication_id IS DISTINCT FROM (source->>'publicationId')::uuid THEN RETURN NULL; END IF;
  SELECT * INTO revision FROM {{schema}}.tf_knowledge_revisions WHERE id=doc.observed_revision_id AND document_id=doc.id;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM {{schema}}.tf_knowledge_publications
    WHERE id=doc.lexical_publication_id AND document_id=doc.id AND revision_id=revision.id) THEN RETURN NULL; END IF;
  IF revision.original->>'kind'='file' THEN
    IF NOT {{schema}}.tf_table_file_allowed(member_id, actor_user, (revision.original->>'fileId')::uuid) THEN RETURN NULL; END IF;
    IF NOT EXISTS(SELECT 1 FROM {{schema}}.tf_files WHERE id=(revision.original->>'fileId')::uuid
      AND sha256=revision.original->>'sha256' AND size=(revision.original->>'bytes')::integer) THEN RETURN NULL; END IF;
  END IF;
  IF origin.provider='conversation' THEN
    -- The chat lock serializes this check with reopening and deletion.
    PERFORM c.id FROM {{schema}}.tf_knowledge_conversation_revisions r
      JOIN {{schema}}.tf_conversations c ON c.id=r.conversation_id
      JOIN {{schema}}.tf_knowledge_revisions kr ON kr.id=r.revision_id
      JOIN {{schema}}.tf_knowledge_documents d ON d.id=kr.document_id AND d.native_id=c.id::text
      JOIN {{schema}}.tf_knowledge_conversation_readers reader ON reader.source_id=d.source_id AND reader.conversation_id=c.id
      JOIN {{schema}}.tf_conversation_messages m ON m.id=r.coverage_message_id AND m.conversation_id=c.id
      WHERE r.revision_id=doc.observed_revision_id AND reader.membership_id=member_id AND reader.user_id=actor_user
        AND c.is_closed AND c.activity_generation=r.generation AND c.deleted_at IS NULL
        AND NOT EXISTS(SELECT 1 FROM {{schema}}.tf_conversation_turns t
          WHERE t.conversation_id=c.id AND t.status IN ('queued','processing','waiting','reconciling'))
      FOR SHARE OF c;
    IF NOT FOUND THEN RETURN NULL; END IF;
  ELSIF origin.provider NOT IN ('note','file') THEN
    allowed := CASE origin.provider
      WHEN 'google' THEN EXISTS(SELECT 1 FROM {{schema}}.tf_knowledge_google_eligible e
        WHERE e.document_id=doc.id AND e.membership_id=member_id AND e.user_id=actor_user)
      WHEN 'slack' THEN EXISTS(SELECT 1 FROM {{schema}}.tf_knowledge_slack_eligible e
        WHERE e.document_id=doc.id AND e.membership_id=member_id AND e.user_id=actor_user)
      WHEN 'github' THEN EXISTS(SELECT 1 FROM {{schema}}.tf_knowledge_github_eligible e
        WHERE e.document_id=doc.id AND e.membership_id=member_id AND e.user_id=actor_user)
      ELSE EXISTS(SELECT 1 FROM {{schema}}.tf_knowledge_atlassian_eligible e
        WHERE e.document_id=doc.id AND e.membership_id=member_id AND e.user_id=actor_user) END
      AND EXISTS(SELECT 1 FROM {{schema}}.tf_knowledge_access_proofs p
        WHERE p.document_id=doc.id AND p.membership_id=member_id AND p.access_epoch=origin.access_epoch
          AND p.acl_checked_at<=clock_timestamp() AND p.membership_checked_at<=clock_timestamp() AND p.expires_at>clock_timestamp());
    IF NOT allowed THEN RETURN NULL; END IF;
  END IF;
  RETURN revision.sources;
END
$$;
REVOKE ALL ON FUNCTION {{schema}}.tf_table_knowledge_sources(uuid,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION {{schema}}.tf_table_knowledge_sources(uuid,text,jsonb) TO {{runtime}},{{confirmation}},{{migration}},{{customOwner}};
