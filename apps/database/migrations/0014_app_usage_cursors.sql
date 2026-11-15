-- Where app usage metering resumes for each workspace. Every settled hour before metered_before has been charged for
-- the workspace's apps, including traffic on names it no longer serves. A run that fails for a workspace leaves its
-- cursor behind, so the next run reads the hours it missed again.
CREATE TABLE app.app_usage_cursors (
  workspace_id uuid PRIMARY KEY REFERENCES app.workspaces(id) ON DELETE CASCADE,
  metered_before timestamptz NOT NULL
);
REVOKE ALL ON TABLE app.app_usage_cursors FROM PUBLIC;
