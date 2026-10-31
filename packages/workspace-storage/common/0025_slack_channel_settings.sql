-- Per-channel Slack settings. A null reply rule follows the attached agent's own rule.
-- Each reaction rule is {"reaction": Slack emoji name, "prompt": what the agent does with the reacted message}.
ALTER TABLE {{schema}}.tf_slack_channel_attachments
  ADD COLUMN replies text CHECK (replies IN ('tag','every-message')),
  ADD COLUMN reactions jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(reactions)='array' AND jsonb_array_length(reactions)<=10);
GRANT UPDATE (replies,reactions) ON {{schema}}.tf_slack_channel_attachments TO {{runtime}};
