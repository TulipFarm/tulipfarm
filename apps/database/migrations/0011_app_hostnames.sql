-- Public app names, global across workspaces so a Host header resolves to one app without scanning workspace schemas.
-- A name is claimed before the workspace records it, then made current; a renamed app's old name is retired and never
-- handed to another app. The edge columns project the app's live release and status; they only move forward in
-- edge_version, so projections may run in any order.
CREATE TABLE app.app_hostnames (
  name text PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  app_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('claiming','current','retired')),
  release_id uuid,
  status text CHECK (status IN ('active','paused','disabled')),
  edge_version bigint NOT NULL DEFAULT 0,
  claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  retired_at timestamptz,
  CHECK ((state = 'retired') = (retired_at IS NOT NULL))
);
CREATE UNIQUE INDEX app_hostnames_current ON app.app_hostnames (workspace_id, app_id) WHERE state = 'current';
REVOKE ALL ON TABLE app.app_hostnames FROM PUBLIC;

-- Unguessable preview hosts, so the preview gateway resolves a host to its app the same way.
CREATE TABLE app.app_preview_hosts (
  preview_key text PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  app_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON TABLE app.app_preview_hosts FROM PUBLIC;
