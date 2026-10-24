-- One row per image an `images.generate` call asks for. The id is derived from the turn or run, the exact call and
-- the image's position, and is also the id of the saved file, so a repeated call finds its rows and returns the same
-- files without generating or charging again. The row keeps what the file viewer shows about a generated image.
CREATE TABLE {{schema}}.tf_image_generations (
  id uuid PRIMARY KEY,
  origin_kind text NOT NULL CHECK (origin_kind IN ('turn', 'run')),
  origin_id uuid NOT NULL,
  conversation_id uuid,
  call_hash text NOT NULL CHECK (call_hash ~ '^[a-f0-9]{64}$'),
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 3),
  creator_membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  state text NOT NULL CHECK (state IN ('pending', 'saved', 'refused', 'failed', 'cancelled')),
  prompt text NOT NULL CHECK (char_length(prompt) BETWEEN 1 AND 4000),
  image_model_id text NOT NULL,
  catalog_revision text,
  sources jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(sources) = 'array'),
  failure text CHECK (failure IS NULL OR failure ~ '^[a-z][a-z-]{0,63}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (origin_kind, origin_id, call_hash, ordinal),
  CHECK ((origin_kind = 'turn') = (conversation_id IS NOT NULL)),
  CHECK ((state = 'failed') = (failure IS NOT NULL))
);
CREATE INDEX tf_image_generations_origin ON {{schema}}.tf_image_generations (origin_kind, origin_id);

REVOKE ALL ON {{schema}}.tf_image_generations FROM PUBLIC;
GRANT SELECT, INSERT ON {{schema}}.tf_image_generations TO {{runtime}};
GRANT UPDATE (state, failure, image_model_id, catalog_revision, updated_at) ON {{schema}}.tf_image_generations TO {{runtime}};
