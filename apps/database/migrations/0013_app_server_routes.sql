-- A server route forwards each request to the app's own server through the gateway instead of serving released
-- files, so it names no release.
ALTER TABLE app.app_hostnames
  ADD COLUMN kind text NOT NULL DEFAULT 'static' CHECK (kind IN ('static','server')),
  ADD CHECK (kind = 'static' OR release_id IS NULL);
