-- GitHub Knowledge indexes default-branch commits as items of kind 'commit'.
ALTER TABLE {{schema}}.tf_knowledge_github_items DROP CONSTRAINT tf_knowledge_github_items_kind_check;
ALTER TABLE {{schema}}.tf_knowledge_github_items ADD CONSTRAINT tf_knowledge_github_items_kind_check CHECK (kind IN ('doc','issue','pull','discussion','code','commit'));
-- The default-branch head whose whole history was last indexed, so later passes list only newer commits.
-- NULL until a repository's commits are first listed in full.
ALTER TABLE {{schema}}.tf_knowledge_github_repositories ADD COLUMN commit_head text;
