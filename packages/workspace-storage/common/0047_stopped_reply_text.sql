-- The text a reply attempt has streamed so far, so a member who stops the reply keeps what they already saw.
-- Holds the attempt's generation and epoch, its text and the sources the model could read before it started.
ALTER TABLE {{schema}}.tf_conversation_turns
  ADD COLUMN streamed jsonb CHECK (streamed IS NULL OR jsonb_typeof(streamed) = 'object');
GRANT UPDATE (streamed) ON {{schema}}.tf_conversation_turns TO {{runtime}};
