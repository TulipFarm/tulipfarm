-- The trace each reply attempt ran under, so an operator can go from a chat to its traces without IDs in telemetry.
ALTER TABLE {{schema}}.tf_conversation_turns
  ADD COLUMN trace_id text CHECK (trace_id ~ '^[0-9a-f]{32}$'),
  ADD COLUMN trace_sampled boolean,
  ADD CONSTRAINT tf_conversation_turns_trace_check CHECK ((trace_id IS NULL) = (trace_sampled IS NULL));
GRANT UPDATE (trace_id, trace_sampled) ON {{schema}}.tf_conversation_turns TO {{runtime}};
