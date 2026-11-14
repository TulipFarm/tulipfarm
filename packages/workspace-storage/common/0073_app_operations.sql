-- Every publish, rollback, stop and rename an editor asks for. The generation is claimed at admission, so a later
-- operation supersedes an earlier one that finishes after it. Repeating a request id returns the same operation.
CREATE TABLE {{schema}}.tf_app_operations (
  id uuid PRIMARY KEY,
  app_id uuid NOT NULL REFERENCES {{schema}}.tf_apps(id),
  request_id uuid NOT NULL,
  requested_by uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  kind text NOT NULL CHECK (kind IN ('publish','rollback','pause','resume','disable','enable','rename')),
  generation bigint NOT NULL,
  target_release_id uuid REFERENCES {{schema}}.tf_app_releases(id),
  target_version_id uuid,
  status text NOT NULL CHECK (status IN ('admitted','staging','switched','superseded','failed')),
  failure jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  UNIQUE (requested_by, request_id)
);
REVOKE ALL ON {{schema}}.tf_app_operations FROM PUBLIC;
GRANT SELECT, INSERT ON {{schema}}.tf_app_operations TO {{runtime}};
GRANT UPDATE (status, failure, finished_at) ON {{schema}}.tf_app_operations TO {{runtime}};

-- A published version of a private app's definition. Kept apart from public releases, which need a build and a
-- publisher.
CREATE TABLE {{schema}}.tf_app_versions (
  id uuid PRIMARY KEY,
  app_id uuid NOT NULL REFERENCES {{schema}}.tf_apps(id),
  number integer NOT NULL CHECK (number >= 1),
  definition jsonb NOT NULL,
  digest text NOT NULL,
  published_by uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (app_id, number)
);
REVOKE ALL ON {{schema}}.tf_app_versions FROM PUBLIC;
GRANT SELECT, INSERT ON {{schema}}.tf_app_versions TO {{runtime}};

-- Workspace records a private app version names but can no longer find, such as 'table:<id>' or 'field:<id>'.
CREATE TABLE {{schema}}.tf_app_broken_references (
  version_id uuid NOT NULL REFERENCES {{schema}}.tf_app_versions(id),
  reference text NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (version_id, reference)
);
REVOKE ALL ON {{schema}}.tf_app_broken_references FROM PUBLIC;
GRANT SELECT, INSERT ON {{schema}}.tf_app_broken_references TO {{runtime}};

-- Hosting usage billed per app per window. The primary key makes metering a window twice a no-op.
CREATE TABLE {{schema}}.tf_app_usage_windows (
  app_id uuid NOT NULL REFERENCES {{schema}}.tf_apps(id),
  window_start timestamptz NOT NULL,
  requests bigint NOT NULL,
  bytes bigint NOT NULL,
  units numeric(40,0) NOT NULL,
  PRIMARY KEY (app_id, window_start)
);
REVOKE ALL ON {{schema}}.tf_app_usage_windows FROM PUBLIC;
GRANT SELECT, INSERT ON {{schema}}.tf_app_usage_windows TO {{runtime}};
