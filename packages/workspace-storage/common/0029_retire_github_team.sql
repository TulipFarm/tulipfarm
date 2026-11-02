-- GitHub team integrations are retired: members read GitHub through their own sign-in. Erase every saved team token.
UPDATE {{schema}}.tf_integrations
SET deleted_at = clock_timestamp(), enabled = false, credential = NULL, generation = generation + 1
WHERE deleted_at IS NULL;
