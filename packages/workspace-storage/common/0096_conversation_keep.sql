-- Chats whose compacted messages are sent to Keep for recall. `covered_through` is the last turn sequence compaction
-- moved out of the live context and `sent_through` the last one Keep has. `held` stays true from the first send until
-- Keep forgets the chat, so a deleted chat is always forgotten, even after the workspace stops using Keep.
-- `hold_count` grows with every send attempt, so a forget only removes the row when no send started since it looked.
-- `next_attempt_at` doubles as the lease of the replica working on the row.
CREATE TABLE {{schema}}.tf_conversation_keep (
  conversation_id uuid PRIMARY KEY,
  covered_through bigint NOT NULL DEFAULT 0 CHECK (covered_through >= 0),
  sent_through bigint NOT NULL DEFAULT 0 CHECK (sent_through >= 0),
  held boolean NOT NULL DEFAULT false,
  hold_count bigint NOT NULL DEFAULT 0 CHECK (hold_count >= 0),
  forget boolean NOT NULL DEFAULT false,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_error text CHECK (last_error IS NULL OR char_length(last_error) <= 200)
);
CREATE INDEX tf_conversation_keep_due ON {{schema}}.tf_conversation_keep (next_attempt_at)
  WHERE forget OR covered_through > sent_through;
REVOKE ALL ON {{schema}}.tf_conversation_keep FROM PUBLIC;
GRANT SELECT, INSERT, DELETE ON {{schema}}.tf_conversation_keep TO {{runtime}};
GRANT UPDATE (covered_through, sent_through, held, hold_count, forget, attempts, next_attempt_at, last_error)
  ON {{schema}}.tf_conversation_keep TO {{runtime}};
