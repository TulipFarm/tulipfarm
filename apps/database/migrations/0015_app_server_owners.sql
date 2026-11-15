-- The workspace each server app belongs to, recorded before the app's first host is brought up. Hosts are listed by
-- app, and a deleted workspace's schema cannot be read, so this is how reconcile finds the hosts to remove once its
-- workspace is gone.
CREATE TABLE app.app_server_owners (
  app_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id)
);
REVOKE ALL ON TABLE app.app_server_owners FROM PUBLIC;
