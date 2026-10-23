-- GitHub Knowledge indexes every repository an account can read, with every content kind and full history.
-- Members opt individual repositories out; an excluded repository keeps its row so later passes never re-add it.
ALTER TABLE {{schema}}.tf_knowledge_github_repositories ADD COLUMN excluded boolean NOT NULL DEFAULT false;

-- A selection can name up to 1,000 repositories, which no longer fits a btree key, so uniqueness uses its digest.
ALTER TABLE {{schema}}.tf_knowledge_sources DROP CONSTRAINT tf_knowledge_sources_selection_check;
ALTER TABLE {{schema}}.tf_knowledge_sources ADD CONSTRAINT tf_knowledge_sources_selection_check
  CHECK (octet_length(selection) BETWEEN 1 AND 262144);
DROP INDEX {{schema}}.tf_knowledge_sources_live_selection;
CREATE UNIQUE INDEX tf_knowledge_sources_live_selection ON {{schema}}.tf_knowledge_sources
  (provider,account_namespace,md5(selection),owner_membership_id) WHERE state <> 'removed';
-- Source settings change kinds, opt-out patterns and the optional cutoff in place.
GRANT UPDATE (selection) ON {{schema}}.tf_knowledge_sources TO {{runtime}};

-- Automatic GitHub sources no longer keep a rolling 90-day window: they index full history.
UPDATE {{schema}}.tf_knowledge_sources SET selection=((selection::jsonb)-'window'-'after')::text
WHERE provider='github' AND (selection::jsonb)->>'window'='rolling-90d';
UPDATE {{schema}}.tf_knowledge_github_sources SET selection=selection-'window'-'after'
WHERE selection->>'window'='rolling-90d';
UPDATE {{schema}}.tf_knowledge_default_sources d SET selection=d.selection-'window'-'after'
FROM {{schema}}.tf_knowledge_default_intents i
WHERE i.id=d.intent_id AND i.product='github' AND d.selection->>'window'='rolling-90d';

-- Every connected GitHub account gets an automatic source, including accounts connected while it was gated.
-- The ID matches recordDefaultKnowledgeIntent, so a later connect of the same account never adds a second intent.
INSERT INTO {{schema}}.tf_knowledge_default_intents (id,product,membership_id,account_key,account_label)
SELECT (substr(h,1,8)||'-'||substr(h,9,4)||'-5'||substr(h,14,3)||'-a'||substr(h,18,3)||'-'||substr(h,21,12))::uuid,
  'github',k.owner_membership_id,k.id::text,k.identity->>'login'
FROM (SELECT a.*,encode(sha256(convert_to('default-intent:github:'||a.owner_membership_id||':'||a.id,'UTF8')),'hex') AS h
  FROM {{schema}}.tf_github_accounts a
  JOIN {{schema}}.tf_memberships m ON m.id=a.owner_membership_id AND m.removed_at IS NULL
  WHERE a.state='active' AND a.identity IS NOT NULL AND char_length(a.identity->>'login') BETWEEN 1 AND 256) k
ON CONFLICT DO NOTHING;
