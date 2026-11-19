-- The host that runs a server app's unpublished draft, so editors can preview it. Each app has one draft, so it has at
-- most one draft host. generation counts the starts; a start that finds a newer generation retires its host. host_ref is
-- the app host's own name for the host. opened_at is when an editor last opened the draft preview.
CREATE TABLE {{schema}}.tf_app_draft_hosts (
  app_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_apps(id),
  generation bigint NOT NULL CHECK (generation > 0),
  build_id text NOT NULL REFERENCES {{schema}}.tf_app_builds(id),
  state text NOT NULL CHECK (state IN ('starting','ready','failed','stopped')),
  host_ref text CHECK (char_length(host_ref) BETWEEN 1 AND 512),
  failure jsonb,
  opened_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((state = 'ready') = (host_ref IS NOT NULL)),
  CHECK ((state = 'failed') = (failure IS NOT NULL))
);
REVOKE ALL ON {{schema}}.tf_app_draft_hosts FROM PUBLIC;
GRANT SELECT, INSERT ON {{schema}}.tf_app_draft_hosts TO {{runtime}};
GRANT UPDATE (generation, build_id, state, host_ref, failure, opened_at, updated_at)
  ON {{schema}}.tf_app_draft_hosts TO {{runtime}};
