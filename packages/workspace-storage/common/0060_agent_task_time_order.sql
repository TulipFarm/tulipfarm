CREATE INDEX tf_agent_tasks_owner_started ON {{schema}}.tf_agent_tasks
  (owner_membership_id, owner_user_id, created_at DESC, id DESC);
