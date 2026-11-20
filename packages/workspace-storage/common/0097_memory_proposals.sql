-- With Keep, background learning suggests edits to a member's memory instead of writing it. Each row is one pending
-- edit, bound to the profile revision it was made against. A decision deletes the row, so no decided text is kept.
CREATE TABLE {{schema}}.tf_memory_proposals (
  id uuid PRIMARY KEY,
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships (id),
  conversation_id uuid NOT NULL REFERENCES {{schema}}.tf_conversations (id) ON DELETE CASCADE,
  message_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('add', 'change', 'remove')),
  before_text text CHECK (char_length(before_text) BETWEEN 1 AND 2000),
  after_text text CHECK (char_length(after_text) BETWEEN 1 AND 2000),
  quote text NOT NULL CHECK (char_length(quote) BETWEEN 1 AND 2000),
  base_revision integer NOT NULL CHECK (base_revision >= 0),
  base_revision_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((kind = 'add') = (before_text IS NULL) AND (kind = 'remove') = (after_text IS NULL))
);
CREATE INDEX tf_memory_proposals_member ON {{schema}}.tf_memory_proposals (membership_id, created_at);
CREATE INDEX tf_memory_proposals_chat ON {{schema}}.tf_memory_proposals (conversation_id);

-- Hashes of text a member forgot or dismissed, per source chat, so learning does not suggest it again. Never the text.
CREATE TABLE {{schema}}.tf_memory_learning_blocks (
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships (id),
  conversation_id uuid NOT NULL REFERENCES {{schema}}.tf_conversations (id) ON DELETE CASCADE,
  hash text NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (membership_id, conversation_id, hash)
);

-- When the member last changed their Keep memory themselves. Learning reads only their messages after it.
CREATE TABLE {{schema}}.tf_memory_learning (
  membership_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_memberships (id),
  manual_at timestamptz NOT NULL
);

REVOKE ALL ON TABLE {{schema}}.tf_memory_proposals, {{schema}}.tf_memory_learning_blocks, {{schema}}.tf_memory_learning
  FROM PUBLIC, {{migration}}, {{customOwner}}, {{confirmation}};
GRANT SELECT, INSERT, DELETE ON TABLE {{schema}}.tf_memory_proposals TO {{runtime}};
GRANT UPDATE (base_revision, base_revision_id) ON TABLE {{schema}}.tf_memory_proposals TO {{runtime}};
GRANT SELECT, INSERT, DELETE ON TABLE {{schema}}.tf_memory_learning_blocks TO {{runtime}};
GRANT SELECT, INSERT, DELETE ON TABLE {{schema}}.tf_memory_learning TO {{runtime}};
GRANT UPDATE (manual_at) ON TABLE {{schema}}.tf_memory_learning TO {{runtime}};

CREATE FUNCTION {{schema}}.forget_removed_member_memory_learning() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.removed_at IS NOT NULL AND OLD.removed_at IS NULL THEN
    DELETE FROM {{schema}}.tf_memory_proposals WHERE membership_id=NEW.id;
    DELETE FROM {{schema}}.tf_memory_learning_blocks WHERE membership_id=NEW.id;
    DELETE FROM {{schema}}.tf_memory_learning WHERE membership_id=NEW.id;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION {{schema}}.forget_removed_member_memory_learning() FROM PUBLIC;
CREATE TRIGGER tf_memberships_forget_memory_learning AFTER UPDATE OF removed_at ON {{schema}}.tf_memberships
  FOR EACH ROW EXECUTE FUNCTION {{schema}}.forget_removed_member_memory_learning();
