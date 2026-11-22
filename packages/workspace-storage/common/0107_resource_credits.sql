-- Storage and compute are charged in credit units and summarized as their own activities.
ALTER TABLE {{schema}}.tf_credit_usage
  DROP CONSTRAINT tf_credit_usage_activity_check,
  ADD CONSTRAINT tf_credit_usage_activity_check
    CHECK (activity IN ('chat','agent','other','table-search','app-build','app-hosting','storage','compute'));

-- One measurement of the workspace's stored bytes per source and UTC day, charged with the day's storage.
CREATE TABLE {{schema}}.tf_storage_usage (
  day date NOT NULL,
  source text NOT NULL CHECK (source IN ('database','objects','apps')),
  bytes bigint NOT NULL CHECK (bytes >= 0),
  units numeric(30,0) NOT NULL CHECK (units >= 0),
  measured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (day, source)
);
REVOKE ALL ON {{schema}}.tf_storage_usage FROM PUBLIC;
GRANT SELECT, INSERT ON {{schema}}.tf_storage_usage TO {{runtime}};

-- One attempt of an agent task step or workflow step on a shared worker. It is written when the step starts and
-- finished when it ends, so a crashed attempt is still found and charged up to its timeout.
CREATE TABLE {{schema}}.tf_compute_steps (
  id text PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 500),
  kind text NOT NULL CHECK (kind IN ('agent-task','workflow')),
  subject_id text NOT NULL CHECK (char_length(subject_id) BETWEEN 1 AND 200),
  started_at timestamptz NOT NULL,
  deadline timestamptz NOT NULL,
  ended_at timestamptz,
  charged_at timestamptz,
  CHECK (deadline > started_at),
  CHECK (ended_at IS NULL OR ended_at >= started_at),
  CHECK (charged_at IS NULL OR ended_at IS NOT NULL)
);
CREATE INDEX tf_compute_steps_uncharged ON {{schema}}.tf_compute_steps (started_at) WHERE charged_at IS NULL;
REVOKE ALL ON {{schema}}.tf_compute_steps FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE (ended_at, charged_at) ON {{schema}}.tf_compute_steps TO {{runtime}};

-- Sandbox compute reported by the execution provider, one row per hour once it is charged.
CREATE TABLE {{schema}}.tf_compute_windows (
  window_start timestamptz NOT NULL,
  source text NOT NULL CHECK (source IN ('sandbox')),
  units numeric(30,0) NOT NULL CHECK (units >= 0),
  measured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (window_start, source)
);
REVOKE ALL ON {{schema}}.tf_compute_windows FROM PUBLIC;
GRANT SELECT, INSERT ON {{schema}}.tf_compute_windows TO {{runtime}};
