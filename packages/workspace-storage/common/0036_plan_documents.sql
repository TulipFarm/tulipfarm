-- Plan documents: each content revision of a plan is rendered to HTML and filed as a version of one PDF in the starter's
-- Files. A row is one rendering of a revision under one approval generation, the number of approvals recorded when it
-- was rendered, so approving a revision adds a newly stamped rendering of it. The HTML lives in object storage.
ALTER TABLE {{schema}}.tf_agent_plans
  ADD COLUMN document_file_id uuid REFERENCES {{schema}}.tf_files(id),
  ADD COLUMN document_file_detached boolean NOT NULL DEFAULT false,
  ADD COLUMN document_file_named_from text CHECK (char_length(document_file_named_from) BETWEEN 1 AND 255);
CREATE TABLE {{schema}}.tf_agent_plan_documents (
  plan_id uuid NOT NULL,
  revision integer NOT NULL,
  generation integer NOT NULL CHECK (generation >= 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','rendering','ready','failed')),
  error text CHECK (error IN ('render','too-large','quota','files')),
  html_object_key uuid,
  html_size integer CHECK (html_size > 0),
  html_digest text CHECK (html_digest ~ '^[0-9a-f]{64}$'),
  stamp_tone text CHECK (stamp_tone IN ('draft','approved','changed')),
  pdf_file_id uuid REFERENCES {{schema}}.tf_files(id),
  pdf_file_version integer CHECK (pdf_file_version > 0),
  dispatched_at timestamptz,
  rendered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (plan_id, revision, generation),
  FOREIGN KEY (plan_id, revision) REFERENCES {{schema}}.tf_agent_plan_revisions(plan_id, revision),
  CHECK ((html_object_key IS NULL) = (html_digest IS NULL) AND (html_object_key IS NULL) = (html_size IS NULL)),
  CHECK ((pdf_file_id IS NULL) = (pdf_file_version IS NULL)),
  CHECK ((status = 'failed') = (error IS NOT NULL)),
  CHECK (status <> 'ready' OR html_object_key IS NOT NULL)
);
CREATE INDEX tf_agent_plan_documents_unfinished ON {{schema}}.tf_agent_plan_documents (dispatched_at)
  WHERE status IN ('pending','rendering');
REVOKE ALL ON {{schema}}.tf_agent_plan_documents FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON {{schema}}.tf_agent_plan_documents TO {{runtime}};
GRANT UPDATE (document_file_id, document_file_detached, document_file_named_from) ON {{schema}}.tf_agent_plans TO {{runtime}};
