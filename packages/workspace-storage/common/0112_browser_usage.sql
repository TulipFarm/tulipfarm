-- Browser time, charged per minute in the flow (chat or agent task) that used the browser. A row covers one stretch
-- of one browser session from `started_at`: it ends when the session closes, or else at `closes_at`, when the browser
-- host closes it unless something uses it first. Activity after a row is charged starts a new row.
CREATE TABLE {{schema}}.tf_browser_usage (
  session_id uuid NOT NULL,
  opened_at timestamptz NOT NULL,
  started_at timestamptz NOT NULL,
  flow_id text NOT NULL CHECK (char_length(flow_id) BETWEEN 1 AND 200),
  last_active_at timestamptz NOT NULL,
  closes_at timestamptz NOT NULL,
  ended_at timestamptz,
  charged_at timestamptz,
  PRIMARY KEY (session_id, opened_at, started_at),
  CHECK (started_at >= opened_at),
  CHECK (ended_at IS NULL OR ended_at >= started_at),
  CHECK (charged_at IS NULL OR ended_at IS NOT NULL)
);
CREATE INDEX tf_browser_usage_uncharged ON {{schema}}.tf_browser_usage (closes_at) WHERE charged_at IS NULL;
REVOKE ALL ON {{schema}}.tf_browser_usage FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE (last_active_at, closes_at, ended_at, charged_at) ON {{schema}}.tf_browser_usage TO {{runtime}};
