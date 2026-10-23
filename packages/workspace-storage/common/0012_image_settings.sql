-- Workspace image settings: the recognition model, the default image model and whether image generation is on.
-- A missing row means the catalog defaults: the document-vision model, the default image model, generation on.
CREATE TABLE {{schema}}.tf_image_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  recognition_family_id text CHECK (recognition_family_id ~ '^[a-z][a-z0-9-]{0,99}$'),
  default_image_model_id text CHECK (default_image_model_id ~ '^[a-z][a-z0-9-]{0,99}$'),
  generation_enabled boolean NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  editor_membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships (id),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE {{schema}}.tf_image_settings_commands (
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships (id),
  request_id uuid NOT NULL,
  input jsonb NOT NULL,
  receipt jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (membership_id, request_id)
);

REVOKE ALL ON {{schema}}.tf_image_settings, {{schema}}.tf_image_settings_commands FROM PUBLIC;
GRANT SELECT, INSERT ON {{schema}}.tf_image_settings TO {{runtime}};
GRANT UPDATE (recognition_family_id, default_image_model_id, generation_enabled, revision, editor_membership_id, updated_at)
  ON {{schema}}.tf_image_settings TO {{runtime}};
GRANT SELECT, INSERT ON {{schema}}.tf_image_settings_commands TO {{runtime}};
