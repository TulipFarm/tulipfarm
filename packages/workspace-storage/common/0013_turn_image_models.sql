-- The chat family, recognition model and image model a turn was admitted with, and the catalog revision that served
-- them, so later setting or catalog changes do not affect a turn already in flight. NULL for turns admitted before
-- this migration or with the images feature off.
ALTER TABLE {{schema}}.tf_conversation_turns
  ADD COLUMN image_models jsonb CHECK (image_models IS NULL OR jsonb_typeof(image_models) = 'object');

GRANT UPDATE (image_models) ON {{schema}}.tf_conversation_turns TO {{runtime}};
