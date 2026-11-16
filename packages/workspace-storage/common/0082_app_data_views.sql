-- A data view is the only path from a public app to table rows: one table, the fields it lists by stable id, a row
-- predicate over fields and request parameters, and the row actions it allows. A view never changes; a different
-- shape is a new view that needs its own approval. Field and predicate validity is rechecked against the live table on
-- every request, so a field added to the table later stays outside the view.
CREATE TABLE {{schema}}.tf_app_data_views (
  id uuid PRIMARY KEY,
  app_id uuid NOT NULL REFERENCES {{schema}}.tf_apps(id),
  table_id uuid NOT NULL REFERENCES {{schema}}.tf_table_catalog(id),
  field_ids uuid[] NOT NULL CHECK (cardinality(field_ids) BETWEEN 1 AND 64),
  predicate jsonb NOT NULL,
  actions text[] NOT NULL
    CHECK (cardinality(actions) BETWEEN 1 AND 4 AND actions <@ ARRAY['read','create','update','delete']),
  created_by uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX tf_app_data_views_app ON {{schema}}.tf_app_data_views (app_id);
REVOKE ALL ON {{schema}}.tf_app_data_views FROM PUBLIC;
GRANT SELECT, INSERT ON {{schema}}.tf_app_data_views TO {{runtime}};

-- A view granted to one release. A member who may share the table shares it, then an admin approves it. Both are kept
-- as a record of the decision only: a request is served while both people are still current and the sharer still holds
-- the table permissions the view uses.
CREATE TABLE {{schema}}.tf_app_data_view_grants (
  release_id uuid NOT NULL REFERENCES {{schema}}.tf_app_releases(id),
  view_id uuid NOT NULL REFERENCES {{schema}}.tf_app_data_views(id),
  shared_by uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  shared_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  approved_by uuid REFERENCES {{schema}}.tf_memberships(id),
  approved_at timestamptz,
  PRIMARY KEY (release_id, view_id),
  CHECK ((approved_by IS NULL) = (approved_at IS NULL))
);
CREATE INDEX tf_app_data_view_grants_view ON {{schema}}.tf_app_data_view_grants (view_id);
REVOKE ALL ON {{schema}}.tf_app_data_view_grants FROM PUBLIC;
GRANT SELECT, INSERT, DELETE ON {{schema}}.tf_app_data_view_grants TO {{runtime}};
GRANT UPDATE (approved_by, approved_at) ON {{schema}}.tf_app_data_view_grants TO {{runtime}};
