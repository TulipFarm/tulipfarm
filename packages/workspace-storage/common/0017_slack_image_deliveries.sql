-- The Slack message a run's generated image went out with. The transaction that records a message as sent claims the
-- run's unclaimed saved images, so a draft that is rejected, expires or fails claims none, and two messages sent at once
-- never carry the same image.
ALTER TABLE {{schema}}.tf_image_generations ADD COLUMN slack_action_id uuid REFERENCES {{schema}}.tf_slack_actions(id);
CREATE INDEX tf_image_generations_slack_action ON {{schema}}.tf_image_generations (slack_action_id)
  WHERE slack_action_id IS NOT NULL;
GRANT UPDATE (slack_action_id) ON {{schema}}.tf_image_generations TO {{runtime}};
