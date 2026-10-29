-- The text a model wrote before a tool call, kept with that call so a reload shows what the live chat showed.
-- NULL for calls saved before this migration or with no text.
ALTER TABLE {{schema}}.tf_conversation_tool_calls
  ADD COLUMN narration text CHECK (narration IS NULL OR char_length(narration) <= 2000);
