-- A grant belongs to the view, not to a release: whichever release is live serves the app's approved views, so a new
-- release needs no new share or approval. Who shared and who approved is the recorded decision; the grant keeps serving
-- after either person leaves, until it is revoked. No grant rows exist yet, so the table is replaced.
DROP TABLE {{schema}}.tf_app_data_view_grants;

CREATE TABLE {{schema}}.tf_app_data_view_grants (
  view_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_app_data_views(id),
  shared_by uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  shared_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  approved_by uuid REFERENCES {{schema}}.tf_memberships(id),
  approved_at timestamptz,
  CHECK ((approved_by IS NULL) = (approved_at IS NULL))
);
REVOKE ALL ON {{schema}}.tf_app_data_view_grants FROM PUBLIC;
GRANT SELECT, DELETE ON {{schema}}.tf_app_data_view_grants TO {{runtime}};
GRANT INSERT (view_id, shared_by) ON {{schema}}.tf_app_data_view_grants TO {{runtime}};
GRANT UPDATE (approved_by, approved_at) ON {{schema}}.tf_app_data_view_grants TO {{runtime}};
