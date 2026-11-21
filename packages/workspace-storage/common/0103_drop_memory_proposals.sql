-- Learning after a chat now writes memory files directly, so suggested edits and the hashes that kept dismissed
-- suggestions from returning are no longer read or written. When the member last changed memory stays.
CREATE OR REPLACE FUNCTION {{schema}}.forget_removed_member_memory_learning() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.removed_at IS NOT NULL AND OLD.removed_at IS NULL THEN
    DELETE FROM {{schema}}.tf_memory_learning WHERE membership_id=NEW.id;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION {{schema}}.forget_removed_member_memory_learning() FROM PUBLIC;

DROP TABLE IF EXISTS {{schema}}.tf_memory_proposals;
DROP TABLE IF EXISTS {{schema}}.tf_memory_learning_blocks;
