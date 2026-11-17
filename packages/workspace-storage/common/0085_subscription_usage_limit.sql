-- When a plan last refused a reply because it reached its usage limit. The next reply the plan answers clears it, so
-- the model picker can say whether the plan is available. It holds only a time, never message content.
ALTER TABLE {{schema}}.tf_subscription_connections ADD COLUMN usage_limited_at timestamptz;
GRANT UPDATE (usage_limited_at) ON {{schema}}.tf_subscription_connections TO {{runtime}};
