-- GitHub App user tokens expire after 8 hours and are renewed with a single-use refresh token.
-- expires_at now holds the refresh-token expiry; access_expires_at holds the access-token expiry.
ALTER TABLE {{schema}}.tf_github_accounts ADD COLUMN refresh_credential jsonb;
ALTER TABLE {{schema}}.tf_github_accounts ADD COLUMN access_expires_at timestamptz;
ALTER TABLE {{schema}}.tf_github_accounts ADD CONSTRAINT tf_github_accounts_refresh_check CHECK (state = 'active' OR refresh_credential IS NULL);
GRANT UPDATE (refresh_credential, access_expires_at) ON {{schema}}.tf_github_accounts TO {{runtime}};
