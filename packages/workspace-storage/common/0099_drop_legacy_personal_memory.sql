-- Personal memory lives in Keep. The earlier in-workspace store and the marker of when a workspace first used Keep are
-- no longer read or written, and nothing is migrated from them.

-- A saved Bud preference kept the earlier memory's text and revision so it could be undone. Keep numbers revisions
-- differently, so that revision could match a live one and the undo would write the earlier text over Keep's memory.
-- Clearing both makes such an undo report that the preference changed instead.
DO $$
BEGIN
  IF (SELECT count(*) FROM pg_catalog.pg_attribute
      WHERE attrelid = to_regclass('{{schema}}.tf_bud_preferences')
        AND attname IN ('previous_content', 'saved_revision') AND attnum > 0 AND NOT attisdropped) = 2 THEN
    UPDATE {{schema}}.tf_bud_preferences SET previous_content = NULL, saved_revision = NULL
    WHERE previous_content IS NOT NULL OR saved_revision IS NOT NULL;
  END IF;
END $$;

DROP TABLE IF EXISTS {{schema}}.tf_personal_memory;
DROP TABLE IF EXISTS {{schema}}.tf_keep_memory;
