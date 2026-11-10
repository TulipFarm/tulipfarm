ALTER TABLE {{schema}}.tf_knowledge_sources
  ADD COLUMN account_identity text NOT NULL DEFAULT '';
UPDATE {{schema}}.tf_knowledge_sources s
SET account_identity=a.binding->>'accountId'
FROM {{schema}}.tf_knowledge_atlassian_sources a WHERE a.source_id=s.id;

DROP INDEX {{schema}}.tf_knowledge_sources_live_selection;
CREATE UNIQUE INDEX tf_knowledge_sources_live_selection ON {{schema}}.tf_knowledge_sources
  (provider,account_namespace,account_identity,md5(selection),owner_membership_id) WHERE state <> 'removed';

ALTER TABLE {{schema}}.tf_knowledge_default_intents
  ADD COLUMN restore_coverage boolean NOT NULL DEFAULT false;
