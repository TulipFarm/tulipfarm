-- When the send request that saved a turn's message reached the API, so reply time can include the save itself.
-- NULL for turns saved before this migration or created without a send request.
ALTER TABLE {{schema}}.tf_conversation_turns ADD COLUMN timing_requested_at timestamptz;
