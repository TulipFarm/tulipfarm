-- A follow-up is one saved instruction that runs later as a new agent turn in the chat or Slack thread it came from.
CREATE TABLE {{schema}}.tf_follow_ups (
  id uuid PRIMARY KEY,
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  user_id text NOT NULL,
  surface text NOT NULL CHECK (surface IN ('chat', 'slack')),
  origin text NOT NULL CHECK (origin IN ('chat', 'slack-mention', 'slack-reaction')),
  conversation_id uuid,
  origin_turn_id uuid,
  slack_installation_id uuid,
  slack_generation integer,
  slack_channel text,
  slack_thread_ts text,
  slack_item_ts text,
  slack_parent_event_id uuid,
  reaction_key text,
  instruction text NOT NULL CHECK (length(instruction) BETWEEN 1 AND 4000),
  due_at timestamptz NOT NULL,
  timezone text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'claimed', 'fired', 'cancelled', 'failed', 'skipped')),
  chain_root_id uuid NOT NULL,
  chain_depth integer NOT NULL CHECK (chain_depth BETWEEN 1 AND 12),
  chain_started_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  claimed_at timestamptz,
  finished_at timestamptz,
  fired_message_id uuid,
  fired_event_id uuid,
  failure_reason text CHECK (failure_reason IS NULL OR length(failure_reason) <= 200),
  CHECK (surface <> 'chat' OR (conversation_id IS NOT NULL AND origin = 'chat')),
  CHECK (surface <> 'slack' OR (slack_installation_id IS NOT NULL AND slack_generation IS NOT NULL
    AND slack_channel IS NOT NULL AND slack_thread_ts IS NOT NULL AND origin <> 'chat')),
  CHECK (origin <> 'slack-reaction' OR (reaction_key IS NOT NULL AND slack_item_ts IS NOT NULL)),
  CHECK (due_at <= chain_started_at + interval '24 hours 5 minutes')
);
CREATE INDEX tf_follow_ups_due ON {{schema}}.tf_follow_ups (due_at, id) WHERE status = 'pending';
CREATE INDEX tf_follow_ups_conversation ON {{schema}}.tf_follow_ups (conversation_id, created_at) WHERE conversation_id IS NOT NULL;
CREATE INDEX tf_follow_ups_thread ON {{schema}}.tf_follow_ups (slack_channel, slack_thread_ts) WHERE surface = 'slack';
CREATE INDEX tf_follow_ups_chain ON {{schema}}.tf_follow_ups (chain_root_id);
CREATE UNIQUE INDEX tf_follow_ups_pending_reaction ON {{schema}}.tf_follow_ups (reaction_key) WHERE status = 'pending';
CREATE UNIQUE INDEX tf_follow_ups_fired_message ON {{schema}}.tf_follow_ups (fired_message_id) WHERE fired_message_id IS NOT NULL;
CREATE UNIQUE INDEX tf_follow_ups_fired_event ON {{schema}}.tf_follow_ups (fired_event_id) WHERE fired_event_id IS NOT NULL;
REVOKE ALL ON {{schema}}.tf_follow_ups FROM PUBLIC;
GRANT SELECT, INSERT ON {{schema}}.tf_follow_ups TO {{runtime}};
GRANT UPDATE (status, claimed_at, finished_at, fired_message_id, fired_event_id, failure_reason)
  ON {{schema}}.tf_follow_ups TO {{runtime}};
