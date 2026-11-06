CREATE TABLE {{schema}}.tf_execution_areas (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL UNIQUE REFERENCES {{schema}}.tf_conversations(id),
  generation integer NOT NULL DEFAULT 1 CHECK (generation > 0),
  profile jsonb NOT NULL CHECK (jsonb_typeof(profile) = 'object'),
  policy_revision text NOT NULL CHECK (policy_revision ~ '^[a-f0-9]{64}$'),
  scope_revision text NOT NULL CHECK (scope_revision ~ '^[a-f0-9]{64}$'),
  base_revision text NOT NULL CHECK (base_revision ~ '^[a-f0-9]{64}$'),
  consent_revision integer NOT NULL DEFAULT 0 CHECK (consent_revision >= 0),
  manifest_id uuid,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','deleting','deleted')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, conversation_id)
);
CREATE TABLE {{schema}}.tf_execution_consents (
  area_id uuid NOT NULL REFERENCES {{schema}}.tf_execution_areas(id),
  revision integer NOT NULL CHECK (revision > 0),
  scope_revision text NOT NULL CHECK (scope_revision ~ '^[a-f0-9]{64}$'),
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  granted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  PRIMARY KEY (area_id, revision)
);
CREATE UNIQUE INDEX tf_execution_consent_active ON {{schema}}.tf_execution_consents(area_id)
  WHERE revoked_at IS NULL;
CREATE TABLE {{schema}}.tf_execution_allocations (
  id uuid PRIMARY KEY,
  area_id uuid NOT NULL REFERENCES {{schema}}.tf_execution_areas(id),
  generation integer NOT NULL CHECK (generation > 0),
  runner_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('preparing','ready','stopping','stopped','recovery-required')),
  deadline timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (area_id, generation),
  UNIQUE (id, area_id, generation)
);
CREATE UNIQUE INDEX tf_execution_one_writer ON {{schema}}.tf_execution_allocations(area_id)
  WHERE state <> 'stopped';
CREATE TABLE {{schema}}.tf_execution_jobs (
  id uuid PRIMARY KEY,
  area_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  generation integer NOT NULL CHECK (generation > 0),
  turn_id uuid NOT NULL,
  turn_generation integer NOT NULL CHECK (turn_generation >= 0),
  turn_epoch integer NOT NULL CHECK (turn_epoch >= 0),
  call_id uuid NOT NULL UNIQUE REFERENCES {{schema}}.tf_conversation_tool_calls(id),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  consent_revision integer NOT NULL,
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  command jsonb NOT NULL CHECK (jsonb_typeof(command) = 'object'),
  sources jsonb NOT NULL CHECK (jsonb_typeof(sources) = 'array'),
  state text NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued','starting','running','saving','completed','cancelled','timed-out','outcome-unknown')),
  allocation_id uuid,
  queue_deadline timestamptz NOT NULL,
  deadline timestamptz,
  cancel_requested_at timestamptz,
  next_event integer NOT NULL DEFAULT 1 CHECK (next_event > 0),
  output_cursor integer NOT NULL DEFAULT 0 CHECK (output_cursor >= 0),
  output_bytes bigint NOT NULL DEFAULT 0 CHECK (output_bytes BETWEEN 0 AND 9007199254740991),
  output_truncated boolean NOT NULL DEFAULT false,
  output_complete boolean NOT NULL DEFAULT false,
  result jsonb,
  file_save jsonb CHECK (file_save IS NULL OR jsonb_typeof(file_save) = 'object'),
  save_after timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  FOREIGN KEY (area_id, conversation_id) REFERENCES {{schema}}.tf_execution_areas(id, conversation_id),
  FOREIGN KEY (conversation_id, turn_id) REFERENCES {{schema}}.tf_conversation_turns(conversation_id, id),
  FOREIGN KEY (area_id, consent_revision) REFERENCES {{schema}}.tf_execution_consents(area_id, revision),
  FOREIGN KEY (allocation_id, area_id, generation) REFERENCES {{schema}}.tf_execution_allocations(id, area_id, generation),
  CHECK ((state IN ('completed','cancelled','timed-out')) = (finished_at IS NOT NULL))
);
CREATE UNIQUE INDEX tf_execution_one_running_job ON {{schema}}.tf_execution_jobs(area_id)
  WHERE state IN ('starting','running','saving','outcome-unknown');
CREATE INDEX tf_execution_job_queue ON {{schema}}.tf_execution_jobs(area_id, created_at, id)
  WHERE state = 'queued';
CREATE TABLE {{schema}}.tf_execution_events (
  job_id uuid NOT NULL REFERENCES {{schema}}.tf_execution_jobs(id),
  sequence integer NOT NULL CHECK (sequence > 0),
  kind text NOT NULL CHECK (kind IN ('status','output')),
  source_sequence integer CHECK (source_sequence > 0),
  value jsonb NOT NULL CHECK (octet_length(value::text) <= 65536),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (job_id, sequence),
  UNIQUE (job_id, source_sequence),
  CHECK ((kind = 'output') = (source_sequence IS NOT NULL))
);
CREATE TABLE {{schema}}.tf_execution_manifests (
  id uuid PRIMARY KEY,
  area_id uuid NOT NULL REFERENCES {{schema}}.tf_execution_areas(id),
  generation integer NOT NULL CHECK (generation > 0),
  parent_id uuid,
  file_count integer NOT NULL CHECK (file_count >= 0),
  total_bytes bigint NOT NULL CHECK (total_bytes BETWEEN 0 AND 9007199254740991),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (area_id, id),
  FOREIGN KEY (area_id, parent_id) REFERENCES {{schema}}.tf_execution_manifests(area_id, id)
);
CREATE TABLE {{schema}}.tf_execution_objects (
  id uuid PRIMARY KEY,
  area_id uuid NOT NULL REFERENCES {{schema}}.tf_execution_areas(id),
  generation integer NOT NULL CHECK (generation > 0),
  state text NOT NULL DEFAULT 'uploading' CHECK (state IN ('uploading','ready','deleting','deleted')),
  size bigint NOT NULL CHECK (size BETWEEN 0 AND 9007199254740991),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  chunks jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(chunks) = 'array'),
  retired_chunks bigint NOT NULL DEFAULT 0
    CHECK (retired_chunks BETWEEN 0 AND ceil(size::numeric / 1048576)),
  sources jsonb NOT NULL CHECK (jsonb_typeof(sources) = 'array'),
  expires_at timestamptz NOT NULL,
  UNIQUE (area_id, id)
);
CREATE TABLE {{schema}}.tf_execution_manifest_files (
  area_id uuid NOT NULL,
  manifest_id uuid NOT NULL,
  path text NOT NULL CHECK (octet_length(path) BETWEEN 1 AND 16384),
  size bigint NOT NULL CHECK (size BETWEEN 0 AND 9007199254740991),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  executable boolean NOT NULL,
  object_id uuid NOT NULL,
  sources jsonb NOT NULL CHECK (jsonb_typeof(sources) = 'array'),
  PRIMARY KEY (manifest_id, path),
  FOREIGN KEY (area_id, manifest_id) REFERENCES {{schema}}.tf_execution_manifests(area_id, id),
  FOREIGN KEY (area_id, object_id) REFERENCES {{schema}}.tf_execution_objects(area_id, id)
);
ALTER TABLE {{schema}}.tf_execution_areas ADD FOREIGN KEY (id, manifest_id)
  REFERENCES {{schema}}.tf_execution_manifests(area_id, id);
CREATE TABLE {{schema}}.tf_execution_outbox (
  id uuid PRIMARY KEY,
  area_id uuid NOT NULL REFERENCES {{schema}}.tf_execution_areas(id),
  generation integer NOT NULL CHECK (generation > 0),
  job_id uuid REFERENCES {{schema}}.tf_execution_jobs(id),
  object_id uuid REFERENCES {{schema}}.tf_execution_objects(id),
  operation text NOT NULL CHECK (operation IN ('start','poll','stop','cleanup','resume','file-cleanup')),
  dedupe_key text NOT NULL UNIQUE,
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_id uuid,
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  completed_at timestamptz,
  CHECK ((lease_id IS NULL) = (lease_until IS NULL))
);
CREATE INDEX tf_execution_outbox_due ON {{schema}}.tf_execution_outbox(available_at, id)
  WHERE completed_at IS NULL;
CREATE INDEX tf_execution_outbox_operation_due ON {{schema}}.tf_execution_outbox(operation, available_at, id)
  WHERE completed_at IS NULL;
REVOKE ALL ON {{schema}}.tf_execution_areas, {{schema}}.tf_execution_consents,
  {{schema}}.tf_execution_allocations, {{schema}}.tf_execution_jobs, {{schema}}.tf_execution_events,
  {{schema}}.tf_execution_manifests, {{schema}}.tf_execution_manifest_files,
  {{schema}}.tf_execution_outbox, {{schema}}.tf_execution_objects FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON {{schema}}.tf_execution_areas, {{schema}}.tf_execution_consents,
  {{schema}}.tf_execution_allocations, {{schema}}.tf_execution_jobs, {{schema}}.tf_execution_outbox,
  {{schema}}.tf_execution_objects TO {{runtime}};
GRANT SELECT, INSERT ON {{schema}}.tf_execution_events, {{schema}}.tf_execution_manifests,
  {{schema}}.tf_execution_manifest_files TO {{runtime}};
