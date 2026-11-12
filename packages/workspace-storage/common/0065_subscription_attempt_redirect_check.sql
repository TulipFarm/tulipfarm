-- 0064's redirect check repeated a class up to 500 times, past Postgres's limit of 255, so every
-- sign-in attempt insert failed with "invalid repetition count".
ALTER TABLE {{schema}}.tf_subscription_connection_attempts
  DROP CONSTRAINT tf_subscription_connection_attempts_redirect_uri_check,
  ADD CONSTRAINT tf_subscription_connection_attempts_redirect_uri_check CHECK (
    char_length(redirect_uri) <= 508
    AND redirect_uri ~ '^(http://127\.0\.0\.1:[0-9]{1,5}/auth/callback|https://[^\s]+)$'
  );
