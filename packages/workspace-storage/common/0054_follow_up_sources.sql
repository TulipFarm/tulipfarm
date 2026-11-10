ALTER TABLE {{schema}}.tf_follow_ups ADD COLUMN sources jsonb
  CHECK (sources IS NULL OR (jsonb_typeof(sources) = 'array' AND jsonb_array_length(sources) <= 1000));
