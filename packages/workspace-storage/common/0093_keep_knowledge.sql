-- Knowledge documents sent to Keep. `held` stays true from the first send until Keep forgets the document, so a
-- removed, tombstoned or disconnected document that Keep may still hold is always found and forgotten. A failed
-- document waits until `next_attempt_at`, and one sync at a time holds a document's lease.
CREATE TABLE {{schema}}.tf_keep_knowledge (
  document_id uuid PRIMARY KEY,
  held boolean NOT NULL DEFAULT false,
  publication_id uuid,
  delivered_at timestamptz,
  failed_publication_id uuid,
  failed_at timestamptz,
  last_error text CHECK (last_error IS NULL OR char_length(last_error) <= 1024),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz,
  lease_token uuid,
  lease_until timestamptz,
  CHECK ((lease_token IS NULL) = (lease_until IS NULL))
);
REVOKE ALL ON {{schema}}.tf_keep_knowledge FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON {{schema}}.tf_keep_knowledge TO {{runtime}};
