-- A table approval or rejection appends its outcome to the chat as the confirmation role, which records chat activity
-- like any other message: it reopens the chat and marks its maintenance stale.
GRANT UPDATE (is_closed, activity_generation) ON {{schema}}.tf_conversations TO {{confirmation}};
GRANT SELECT (conversation_id, state), UPDATE (state, lease_until, updated_at)
  ON {{schema}}.tf_conversation_maintenance TO {{confirmation}};
