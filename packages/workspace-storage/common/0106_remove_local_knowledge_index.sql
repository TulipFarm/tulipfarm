-- Keep indexes and searches Knowledge. The local embeddings, vector index, keyword index and their queues are no longer
-- read or written, so they are dropped. Nothing is copied to Keep. Publications and chunks stay: they hold the parsed
-- passages that are delivered to Keep and that hydrate Keep's results.

-- Eligibility no longer reports a vector publication.
DROP FUNCTION {{schema}}.tf_knowledge_slack_eligible_for(uuid,text);
DROP VIEW {{schema}}.tf_knowledge_slack_eligible;
CREATE VIEW {{schema}}.tf_knowledge_slack_eligible WITH (security_invoker=true) AS
SELECT d.id AS document_id,x.membership_id,x.user_id,LEAST(p.expires_at,x.expires_at) AS expires_at,
  d.source_id,d.observed_revision_id AS revision_id,d.lexical_publication_id AS publication_id,s.access_epoch,s.provider
FROM (SELECT a.source_id,a.conversation_id,a.membership_id,a.binding,a.expires_at,
    {{schema}}.tf_knowledge_slack_reader(a.source_id,a.membership_id,a.binding,c.kind) AS user_id
  FROM {{schema}}.tf_knowledge_slack_access a
  JOIN {{schema}}.tf_knowledge_slack_conversations c ON c.source_id=a.source_id AND c.conversation_id=a.conversation_id AND c.state='active'
  WHERE a.expires_at>clock_timestamp() AND a.observed_at<=clock_timestamp()) x
JOIN {{schema}}.tf_knowledge_slack_items i ON i.source_id=x.source_id AND i.conversation_id=x.conversation_id
JOIN {{schema}}.tf_knowledge_documents d ON d.id=i.document_id AND d.source_id=x.source_id AND d.tombstoned_at IS NULL
JOIN {{schema}}.tf_knowledge_sources s ON s.id=d.source_id AND s.provider='slack'
JOIN {{schema}}.tf_knowledge_revisions r ON r.id=d.observed_revision_id
JOIN {{schema}}.tf_knowledge_access_proofs p ON p.document_id=d.id AND p.membership_id=x.membership_id AND p.access_epoch=s.access_epoch
WHERE x.user_id IS NOT NULL AND p.expires_at>clock_timestamp() AND r.document_id=d.id AND r.sources='[]'::jsonb
  AND r.original->>'kind'='object' AND r.original->>'key'=r.id::text
  AND p.acl_version=r.source_revision AND p.principal=x.binding->>'slackUserId'
  AND p.acl_checked_at<=clock_timestamp() AND p.membership_checked_at<=clock_timestamp();
CREATE FUNCTION {{schema}}.tf_knowledge_slack_eligible_for(membership uuid,actor text)
RETURNS TABLE (document_id uuid,source_id uuid,revision_id uuid,publication_id uuid,access_epoch integer,expires_at timestamptz,provider text)
LANGUAGE plpgsql STABLE SET search_path=pg_catalog SET plan_cache_mode=force_generic_plan AS $$
BEGIN
  RETURN QUERY SELECT e.document_id,e.source_id,e.revision_id,e.publication_id,e.access_epoch,e.expires_at,e.provider
    FROM {{schema}}.tf_knowledge_slack_eligible e WHERE e.membership_id=membership AND e.user_id=actor;
END $$;
REVOKE ALL ON {{schema}}.tf_knowledge_slack_eligible FROM PUBLIC;
GRANT SELECT ON {{schema}}.tf_knowledge_slack_eligible TO {{runtime}};
REVOKE ALL ON FUNCTION {{schema}}.tf_knowledge_slack_eligible_for(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION {{schema}}.tf_knowledge_slack_eligible_for(uuid,text) TO {{runtime}};

DROP FUNCTION {{schema}}.tf_knowledge_github_eligible_for(uuid,text);
DROP VIEW {{schema}}.tf_knowledge_github_eligible;
CREATE VIEW {{schema}}.tf_knowledge_github_eligible WITH (security_invoker=true) AS
SELECT d.id AS document_id,x.membership_id,x.user_id,LEAST(p.expires_at,x.expires_at) AS expires_at,
  d.source_id,d.observed_revision_id AS revision_id,d.lexical_publication_id AS publication_id,s.access_epoch,s.provider
FROM (SELECT a.source_id,a.repository_id,a.membership_id,a.binding,a.expires_at,
    {{schema}}.tf_knowledge_github_reader(a.source_id,a.membership_id,a.binding) AS user_id
  FROM {{schema}}.tf_knowledge_github_access a
  JOIN {{schema}}.tf_knowledge_github_repositories c ON c.source_id=a.source_id AND c.repository_id=a.repository_id AND c.state='active'
  WHERE a.expires_at>clock_timestamp() AND a.observed_at<=clock_timestamp()) x
JOIN {{schema}}.tf_knowledge_github_items i ON i.source_id=x.source_id AND i.repository_id=x.repository_id
JOIN {{schema}}.tf_knowledge_documents d ON d.id=i.document_id AND d.source_id=x.source_id AND d.tombstoned_at IS NULL
JOIN {{schema}}.tf_knowledge_sources s ON s.id=d.source_id AND s.provider='github'
JOIN {{schema}}.tf_knowledge_revisions r ON r.id=d.observed_revision_id
JOIN {{schema}}.tf_knowledge_access_proofs p ON p.document_id=d.id AND p.membership_id=x.membership_id AND p.access_epoch=s.access_epoch
WHERE x.user_id IS NOT NULL AND p.expires_at>clock_timestamp() AND r.document_id=d.id AND r.sources='[]'::jsonb
  AND r.original->>'kind'='object' AND r.original->>'key'=r.id::text
  AND p.acl_version=r.source_revision AND p.principal=x.binding->>'githubUserId'
  AND p.acl_checked_at<=clock_timestamp() AND p.membership_checked_at<=clock_timestamp();
CREATE FUNCTION {{schema}}.tf_knowledge_github_eligible_for(membership uuid,actor text)
RETURNS TABLE (document_id uuid,source_id uuid,revision_id uuid,publication_id uuid,access_epoch integer,expires_at timestamptz,provider text)
LANGUAGE plpgsql STABLE SET search_path=pg_catalog SET plan_cache_mode=force_generic_plan AS $$
BEGIN
  RETURN QUERY SELECT e.document_id,e.source_id,e.revision_id,e.publication_id,e.access_epoch,e.expires_at,e.provider
    FROM {{schema}}.tf_knowledge_github_eligible e WHERE e.membership_id=membership AND e.user_id=actor;
END $$;
REVOKE ALL ON {{schema}}.tf_knowledge_github_eligible FROM PUBLIC;
GRANT SELECT ON {{schema}}.tf_knowledge_github_eligible TO {{runtime}};
REVOKE ALL ON FUNCTION {{schema}}.tf_knowledge_github_eligible_for(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION {{schema}}.tf_knowledge_github_eligible_for(uuid,text) TO {{runtime}};

DROP FUNCTION {{schema}}.tf_knowledge_atlassian_eligible_for(uuid,text);
DROP VIEW {{schema}}.tf_knowledge_atlassian_eligible;
CREATE VIEW {{schema}}.tf_knowledge_atlassian_eligible WITH (security_invoker=true) AS
SELECT d.id AS document_id,x.membership_id,x.user_id,LEAST(p.expires_at,x.expires_at) AS expires_at,
  d.source_id,d.observed_revision_id AS revision_id,d.lexical_publication_id AS publication_id,s.access_epoch,s.provider
FROM (SELECT a.source_id,a.native_id,a.membership_id,a.binding,a.expires_at,
    {{schema}}.tf_knowledge_atlassian_reader(a.source_id,a.membership_id,a.binding,g.product) AS user_id
  FROM {{schema}}.tf_knowledge_atlassian_access a
  JOIN {{schema}}.tf_knowledge_atlassian_sources g ON g.source_id=a.source_id
  WHERE a.expires_at>clock_timestamp() AND a.observed_at<=clock_timestamp()) x
JOIN {{schema}}.tf_knowledge_atlassian_items i ON i.source_id=x.source_id AND i.native_id=x.native_id
JOIN {{schema}}.tf_knowledge_atlassian_targets t ON t.source_id=i.source_id AND t.target_id=i.target_id AND t.state='active'
JOIN {{schema}}.tf_knowledge_documents d ON d.id=i.document_id AND d.source_id=x.source_id AND d.tombstoned_at IS NULL
JOIN {{schema}}.tf_knowledge_sources s ON s.id=d.source_id AND s.provider IN ('confluence','jira')
JOIN {{schema}}.tf_knowledge_revisions r ON r.id=d.observed_revision_id
JOIN {{schema}}.tf_knowledge_access_proofs p ON p.document_id=d.id AND p.membership_id=x.membership_id AND p.access_epoch=s.access_epoch
WHERE x.user_id IS NOT NULL AND p.expires_at>clock_timestamp() AND r.document_id=d.id AND r.sources='[]'::jsonb
  AND r.original->>'kind'='object' AND r.original->>'key'=r.id::text
  AND p.acl_version=r.source_revision AND p.principal=x.binding->>'atlassianAccountId'
  AND p.membership_version=x.binding->>'accountGeneration'
  AND p.acl_checked_at<=clock_timestamp() AND p.membership_checked_at<=clock_timestamp();
CREATE FUNCTION {{schema}}.tf_knowledge_atlassian_eligible_for(membership uuid,actor text)
RETURNS TABLE (document_id uuid,source_id uuid,revision_id uuid,publication_id uuid,access_epoch integer,expires_at timestamptz,provider text)
LANGUAGE plpgsql STABLE SET search_path=pg_catalog SET plan_cache_mode=force_generic_plan AS $$
BEGIN
  RETURN QUERY SELECT e.document_id,e.source_id,e.revision_id,e.publication_id,e.access_epoch,e.expires_at,e.provider
    FROM {{schema}}.tf_knowledge_atlassian_eligible e WHERE e.membership_id=membership AND e.user_id=actor;
END $$;
REVOKE ALL ON {{schema}}.tf_knowledge_atlassian_eligible FROM PUBLIC;
GRANT SELECT ON {{schema}}.tf_knowledge_atlassian_eligible TO {{runtime}};
REVOKE ALL ON FUNCTION {{schema}}.tf_knowledge_atlassian_eligible_for(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION {{schema}}.tf_knowledge_atlassian_eligible_for(uuid,text) TO {{runtime}};

CREATE OR REPLACE FUNCTION {{schema}}.tf_tombstone_conversation_knowledge() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $body$
DECLARE retired_at timestamptz := clock_timestamp();
BEGIN
  UPDATE {{schema}}.tf_knowledge_documents d
    SET tombstoned_at=COALESCE(d.tombstoned_at,retired_at),
        retain_until=COALESCE(d.retain_until,retired_at+interval '30 days'),
        lexical_publication_id=NULL
    FROM {{schema}}.tf_knowledge_sources s
    WHERE d.source_id=s.id AND s.provider='conversation' AND d.native_id=NEW.id::text;
  RETURN NEW;
END
$body$;
REVOKE ALL ON FUNCTION {{schema}}.tf_tombstone_conversation_knowledge() FROM PUBLIC;

DROP TABLE IF EXISTS {{schema}}.tf_knowledge_search_vectors;
DROP TABLE IF EXISTS {{schema}}.tf_knowledge_search_queries;
DROP TABLE IF EXISTS {{schema}}.tf_knowledge_embedding_retries;
DROP TABLE IF EXISTS {{schema}}.tf_knowledge_embedding_items;
DROP TABLE IF EXISTS {{schema}}.tf_knowledge_embedding_active_profile;
DROP INDEX IF EXISTS {{schema}}.tf_knowledge_documents_unembedded;
ALTER TABLE {{schema}}.tf_knowledge_documents DROP COLUMN IF EXISTS vector_publication_id;
DROP TABLE IF EXISTS {{schema}}.tf_knowledge_vector_publications;
DROP TABLE IF EXISTS {{schema}}.tf_knowledge_embedding_vectors;
DROP TABLE IF EXISTS {{schema}}.tf_knowledge_embedding_cache;
DROP TABLE IF EXISTS {{schema}}.tf_knowledge_embedding_jobs;
DROP TABLE IF EXISTS {{schema}}.tf_knowledge_embedding_profiles;

ALTER TABLE {{schema}}.tf_knowledge_work DROP COLUMN IF EXISTS embedding;
ALTER TABLE {{schema}}.tf_conversation_maintenance DROP COLUMN IF EXISTS embedding_status;
DROP INDEX IF EXISTS {{schema}}.tf_knowledge_search_english_gin;
DROP INDEX IF EXISTS {{schema}}.tf_knowledge_search_identifiers_gin;
ALTER TABLE {{schema}}.tf_knowledge_chunks
  DROP COLUMN IF EXISTS search_vector,
  DROP COLUMN IF EXISTS search_title,
  DROP COLUMN IF EXISTS identifiers;
