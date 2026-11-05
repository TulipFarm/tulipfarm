-- A chat follow-up posts to Slack as the account the chat had chosen when it was scheduled.
-- Null means the follow-up predates this choice and uses the chat's current one.
ALTER TABLE {{schema}}.tf_follow_ups ADD COLUMN slack_sender text CHECK (slack_sender IN ('user', 'app'));
GRANT SELECT (fired_message_id, slack_sender) ON {{schema}}.tf_follow_ups TO {{confirmation}};
