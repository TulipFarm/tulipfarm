-- A password, or a username and password, may be typed into a site's sign-in form in the chat's browser instead of
-- being sent in an HTTP request.
ALTER TABLE {{schema}}.tf_secrets DROP CONSTRAINT tf_secrets_placement_check;
ALTER TABLE {{schema}}.tf_secrets
  ADD CONSTRAINT tf_secrets_placement_check
    CHECK (placement->>'kind' IN ('bearer','basic','header','cookie','query','body','browser'));
