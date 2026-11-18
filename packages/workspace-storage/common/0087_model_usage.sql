-- One row per chat model call, written in the transaction that settles it, for the workspace Usage page: who it ran
-- for, which model and provider answered, what paid for it (workspace credits, a member's plan, or an API key), its
-- tokens and list price, and whether a fallback answered and why. Credits charged stay in tf_credit_usage under the
-- same id; agent runs read their tokens from tf_model_attempts. It holds no message content.
CREATE TABLE {{schema}}.tf_model_usage (
  id text PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  activity text NOT NULL,
  flow_id text,
  membership_id uuid,
  agent_id uuid,
  model_id text NOT NULL,
  model_provider text NOT NULL,
  paid_by text NOT NULL CHECK (paid_by IN ('credits','plan','key')),
  connection_id uuid,
  input_tokens bigint NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cached_tokens bigint NOT NULL DEFAULT 0 CHECK (cached_tokens >= 0),
  -- The call at the model's list price, in picodollars; null when the catalog has no list price for it.
  list_pico_usd bigint CHECK (list_pico_usd >= 0),
  pricing_revision text,
  fallback boolean NOT NULL DEFAULT false,
  fallback_reason text,
  fallback_from_model text,
  fallback_from_connection uuid
);
CREATE INDEX tf_model_usage_occurred_at ON {{schema}}.tf_model_usage (occurred_at);
REVOKE ALL ON {{schema}}.tf_model_usage FROM PUBLIC;
GRANT SELECT, INSERT ON {{schema}}.tf_model_usage TO {{runtime}};
