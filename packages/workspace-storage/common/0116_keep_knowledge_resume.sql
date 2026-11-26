-- Progress of a document Keep is still receiving in batches. `sending_publication_id` is the publication being sent,
-- `sending_chunks` its chunk count and `sent_ordinal` the last chunk Keep has acknowledged, NULL before the first
-- (replacing) batch. A later sync of the same publication sends only the chunks after `sent_ordinal`, without
-- `replace`. `timeouts` counts Keep timeouts in a row on this publication since its last acknowledged batch.
ALTER TABLE {{schema}}.tf_keep_knowledge
  ADD COLUMN IF NOT EXISTS sending_publication_id uuid,
  ADD COLUMN IF NOT EXISTS sending_chunks integer CHECK (sending_chunks > 0),
  ADD COLUMN IF NOT EXISTS sent_ordinal integer,
  ADD COLUMN IF NOT EXISTS timeouts integer NOT NULL DEFAULT 0 CHECK (timeouts >= 0);
