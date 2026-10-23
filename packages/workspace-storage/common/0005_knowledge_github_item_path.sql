-- The full repository path of a GitHub file item. A path longer than 1,024 bytes is identified in native_id by its
-- SHA-256 hash, so re-reading the file needs the path kept here. NULL for issues, discussions and older items.
ALTER TABLE {{schema}}.tf_knowledge_github_items ADD COLUMN path text;
