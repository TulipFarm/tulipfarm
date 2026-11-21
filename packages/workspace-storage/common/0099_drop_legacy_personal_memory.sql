-- Personal memory lives in Keep. The earlier in-workspace store and the marker of when a workspace first used Keep are
-- no longer read or written, and nothing is migrated from them.
DROP TABLE IF EXISTS {{schema}}.tf_personal_memory;
DROP TABLE IF EXISTS {{schema}}.tf_keep_memory;
