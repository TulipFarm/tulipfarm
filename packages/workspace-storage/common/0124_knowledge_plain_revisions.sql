-- Keep's dispatcher asks every workspace every 30 seconds whether any document is due. Proving nothing is due checks
-- that each document's current revision is plain (no derived sources). This index answers that from a small
-- index-only scan instead of reading every wide revision row.
CREATE INDEX tf_knowledge_revisions_plain ON {{schema}}.tf_knowledge_revisions (id) WHERE sources = '[]'::jsonb;
