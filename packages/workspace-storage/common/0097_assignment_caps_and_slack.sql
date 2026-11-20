-- Daily caps for assigned work reset at midnight in the workspace's time zone. Credit caps are whole credits; the
-- engine compares them with the credits each row run charged that day.
ALTER TABLE {{schema}}.tf_workspace_assignment_limits
  ADD COLUMN time_zone text NOT NULL DEFAULT 'UTC' CHECK (char_length(time_zone) BETWEEN 1 AND 64),
  ADD COLUMN daily_credits integer CHECK (daily_credits BETWEEN 1 AND 1000000);
ALTER TABLE {{schema}}.tf_agent_assignment_limits
  ADD COLUMN daily_credits integer CHECK (daily_credits BETWEEN 1 AND 1000000);

-- Members get a Slack direct message for each Inbox item unless they turned that kind off here.
CREATE TABLE {{schema}}.tf_inbox_slack_muted (
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('assigned','waiting','finished','mention')),
  PRIMARY KEY (membership_id, kind)
);
REVOKE ALL ON {{schema}}.tf_inbox_slack_muted FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON {{schema}}.tf_inbox_slack_muted TO {{runtime}};

CREATE INDEX tf_inbox_items_unnotified ON {{schema}}.tf_inbox_items(created_at)
  WHERE notified_at IS NULL AND done_at IS NULL AND resolved_at IS NULL;
