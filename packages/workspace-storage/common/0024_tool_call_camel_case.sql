-- Tool names may use camelCase after the first character, such as rows.resolveReference.
ALTER TABLE {{schema}}.tf_conversation_tool_calls DROP CONSTRAINT tf_conversation_tool_calls_tool_check;
ALTER TABLE {{schema}}.tf_conversation_tool_calls ADD CONSTRAINT tf_conversation_tool_calls_tool_check CHECK(tool ~ '^[a-z][a-zA-Z0-9.]{0,63}$');
