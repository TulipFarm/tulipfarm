-- Media recognition in Knowledge documents: the workspace switch, coverage gaps per publication,
-- reusable recognitions and the bounded re-parse sweep once recognition becomes available.
CREATE TABLE {{schema}}.tf_knowledge_settings (
  version integer PRIMARY KEY CHECK (version = 1),
  media_recognition boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO {{schema}}.tf_knowledge_settings (version) VALUES (1);

-- Parts of a publication's original that Knowledge could not read.
CREATE TABLE {{schema}}.tf_knowledge_coverage_gaps (
  publication_id uuid NOT NULL REFERENCES {{schema}}.tf_knowledge_publications(id),
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 9999),
  kind text NOT NULL CHECK (kind IN ('image','video','audio','object','other')),
  reason text NOT NULL CHECK (reason IN ('unsupported-media','recognition-unavailable','refused','empty','limit')),
  location jsonb NOT NULL CHECK (jsonb_typeof(location) = 'object'),
  label text NOT NULL CHECK (char_length(label) <= 512),
  PRIMARY KEY (publication_id, ordinal)
);

-- Recognitions keyed by media sha256, model id and prompt version, reused across documents in this workspace.
CREATE TABLE {{schema}}.tf_knowledge_recognitions (
  key text PRIMARY KEY CHECK (octet_length(key) BETWEEN 1 AND 1024),
  recognition jsonb NOT NULL CHECK (jsonb_typeof(recognition) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX tf_knowledge_recognitions_created ON {{schema}}.tf_knowledge_recognitions (created_at);

-- Revisions re-queued because recognition became available, with backoff so a sweep never loops.
CREATE TABLE {{schema}}.tf_knowledge_recognition_retries (
  revision_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_knowledge_revisions(id),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 1000),
  retry_after timestamptz NOT NULL DEFAULT clock_timestamp()
);

REVOKE ALL ON {{schema}}.tf_knowledge_settings, {{schema}}.tf_knowledge_coverage_gaps,
  {{schema}}.tf_knowledge_recognitions, {{schema}}.tf_knowledge_recognition_retries FROM PUBLIC;
GRANT SELECT ON {{schema}}.tf_knowledge_settings TO {{runtime}};
GRANT UPDATE (media_recognition, updated_at) ON {{schema}}.tf_knowledge_settings TO {{runtime}};
GRANT SELECT, INSERT ON {{schema}}.tf_knowledge_coverage_gaps TO {{runtime}};
GRANT SELECT, INSERT, DELETE ON {{schema}}.tf_knowledge_recognitions TO {{runtime}};
GRANT SELECT, INSERT, DELETE ON {{schema}}.tf_knowledge_recognition_retries TO {{runtime}};
GRANT UPDATE (attempts, retry_after) ON {{schema}}.tf_knowledge_recognition_retries TO {{runtime}};

-- Parts of a project knowledge file that could not be read: the count and the first few. Null when all of it was read.
-- The runtime's existing SELECT, INSERT grant on the table covers this column.
ALTER TABLE {{schema}}.tf_project_knowledge_revisions ADD COLUMN gaps jsonb
  CHECK (gaps IS NULL OR (jsonb_typeof(gaps) = 'object' AND octet_length(gaps::text) <= 65536));
