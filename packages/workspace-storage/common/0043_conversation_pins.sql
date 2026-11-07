-- Chats a member pinned to the top of their chat list. A pin belongs to the member, so pinning a
-- shared project chat does not pin it for anyone else.
CREATE TABLE {{schema}}.tf_conversation_pins (
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  conversation_id uuid NOT NULL REFERENCES {{schema}}.tf_conversations(id),
  pinned_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (membership_id, conversation_id)
);
REVOKE ALL ON {{schema}}.tf_conversation_pins FROM PUBLIC;
GRANT SELECT, INSERT, DELETE ON {{schema}}.tf_conversation_pins TO {{runtime}};

ALTER TABLE {{schema}}.tf_conversation_commands
  DROP CONSTRAINT tf_conversation_commands_operation_check,
  ADD CONSTRAINT tf_conversation_commands_operation_check
    CHECK (operation IN ('create', 'send', 'rename', 'archive', 'delete', 'retry', 'cancel', 'answer', 'cancel-request', 'approval', 'move', 'pin'));
