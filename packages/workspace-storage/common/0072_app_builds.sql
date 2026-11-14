-- A build turns one commit into a static file tree. Its id digests the commit, recipe and builder, so asking for the
-- same build twice finds the existing row.
CREATE TABLE {{schema}}.tf_app_builds (
  id text PRIMARY KEY CHECK (id ~ '^[0-9a-f]{64}$'),
  app_id uuid NOT NULL REFERENCES {{schema}}.tf_apps(id),
  commit text NOT NULL,
  recipe jsonb NOT NULL,
  builder text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued','running','succeeded','failed')),
  manifest_key text,
  manifest_digest text,
  files integer,
  bytes bigint,
  failure jsonb,
  requested_by uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  CHECK ((status = 'succeeded') = (manifest_digest IS NOT NULL)),
  CHECK ((status = 'failed') = (failure IS NOT NULL))
);
REVOKE ALL ON {{schema}}.tf_app_builds FROM PUBLIC;
GRANT SELECT, INSERT ON {{schema}}.tf_app_builds TO {{runtime}};
GRANT UPDATE (status, manifest_key, manifest_digest, files, bytes, failure, finished_at)
  ON {{schema}}.tf_app_builds TO {{runtime}};

-- A published version of a public app. Immutable once written, apart from recording that the publisher holds every
-- file.
CREATE TABLE {{schema}}.tf_app_releases (
  id uuid PRIMARY KEY,
  app_id uuid NOT NULL REFERENCES {{schema}}.tf_apps(id),
  number integer NOT NULL CHECK (number >= 1),
  build_id text NOT NULL REFERENCES {{schema}}.tf_app_builds(id),
  commit text NOT NULL,
  manifest_digest text NOT NULL,
  staged_at timestamptz,
  published_by uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (app_id, number)
);
REVOKE ALL ON {{schema}}.tf_app_releases FROM PUBLIC;
GRANT SELECT, INSERT ON {{schema}}.tf_app_releases TO {{runtime}};
GRANT UPDATE (staged_at) ON {{schema}}.tf_app_releases TO {{runtime}};
