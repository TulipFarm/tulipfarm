-- Commit history became a content kind after the first GitHub sources were saved. A source whose kinds are exactly
-- the earlier full default set never chose to leave commits out, so it gains them; a source whose owner cleared any
-- kind keeps its saved choice. Commit tracking for those sources restarts so their full history is indexed.
WITH targets AS (
  SELECT s.id,(((s.selection::jsonb)||'{"kinds":["code","commits","discussions","docs","issues","pulls"]}'::jsonb)::text) AS selection
  FROM {{schema}}.tf_knowledge_sources s
  JOIN {{schema}}.tf_knowledge_github_sources g ON g.source_id=s.id
  WHERE s.provider='github' AND s.state<>'removed'
    AND g.selection->'kinds'='["code","discussions","docs","issues","pulls"]'::jsonb
    AND (s.selection::jsonb)->'kinds'='["code","discussions","docs","issues","pulls"]'::jsonb
), settled AS (
  SELECT t.* FROM targets t JOIN {{schema}}.tf_knowledge_sources s ON s.id=t.id
  WHERE NOT EXISTS (SELECT 1 FROM {{schema}}.tf_knowledge_sources o
    WHERE o.id<>s.id AND o.state<>'removed' AND o.provider=s.provider AND o.account_namespace=s.account_namespace
      AND o.owner_membership_id IS NOT DISTINCT FROM s.owner_membership_id AND md5(o.selection)=md5(t.selection))
), sources AS (
  UPDATE {{schema}}.tf_knowledge_sources s SET selection=t.selection FROM settled t WHERE s.id=t.id RETURNING s.id
), github AS (
  UPDATE {{schema}}.tf_knowledge_github_sources g
  SET selection=jsonb_set(g.selection,'{kinds}','["code","commits","discussions","docs","issues","pulls"]'::jsonb)
  FROM sources t WHERE g.source_id=t.id RETURNING g.source_id
)
UPDATE {{schema}}.tf_knowledge_github_repositories r SET commit_head=NULL FROM github t WHERE r.source_id=t.source_id;

-- Automatic sources not created yet start with commits too.
UPDATE {{schema}}.tf_knowledge_default_sources d
SET selection=jsonb_set(d.selection,'{kinds}','["code","commits","discussions","docs","issues","pulls"]'::jsonb)
FROM {{schema}}.tf_knowledge_default_intents i
WHERE i.id=d.intent_id AND i.product='github'
  AND d.selection->'kinds'='["code","discussions","docs","issues","pulls"]'::jsonb;
