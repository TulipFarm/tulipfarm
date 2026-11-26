-- Member-connected BYOK API key providers (Anthropic, OpenAI, Google, xAI, and OpenAI-compatible custom endpoints).
-- Reuses tf_subscription_connections and tf_subscription_grants for encrypted credential storage, sharing, multi-account
-- selection, model discovery caching, and per-model enable/disable.
ALTER TABLE {{schema}}.tf_subscription_connections
  DROP CONSTRAINT tf_subscription_connections_provider_check,
  ADD CONSTRAINT tf_subscription_connections_provider_check CHECK (
    provider IN (
      'chatgpt',
      'claude',
      'copilot',
      'byok-anthropic',
      'byok-openai',
      'byok-google',
      'byok-xai',
      'byok-openai-compatible'
    )
  ),
  DROP CONSTRAINT tf_subscription_connections_models_check,
  ADD CONSTRAINT tf_subscription_connections_models_check CHECK (
    models IS NULL OR (jsonb_typeof(models) = 'array' AND octet_length(models::text) <= 524288)
  ),
  DROP CONSTRAINT tf_subscription_connections_disabled_models_check,
  ADD CONSTRAINT tf_subscription_connections_disabled_models_check CHECK (
    cardinality(disabled_models) <= 1000
  ),
  ADD COLUMN endpoint text,
  ADD CONSTRAINT tf_subscription_connections_endpoint_check CHECK (
    endpoint IS NULL OR (provider LIKE 'byok-%' AND char_length(endpoint) BETWEEN 1 AND 500)
  );
GRANT UPDATE (endpoint) ON {{schema}}.tf_subscription_connections TO {{runtime}};
