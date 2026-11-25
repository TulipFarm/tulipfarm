ALTER TABLE {{schema}}.tf_agents
  ADD COLUMN IF NOT EXISTS coding_agent text CHECK (coding_agent IN ('claude-code', 'codex', 'copilot'));
GRANT UPDATE (coding_agent) ON {{schema}}.tf_agents TO {{runtime}};

ALTER TABLE {{schema}}.tf_conversation_turns
  ADD COLUMN IF NOT EXISTS code_session_id uuid;
GRANT UPDATE (code_session_id) ON {{schema}}.tf_conversation_turns TO {{runtime}};

ALTER TABLE {{schema}}.tf_conversation_parts
  ADD COLUMN IF NOT EXISTS code_session_id uuid;

ALTER TABLE {{schema}}.tf_conversation_parts
  DROP CONSTRAINT IF EXISTS tf_conversation_parts_kind_check;

ALTER TABLE {{schema}}.tf_conversation_parts
  ADD CONSTRAINT tf_conversation_parts_kind_check CHECK (
    ((kind = 'text'::text) AND (text IS NOT NULL) AND (attachment_id IS NULL) AND (request_id IS NULL) AND (response_id IS NULL) AND (approval_id IS NULL) AND (file_id IS NULL) AND (google_file IS NULL) AND (skill_id IS NULL) AND (compaction_id IS NULL) AND (code_session_id IS NULL))
    OR ((kind = 'attachment'::text) AND (text IS NULL) AND (attachment_id IS NOT NULL) AND (request_id IS NULL) AND (response_id IS NULL) AND (approval_id IS NULL) AND (file_id IS NULL) AND (google_file IS NULL) AND (skill_id IS NULL) AND (compaction_id IS NULL) AND (code_session_id IS NULL))
    OR ((kind = 'request'::text) AND (text IS NULL) AND (attachment_id IS NULL) AND (request_id IS NOT NULL) AND (response_id IS NULL) AND (approval_id IS NULL) AND (file_id IS NULL) AND (google_file IS NULL) AND (skill_id IS NULL) AND (compaction_id IS NULL) AND (code_session_id IS NULL))
    OR ((kind = 'response'::text) AND (text IS NULL) AND (attachment_id IS NULL) AND (request_id IS NULL) AND (response_id IS NOT NULL) AND (approval_id IS NULL) AND (file_id IS NULL) AND (google_file IS NULL) AND (skill_id IS NULL) AND (compaction_id IS NULL) AND (code_session_id IS NULL))
    OR ((kind = ANY (ARRAY['approval'::text, 'approval-resolution'::text])) AND (text IS NULL) AND (attachment_id IS NULL) AND (request_id IS NULL) AND (response_id IS NULL) AND (approval_id IS NOT NULL) AND (file_id IS NULL) AND (google_file IS NULL) AND (skill_id IS NULL) AND (compaction_id IS NULL) AND (code_session_id IS NULL))
    OR ((kind = 'file'::text) AND (text IS NULL) AND (attachment_id IS NULL) AND (request_id IS NULL) AND (response_id IS NULL) AND (approval_id IS NULL) AND (file_id IS NOT NULL) AND (google_file IS NULL) AND (skill_id IS NULL) AND (compaction_id IS NULL) AND (code_session_id IS NULL))
    OR ((kind = 'google-file'::text) AND (text IS NULL) AND (attachment_id IS NULL) AND (request_id IS NULL) AND (response_id IS NULL) AND (approval_id IS NULL) AND (file_id IS NULL) AND (google_file IS NOT NULL) AND (skill_id IS NULL) AND (compaction_id IS NULL) AND (code_session_id IS NULL) AND (jsonb_typeof(google_file) = 'object'::text) AND (google_file ?& ARRAY['fileId'::text, 'integrationId'::text, 'accountId'::text, 'generation'::text, 'name'::text, 'mimeType'::text]) AND (octet_length((google_file)::text) <= 4096))
    OR ((kind = ANY (ARRAY['skill'::text, 'skill-use'::text])) AND (text IS NULL) AND (attachment_id IS NULL) AND (request_id IS NULL) AND (response_id IS NULL) AND (approval_id IS NULL) AND (file_id IS NULL) AND (google_file IS NULL) AND (skill_id IS NOT NULL) AND (compaction_id IS NULL) AND (code_session_id IS NULL))
    OR ((kind = 'compact'::text) AND (attachment_id IS NULL) AND (request_id IS NULL) AND (response_id IS NULL) AND (approval_id IS NULL) AND (file_id IS NULL) AND (google_file IS NULL) AND (skill_id IS NULL) AND (code_session_id IS NULL) AND ((text IS NULL) OR (compaction_id IS NULL)) AND (char_length(COALESCE(text, 'x'::text)) <= 2000))
    OR ((kind = 'compaction'::text) AND (text IS NULL) AND (attachment_id IS NULL) AND (request_id IS NULL) AND (response_id IS NULL) AND (approval_id IS NULL) AND (file_id IS NULL) AND (google_file IS NULL) AND (skill_id IS NULL) AND (compaction_id IS NOT NULL) AND (code_session_id IS NULL))
    OR ((kind = 'layout'::text) AND (text IS NOT NULL) AND (layout IS NOT NULL) AND (attachment_id IS NULL) AND (request_id IS NULL) AND (response_id IS NULL) AND (approval_id IS NULL) AND (file_id IS NULL) AND (google_file IS NULL) AND (skill_id IS NULL) AND (compaction_id IS NULL) AND (code_session_id IS NULL))
    OR ((kind = 'layout-action'::text) AND (text IS NULL) AND (layout IS NULL) AND (layout_action IS NOT NULL) AND (attachment_id IS NULL) AND (request_id IS NULL) AND (response_id IS NULL) AND (approval_id IS NULL) AND (file_id IS NULL) AND (google_file IS NULL) AND (skill_id IS NULL) AND (compaction_id IS NULL) AND (code_session_id IS NULL))
    OR ((kind = 'code-session'::text) AND (text IS NULL) AND (layout IS NULL) AND (layout_action IS NULL) AND (attachment_id IS NULL) AND (request_id IS NULL) AND (response_id IS NULL) AND (approval_id IS NULL) AND (file_id IS NULL) AND (google_file IS NULL) AND (skill_id IS NULL) AND (compaction_id IS NULL) AND (code_session_id IS NOT NULL))
  );

CREATE TABLE {{schema}}.tf_member_code_settings (
  membership_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_memberships(id) ON DELETE CASCADE,
  branch_prefix text NOT NULL DEFAULT 'tulipfarm' CHECK (char_length(branch_prefix) BETWEEN 1 AND 64),
  open_pull_requests boolean NOT NULL DEFAULT false,
  open_as_draft boolean NOT NULL DEFAULT true,
  reviewers jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON {{schema}}.tf_member_code_settings FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON {{schema}}.tf_member_code_settings TO {{runtime}};

CREATE TABLE {{schema}}.tf_conversation_turn_modes (
  conversation_id uuid NOT NULL REFERENCES {{schema}}.tf_conversations(id) ON DELETE CASCADE,
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id) ON DELETE CASCADE,
  mode text NOT NULL CHECK (mode IN ('normal', 'plan', 'code')),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (conversation_id, membership_id)
);
REVOKE ALL ON {{schema}}.tf_conversation_turn_modes FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON {{schema}}.tf_conversation_turn_modes TO {{runtime}};

CREATE TABLE {{schema}}.tf_code_sessions (
  id uuid PRIMARY KEY,
  table_id uuid REFERENCES {{schema}}.tf_table_catalog(id) ON DELETE SET NULL,
  row_id uuid,
  owner_membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  origin_conversation_id uuid REFERENCES {{schema}}.tf_conversations(id) ON DELETE SET NULL,
  origin_turn_id uuid,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 240),
  request text NOT NULL CHECK (char_length(request) BETWEEN 1 AND 16000),
  agent text NOT NULL CHECK (agent IN ('claude-code', 'codex', 'copilot')),
  repository text NOT NULL CHECK (char_length(repository) BETWEEN 1 AND 200),
  base_branch text NOT NULL CHECK (char_length(base_branch) BETWEEN 1 AND 200),
  session_branch text NOT NULL CHECK (char_length(session_branch) BETWEEN 1 AND 255),
  github_account text,
  pull_request_number integer,
  pull_request_url text,
  stage text NOT NULL CHECK (stage IN (
    'brainstorm', 'plan', 'awaiting-plan-approval', 'code', 'verify',
    'pull-request', 'review', 'awaiting-merge-approval', 'merging',
    'merged', 'stopped', 'failed'
  )),
  reviewers jsonb NOT NULL DEFAULT '[]'::jsonb,
  open_pull_requests boolean NOT NULL DEFAULT false,
  open_as_draft boolean NOT NULL DEFAULT true,
  budget_ms bigint NOT NULL DEFAULT 14400000 CHECK (budget_ms > 0),
  active_ms bigint NOT NULL DEFAULT 0 CHECK (active_ms >= 0),
  fix_attempts integer NOT NULL DEFAULT 0 CHECK (fix_attempts >= 0),
  review_rounds integer NOT NULL DEFAULT 0 CHECK (review_rounds >= 0),
  summary text,
  plan_markdown text,
  plan_approved_at timestamptz,
  usage_limit_until timestamptz,
  workflow_id text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX tf_code_sessions_owner_idx ON {{schema}}.tf_code_sessions(owner_membership_id, created_at DESC);
CREATE INDEX tf_code_sessions_row_idx ON {{schema}}.tf_code_sessions(table_id, row_id) WHERE table_id IS NOT NULL AND row_id IS NOT NULL;
CREATE INDEX tf_code_sessions_conv_idx ON {{schema}}.tf_code_sessions(origin_conversation_id, created_at DESC) WHERE origin_conversation_id IS NOT NULL;
REVOKE ALL ON {{schema}}.tf_code_sessions FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON {{schema}}.tf_code_sessions TO {{runtime}};

CREATE TABLE {{schema}}.tf_code_session_steps (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES {{schema}}.tf_code_sessions(id) ON DELETE CASCADE,
  stage text NOT NULL,
  agent text NOT NULL CHECK (agent IN ('claude-code', 'codex', 'copilot')),
  model text,
  outcome text NOT NULL CHECK (outcome IN ('questions', 'plan', 'done', 'blocked', 'limit', 'failed')),
  final_message text,
  changed_files text[] NOT NULL DEFAULT '{}',
  diff_summary text,
  checks jsonb NOT NULL DEFAULT '[]'::jsonb,
  screenshots jsonb NOT NULL DEFAULT '[]'::jsonb,
  active_ms bigint NOT NULL DEFAULT 0 CHECK (active_ms >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX tf_code_session_steps_session_idx ON {{schema}}.tf_code_session_steps(session_id, created_at ASC);
REVOKE ALL ON {{schema}}.tf_code_session_steps FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON {{schema}}.tf_code_session_steps TO {{runtime}};

CREATE TABLE {{schema}}.tf_code_session_requests (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES {{schema}}.tf_code_sessions(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('question', 'plan-approval', 'pr-approval', 'merge-approval', 'stuck', 'budget')),
  payload jsonb NOT NULL,
  decision_digest text NOT NULL CHECK (decision_digest ~ '^[a-f0-9]{64}$'),
  answer jsonb,
  answered_by uuid REFERENCES {{schema}}.tf_memberships(id),
  answered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX tf_code_session_requests_open_idx ON {{schema}}.tf_code_session_requests(session_id, created_at DESC) WHERE answered_at IS NULL;
REVOKE ALL ON {{schema}}.tf_code_session_requests FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON {{schema}}.tf_code_session_requests TO {{runtime}};

CREATE TABLE {{schema}}.tf_code_session_terminal_chunks (
  id bigserial PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES {{schema}}.tf_code_sessions(id) ON DELETE CASCADE,
  stage text NOT NULL,
  stream text NOT NULL CHECK (stream IN ('stdout', 'stderr', 'system', 'prompt', 'answer')),
  chunk text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX tf_code_session_terminal_chunks_session_idx ON {{schema}}.tf_code_session_terminal_chunks(session_id, id ASC);
REVOKE ALL ON {{schema}}.tf_code_session_terminal_chunks FROM PUBLIC;
GRANT SELECT, INSERT ON {{schema}}.tf_code_session_terminal_chunks TO {{runtime}};
GRANT USAGE, SELECT ON SEQUENCE {{schema}}.tf_code_session_terminal_chunks_id_seq TO {{runtime}};

