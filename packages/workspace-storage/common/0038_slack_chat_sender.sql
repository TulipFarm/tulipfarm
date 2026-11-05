-- Who posts a chat's Slack messages: the person's own Slack account, or the TulipFarm app.
-- No row means the person's account. The version moves on every change so prepared sends go stale.
CREATE TABLE {{schema}}.tf_slack_chat_sender (
  conversation_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_conversations(id),
  sender text NOT NULL CHECK (sender IN ('user', 'app')),
  version integer NOT NULL CHECK (version > 0)
);
REVOKE ALL ON {{schema}}.tf_slack_chat_sender FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON {{schema}}.tf_slack_chat_sender TO {{runtime}};
GRANT SELECT ON {{schema}}.tf_slack_chat_sender TO {{confirmation}};
