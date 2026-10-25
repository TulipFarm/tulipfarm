-- One row per image or page sent to the recognition model: who asked, the model, the file it came from, the unit's
-- outcome and the Knowledge credit attempt that charged it. Generated images keep theirs in tf_image_generations (0015).
-- Cache hits make no model call and have no row. Neither the image nor the recognised text is kept here.
CREATE TABLE {{schema}}.tf_recognition_receipts (
  id uuid PRIMARY KEY,
  -- The chat turn (`chat:<conversation>:<turn>`), task (`task:<id>`) or Knowledge document the read belongs to.
  flow_id text NOT NULL CHECK (char_length(flow_id) BETWEEN 1 AND 300),
  requester_kind text NOT NULL CHECK (requester_kind IN ('member', 'source')),
  requester_id text NOT NULL CHECK (char_length(requester_id) BETWEEN 1 AND 200),
  -- `attachment:<id>`, `file:<id>`, `google:<id>` or `link:<sha256>`; null for Knowledge, whose flow is the document.
  source text CHECK (source IS NULL OR source ~ '^(attachment|file|google|link):[A-Za-z0-9_-]{1,200}$'),
  model_id text NOT NULL,
  prompt_version text NOT NULL,
  unit_kind text NOT NULL CHECK (unit_kind IN ('image', 'page')),
  media_type text NOT NULL CHECK (media_type ~ '^[a-z]+/[a-z0-9.+-]{1,64}$'),
  bytes integer NOT NULL CHECK (bytes >= 0),
  media_sha256 text CHECK (media_sha256 IS NULL OR media_sha256 ~ '^[a-f0-9]{64}$'),
  outcome text NOT NULL CHECK (outcome IN ('recognized', 'empty', 'refused', 'failed', 'unavailable')),
  -- The charge: null when no credits were reserved, such as a refused reservation.
  credit_attempt_id text REFERENCES {{schema}}.tf_knowledge_credit_attempts(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX tf_recognition_receipts_flow ON {{schema}}.tf_recognition_receipts (flow_id, created_at);
CREATE UNIQUE INDEX tf_recognition_receipts_attempt ON {{schema}}.tf_recognition_receipts (credit_attempt_id)
  WHERE credit_attempt_id IS NOT NULL;

REVOKE ALL ON {{schema}}.tf_recognition_receipts FROM PUBLIC;
GRANT SELECT, INSERT ON {{schema}}.tf_recognition_receipts TO {{runtime}};
