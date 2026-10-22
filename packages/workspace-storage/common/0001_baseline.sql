-- Squashed workspace common baseline (0001-0052 concatenated in order). Production started empty, so history was rewritten.

-- 0001_baseline.sql
CREATE TABLE {{schema}}.tf_provisioning (
  id integer PRIMARY KEY CHECK (id = 1), workspace_id uuid UNIQUE NOT NULL,
  initialized_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE {{schema}}.tf_memberships (
  id uuid PRIMARY KEY, user_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'member')),
  created_at timestamptz NOT NULL DEFAULT now(), removed_at timestamptz
);
CREATE UNIQUE INDEX tf_memberships_active_user ON {{schema}}.tf_memberships (user_id) WHERE removed_at IS NULL;
CREATE TABLE {{schema}}.tf_authorization_lock (
  id integer PRIMARY KEY CHECK (id = 1), lock_version bigint NOT NULL DEFAULT 0
);
INSERT INTO {{schema}}.tf_authorization_lock (id) VALUES (1);
CREATE TABLE {{schema}}.tf_teams (
  id uuid PRIMARY KEY, name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE {{schema}}.tf_member_teams (
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships (id),
  team_id uuid NOT NULL REFERENCES {{schema}}.tf_teams (id),
  PRIMARY KEY (membership_id, team_id)
);
CREATE TABLE {{schema}}.tf_grants (
  team_id uuid NOT NULL REFERENCES {{schema}}.tf_teams (id),
  asset_id uuid NOT NULL, permission text NOT NULL,
  PRIMARY KEY (team_id, asset_id, permission)
);
CREATE TABLE {{schema}}.tf_soul_head (
  id integer PRIMARY KEY CHECK (id = 1), revision text, updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO {{schema}}.tf_soul_head (id) VALUES (1);
CREATE TABLE {{schema}}.tf_authoring_commands (
  id uuid PRIMARY KEY, membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships (id),
  table_id uuid NOT NULL, request_id text NOT NULL, expected_soul_revision text,
  change jsonb NOT NULL, status text NOT NULL CHECK (status IN ('preparing', 'accepted', 'conflict', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (membership_id, request_id)
);
CREATE TABLE {{schema}}.tf_soul_revisions (
  revision text PRIMARY KEY, parent_revision text, command_id uuid UNIQUE NOT NULL REFERENCES {{schema}}.tf_authoring_commands (id),
  bundle_key text NOT NULL, bundle_sha256 text NOT NULL, accepted_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE {{schema}}.tf_table_catalog (
  id uuid PRIMARY KEY, owning_team_id uuid NOT NULL REFERENCES {{schema}}.tf_teams (id),
  physical_table text UNIQUE NOT NULL CHECK (physical_table ~ '^[a-z][a-z0-9_]{0,47}$' AND physical_table !~ '^(tf_|pg_)'),
  display_name text NOT NULL, target_revision text NOT NULL,
  applied_revision text, applied_definition jsonb, maintenance boolean NOT NULL DEFAULT false,
  lock_version bigint NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE {{schema}}.tf_migration_jobs (
  id uuid PRIMARY KEY, table_id uuid NOT NULL REFERENCES {{schema}}.tf_table_catalog (id),
  command_id uuid UNIQUE NOT NULL REFERENCES {{schema}}.tf_authoring_commands (id),
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships (id),
  target_revision text NOT NULL, expected_applied_revision text, predecessor_id uuid REFERENCES {{schema}}.tf_migration_jobs (id),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'planning', 'waiting_for_confirmation', 'blocked', 'applying', 'applied', 'failed', 'rejected', 'superseded')),
  plan jsonb, plan_digest text, planner_version integer, common_version integer,
  error_code text, updated_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (table_id, target_revision)
);
CREATE TABLE {{schema}}.tf_confirmations (
  id uuid PRIMARY KEY, workspace_id uuid NOT NULL, table_id uuid NOT NULL REFERENCES {{schema}}.tf_table_catalog (id),
  migration_id uuid NOT NULL REFERENCES {{schema}}.tf_migration_jobs (id), plan_digest text NOT NULL,
  expected_applied_revision text, destructive_effect jsonb NOT NULL,
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships (id),
  expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), consumed_at timestamptz,
  UNIQUE (migration_id, plan_digest, membership_id)
);
CREATE TABLE {{schema}}.tf_migration_ledger (
  migration_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_migration_jobs (id),
  table_id uuid NOT NULL REFERENCES {{schema}}.tf_table_catalog (id),
  applied_revision text NOT NULL, plan_digest text NOT NULL,
  confirmation_id uuid REFERENCES {{schema}}.tf_confirmations (id), applied_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE {{schema}}.tf_outbox (
  id uuid PRIMARY KEY, migration_id uuid UNIQUE NOT NULL REFERENCES {{schema}}.tf_migration_jobs (id),
  created_at timestamptz NOT NULL DEFAULT now(), dispatched_at timestamptz, attempts integer NOT NULL DEFAULT 0
);
CREATE TABLE {{schema}}.tf_audit_events (
  id uuid PRIMARY KEY, actor_id text NOT NULL, operation text NOT NULL, subject_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

REVOKE ALL ON TABLE {{schema}}."tf_common_migrations" FROM PUBLIC, {{runtime}}, {{migration}}, {{customOwner}}, {{confirmation}};
REVOKE ALL ON TABLE {{schema}}."tf_provisioning" FROM PUBLIC, {{runtime}}, {{migration}}, {{customOwner}}, {{confirmation}};
REVOKE ALL ON TABLE {{schema}}."tf_memberships" FROM PUBLIC, {{runtime}}, {{migration}}, {{customOwner}}, {{confirmation}};
REVOKE ALL ON TABLE {{schema}}."tf_authorization_lock" FROM PUBLIC, {{runtime}}, {{migration}}, {{customOwner}}, {{confirmation}};
REVOKE ALL ON TABLE {{schema}}."tf_teams" FROM PUBLIC, {{runtime}}, {{migration}}, {{customOwner}}, {{confirmation}};
REVOKE ALL ON TABLE {{schema}}."tf_member_teams" FROM PUBLIC, {{runtime}}, {{migration}}, {{customOwner}}, {{confirmation}};
REVOKE ALL ON TABLE {{schema}}."tf_grants" FROM PUBLIC, {{runtime}}, {{migration}}, {{customOwner}}, {{confirmation}};
REVOKE ALL ON TABLE {{schema}}."tf_soul_head" FROM PUBLIC, {{runtime}}, {{migration}}, {{customOwner}}, {{confirmation}};
REVOKE ALL ON TABLE {{schema}}."tf_authoring_commands" FROM PUBLIC, {{runtime}}, {{migration}}, {{customOwner}}, {{confirmation}};
REVOKE ALL ON TABLE {{schema}}."tf_soul_revisions" FROM PUBLIC, {{runtime}}, {{migration}}, {{customOwner}}, {{confirmation}};
REVOKE ALL ON TABLE {{schema}}."tf_table_catalog" FROM PUBLIC, {{runtime}}, {{migration}}, {{customOwner}}, {{confirmation}};
REVOKE ALL ON TABLE {{schema}}."tf_migration_jobs" FROM PUBLIC, {{runtime}}, {{migration}}, {{customOwner}}, {{confirmation}};
REVOKE ALL ON TABLE {{schema}}."tf_confirmations" FROM PUBLIC, {{runtime}}, {{migration}}, {{customOwner}}, {{confirmation}};
REVOKE ALL ON TABLE {{schema}}."tf_migration_ledger" FROM PUBLIC, {{runtime}}, {{migration}}, {{customOwner}}, {{confirmation}};
REVOKE ALL ON TABLE {{schema}}."tf_outbox" FROM PUBLIC, {{runtime}}, {{migration}}, {{customOwner}}, {{confirmation}};
REVOKE ALL ON TABLE {{schema}}."tf_audit_events" FROM PUBLIC, {{runtime}}, {{migration}}, {{customOwner}}, {{confirmation}};
GRANT SELECT ON TABLE {{schema}}."tf_common_migrations" TO {{runtime}};
GRANT SELECT ON TABLE {{schema}}."tf_memberships" TO {{runtime}};
GRANT SELECT ON TABLE {{schema}}."tf_authorization_lock" TO {{runtime}};
GRANT SELECT ON TABLE {{schema}}."tf_teams" TO {{runtime}};
GRANT SELECT ON TABLE {{schema}}."tf_member_teams" TO {{runtime}};
GRANT SELECT ON TABLE {{schema}}."tf_grants" TO {{runtime}};
GRANT SELECT ON TABLE {{schema}}."tf_soul_head" TO {{runtime}};
GRANT SELECT ON TABLE {{schema}}."tf_authoring_commands" TO {{runtime}};
GRANT SELECT ON TABLE {{schema}}."tf_soul_revisions" TO {{runtime}};
GRANT SELECT ON TABLE {{schema}}."tf_table_catalog" TO {{runtime}};
GRANT SELECT ON TABLE {{schema}}."tf_migration_jobs" TO {{runtime}};
GRANT SELECT ON TABLE {{schema}}."tf_confirmations" TO {{runtime}};
GRANT SELECT ON TABLE {{schema}}."tf_migration_ledger" TO {{runtime}};
GRANT SELECT ON TABLE {{schema}}."tf_outbox" TO {{runtime}};
GRANT SELECT ON TABLE {{schema}}."tf_audit_events" TO {{runtime}};
GRANT INSERT, UPDATE, DELETE ON TABLE {{schema}}."tf_memberships" TO {{runtime}};
GRANT INSERT, UPDATE, DELETE ON TABLE {{schema}}."tf_teams" TO {{runtime}};
GRANT INSERT, UPDATE, DELETE ON TABLE {{schema}}."tf_member_teams" TO {{runtime}};
GRANT INSERT, UPDATE, DELETE ON TABLE {{schema}}."tf_grants" TO {{runtime}};
GRANT INSERT, UPDATE, DELETE ON TABLE {{schema}}."tf_authoring_commands" TO {{runtime}};
GRANT INSERT, UPDATE, DELETE ON TABLE {{schema}}."tf_outbox" TO {{runtime}};
GRANT UPDATE (revision, updated_at) ON {{schema}}."tf_soul_head" TO {{runtime}};
GRANT INSERT ON {{schema}}."tf_soul_revisions", {{schema}}."tf_audit_events" TO {{runtime}};
GRANT INSERT (id, owning_team_id, physical_table, display_name, target_revision), UPDATE (owning_team_id, display_name, target_revision, lock_version) ON {{schema}}."tf_table_catalog" TO {{runtime}};
GRANT INSERT (id, table_id, command_id, membership_id, target_revision, expected_applied_revision, predecessor_id) ON {{schema}}."tf_migration_jobs" TO {{runtime}};
GRANT SELECT ON {{schema}}."tf_common_migrations" TO {{migration}}, {{customOwner}}, {{confirmation}};
GRANT SELECT ON {{schema}}."tf_authorization_lock" TO {{migration}}, {{customOwner}}, {{confirmation}};
GRANT SELECT ON {{schema}}."tf_memberships" TO {{migration}}, {{customOwner}}, {{confirmation}};
GRANT SELECT ON {{schema}}."tf_teams" TO {{migration}}, {{customOwner}}, {{confirmation}};
GRANT SELECT ON {{schema}}."tf_member_teams" TO {{migration}}, {{customOwner}}, {{confirmation}};
GRANT SELECT ON {{schema}}."tf_grants" TO {{migration}}, {{customOwner}}, {{confirmation}};
GRANT SELECT ON {{schema}}."tf_table_catalog" TO {{migration}}, {{customOwner}}, {{confirmation}};
GRANT SELECT ON {{schema}}."tf_migration_jobs" TO {{migration}}, {{customOwner}}, {{confirmation}};
GRANT SELECT ON {{schema}}."tf_confirmations" TO {{migration}}, {{customOwner}}, {{confirmation}};
GRANT SELECT ON {{schema}}."tf_migration_ledger" TO {{migration}}, {{customOwner}}, {{confirmation}};
GRANT UPDATE (lock_version) ON {{schema}}."tf_authorization_lock" TO {{runtime}}, {{migration}}, {{customOwner}}, {{confirmation}};
GRANT SELECT ON {{schema}}."tf_authoring_commands", {{schema}}."tf_soul_revisions" TO {{migration}}, {{customOwner}};
GRANT UPDATE (lock_version) ON {{schema}}."tf_table_catalog" TO {{confirmation}};
GRANT UPDATE (applied_revision, applied_definition, maintenance, lock_version) ON {{schema}}."tf_table_catalog" TO {{migration}}, {{customOwner}};
GRANT UPDATE (status, plan, plan_digest, planner_version, common_version, error_code, updated_at) ON {{schema}}."tf_migration_jobs" TO {{migration}}, {{customOwner}};
GRANT UPDATE (consumed_at) ON {{schema}}."tf_confirmations" TO {{migration}}, {{customOwner}};
GRANT INSERT ON {{schema}}."tf_migration_ledger" TO {{migration}}, {{customOwner}};
GRANT INSERT (id, workspace_id, table_id, migration_id, plan_digest, expected_applied_revision, destructive_effect, membership_id, expires_at) ON {{schema}}."tf_confirmations" TO {{confirmation}};

CREATE VIEW {{schema}}.tf_table_authoring AS SELECT * FROM {{schema}}.tf_authoring_commands;
CREATE VIEW {{schema}}.tf_table_revisions AS SELECT * FROM {{schema}}.tf_soul_revisions;
GRANT SELECT ON {{schema}}.tf_table_authoring, {{schema}}.tf_table_revisions TO {{migration}}, {{customOwner}};

CREATE TABLE {{schema}}.tf_table_controls (
  id uuid PRIMARY KEY,
  migration_id uuid NOT NULL REFERENCES {{schema}}.tf_migration_jobs (id),
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships (id),
  operation text NOT NULL CHECK (operation IN ('retry', 'reject')),
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  outcome text
);
GRANT SELECT, INSERT (id, migration_id, membership_id, operation) ON {{schema}}.tf_table_controls TO {{runtime}};
GRANT SELECT, UPDATE (processed_at, outcome) ON {{schema}}.tf_table_controls TO {{migration}}, {{customOwner}};

CREATE TABLE {{schema}}.tf_table_execution_events (
  id uuid PRIMARY KEY, migration_id uuid NOT NULL REFERENCES {{schema}}.tf_migration_jobs (id),
  operation text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON {{schema}}.tf_table_execution_events TO {{runtime}};
GRANT SELECT, INSERT ON {{schema}}.tf_table_execution_events TO {{migration}}, {{customOwner}};

ALTER TABLE {{schema}}.tf_confirmations
  DROP CONSTRAINT tf_confirmations_migration_id_plan_digest_membership_id_key;
ALTER TABLE {{schema}}.tf_confirmations
  ADD CONSTRAINT tf_confirmation_history_identity
  UNIQUE (migration_id, plan_digest, membership_id, expires_at);

CREATE TABLE {{schema}}.tf_invitations (
  id uuid PRIMARY KEY,
  issuer_membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships (id),
  kind text NOT NULL CHECK (kind IN ('email', 'share')),
  email text,
  token_hash text UNIQUE NOT NULL CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  revoked_at timestamptz,
  consumed_membership_id uuid REFERENCES {{schema}}.tf_memberships (id),
  CHECK ((kind = 'email' AND email IS NOT NULL) OR (kind = 'share' AND email IS NULL)),
  CHECK (kind = 'email' OR consumed_membership_id IS NULL)
);
CREATE TABLE {{schema}}.tf_invitation_redemptions (
  invitation_id uuid NOT NULL REFERENCES {{schema}}.tf_invitations (id),
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (invitation_id, membership_id)
);
GRANT SELECT, INSERT, UPDATE ON {{schema}}.tf_invitations TO {{runtime}};
GRANT SELECT, INSERT ON {{schema}}.tf_invitation_redemptions TO {{runtime}};

CREATE TABLE {{schema}}.tf_agents (
  id uuid PRIMARY KEY, enabled boolean NOT NULL DEFAULT true
);
CREATE TABLE {{schema}}.tf_agent_definitions (
  agent_id uuid NOT NULL REFERENCES {{schema}}.tf_agents (id),
  revision text NOT NULL CHECK (revision ~ '^[a-f0-9]{64}$'),
  definition jsonb NOT NULL,
  PRIMARY KEY (agent_id, revision)
);
CREATE TABLE {{schema}}.tf_agent_activations (
  id uuid PRIMARY KEY, agent_id uuid NOT NULL,
  definition_revision text NOT NULL, scope jsonb NOT NULL CHECK (jsonb_typeof(scope) = 'array'),
  revoked_at timestamptz,
  FOREIGN KEY (agent_id, definition_revision) REFERENCES {{schema}}.tf_agent_definitions (agent_id, revision),
  UNIQUE (id, agent_id, definition_revision)
);
CREATE TABLE {{schema}}.tf_agent_teams (
  agent_id uuid NOT NULL REFERENCES {{schema}}.tf_agents (id),
  team_id uuid NOT NULL REFERENCES {{schema}}.tf_teams (id),
  PRIMARY KEY (agent_id, team_id)
);
CREATE TABLE {{schema}}.tf_agent_limits (
  agent_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_agents (id),
  scope jsonb NOT NULL CHECK (jsonb_typeof(scope) = 'array')
);
CREATE TABLE {{schema}}.tf_agent_schedules (
  id uuid PRIMARY KEY, activation_id uuid NOT NULL REFERENCES {{schema}}.tf_agent_activations (id),
  scope jsonb NOT NULL CHECK (jsonb_typeof(scope) = 'array'), revoked_at timestamptz,
  UNIQUE (id, activation_id)
);
CREATE TABLE {{schema}}.tf_agent_runs (
  id uuid PRIMARY KEY, agent_id uuid NOT NULL, activation_id uuid NOT NULL,
  definition_revision text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('delegated', 'scheduled')),
  user_id text, membership_id uuid REFERENCES {{schema}}.tf_memberships (id), schedule_id uuid,
  scope jsonb NOT NULL CHECK (jsonb_typeof(scope) = 'array'),
  status text NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'running', 'waiting', 'completed', 'blocked', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (activation_id, agent_id, definition_revision) REFERENCES {{schema}}.tf_agent_activations (id, agent_id, definition_revision),
  FOREIGN KEY (schedule_id, activation_id) REFERENCES {{schema}}.tf_agent_schedules (id, activation_id),
  CHECK ((kind = 'delegated' AND user_id IS NOT NULL AND membership_id IS NOT NULL AND schedule_id IS NULL)
      OR (kind = 'scheduled' AND user_id IS NULL AND membership_id IS NULL AND schedule_id IS NOT NULL))
);
CREATE TABLE {{schema}}.tf_agent_tool_calls (
  id uuid PRIMARY KEY, run_id uuid NOT NULL REFERENCES {{schema}}.tf_agent_runs (id),
  sequence integer NOT NULL CHECK (sequence >= 0 AND sequence < 100),
  call jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'waiting', 'blocked', 'failed')),
  result jsonb, UNIQUE (run_id, sequence)
);
ALTER TABLE {{schema}}.tf_authoring_commands ALTER COLUMN membership_id DROP NOT NULL;
ALTER TABLE {{schema}}.tf_authoring_commands ADD COLUMN agent_run_id uuid REFERENCES {{schema}}.tf_agent_runs (id);
ALTER TABLE {{schema}}.tf_authoring_commands ADD CONSTRAINT tf_authoring_actor CHECK ((membership_id IS NOT NULL) <> (agent_run_id IS NOT NULL));
CREATE UNIQUE INDEX tf_authoring_agent_request ON {{schema}}.tf_authoring_commands (agent_run_id, request_id);
ALTER TABLE {{schema}}.tf_migration_jobs ALTER COLUMN membership_id DROP NOT NULL;
ALTER TABLE {{schema}}.tf_migration_jobs ADD COLUMN agent_run_id uuid REFERENCES {{schema}}.tf_agent_runs (id);
ALTER TABLE {{schema}}.tf_migration_jobs ADD CONSTRAINT tf_migration_actor CHECK ((membership_id IS NOT NULL) <> (agent_run_id IS NOT NULL));
DO $agent_grants$
DECLARE
  workspace_schema text := '{{schema}}'::regnamespace::text;
  relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['tf_agents', 'tf_agent_definitions', 'tf_agent_activations', 'tf_agent_teams', 'tf_agent_limits', 'tf_agent_schedules', 'tf_agent_runs', 'tf_agent_tool_calls'] LOOP
    EXECUTE format('REVOKE ALL ON %I.%I FROM PUBLIC', workspace_schema, relation);
    EXECUTE format('GRANT SELECT, INSERT ON %I.%I TO %I', workspace_schema, relation, workspace_schema || '_runtime');
    IF relation <> 'tf_agent_tool_calls' AND relation <> 'tf_agent_definitions' THEN
      EXECUTE format('GRANT SELECT ON %I.%I TO %I, %I, %I', workspace_schema, relation, workspace_schema || '_migration', workspace_schema || '_owner', workspace_schema || '_confirmation');
    END IF;
  END LOOP;
  EXECUTE format('GRANT UPDATE (enabled) ON %I.tf_agents TO %I', workspace_schema, workspace_schema || '_runtime');
  EXECUTE format('GRANT UPDATE (revoked_at) ON %I.tf_agent_activations, %I.tf_agent_schedules TO %I', workspace_schema, workspace_schema, workspace_schema || '_runtime');
  EXECUTE format('GRANT UPDATE (scope) ON %I.tf_agent_limits TO %I', workspace_schema, workspace_schema || '_runtime');
  EXECUTE format('GRANT UPDATE (status) ON %I.tf_agent_runs TO %I', workspace_schema, workspace_schema || '_runtime');
  EXECUTE format('GRANT UPDATE (status, result) ON %I.tf_agent_tool_calls TO %I', workspace_schema, workspace_schema || '_runtime');
  EXECUTE format('GRANT DELETE ON %I.tf_agent_teams TO %I', workspace_schema, workspace_schema || '_runtime');
  EXECUTE format('GRANT INSERT (agent_run_id) ON %I.tf_migration_jobs TO %I', workspace_schema, workspace_schema || '_runtime');
END
$agent_grants$;

CREATE TABLE {{schema}}.tf_retired_teams (
  id uuid PRIMARY KEY,
  retired_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO {{schema}}.tf_retired_teams (id, retired_at)
SELECT subject_id, min(created_at) FROM {{schema}}.tf_audit_events
WHERE operation = 'team.delete' GROUP BY subject_id;
GRANT SELECT, INSERT ON {{schema}}.tf_retired_teams TO {{runtime}};

ALTER TABLE {{schema}}.tf_invitations
  ALTER COLUMN created_at SET DEFAULT clock_timestamp(),
  ALTER COLUMN expires_at SET DEFAULT (clock_timestamp() + interval '7 days');
CREATE INDEX tf_invitations_page ON {{schema}}.tf_invitations (created_at DESC, id DESC);

ALTER TABLE {{schema}}.tf_invitations ADD COLUMN request_id uuid UNIQUE;
SELECT pg_catalog.pg_advisory_xact_lock(734129, 10);
GRANT USAGE ON SCHEMA app TO {{runtime}};
GRANT EXECUTE ON FUNCTION app.invitation_delivery(uuid, uuid, text, jsonb, timestamptz) TO {{runtime}};

ALTER TABLE {{schema}}.tf_agents
  ADD COLUMN owning_team_id uuid REFERENCES {{schema}}.tf_teams (id),
  ADD COLUMN display_name text,
  ADD COLUMN saved_revision text,
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN policy_version integer NOT NULL DEFAULT 0;

CREATE TABLE {{schema}}.tf_agent_grants (
  agent_id uuid NOT NULL REFERENCES {{schema}}.tf_agents (id),
  team_id uuid NOT NULL REFERENCES {{schema}}.tf_teams (id) ON DELETE CASCADE,
  permission text NOT NULL CHECK (permission IN ('read', 'edit', 'delete', 'invoke')),
  PRIMARY KEY (agent_id, team_id, permission)
);
GRANT SELECT ON {{schema}}.tf_agent_grants TO {{migration}}, {{customOwner}};
CREATE TABLE {{schema}}.tf_agent_creation_grants (
  team_id uuid NOT NULL REFERENCES {{schema}}.tf_teams (id) ON DELETE CASCADE,
  owning_team_id uuid NOT NULL REFERENCES {{schema}}.tf_teams (id) ON DELETE CASCADE,
  PRIMARY KEY (team_id, owning_team_id)
);
CREATE TABLE {{schema}}.tf_agent_commands (
  id uuid PRIMARY KEY,
  agent_id uuid NOT NULL,
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships (id),
  user_id text NOT NULL,
  request_id uuid NOT NULL,
  input jsonb NOT NULL,
  status text NOT NULL DEFAULT 'preparing' CHECK (status IN ('preparing', 'accepted', 'conflict', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  dispatched_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  accepted_revision text,
  UNIQUE (membership_id, request_id)
);
ALTER TABLE {{schema}}.tf_soul_revisions ALTER COLUMN command_id DROP NOT NULL;
ALTER TABLE {{schema}}.tf_soul_revisions ADD COLUMN agent_command_id uuid UNIQUE REFERENCES {{schema}}.tf_agent_commands (id);
ALTER TABLE {{schema}}.tf_soul_revisions ADD CONSTRAINT tf_soul_revision_command CHECK ((command_id IS NOT NULL) <> (agent_command_id IS NOT NULL));
CREATE TABLE {{schema}}.tf_agent_saved_revisions (
  agent_id uuid NOT NULL REFERENCES {{schema}}.tf_agents (id),
  soul_revision text NOT NULL REFERENCES {{schema}}.tf_soul_revisions (revision),
  definition_revision text NOT NULL,
  projection jsonb NOT NULL,
  PRIMARY KEY (agent_id, soul_revision),
  FOREIGN KEY (agent_id, definition_revision) REFERENCES {{schema}}.tf_agent_definitions (agent_id, revision)
);
ALTER TABLE {{schema}}.tf_agents ADD CONSTRAINT tf_agent_saved_revision FOREIGN KEY (id, saved_revision) REFERENCES {{schema}}.tf_agent_saved_revisions (agent_id, soul_revision);
ALTER TABLE {{schema}}.tf_agents ADD CONSTRAINT tf_agent_saved_owner CHECK (saved_revision IS NULL OR deleted_at IS NOT NULL OR (owning_team_id IS NOT NULL AND display_name IS NOT NULL));

DO $saved_agent_grants$
DECLARE
  workspace_schema text := '{{schema}}'::regnamespace::text;
  relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['tf_agent_grants', 'tf_agent_creation_grants', 'tf_agent_commands', 'tf_agent_saved_revisions'] LOOP
    EXECUTE format('REVOKE ALL ON %I.%I FROM PUBLIC', workspace_schema, relation);
    EXECUTE format('GRANT SELECT, INSERT ON %I.%I TO %I', workspace_schema, relation, workspace_schema || '_runtime');
  END LOOP;
  EXECUTE format('GRANT DELETE ON %I.tf_agent_grants, %I.tf_agent_creation_grants TO %I', workspace_schema, workspace_schema, workspace_schema || '_runtime');
  EXECUTE format('GRANT UPDATE (status, dispatched_at, attempts, accepted_revision) ON %I.tf_agent_commands TO %I', workspace_schema, workspace_schema || '_runtime');
  EXECUTE format('GRANT UPDATE (owning_team_id, display_name, saved_revision, deleted_at, policy_version) ON %I.tf_agents TO %I', workspace_schema, workspace_schema || '_runtime');
END
$saved_agent_grants$;

CREATE TABLE {{schema}}.tf_connections (
  id uuid PRIMARY KEY,
  owning_team_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  enabled boolean NOT NULL DEFAULT true,
  generation integer NOT NULL DEFAULT 1 CHECK (generation > 0),
  grants_version integer NOT NULL DEFAULT 1 CHECK (grants_version > 0),
  credential jsonb,
  creation_intent jsonb NOT NULL,
  created_by jsonb NOT NULL,
  deleted_at timestamptz,
  live_owning_team_id uuid GENERATED ALWAYS AS (CASE WHEN deleted_at IS NULL THEN owning_team_id END) STORED REFERENCES {{schema}}.tf_teams (id),
  CHECK ((deleted_at IS NULL) = (credential IS NOT NULL))
);
CREATE TABLE {{schema}}.tf_connection_sources (
  id uuid PRIMARY KEY,
  connection_id uuid NOT NULL REFERENCES {{schema}}.tf_connections (id),
  owner text NOT NULL CHECK (owner ~ '^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$'),
  repo text NOT NULL CHECK (repo ~ '^[a-zA-Z0-9_.-]{1,100}$' AND repo NOT IN ('.', '..')),
  UNIQUE (connection_id, id)
);
CREATE UNIQUE INDEX tf_connection_repository ON {{schema}}.tf_connection_sources (connection_id, lower(owner), lower(repo));
CREATE TABLE {{schema}}.tf_connection_grants (
  connection_id uuid NOT NULL REFERENCES {{schema}}.tf_connections (id),
  team_id uuid NOT NULL REFERENCES {{schema}}.tf_teams (id),
  permission text NOT NULL CHECK (permission IN ('read', 'use', 'manage')),
  read_permission text NOT NULL DEFAULT 'read' CHECK (read_permission = 'read'),
  PRIMARY KEY (connection_id, team_id, permission),
  FOREIGN KEY (connection_id, team_id, read_permission) REFERENCES {{schema}}.tf_connection_grants (connection_id, team_id, permission) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE {{schema}}.tf_connection_source_grants (
  connection_id uuid NOT NULL,
  source_id uuid NOT NULL,
  team_id uuid NOT NULL REFERENCES {{schema}}.tf_teams (id),
  permission text NOT NULL DEFAULT 'github.issue.read' CHECK (permission = 'github.issue.read'),
  PRIMARY KEY (source_id, team_id),
  FOREIGN KEY (connection_id, source_id) REFERENCES {{schema}}.tf_connection_sources (connection_id, id)
);
CREATE TABLE {{schema}}.tf_connection_creation_grants (
  team_id uuid NOT NULL REFERENCES {{schema}}.tf_teams (id),
  owning_team_id uuid NOT NULL REFERENCES {{schema}}.tf_teams (id),
  permission text NOT NULL DEFAULT 'connection.create' CHECK (permission = 'connection.create'),
  PRIMARY KEY (team_id, owning_team_id)
);
CREATE TABLE {{schema}}.tf_connection_dispatches (
  request_id uuid PRIMARY KEY,
  connection_id uuid NOT NULL,
  source_id uuid NOT NULL,
  actor jsonb NOT NULL,
  issue_number integer NOT NULL CHECK (issue_number > 0),
  generation integer NOT NULL CHECK (generation > 0),
  status text NOT NULL CHECK (status IN ('executing', 'completed', 'failed')),
  attempt integer NOT NULL CHECK (attempt BETWEEN 1 AND 3),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  result jsonb,
  FOREIGN KEY (connection_id, source_id) REFERENCES {{schema}}.tf_connection_sources (connection_id, id),
  CHECK ((status = 'completed') = (result IS NOT NULL))
);
CREATE INDEX tf_connection_grants_team ON {{schema}}.tf_connection_grants (team_id, connection_id);
CREATE INDEX tf_connection_source_grants_team ON {{schema}}.tf_connection_source_grants (team_id, source_id);
DO $capabilities$
DECLARE
  workspace_schema text := '{{schema}}'::regnamespace::text;
  relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['tf_connections', 'tf_connection_sources', 'tf_connection_grants', 'tf_connection_source_grants', 'tf_connection_creation_grants', 'tf_connection_dispatches'] LOOP
    EXECUTE format('REVOKE ALL ON %I.%I FROM PUBLIC', workspace_schema, relation);
    EXECUTE format('GRANT SELECT, INSERT ON %I.%I TO %I', workspace_schema, relation, workspace_schema || '_runtime');
  END LOOP;
  EXECUTE format('GRANT UPDATE (name, owning_team_id, enabled, generation, grants_version, credential, deleted_at) ON %I.tf_connections TO %I', workspace_schema, workspace_schema || '_runtime');
  EXECUTE format('GRANT UPDATE (status, attempt, started_at, generation, result) ON %I.tf_connection_dispatches TO %I', workspace_schema, workspace_schema || '_runtime');
  EXECUTE format('GRANT DELETE ON %I.tf_connection_grants, %I.tf_connection_source_grants, %I.tf_connection_creation_grants TO %I', workspace_schema, workspace_schema, workspace_schema, workspace_schema || '_runtime');
END
$capabilities$;

ALTER TABLE {{schema}}.tf_agent_schedules
  ADD COLUMN interval_minutes integer CHECK (interval_minutes BETWEEN 1 AND 10080),
  ADD COLUMN call jsonb,
  ADD COLUMN next_run_at timestamptz,
  ADD COLUMN dispatched_at timestamptz,
  ADD CONSTRAINT tf_schedule_trigger CHECK ((interval_minutes IS NULL AND call IS NULL AND next_run_at IS NULL) OR (interval_minutes IS NOT NULL AND call IS NOT NULL AND next_run_at IS NOT NULL));
CREATE INDEX tf_agent_schedules_due ON {{schema}}.tf_agent_schedules (next_run_at, id) WHERE revoked_at IS NULL;
DO $grants$
BEGIN
  EXECUTE format('GRANT UPDATE (next_run_at, dispatched_at) ON %I.tf_agent_schedules TO %I', '{{schema}}'::regnamespace::text, '{{schema}}'::regnamespace::text || '_runtime');
END
$grants$;

CREATE TABLE {{schema}}.tf_agent_chat_turns (
  id uuid PRIMARY KEY REFERENCES {{schema}}.tf_agent_runs (id),
  prompt text NOT NULL CHECK (length(prompt) BETWEEN 1 AND 8000),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','selecting','tool','answered','failed')),
  lease_id uuid,
  lease_until timestamptz,
  decision jsonb,
  attempted_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  created_at timestamptz NOT NULL DEFAULT now()
);
DO $grants$
BEGIN
  EXECUTE format('REVOKE ALL ON %I.tf_agent_chat_turns FROM PUBLIC', '{{schema}}'::regnamespace::text);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE (status, lease_id, lease_until, decision, attempted_at, attempts) ON %I.tf_agent_chat_turns TO %I', '{{schema}}'::regnamespace::text, '{{schema}}'::regnamespace::text || '_runtime');
END
$grants$;

ALTER TABLE {{schema}}.tf_invitations
  ADD COLUMN copy_material jsonb,
  ADD COLUMN predecessor_id uuid UNIQUE REFERENCES {{schema}}.tf_invitations(id);
UPDATE {{schema}}.tf_invitations SET revoked_at = COALESCE(revoked_at, clock_timestamp()) WHERE kind = 'share';
ALTER TABLE {{schema}}.tf_invitations
  ADD CONSTRAINT email_only_active_invitation CHECK (kind = 'email' OR revoked_at IS NOT NULL),
  ADD CONSTRAINT terminal_invitation_has_no_copy CHECK (copy_material IS NULL OR (kind = 'email' AND revoked_at IS NULL AND consumed_membership_id IS NULL)),
  ALTER COLUMN created_at SET DEFAULT clock_timestamp(),
  ALTER COLUMN expires_at SET DEFAULT (clock_timestamp() + interval '7 days');
CREATE INDEX invitation_copy_expiry ON {{schema}}.tf_invitations(expires_at, id) WHERE copy_material IS NOT NULL;
GRANT SELECT (id, expires_at, copy_material), UPDATE (copy_material) ON {{schema}}.tf_invitations TO {{migration}};
CREATE TABLE {{schema}}.tf_invitation_operations (
  request_id uuid PRIMARY KEY,
  email text NOT NULL,
  predecessor_id uuid REFERENCES {{schema}}.tf_invitations(id),
  outcome text NOT NULL CHECK (outcome IN ('created', 'pending', 'already-member')),
  invitation_id uuid REFERENCES {{schema}}.tf_invitations(id),
  CHECK ((outcome = 'already-member') = (invitation_id IS NULL)),
  CHECK (predecessor_id IS NULL OR outcome = 'created')
);
INSERT INTO {{schema}}.tf_invitation_operations (request_id, email, predecessor_id, outcome, invitation_id)
  SELECT request_id, email, predecessor_id, 'created', id FROM {{schema}}.tf_invitations WHERE request_id IS NOT NULL;
GRANT SELECT, INSERT ON {{schema}}.tf_invitation_operations TO {{runtime}};

CREATE TABLE {{schema}}.tf_conversations (
  id uuid PRIMARY KEY,
  kind text NOT NULL DEFAULT 'private' CHECK (kind = 'private'),
  owner_user_id text NOT NULL,
  owner_membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  title text NOT NULL DEFAULT 'New chat' CHECK (char_length(title) BETWEEN 1 AND 640),
  title_revision integer NOT NULL DEFAULT 0 CHECK (title_revision >= 0),
  title_manual boolean NOT NULL DEFAULT false,
  archived_at timestamptz,
  activity_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  next_message_sequence integer NOT NULL DEFAULT 1 CHECK (next_message_sequence > 0)
);
CREATE INDEX tf_conversations_owner_activity ON {{schema}}.tf_conversations
  (owner_membership_id, (archived_at IS NOT NULL), activity_at DESC, id DESC);

CREATE TABLE {{schema}}.tf_conversation_messages (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES {{schema}}.tf_conversations(id),
  sequence integer NOT NULL CHECK (sequence > 0),
  author_kind text NOT NULL CHECK (author_kind IN ('human', 'assistant')),
  membership_id uuid REFERENCES {{schema}}.tf_memberships(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((author_kind = 'human') = (membership_id IS NOT NULL)),
  UNIQUE (conversation_id, sequence),
  UNIQUE (conversation_id, id),
  UNIQUE (conversation_id, id, sequence)
);

CREATE TABLE {{schema}}.tf_conversation_parts (
  conversation_id uuid NOT NULL,
  message_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 31),
  kind text NOT NULL CHECK (kind = 'text'),
  version integer NOT NULL DEFAULT 1 CHECK (version = 1),
  text text NOT NULL CHECK (octet_length(text) BETWEEN 1 AND 65536),
  PRIMARY KEY (message_id, ordinal),
  FOREIGN KEY (conversation_id, message_id) REFERENCES {{schema}}.tf_conversation_messages(conversation_id, id)
);

CREATE TABLE {{schema}}.tf_conversation_turns (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES {{schema}}.tf_conversations(id),
  source_message_id uuid NOT NULL UNIQUE,
  accepted_sequence integer NOT NULL CHECK (accepted_sequence > 0),
  responder text NOT NULL DEFAULT 'reverse-text-v1' CHECK (responder = 'reverse-text-v1'),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'waiting', 'reconciling', 'failed', 'completed', 'cancelled', 'blocked')),
  attempt_epoch integer NOT NULL DEFAULT 0 CHECK (attempt_epoch >= 0),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_until timestamptz,
  retry_at timestamptz,
  error_code text,
  response_message_id uuid UNIQUE,
  generation integer NOT NULL DEFAULT 0 CHECK (generation >= 0),
  UNIQUE (conversation_id, id),
  UNIQUE (conversation_id, accepted_sequence),
  FOREIGN KEY (conversation_id, source_message_id, accepted_sequence) REFERENCES {{schema}}.tf_conversation_messages(conversation_id, id, sequence),
  FOREIGN KEY (conversation_id, response_message_id) REFERENCES {{schema}}.tf_conversation_messages(conversation_id, id),
  CHECK ((status = 'completed') = (response_message_id IS NOT NULL)),
  CHECK ((status = 'processing') = (lease_until IS NOT NULL))
);
CREATE UNIQUE INDEX tf_conversation_active_turn ON {{schema}}.tf_conversation_turns (conversation_id)
  WHERE status IN ('processing', 'waiting', 'reconciling', 'failed');
CREATE INDEX tf_conversation_queue ON {{schema}}.tf_conversation_turns (conversation_id, accepted_sequence)
  WHERE status NOT IN ('completed', 'cancelled', 'blocked');

CREATE TABLE {{schema}}.tf_conversation_commands (
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  command_id uuid NOT NULL,
  operation text NOT NULL CHECK (operation IN ('create', 'send', 'rename', 'archive')),
  conversation_id uuid NOT NULL REFERENCES {{schema}}.tf_conversations(id),
  input_digest text NOT NULL CHECK (input_digest ~ '^[a-f0-9]{64}$'),
  outcome jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (membership_id, command_id)
);

CREATE TABLE {{schema}}.tf_conversation_outbox (
  turn_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  generation integer NOT NULL CHECK (generation >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  dispatched_at timestamptz,
  PRIMARY KEY (turn_id, generation),
  FOREIGN KEY (conversation_id, turn_id) REFERENCES {{schema}}.tf_conversation_turns(conversation_id, id)
);
CREATE INDEX tf_conversation_outbox_due ON {{schema}}.tf_conversation_outbox (next_attempt_at)
  WHERE dispatched_at IS NULL;

REVOKE ALL ON {{schema}}.tf_conversations, {{schema}}.tf_conversation_messages,
  {{schema}}.tf_conversation_parts, {{schema}}.tf_conversation_turns,
  {{schema}}.tf_conversation_commands, {{schema}}.tf_conversation_outbox FROM PUBLIC;
GRANT SELECT, INSERT ON {{schema}}.tf_conversations, {{schema}}.tf_conversation_messages,
  {{schema}}.tf_conversation_parts, {{schema}}.tf_conversation_turns,
  {{schema}}.tf_conversation_commands, {{schema}}.tf_conversation_outbox TO {{runtime}};
GRANT UPDATE (title, title_revision, title_manual, archived_at, activity_at, next_message_sequence)
  ON {{schema}}.tf_conversations TO {{runtime}};
GRANT UPDATE (status, attempt_epoch, attempts, lease_until, retry_at, error_code, response_message_id, generation)
  ON {{schema}}.tf_conversation_turns TO {{runtime}};
GRANT UPDATE (next_attempt_at, dispatched_at) ON {{schema}}.tf_conversation_outbox TO {{runtime}};

ALTER TABLE {{schema}}.tf_conversation_commands
  DROP CONSTRAINT tf_conversation_commands_operation_check,
  ADD CONSTRAINT tf_conversation_commands_operation_check
    CHECK (operation IN ('create', 'send', 'rename', 'archive', 'retry', 'cancel'));

CREATE TABLE {{schema}}.tf_model_fallback_rules (
  source_family_id text PRIMARY KEY CHECK (source_family_id ~ '^[a-z][a-z0-9-]{0,99}$'),
  target_family_id text CHECK (target_family_id ~ '^[a-z][a-z0-9-]{0,99}$'),
  revision integer NOT NULL CHECK (revision > 0),
  editor_membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships (id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (source_family_id <> target_family_id)
);
CREATE TABLE {{schema}}.tf_model_policy_commands (
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships (id),
  request_id uuid NOT NULL,
  input jsonb NOT NULL,
  receipt jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (membership_id, request_id)
);
DO $grants$
BEGIN
  EXECUTE format('REVOKE ALL ON %I.tf_model_fallback_rules, %I.tf_model_policy_commands FROM PUBLIC', '{{schema}}'::regnamespace::text, '{{schema}}'::regnamespace::text);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE (target_family_id, revision, editor_membership_id, updated_at) ON %I.tf_model_fallback_rules TO %I', '{{schema}}'::regnamespace::text, '{{schema}}'::regnamespace::text || '_runtime');
  EXECUTE format('GRANT SELECT, INSERT ON %I.tf_model_policy_commands TO %I', '{{schema}}'::regnamespace::text, '{{schema}}'::regnamespace::text || '_runtime');
END
$grants$;

CREATE TABLE {{schema}}.tf_model_generations (
  run_id uuid NOT NULL REFERENCES {{schema}}.tf_agent_chat_turns (id),
  generation integer NOT NULL CHECK (generation >= 0),
  binding jsonb NOT NULL,
  budget_pico_usd numeric(30,0) NOT NULL CHECK (budget_pico_usd >= 0),
  spent_pico_usd numeric(30,0) NOT NULL DEFAULT 0 CHECK (spent_pico_usd >= 0),
  deadline timestamptz NOT NULL DEFAULT clock_timestamp() + interval '150 seconds',
  next_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','failed','committed')),
  failure text,
  winner uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (run_id,generation)
);
CREATE TABLE {{schema}}.tf_model_attempts (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL,
  generation integer NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 3),
  role text NOT NULL CHECK (role IN ('primary','fallback')),
  resolution jsonb NOT NULL,
  reserved_pico_usd numeric(30,0) NOT NULL CHECK (reserved_pico_usd >= 0),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','failed','abandoned')),
  lease_until timestamptz NOT NULL,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  outcome jsonb,
  usage jsonb NOT NULL DEFAULT '{"kind":"unknown","reason":"abandoned"}',
  cost jsonb NOT NULL DEFAULT '{"kind":"unknown","reason":"abandoned"}',
  UNIQUE (run_id,generation,ordinal),
  FOREIGN KEY (run_id,generation) REFERENCES {{schema}}.tf_model_generations (run_id,generation)
);
CREATE UNIQUE INDEX tf_model_attempt_running ON {{schema}}.tf_model_attempts (run_id,generation) WHERE status='running';
CREATE TABLE {{schema}}.tf_model_retry_commands (
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships (id),
  request_id uuid NOT NULL,
  input jsonb NOT NULL,
  receipt jsonb NOT NULL,
  PRIMARY KEY (membership_id,request_id)
);
DO $grants$
BEGIN
  EXECUTE format('REVOKE ALL ON %I.tf_model_generations, %I.tf_model_attempts, %I.tf_model_retry_commands FROM PUBLIC', '{{schema}}'::regnamespace::text, '{{schema}}'::regnamespace::text, '{{schema}}'::regnamespace::text);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE (spent_pico_usd,next_at,status,failure,winner) ON %I.tf_model_generations TO %I', '{{schema}}'::regnamespace::text, '{{schema}}'::regnamespace::text || '_runtime');
  EXECUTE format('GRANT SELECT, INSERT, UPDATE (status,finished_at,outcome,usage,cost) ON %I.tf_model_attempts TO %I', '{{schema}}'::regnamespace::text, '{{schema}}'::regnamespace::text || '_runtime');
  EXECUTE format('GRANT SELECT, INSERT ON %I.tf_model_retry_commands TO %I', '{{schema}}'::regnamespace::text, '{{schema}}'::regnamespace::text || '_runtime');
END
$grants$;

CREATE TABLE {{schema}}.tf_conversation_attachments (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES {{schema}}.tf_conversations(id),
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  object_key uuid NOT NULL UNIQUE,
  filename text NOT NULL CHECK (char_length(filename) BETWEEN 1 AND 255),
  media_type text NOT NULL,
  size integer NOT NULL CHECK (size BETWEEN 1 AND 10485760),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved', 'ready', 'bound', 'abandoned')),
  expires_at timestamptz NOT NULL DEFAULT (clock_timestamp() + interval '24 hours'),
  message_id uuid,
  cleanup_after timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (conversation_id, id),
  FOREIGN KEY (conversation_id, message_id) REFERENCES {{schema}}.tf_conversation_messages(conversation_id, id),
  CHECK ((state = 'bound') = (message_id IS NOT NULL))
);
CREATE INDEX tf_attachment_cleanup ON {{schema}}.tf_conversation_attachments(cleanup_after, expires_at) WHERE state <> 'bound';
ALTER TABLE {{schema}}.tf_conversation_parts
  DROP CONSTRAINT tf_conversation_parts_kind_check,
  ALTER COLUMN text DROP NOT NULL,
  ADD COLUMN attachment_id uuid,
  ADD CONSTRAINT tf_conversation_parts_kind_check CHECK (
    (kind = 'text' AND text IS NOT NULL AND attachment_id IS NULL) OR
    (kind = 'attachment' AND text IS NULL AND attachment_id IS NOT NULL)),
  ADD FOREIGN KEY (conversation_id, attachment_id) REFERENCES {{schema}}.tf_conversation_attachments(conversation_id, id),
  ADD UNIQUE (attachment_id);
REVOKE ALL ON {{schema}}.tf_conversation_attachments FROM PUBLIC;
GRANT SELECT, INSERT ON {{schema}}.tf_conversation_attachments TO {{runtime}};
GRANT UPDATE (state, message_id, cleanup_after) ON {{schema}}.tf_conversation_attachments TO {{runtime}};

CREATE TABLE {{schema}}.tf_internal_conversations (
  id uuid PRIMARY KEY REFERENCES {{schema}}.tf_agent_runs(id),
  origin_conversation_id uuid,
  origin_turn_id uuid,
  next_sequence integer NOT NULL DEFAULT 1 CHECK (next_sequence > 0),
  CHECK ((origin_conversation_id IS NULL) = (origin_turn_id IS NULL)),
  FOREIGN KEY (origin_conversation_id, origin_turn_id)
    REFERENCES {{schema}}.tf_conversation_turns(conversation_id, id)
);

CREATE TABLE {{schema}}.tf_conversation_runtime_claims (
  conversation_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_internal_conversations(id),
  owner_id uuid NOT NULL,
  epoch integer NOT NULL CHECK (epoch > 0),
  lease_until timestamptz NOT NULL
);

CREATE TABLE {{schema}}.tf_internal_messages (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES {{schema}}.tf_internal_conversations(id),
  sequence integer NOT NULL CHECK (sequence > 0),
  producer_id uuid NOT NULL,
  input_digest text NOT NULL CHECK (input_digest ~ '^[a-f0-9]{64}$'),
  epoch integer NOT NULL CHECK (epoch > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (conversation_id, sequence),
  UNIQUE (conversation_id, producer_id),
  UNIQUE (conversation_id, id)
);

ALTER TABLE {{schema}}.tf_agent_tool_calls ADD CONSTRAINT tf_agent_tool_call_run_identity UNIQUE (run_id, id);
CREATE TABLE {{schema}}.tf_internal_parts (
  conversation_id uuid NOT NULL,
  message_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 31),
  kind text NOT NULL CHECK (kind IN ('text', 'tool')),
  text text,
  call_id uuid,
  PRIMARY KEY (message_id, ordinal),
  FOREIGN KEY (conversation_id, message_id) REFERENCES {{schema}}.tf_internal_messages(conversation_id, id),
  FOREIGN KEY (conversation_id, call_id) REFERENCES {{schema}}.tf_agent_tool_calls(run_id, id),
  CHECK ((kind = 'text' AND text IS NOT NULL AND octet_length(text) BETWEEN 1 AND 65536 AND call_id IS NULL)
    OR (kind = 'tool' AND text IS NULL AND call_id IS NOT NULL))
);

CREATE TABLE {{schema}}.tf_internal_publications (
  internal_id uuid NOT NULL REFERENCES {{schema}}.tf_internal_conversations(id),
  producer_id uuid NOT NULL,
  call_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'waiting', 'completed', 'blocked', 'failed')),
  conversation_id uuid NOT NULL,
  message_id uuid NOT NULL,
  PRIMARY KEY (internal_id, producer_id),
  FOREIGN KEY (internal_id, call_id) REFERENCES {{schema}}.tf_agent_tool_calls(run_id, id),
  FOREIGN KEY (conversation_id, message_id) REFERENCES {{schema}}.tf_conversation_messages(conversation_id, id)
);

REVOKE ALL ON {{schema}}.tf_internal_conversations, {{schema}}.tf_conversation_runtime_claims,
  {{schema}}.tf_internal_messages, {{schema}}.tf_internal_parts, {{schema}}.tf_internal_publications FROM PUBLIC;
GRANT SELECT, INSERT ON {{schema}}.tf_internal_conversations, {{schema}}.tf_conversation_runtime_claims,
  {{schema}}.tf_internal_messages, {{schema}}.tf_internal_parts, {{schema}}.tf_internal_publications TO {{runtime}};
GRANT UPDATE (next_sequence) ON {{schema}}.tf_internal_conversations TO {{runtime}};
GRANT UPDATE (owner_id, epoch, lease_until) ON {{schema}}.tf_conversation_runtime_claims TO {{runtime}};

LOCK TABLE {{schema}}.tf_teams IN ACCESS EXCLUSIVE MODE;
DO $team_names$
BEGIN
  IF EXISTS (SELECT lower(btrim(name)) FROM {{schema}}.tf_teams GROUP BY lower(btrim(name)) HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'duplicate-team-name: resolve teams with the same lower(btrim(name)) in this workspace, then rerun the common migration stream. No teams have been merged or renamed.' USING ERRCODE = 'P0020';
  END IF;
END
$team_names$;
ALTER TABLE {{schema}}.tf_teams ADD COLUMN description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 1000);
CREATE UNIQUE INDEX tf_teams_normalized_name ON {{schema}}.tf_teams (lower(btrim(name)));

CREATE TABLE {{schema}}.tf_conversation_requests (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL,
  turn_id uuid NOT NULL,
  internal_id uuid NOT NULL REFERENCES {{schema}}.tf_internal_conversations(id),
  producer_id uuid NOT NULL,
  input_digest text NOT NULL CHECK (input_digest ~ '^[a-f0-9]{64}$'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision = 1),
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  prompt text NOT NULL CHECK (octet_length(prompt) BETWEEN 1 AND 65536),
  answer_schema jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'answered', 'cancelled', 'expired')),
  expires_at timestamptz NOT NULL DEFAULT (clock_timestamp() + interval '7 days'),
  generation integer NOT NULL,
  attempt_epoch integer NOT NULL,
  UNIQUE (internal_id, producer_id),
  UNIQUE (conversation_id, id),
  UNIQUE (conversation_id, id, revision),
  FOREIGN KEY (conversation_id, turn_id) REFERENCES {{schema}}.tf_conversation_turns(conversation_id, id)
);
CREATE UNIQUE INDEX tf_conversation_pending_request ON {{schema}}.tf_conversation_requests(turn_id) WHERE status = 'pending';
CREATE INDEX tf_conversation_request_expiry ON {{schema}}.tf_conversation_requests(expires_at) WHERE status = 'pending';

CREATE TABLE {{schema}}.tf_conversation_responses (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL,
  request_id uuid NOT NULL UNIQUE,
  request_revision integer NOT NULL,
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  command_id uuid NOT NULL,
  answer jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (conversation_id, id),
  FOREIGN KEY (conversation_id, request_id, request_revision) REFERENCES {{schema}}.tf_conversation_requests(conversation_id, id, revision),
  FOREIGN KEY (membership_id, command_id) REFERENCES {{schema}}.tf_conversation_commands(membership_id, command_id) DEFERRABLE INITIALLY DEFERRED
);

ALTER TABLE {{schema}}.tf_conversation_parts
  DROP CONSTRAINT tf_conversation_parts_kind_check,
  ADD COLUMN request_id uuid,
  ADD COLUMN response_id uuid,
  ADD CONSTRAINT tf_conversation_parts_kind_check CHECK (
    (kind = 'text' AND text IS NOT NULL AND attachment_id IS NULL AND request_id IS NULL AND response_id IS NULL) OR
    (kind = 'attachment' AND text IS NULL AND attachment_id IS NOT NULL AND request_id IS NULL AND response_id IS NULL) OR
    (kind = 'request' AND text IS NULL AND attachment_id IS NULL AND request_id IS NOT NULL AND response_id IS NULL) OR
    (kind = 'response' AND text IS NULL AND attachment_id IS NULL AND request_id IS NULL AND response_id IS NOT NULL)),
  ADD FOREIGN KEY (conversation_id, request_id) REFERENCES {{schema}}.tf_conversation_requests(conversation_id, id),
  ADD FOREIGN KEY (conversation_id, response_id) REFERENCES {{schema}}.tf_conversation_responses(conversation_id, id);

ALTER TABLE {{schema}}.tf_conversation_commands DROP CONSTRAINT tf_conversation_commands_operation_check,
  ADD CONSTRAINT tf_conversation_commands_operation_check CHECK (operation IN ('create', 'send', 'rename', 'archive', 'retry', 'cancel', 'answer', 'cancel-request'));

REVOKE ALL ON {{schema}}.tf_conversation_requests, {{schema}}.tf_conversation_responses FROM PUBLIC;
GRANT SELECT, INSERT ON {{schema}}.tf_conversation_requests, {{schema}}.tf_conversation_responses TO {{runtime}};
GRANT UPDATE (status) ON {{schema}}.tf_conversation_requests TO {{runtime}};

CREATE TABLE {{schema}}.tf_conversation_approval_requests (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL,
  turn_id uuid NOT NULL,
  internal_id uuid NOT NULL REFERENCES {{schema}}.tf_internal_conversations(id),
  producer_id uuid NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision = 1),
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  prompt text NOT NULL CHECK (octet_length(prompt) BETWEEN 1 AND 65536),
  migration_id uuid NOT NULL UNIQUE REFERENCES {{schema}}.tf_migration_jobs(id),
  table_id uuid NOT NULL REFERENCES {{schema}}.tf_table_catalog(id),
  plan_digest text NOT NULL,
  expected_applied_revision text,
  destructive_effect jsonb NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT (clock_timestamp() + interval '24 hours'),
  generation integer NOT NULL,
  attempt_epoch integer NOT NULL,
  UNIQUE (internal_id, producer_id),
  UNIQUE (conversation_id, id),
  UNIQUE (id, revision),
  FOREIGN KEY (conversation_id, turn_id) REFERENCES {{schema}}.tf_conversation_turns(conversation_id, id)
);

CREATE TABLE {{schema}}.tf_conversation_approval_resolutions (
  request_id uuid PRIMARY KEY,
  request_revision integer NOT NULL,
  resolution text NOT NULL CHECK (resolution IN ('approved','rejected','expired','cancelled')),
  membership_id uuid REFERENCES {{schema}}.tf_memberships(id),
  command_id uuid,
  requested_decision text CHECK (requested_decision IN ('approve','reject','cancel')),
  confirmation_id uuid REFERENCES {{schema}}.tf_confirmations(id),
  rejection_id uuid REFERENCES {{schema}}.tf_table_controls(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (request_id, request_revision) REFERENCES {{schema}}.tf_conversation_approval_requests(id, revision),
  CHECK ((resolution = 'approved') = (confirmation_id IS NOT NULL)),
  CHECK ((resolution = 'rejected') = (rejection_id IS NOT NULL)),
  CHECK ((membership_id IS NULL) = (command_id IS NULL)),
  CHECK ((command_id IS NULL) = (requested_decision IS NULL)),
  CHECK (resolution = 'expired' OR membership_id IS NOT NULL),
  UNIQUE (membership_id, command_id)
);
CREATE INDEX tf_conversation_approval_expiry ON {{schema}}.tf_conversation_approval_requests(expires_at);
CREATE INDEX tf_conversation_approval_action ON {{schema}}.tf_conversation_approval_requests(migration_id);

ALTER TABLE {{schema}}.tf_conversation_parts
  DROP CONSTRAINT tf_conversation_parts_kind_check,
  ADD COLUMN approval_id uuid,
  ADD CONSTRAINT tf_conversation_parts_kind_check CHECK (
    (kind = 'text' AND text IS NOT NULL AND attachment_id IS NULL AND request_id IS NULL AND response_id IS NULL AND approval_id IS NULL) OR
    (kind = 'attachment' AND text IS NULL AND attachment_id IS NOT NULL AND request_id IS NULL AND response_id IS NULL AND approval_id IS NULL) OR
    (kind = 'request' AND text IS NULL AND attachment_id IS NULL AND request_id IS NOT NULL AND response_id IS NULL AND approval_id IS NULL) OR
    (kind = 'response' AND text IS NULL AND attachment_id IS NULL AND request_id IS NULL AND response_id IS NOT NULL AND approval_id IS NULL) OR
    (kind IN ('approval','approval-resolution') AND text IS NULL AND attachment_id IS NULL AND request_id IS NULL AND response_id IS NULL AND approval_id IS NOT NULL)),
  ADD FOREIGN KEY (conversation_id, approval_id) REFERENCES {{schema}}.tf_conversation_approval_requests(conversation_id, id);

REVOKE ALL ON {{schema}}.tf_conversation_approval_requests, {{schema}}.tf_conversation_approval_resolutions FROM PUBLIC;
GRANT SELECT, INSERT ON {{schema}}.tf_conversation_approval_requests TO {{runtime}};
GRANT SELECT ON {{schema}}.tf_conversation_approval_resolutions TO {{runtime}}, {{migration}}, {{customOwner}};
GRANT SELECT ON {{schema}}.tf_conversation_approval_requests TO {{confirmation}}, {{migration}}, {{customOwner}};
GRANT SELECT, INSERT ON {{schema}}.tf_conversation_approval_resolutions TO {{confirmation}};
GRANT SELECT ON {{schema}}.tf_conversations, {{schema}}.tf_conversation_turns TO {{confirmation}};
GRANT UPDATE (next_message_sequence, activity_at) ON {{schema}}.tf_conversations TO {{confirmation}};
GRANT UPDATE (status, generation, attempt_epoch, attempts, lease_until, retry_at, error_code) ON {{schema}}.tf_conversation_turns TO {{confirmation}};
GRANT INSERT ON {{schema}}.tf_conversation_messages, {{schema}}.tf_conversation_parts, {{schema}}.tf_conversation_outbox TO {{confirmation}};
GRANT INSERT (id, migration_id, membership_id, operation) ON {{schema}}.tf_table_controls TO {{confirmation}};
GRANT SELECT ON {{schema}}.tf_table_controls TO {{confirmation}};
GRANT SELECT, INSERT ON {{schema}}.tf_conversation_commands TO {{confirmation}};
ALTER TABLE {{schema}}.tf_conversation_commands DROP CONSTRAINT tf_conversation_commands_operation_check,
  ADD CONSTRAINT tf_conversation_commands_operation_check CHECK (operation IN ('create','send','rename','archive','retry','cancel','answer','cancel-request','approval'));

CREATE TABLE {{schema}}.tf_model_availability (
  family_id text PRIMARY KEY CHECK (family_id ~ '^[a-z][a-z0-9-]{0,99}$'),
  enabled boolean NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  last_disabled_revision integer NOT NULL CHECK (last_disabled_revision >= 0 AND last_disabled_revision <= revision),
  editor_membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships (id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE {{schema}}.tf_model_availability_commands (
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships (id),
  request_id uuid NOT NULL,
  input jsonb NOT NULL,
  receipt jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (membership_id, request_id)
);
DO $grants$
DECLARE receipt_owner text;
BEGIN
  EXECUTE format('REVOKE ALL ON %I.tf_model_availability, %I.tf_model_availability_commands FROM PUBLIC', '{{schema}}'::regnamespace::text, '{{schema}}'::regnamespace::text);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE (enabled, revision, last_disabled_revision, editor_membership_id, updated_at) ON %I.tf_model_availability TO %I', '{{schema}}'::regnamespace::text, '{{schema}}'::regnamespace::text || '_runtime');
  EXECUTE format('GRANT SELECT, INSERT ON %I.tf_model_availability_commands TO %I', '{{schema}}'::regnamespace::text, '{{schema}}'::regnamespace::text || '_runtime');
  SELECT pg_get_userbyid(proowner) INTO receipt_owner FROM pg_proc WHERE oid = to_regprocedure('app.model_availability_receipt()');
  IF receipt_owner IS NOT NULL THEN
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', '{{schema}}'::regnamespace::text, receipt_owner);
    EXECUTE format('GRANT SELECT ON %I.tf_memberships, %I.tf_authorization_lock, %I.tf_model_availability TO %I', '{{schema}}'::regnamespace::text, '{{schema}}'::regnamespace::text, '{{schema}}'::regnamespace::text, receipt_owner);
    EXECUTE format('GRANT UPDATE(lock_version) ON %I.tf_authorization_lock TO %I', '{{schema}}'::regnamespace::text, receipt_owner);
    CREATE TRIGGER model_availability_receipt AFTER INSERT ON {{schema}}.tf_model_availability_commands
      FOR EACH ROW EXECUTE FUNCTION app.model_availability_receipt();
  END IF;
END
$grants$;

CREATE TABLE {{schema}}.tf_workflows (
  id uuid PRIMARY KEY,
  revision uuid NOT NULL,
  active_revision uuid,
  enabled boolean NOT NULL DEFAULT false,
  next_run_at timestamptz,
  webhook_digest text
);
CREATE TABLE {{schema}}.tf_workflow_revisions (
  workflow_id uuid NOT NULL REFERENCES {{schema}}.tf_workflows(id),
  id uuid NOT NULL,
  definition jsonb NOT NULL,
  author_membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workflow_id, id)
);
ALTER TABLE {{schema}}.tf_workflows ADD FOREIGN KEY (id, revision) REFERENCES {{schema}}.tf_workflow_revisions(workflow_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE {{schema}}.tf_workflows ADD FOREIGN KEY (id, active_revision) REFERENCES {{schema}}.tf_workflow_revisions(workflow_id,id);
CREATE TABLE {{schema}}.tf_workflow_runs (
  id uuid PRIMARY KEY,
  workflow_id uuid NOT NULL,
  revision uuid NOT NULL,
  request_key text NOT NULL,
  membership_id uuid REFERENCES {{schema}}.tf_memberships(id),
  input jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','waiting','completed','cancelled','blocked','failed')),
  error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  dispatched_at timestamptz,
  FOREIGN KEY (workflow_id, revision) REFERENCES {{schema}}.tf_workflow_revisions(workflow_id,id),
  UNIQUE (workflow_id, request_key)
);
CREATE INDEX tf_workflow_pending ON {{schema}}.tf_workflow_runs (dispatched_at NULLS FIRST, created_at) WHERE status IN ('queued','running','waiting');
CREATE TABLE {{schema}}.tf_workflow_steps (
  run_id uuid NOT NULL REFERENCES {{schema}}.tf_workflow_runs(id),
  step_id text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 31),
  status text NOT NULL CHECK (status IN ('waiting','completed')),
  output jsonb,
  prompt text,
  due_at timestamptz,
  response_id uuid,
  PRIMARY KEY (run_id, step_id),
  UNIQUE (run_id, ordinal)
);
REVOKE ALL ON {{schema}}.tf_workflows, {{schema}}.tf_workflow_revisions, {{schema}}.tf_workflow_runs, {{schema}}.tf_workflow_steps FROM PUBLIC;
GRANT SELECT, INSERT ON {{schema}}.tf_workflows, {{schema}}.tf_workflow_revisions, {{schema}}.tf_workflow_runs, {{schema}}.tf_workflow_steps TO {{runtime}};
GRANT UPDATE (revision,active_revision,enabled,next_run_at,webhook_digest) ON {{schema}}.tf_workflows TO {{runtime}};
GRANT UPDATE (status,error,dispatched_at) ON {{schema}}.tf_workflow_runs TO {{runtime}};
GRANT UPDATE (status,output,response_id) ON {{schema}}.tf_workflow_steps TO {{runtime}};

CREATE TABLE {{schema}}.tf_provider_connections (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  source jsonb NOT NULL,
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  credential jsonb NOT NULL,
  creation_digest text NOT NULL,
  update_digest text,
  generation integer NOT NULL DEFAULT 1 CHECK (generation > 0),
  enabled boolean NOT NULL DEFAULT true
);
CREATE TABLE {{schema}}.tf_provider_polls (
  workflow_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_workflows(id),
  revision uuid NOT NULL,
  connection_id uuid NOT NULL REFERENCES {{schema}}.tf_provider_connections(id),
  cursor jsonb NOT NULL,
  fence uuid NOT NULL,
  next_poll timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_success timestamptz,
  error text,
  FOREIGN KEY (workflow_id, revision) REFERENCES {{schema}}.tf_workflow_revisions(workflow_id,id)
);
CREATE TABLE {{schema}}.tf_provider_events (
  workflow_id uuid NOT NULL,
  revision uuid NOT NULL,
  event_key text NOT NULL,
  payload jsonb NOT NULL,
  admitted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workflow_id,revision,event_key),
  FOREIGN KEY (workflow_id, revision) REFERENCES {{schema}}.tf_workflow_revisions(workflow_id,id)
);
CREATE INDEX tf_provider_pending ON {{schema}}.tf_provider_events(workflow_id,revision,created_at) WHERE NOT admitted;
REVOKE ALL ON {{schema}}.tf_provider_connections, {{schema}}.tf_provider_polls, {{schema}}.tf_provider_events FROM PUBLIC;
GRANT SELECT, INSERT ON {{schema}}.tf_provider_connections, {{schema}}.tf_provider_polls, {{schema}}.tf_provider_events TO {{runtime}};
GRANT UPDATE (credential,generation,enabled,update_digest) ON {{schema}}.tf_provider_connections TO {{runtime}};
GRANT UPDATE (revision,connection_id,cursor,fence,next_poll,last_success,error) ON {{schema}}.tf_provider_polls TO {{runtime}};
GRANT UPDATE (admitted) ON {{schema}}.tf_provider_events TO {{runtime}};

ALTER TABLE {{schema}}.tf_workflows ADD COLUMN generation integer NOT NULL DEFAULT 1 CHECK (generation > 0);
GRANT UPDATE (generation) ON {{schema}}.tf_workflows TO {{runtime}};
CREATE TABLE {{schema}}.tf_workflow_commands (
  id uuid PRIMARY KEY,
  request_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON {{schema}}.tf_workflow_commands FROM PUBLIC;
GRANT SELECT, INSERT ON {{schema}}.tf_workflow_commands TO {{runtime}};

ALTER TABLE {{schema}}.tf_conversation_turns
  DROP CONSTRAINT tf_conversation_turns_responder_check,
  ADD CONSTRAINT tf_conversation_turns_responder_check
    CHECK (responder ~ '^[a-z0-9][a-z0-9._-]{0,99}$');

CREATE TABLE {{schema}}.tf_credit_usage (
  id text PRIMARY KEY,
  flow_id text NOT NULL,
  model_id text NOT NULL,
  agent_id uuid,
  activity text NOT NULL CHECK (activity IN ('chat','agent','other')),
  reserved numeric(30,0) NOT NULL CHECK (reserved >= 0),
  charged numeric(30,0) CHECK (charged >= 0 AND charged <= reserved),
  provider_pico_usd numeric(30,0) CHECK (provider_pico_usd >= 0),
  pricing_revision text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX tf_credit_usage_day ON {{schema}}.tf_credit_usage (created_at);
CREATE INDEX tf_credit_usage_flow ON {{schema}}.tf_credit_usage (flow_id);
DO $grants$
BEGIN
  EXECUTE format('REVOKE ALL ON %I.tf_credit_usage FROM PUBLIC', '{{schema}}'::regnamespace::text);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE(charged,provider_pico_usd) ON %I.tf_credit_usage TO %I', '{{schema}}'::regnamespace::text, '{{schema}}'::regnamespace::text || '_runtime');
END
$grants$;

CREATE TABLE {{schema}}.tf_conversation_tool_calls (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL,
  turn_id uuid NOT NULL,
  sequence integer NOT NULL CHECK (sequence BETWEEN 1 AND 8),
  tool text NOT NULL CHECK (tool ~ '^[a-z][a-z.]{0,63}$'),
  status text NOT NULL CHECK (status IN ('running', 'completed', 'blocked', 'failed')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (conversation_id, turn_id) REFERENCES {{schema}}.tf_conversation_turns(conversation_id, id),
  UNIQUE (turn_id, sequence)
);
CREATE INDEX tf_conversation_tool_turn ON {{schema}}.tf_conversation_tool_calls(turn_id, created_at, id);
REVOKE ALL ON {{schema}}.tf_conversation_tool_calls FROM PUBLIC;
GRANT SELECT, INSERT ON {{schema}}.tf_conversation_tool_calls TO {{runtime}};
GRANT UPDATE (status) ON {{schema}}.tf_conversation_tool_calls TO {{runtime}};

CREATE TABLE {{schema}}.tf_conversation_results (
  conversation_id uuid NOT NULL,
  turn_id uuid PRIMARY KEY,
  message_id uuid NOT NULL UNIQUE,
  sources jsonb NOT NULL CHECK (jsonb_typeof(sources) = 'array' AND jsonb_array_length(sources) <= 1000),
  publication text NOT NULL DEFAULT 'private' CHECK (publication = 'private'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (conversation_id, turn_id) REFERENCES {{schema}}.tf_conversation_turns(conversation_id, id),
  FOREIGN KEY (conversation_id, message_id) REFERENCES {{schema}}.tf_conversation_messages(conversation_id, id)
);
REVOKE ALL ON {{schema}}.tf_conversation_results FROM PUBLIC;
GRANT SELECT, INSERT ON {{schema}}.tf_conversation_results TO {{runtime}};

CREATE TABLE {{schema}}.tf_slack_installations (
  id uuid PRIMARY KEY,
  app_id text NOT NULL,
  team_id text NOT NULL,
  bot_user_id text NOT NULL,
  generation integer NOT NULL CHECK (generation > 0),
  state text NOT NULL CHECK (state IN ('reserved', 'active', 'scope-missing', 'revoked')),
  scopes text[] NOT NULL,
  bot_credential jsonb,
  accepts_events_after bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (state NOT IN ('reserved', 'active') OR bot_credential IS NOT NULL)
);
CREATE UNIQUE INDEX tf_slack_one_installation ON {{schema}}.tf_slack_installations ((true));
CREATE TABLE {{schema}}.tf_slack_events (
  id uuid PRIMARY KEY,
  installation_id uuid NOT NULL REFERENCES {{schema}}.tf_slack_installations(id),
  generation integer NOT NULL CHECK (generation > 0),
  event_id text NOT NULL UNIQUE,
  semantic_key text NOT NULL,
  event_time bigint NOT NULL,
  payload jsonb NOT NULL,
  disposition text NOT NULL CHECK (disposition IN ('held', 'ignored', 'lifecycle')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (installation_id, generation, semantic_key)
);
CREATE TABLE {{schema}}.tf_slack_user_revocations (
  installation_id uuid NOT NULL REFERENCES {{schema}}.tf_slack_installations(id),
  generation integer NOT NULL,
  slack_user_id text NOT NULL,
  event_id text NOT NULL REFERENCES {{schema}}.tf_slack_events(event_id),
  revoked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (installation_id, generation, slack_user_id)
);
REVOKE ALL ON {{schema}}.tf_slack_installations, {{schema}}.tf_slack_events, {{schema}}.tf_slack_user_revocations FROM PUBLIC;
GRANT SELECT, INSERT ON {{schema}}.tf_slack_installations, {{schema}}.tf_slack_events, {{schema}}.tf_slack_user_revocations TO {{runtime}};
GRANT UPDATE (state, generation, scopes, bot_credential, bot_user_id, accepts_events_after) ON {{schema}}.tf_slack_installations TO {{runtime}};

CREATE TABLE {{schema}}.tf_workspace_skills (
  id uuid PRIMARY KEY,
  creator_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  saved_revision text NOT NULL,
  active_revision text,
  enabled boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  CHECK (NOT enabled OR active_revision IS NOT NULL)
);
CREATE TABLE {{schema}}.tf_workspace_skill_revisions (
  skill_id uuid NOT NULL REFERENCES {{schema}}.tf_workspace_skills(id),
  revision text NOT NULL CHECK (revision ~ '^[a-f0-9]{64}$'),
  definition jsonb NOT NULL,
  author_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (skill_id, revision)
);
ALTER TABLE {{schema}}.tf_workspace_skills ADD FOREIGN KEY (id, saved_revision)
  REFERENCES {{schema}}.tf_workspace_skill_revisions(skill_id, revision) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE {{schema}}.tf_workspace_skills ADD FOREIGN KEY (id, active_revision)
  REFERENCES {{schema}}.tf_workspace_skill_revisions(skill_id, revision) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE {{schema}}.tf_workspace_skill_reviews (
  skill_id uuid NOT NULL,
  revision text NOT NULL,
  reviewer_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  reviewed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (skill_id, revision),
  FOREIGN KEY (skill_id, revision) REFERENCES {{schema}}.tf_workspace_skill_revisions(skill_id, revision)
);
CREATE TABLE {{schema}}.tf_workspace_skill_commands (
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  request_id uuid NOT NULL,
  input jsonb NOT NULL,
  receipt jsonb NOT NULL,
  PRIMARY KEY (membership_id, request_id)
);
REVOKE ALL ON {{schema}}.tf_workspace_skills, {{schema}}.tf_workspace_skill_revisions,
  {{schema}}.tf_workspace_skill_reviews, {{schema}}.tf_workspace_skill_commands FROM PUBLIC;
GRANT SELECT, INSERT ON {{schema}}.tf_workspace_skills, {{schema}}.tf_workspace_skill_revisions,
  {{schema}}.tf_workspace_skill_reviews, {{schema}}.tf_workspace_skill_commands TO {{runtime}};
GRANT UPDATE (saved_revision, active_revision, enabled, version) ON {{schema}}.tf_workspace_skills TO {{runtime}};

CREATE TABLE {{schema}}.tf_atlassian_accounts (
  id uuid PRIMARY KEY,
  protocol text NOT NULL CHECK (protocol IN ('atlassian-mcp', 'atlassian-rest', 'trello')),
  ownership text NOT NULL CHECK (ownership IN ('personal', 'business')),
  owner_membership_id uuid REFERENCES {{schema}}.tf_memberships(id),
  generation integer NOT NULL DEFAULT 1 CHECK (generation > 0),
  grants_version integer NOT NULL DEFAULT 1 CHECK (grants_version > 0),
  state text NOT NULL CHECK (state IN ('authorizing', 'active', 'refreshing', 'reconnect-required', 'disconnected')),
  config_hash text NOT NULL,
  identity jsonb,
  resources jsonb NOT NULL DEFAULT '[]',
  scopes text[] NOT NULL DEFAULT '{}',
  credential jsonb,
  expires_at timestamptz,
  refresh_started_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((ownership = 'personal') = (owner_membership_id IS NOT NULL)),
  CHECK (state NOT IN ('active', 'refreshing') OR (credential IS NOT NULL AND expires_at IS NOT NULL AND identity IS NOT NULL)),
  CHECK (state <> 'refreshing' OR refresh_started_at IS NOT NULL)
);
CREATE TABLE {{schema}}.tf_atlassian_account_attempts (
  account_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_atlassian_accounts(id),
  generation integer NOT NULL,
  state_hash text NOT NULL UNIQUE,
  session_hash text NOT NULL,
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  state text NOT NULL CHECK (state IN ('reserved', 'exchanging', 'consumed')),
  verifier jsonb,
  expires_at timestamptz NOT NULL,
  CHECK (state <> 'reserved' OR verifier IS NOT NULL)
);
CREATE TABLE {{schema}}.tf_atlassian_account_member_grants (
  account_id uuid NOT NULL REFERENCES {{schema}}.tf_atlassian_accounts(id),
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  PRIMARY KEY (account_id, membership_id)
);
CREATE TABLE {{schema}}.tf_atlassian_account_team_grants (
  account_id uuid NOT NULL REFERENCES {{schema}}.tf_atlassian_accounts(id),
  team_id uuid NOT NULL REFERENCES {{schema}}.tf_teams(id) ON DELETE CASCADE,
  PRIMARY KEY (account_id, team_id)
);
REVOKE ALL ON {{schema}}.tf_atlassian_accounts, {{schema}}.tf_atlassian_account_attempts, {{schema}}.tf_atlassian_account_member_grants, {{schema}}.tf_atlassian_account_team_grants FROM PUBLIC;
GRANT SELECT, INSERT ON {{schema}}.tf_atlassian_accounts, {{schema}}.tf_atlassian_account_attempts TO {{runtime}};
GRANT UPDATE (generation, grants_version, state, config_hash, identity, resources, scopes, credential, expires_at, refresh_started_at) ON {{schema}}.tf_atlassian_accounts TO {{runtime}};
GRANT UPDATE (generation, state_hash, session_hash, membership_id, state, verifier, expires_at) ON {{schema}}.tf_atlassian_account_attempts TO {{runtime}};
GRANT SELECT, INSERT, DELETE ON {{schema}}.tf_atlassian_account_member_grants, {{schema}}.tf_atlassian_account_team_grants TO {{runtime}};

CREATE TABLE {{schema}}.tf_slack_identities (
  id uuid PRIMARY KEY,
  installation_id uuid NOT NULL REFERENCES {{schema}}.tf_slack_installations(id),
  generation integer NOT NULL,
  slack_user_id text NOT NULL,
  user_id text NOT NULL,
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  state text NOT NULL CHECK (state IN ('consent-required','authorized','revoked')),
  credential jsonb,
  scopes text[] NOT NULL DEFAULT '{}',
  authorized_at timestamptz,
  UNIQUE (installation_id,generation,slack_user_id),
  UNIQUE (installation_id,generation,membership_id),
  CHECK ((state='authorized') = (credential IS NOT NULL))
);
CREATE TABLE {{schema}}.tf_slack_continuations (
  event_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_slack_events(id),
  identity_id uuid NOT NULL REFERENCES {{schema}}.tf_slack_identities(id),
  state text NOT NULL CHECK (state IN ('consent-required','dispatch-held','cancelled')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE {{schema}}.tf_slack_link_challenges (
  state_hash text PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES {{schema}}.tf_slack_events(id),
  installation_id uuid NOT NULL REFERENCES {{schema}}.tf_slack_installations(id),
  generation integer NOT NULL,
  app_id text NOT NULL,
  team_id text NOT NULL,
  slack_user_id text NOT NULL,
  user_id text NOT NULL,
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  session_id text NOT NULL,
  browser_hash text NOT NULL,
  nonce text NOT NULL,
  stage text NOT NULL CHECK (stage IN ('identity','identity-exchanging','identity-proved','operational','operational-exchanging','used')),
  expires_at timestamptz NOT NULL
);
REVOKE ALL ON {{schema}}.tf_slack_identities, {{schema}}.tf_slack_continuations, {{schema}}.tf_slack_link_challenges FROM PUBLIC;
GRANT SELECT,INSERT ON {{schema}}.tf_slack_identities, {{schema}}.tf_slack_continuations, {{schema}}.tf_slack_link_challenges TO {{runtime}};
GRANT UPDATE (state,credential,scopes,authorized_at) ON {{schema}}.tf_slack_identities TO {{runtime}};
GRANT UPDATE (state) ON {{schema}}.tf_slack_continuations TO {{runtime}};
GRANT UPDATE (stage) ON {{schema}}.tf_slack_link_challenges TO {{runtime}};

CREATE TABLE {{schema}}.tf_atlassian_sources (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES {{schema}}.tf_atlassian_accounts(id),
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  binding jsonb NOT NULL CHECK (octet_length(binding::text) <= 2048),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE {{schema}}.tf_atlassian_proposals (
  id uuid PRIMARY KEY,
  source_id uuid NOT NULL REFERENCES {{schema}}.tf_atlassian_sources(id),
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  command_id uuid NOT NULL,
  operation jsonb NOT NULL CHECK (octet_length(operation::text) <= 131072),
  account_generation integer NOT NULL,
  grants_version integer NOT NULL,
  configuration_digest text NOT NULL,
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp() + interval '10 minutes',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (membership_id, command_id),
  UNIQUE (id, membership_id, digest)
);
CREATE TABLE {{schema}}.tf_atlassian_decisions (
  proposal_id uuid PRIMARY KEY,
  membership_id uuid NOT NULL,
  digest text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('approve','reject')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (proposal_id, membership_id, digest) REFERENCES {{schema}}.tf_atlassian_proposals(id, membership_id, digest)
);
CREATE TABLE {{schema}}.tf_atlassian_receipts (
  proposal_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_atlassian_proposals(id),
  status text NOT NULL DEFAULT 'executing' CHECK (status IN ('executing','succeeded','failed','outcome-unknown')),
  result jsonb CHECK (octet_length(result::text) <= 262144),
  error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((status = 'succeeded') = (result IS NOT NULL)),
  CHECK (status NOT IN ('executing','succeeded') OR error IS NULL)
);
CREATE FUNCTION {{schema}}.tf_atlassian_receipt_transition() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF OLD.status <> 'executing' OR NEW.status = 'executing' THEN
    RAISE EXCEPTION 'Receipt is terminal';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER tf_atlassian_receipt_terminal BEFORE UPDATE ON {{schema}}.tf_atlassian_receipts FOR EACH ROW EXECUTE FUNCTION {{schema}}.tf_atlassian_receipt_transition();
REVOKE ALL ON FUNCTION {{schema}}.tf_atlassian_receipt_transition() FROM PUBLIC;
REVOKE ALL ON {{schema}}.tf_atlassian_sources, {{schema}}.tf_atlassian_proposals, {{schema}}.tf_atlassian_decisions, {{schema}}.tf_atlassian_receipts FROM PUBLIC;
GRANT SELECT ON {{schema}}.tf_atlassian_sources, {{schema}}.tf_atlassian_proposals, {{schema}}.tf_atlassian_decisions, {{schema}}.tf_atlassian_receipts TO {{runtime}}, {{confirmation}};
GRANT INSERT (id,account_id,membership_id,name,binding) ON {{schema}}.tf_atlassian_sources TO {{runtime}};
GRANT UPDATE (enabled) ON {{schema}}.tf_atlassian_sources TO {{runtime}};
GRANT INSERT (id,source_id,membership_id,command_id,operation,account_generation,grants_version,configuration_digest,digest) ON {{schema}}.tf_atlassian_proposals TO {{runtime}};
GRANT INSERT (proposal_id) ON {{schema}}.tf_atlassian_receipts TO {{runtime}};
GRANT UPDATE (status,result,error) ON {{schema}}.tf_atlassian_receipts TO {{runtime}};
GRANT INSERT (proposal_id,membership_id,digest,decision) ON {{schema}}.tf_atlassian_decisions TO {{confirmation}};
GRANT SELECT (id,protocol,ownership,owner_membership_id,generation,grants_version,state,expires_at,config_hash,resources) ON {{schema}}.tf_atlassian_accounts TO {{confirmation}};
GRANT SELECT ON {{schema}}.tf_atlassian_account_member_grants, {{schema}}.tf_atlassian_account_team_grants TO {{confirmation}};

CREATE TABLE {{schema}}.tf_google_connections (
  id uuid PRIMARY KEY,
  user_id text NOT NULL,
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  generation integer NOT NULL CHECK (generation > 0),
  status text NOT NULL CHECK (status IN ('disconnected', 'connected', 'reconnect-required')),
  account_id text,
  email text,
  scopes text[] NOT NULL DEFAULT '{}',
  credential jsonb,
  UNIQUE (membership_id),
  CHECK ((status = 'connected') = (credential IS NOT NULL)),
  CHECK (status <> 'connected' OR (account_id IS NOT NULL AND email IS NOT NULL))
);
CREATE TABLE {{schema}}.tf_google_oauth_states (
  connection_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_google_connections(id),
  state_hash text NOT NULL UNIQUE,
  session_hash text NOT NULL,
  generation integer NOT NULL CHECK (generation > 0),
  verifier jsonb NOT NULL,
  expires_at timestamptz NOT NULL
);
DO $capabilities$
DECLARE
  workspace_schema text := '{{schema}}'::regnamespace::text;
BEGIN
  EXECUTE format('REVOKE ALL ON %I.tf_google_connections, %I.tf_google_oauth_states FROM PUBLIC', workspace_schema, workspace_schema);
  EXECUTE format('GRANT SELECT, INSERT ON %I.tf_google_connections TO %I', workspace_schema, workspace_schema || '_runtime');
  EXECUTE format('GRANT UPDATE (generation, status, account_id, email, scopes, credential) ON %I.tf_google_connections TO %I', workspace_schema, workspace_schema || '_runtime');
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I.tf_google_oauth_states TO %I', workspace_schema, workspace_schema || '_runtime');
END
$capabilities$;

ALTER TABLE {{schema}}.tf_agent_activations ADD COLUMN activated_at timestamptz;
ALTER TABLE {{schema}}.tf_agent_activations ALTER COLUMN activated_at SET DEFAULT clock_timestamp();

CREATE TABLE {{schema}}.tf_agent_tasks (
  id uuid PRIMARY KEY,
  owner_user_id text NOT NULL,
  owner_membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  agent_id uuid NOT NULL,
  activation_id uuid NOT NULL,
  definition_revision text NOT NULL,
  skills jsonb NOT NULL CHECK (jsonb_typeof(skills) = 'array'),
  scope jsonb NOT NULL CHECK (jsonb_typeof(scope) = 'array'),
  limits jsonb NOT NULL CHECK (jsonb_typeof(limits) = 'object'),
  flow_id uuid NOT NULL UNIQUE,
  generation integer NOT NULL DEFAULT 0 CHECK (generation >= 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed')),
  active_milliseconds bigint NOT NULL DEFAULT 0 CHECK (active_milliseconds >= 0),
  tool_calls integer NOT NULL DEFAULT 0 CHECK (tool_calls >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (activation_id, agent_id, definition_revision)
    REFERENCES {{schema}}.tf_agent_activations(id, agent_id, definition_revision)
);
CREATE INDEX tf_agent_tasks_owner_page ON {{schema}}.tf_agent_tasks(owner_membership_id, id);
CREATE TABLE {{schema}}.tf_agent_task_messages (
  task_id uuid NOT NULL REFERENCES {{schema}}.tf_agent_tasks(id),
  sequence integer NOT NULL CHECK (sequence >= 0),
  generation integer NOT NULL CHECK (generation >= 0),
  role text NOT NULL CHECK (role IN ('owner', 'agent')),
  text text NOT NULL CHECK (length(text) BETWEEN 1 AND 32000),
  sources jsonb NOT NULL CHECK (jsonb_typeof(sources) = 'array'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (task_id, sequence)
);
CREATE TABLE {{schema}}.tf_agent_task_commands (
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  request_id uuid NOT NULL,
  input_digest text NOT NULL CHECK (input_digest ~ '^[a-f0-9]{64}$'),
  receipt jsonb NOT NULL,
  PRIMARY KEY (membership_id, request_id)
);
REVOKE ALL ON {{schema}}.tf_agent_tasks, {{schema}}.tf_agent_task_messages,
  {{schema}}.tf_agent_task_commands FROM PUBLIC;
GRANT SELECT, INSERT ON {{schema}}.tf_agent_tasks, {{schema}}.tf_agent_task_messages,
  {{schema}}.tf_agent_task_commands TO {{runtime}};
GRANT UPDATE (generation, status, limits, active_milliseconds, tool_calls)
  ON {{schema}}.tf_agent_tasks TO {{runtime}};

CREATE TABLE {{schema}}.tf_google_proposals (
  id uuid PRIMARY KEY,
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  user_id text NOT NULL,
  command_id uuid NOT NULL,
  connection_id uuid NOT NULL REFERENCES {{schema}}.tf_google_connections(id),
  account_id text NOT NULL,
  generation integer NOT NULL CHECK (generation > 0),
  scopes text[] NOT NULL,
  required_scopes text[] NOT NULL,
  operation jsonb NOT NULL CHECK (octet_length(operation::text) <= 4194304),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp() + interval '10 minutes',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (membership_id, command_id),
  UNIQUE (id, membership_id, digest)
);
CREATE TABLE {{schema}}.tf_google_decisions (
  proposal_id uuid PRIMARY KEY,
  membership_id uuid NOT NULL,
  digest text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('approve','reject')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (proposal_id, membership_id, digest) REFERENCES {{schema}}.tf_google_proposals(id, membership_id, digest)
);
CREATE TABLE {{schema}}.tf_google_receipts (
  proposal_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_google_proposals(id),
  status text NOT NULL DEFAULT 'executing' CHECK (status IN ('executing','succeeded','failed','outcome-unknown')),
  result jsonb CHECK (octet_length(result::text) <= 6291456),
  error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((status = 'succeeded') = (result IS NOT NULL)),
  CHECK ((status IN ('executing','succeeded') AND error IS NULL)
    OR (status = 'failed' AND error IS NOT NULL AND error = 'provider-request-failed')
    OR (status = 'outcome-unknown' AND error IS NOT NULL AND error = 'provider-outcome-unknown'))
);
CREATE FUNCTION {{schema}}.tf_google_receipt_transition() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF OLD.status <> 'executing' OR NEW.status = 'executing' THEN
    RAISE EXCEPTION 'Receipt is terminal';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER tf_google_receipt_terminal BEFORE UPDATE ON {{schema}}.tf_google_receipts FOR EACH ROW EXECUTE FUNCTION {{schema}}.tf_google_receipt_transition();
REVOKE ALL ON FUNCTION {{schema}}.tf_google_receipt_transition() FROM PUBLIC;
REVOKE ALL ON {{schema}}.tf_google_proposals, {{schema}}.tf_google_decisions, {{schema}}.tf_google_receipts FROM PUBLIC;
GRANT SELECT ON {{schema}}.tf_google_proposals, {{schema}}.tf_google_decisions, {{schema}}.tf_google_receipts TO {{runtime}}, {{confirmation}};
GRANT INSERT (id,membership_id,user_id,command_id,connection_id,account_id,generation,scopes,required_scopes,operation,digest) ON {{schema}}.tf_google_proposals TO {{runtime}};
GRANT INSERT (proposal_id) ON {{schema}}.tf_google_receipts TO {{runtime}};
GRANT UPDATE (status,result,error) ON {{schema}}.tf_google_receipts TO {{runtime}};
GRANT INSERT (proposal_id,membership_id,digest,decision) ON {{schema}}.tf_google_decisions TO {{confirmation}};
GRANT SELECT (id,membership_id,user_id,account_id,generation,status,scopes) ON {{schema}}.tf_google_connections TO {{confirmation}};

CREATE TABLE {{schema}}.tf_row_tokens (
  physical_table text NOT NULL,
  row_id uuid NOT NULL,
  token uuid NOT NULL,
  PRIMARY KEY (physical_table, row_id)
);
CREATE FUNCTION {{schema}}.tf_row_token_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  INSERT INTO {{schema}}.tf_row_tokens (physical_table,row_id,token)
  VALUES (TG_TABLE_NAME,CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END,gen_random_uuid())
  ON CONFLICT (physical_table,row_id) DO UPDATE SET token=EXCLUDED.token;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION {{schema}}.tf_row_token_changed() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION {{schema}}.tf_row_token_changed() TO {{customOwner}};
REVOKE ALL ON {{schema}}.tf_row_tokens FROM PUBLIC;
GRANT SELECT ON {{schema}}.tf_row_tokens TO {{runtime}},{{confirmation}};
DO $$
DECLARE item record;
BEGIN
  FOR item IN SELECT physical_table FROM {{schema}}.tf_table_catalog WHERE applied_definition IS NOT NULL LOOP
    EXECUTE format('INSERT INTO %I.tf_row_tokens SELECT %L,id,gen_random_uuid() FROM %I.%I', '{{schema}}'::regnamespace::text, item.physical_table, '{{schema}}'::regnamespace::text, item.physical_table);
    EXECUTE format('CREATE TRIGGER tf_row_token_changed AFTER INSERT OR UPDATE OR DELETE ON %I.%I FOR EACH ROW EXECUTE FUNCTION %I.tf_row_token_changed()', '{{schema}}'::regnamespace::text, item.physical_table, '{{schema}}'::regnamespace::text);
  END LOOP;
END
$$;

ALTER TABLE {{schema}}.tf_agent_runs
  ADD COLUMN task_id uuid REFERENCES {{schema}}.tf_agent_tasks(id),
  ADD COLUMN task_generation integer,
  ADD CONSTRAINT tf_agent_run_task_origin CHECK (
    (task_id IS NULL AND task_generation IS NULL) OR
    (task_id IS NOT NULL AND task_generation IS NOT NULL AND task_generation>=0 AND kind='delegated')
  );
CREATE TABLE {{schema}}.tf_agent_task_runs (
  task_id uuid NOT NULL REFERENCES {{schema}}.tf_agent_tasks(id),
  generation integer NOT NULL CHECK (generation>=0),
  run_id uuid NOT NULL UNIQUE REFERENCES {{schema}}.tf_agent_runs(id),
  PRIMARY KEY(task_id,generation),
  UNIQUE(task_id,generation,run_id)
);
CREATE FUNCTION {{schema}}.tf_task_run_binding() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  PERFORM 1 FROM {{schema}}.tf_agent_runs WHERE id=NEW.run_id FOR UPDATE;
  IF NOT EXISTS (
    SELECT 1 FROM {{schema}}.tf_agent_tasks t JOIN {{schema}}.tf_agent_runs r
      ON r.agent_id=t.agent_id AND r.activation_id=t.activation_id
      AND r.definition_revision=t.definition_revision AND r.scope=t.scope
      AND r.user_id=t.owner_user_id AND r.membership_id=t.owner_membership_id
    WHERE t.id=NEW.task_id AND t.generation=NEW.generation AND t.status='pending'
      AND r.id=NEW.run_id AND r.kind='delegated' AND r.status='ready'
      AND r.task_id=NEW.task_id AND r.task_generation=NEW.generation
      AND NOT EXISTS (SELECT 1 FROM {{schema}}.tf_agent_tool_calls c WHERE c.run_id=r.id)
  ) THEN RAISE EXCEPTION 'Task run binding mismatch'; END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION {{schema}}.tf_task_run_binding() FROM PUBLIC;
CREATE TRIGGER tf_task_run_binding BEFORE INSERT ON {{schema}}.tf_agent_task_runs
  FOR EACH ROW EXECUTE FUNCTION {{schema}}.tf_task_run_binding();
CREATE FUNCTION {{schema}}.tf_task_run_created() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.task_id IS NOT NULL THEN
    INSERT INTO {{schema}}.tf_agent_task_runs(task_id,generation,run_id)
      VALUES (NEW.task_id,NEW.task_generation,NEW.id);
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION {{schema}}.tf_task_run_created() FROM PUBLIC;
CREATE TRIGGER tf_task_run_created AFTER INSERT ON {{schema}}.tf_agent_runs
  FOR EACH ROW EXECUTE FUNCTION {{schema}}.tf_task_run_created();
ALTER TABLE {{schema}}.tf_agent_tool_calls DROP CONSTRAINT tf_agent_tool_calls_sequence_check;
ALTER TABLE {{schema}}.tf_agent_tool_calls ADD CONSTRAINT tf_agent_tool_calls_sequence_check CHECK(sequence>=0 AND sequence<10000);
CREATE TABLE {{schema}}.tf_agent_task_proposals (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES {{schema}}.tf_agent_tasks(id),
  generation integer NOT NULL,
  run_id uuid NOT NULL REFERENCES {{schema}}.tf_agent_runs(id),
  request_id uuid NOT NULL,
  input_digest text NOT NULL,
  recovery_digest text,
  digest text NOT NULL,
  actions jsonb NOT NULL CHECK(jsonb_array_length(actions) BETWEEN 1 AND 50 AND octet_length(actions::text)<=1048576),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(task_id,request_id),
  UNIQUE(id,digest),
  FOREIGN KEY(task_id,generation,run_id) REFERENCES {{schema}}.tf_agent_task_runs(task_id,generation,run_id)
);
CREATE TABLE {{schema}}.tf_agent_task_decisions (
  proposal_id uuid PRIMARY KEY,
  digest text NOT NULL,
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  decision text NOT NULL CHECK(decision IN ('approve','reject')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(proposal_id,digest) REFERENCES {{schema}}.tf_agent_task_proposals(id,digest)
);
CREATE TABLE {{schema}}.tf_agent_task_supersessions (
  proposal_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_agent_task_proposals(id),
  successor_id uuid NOT NULL UNIQUE REFERENCES {{schema}}.tf_agent_task_proposals(id)
);
CREATE TABLE {{schema}}.tf_agent_task_action_receipts (
  call_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_agent_tool_calls(id),
  status text NOT NULL CHECK(status IN ('completed','failed')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON {{schema}}.tf_agent_task_action_receipts FROM PUBLIC;
GRANT SELECT,INSERT ON {{schema}}.tf_agent_task_action_receipts TO {{runtime}};
REVOKE ALL ON {{schema}}.tf_agent_task_runs,{{schema}}.tf_agent_task_proposals,{{schema}}.tf_agent_task_decisions,{{schema}}.tf_agent_task_supersessions FROM PUBLIC;
GRANT SELECT,INSERT ON {{schema}}.tf_agent_task_runs,{{schema}}.tf_agent_task_proposals,{{schema}}.tf_agent_task_supersessions TO {{runtime}};
GRANT SELECT ON {{schema}}.tf_agent_task_decisions TO {{runtime}};
GRANT SELECT ON {{schema}}.tf_agent_task_runs,{{schema}}.tf_agent_task_proposals,{{schema}}.tf_agent_task_decisions,{{schema}}.tf_agent_tasks TO {{confirmation}};
GRANT INSERT(proposal_id,digest,membership_id,decision) ON {{schema}}.tf_agent_task_decisions TO {{confirmation}};

CREATE TABLE {{schema}}.tf_slack_link_prompts (
  event_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_slack_events(id),
  installation_id uuid NOT NULL REFERENCES {{schema}}.tf_slack_installations(id),
  generation integer NOT NULL,
  slack_user_id text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sending','retry','sent','unknown','blocked','linked')),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempt_id uuid,
  delivered_channel text,
  delivered_ts text,
  UNIQUE (installation_id,generation,slack_user_id),
  CHECK ((state='sent') = (delivered_channel IS NOT NULL AND delivered_ts IS NOT NULL)),
  CHECK (state<>'sending' OR attempt_id IS NOT NULL)
);
REVOKE ALL ON {{schema}}.tf_slack_link_prompts FROM PUBLIC;
GRANT SELECT, INSERT ON {{schema}}.tf_slack_link_prompts TO {{runtime}};
GRANT UPDATE (state,next_attempt_at,attempt_id,delivered_channel,delivered_ts) ON {{schema}}.tf_slack_link_prompts TO {{runtime}};

CREATE TABLE {{schema}}.tf_chat_authoring_drafts (
  id uuid PRIMARY KEY REFERENCES {{schema}}.tf_conversation_tool_calls(id) DEFERRABLE INITIALLY DEFERRED,
  conversation_id uuid NOT NULL,
  turn_id uuid NOT NULL,
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  user_id text NOT NULL,
  proposal jsonb NOT NULL,
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  sources jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (conversation_id, turn_id) REFERENCES {{schema}}.tf_conversation_turns(conversation_id, id)
);
CREATE TABLE {{schema}}.tf_chat_authoring_decisions (
  draft_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_chat_authoring_drafts(id),
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  command_id uuid NOT NULL,
  input jsonb NOT NULL,
  outcome jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (membership_id, command_id)
);
REVOKE ALL ON {{schema}}.tf_chat_authoring_drafts, {{schema}}.tf_chat_authoring_decisions FROM PUBLIC;
GRANT SELECT, INSERT ON {{schema}}.tf_chat_authoring_drafts, {{schema}}.tf_chat_authoring_decisions TO {{runtime}};

ALTER TABLE {{schema}}.tf_agent_tasks DROP CONSTRAINT tf_agent_tasks_status_check;
ALTER TABLE {{schema}}.tf_model_generations DROP CONSTRAINT tf_model_generations_run_id_fkey;
ALTER TABLE {{schema}}.tf_model_generations ADD FOREIGN KEY (run_id) REFERENCES {{schema}}.tf_agent_runs(id);
ALTER TABLE {{schema}}.tf_agent_tasks ADD CONSTRAINT tf_agent_tasks_status_check
  CHECK (status IN ('pending','completed','waiting-clarification','waiting-approval','paused','failed'));

CREATE TABLE {{schema}}.tf_agent_task_steps (
  task_id uuid NOT NULL,
  generation integer NOT NULL,
  run_id uuid NOT NULL,
  step integer NOT NULL CHECK (step BETWEEN 0 AND 9999),
  decision jsonb,
  call_id uuid,
  proposal_id uuid REFERENCES {{schema}}.tf_agent_task_proposals(id),
  completed boolean NOT NULL DEFAULT false,
  source_tables uuid[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (run_id,step),
  FOREIGN KEY (task_id,generation,run_id) REFERENCES {{schema}}.tf_agent_task_runs(task_id,generation,run_id),
  CHECK (decision IS NULL OR jsonb_typeof(decision)='object')
);
CREATE UNIQUE INDEX tf_task_open_step ON {{schema}}.tf_agent_task_steps(run_id) WHERE NOT completed;
REVOKE ALL ON {{schema}}.tf_agent_task_steps FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE (decision,call_id,proposal_id,completed,source_tables) ON {{schema}}.tf_agent_task_steps TO {{runtime}};

CREATE TABLE {{schema}}.tf_agent_task_tool_usage (
  call_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_agent_tool_calls(id),
  task_id uuid NOT NULL REFERENCES {{schema}}.tf_agent_tasks(id)
);
REVOKE ALL ON {{schema}}.tf_agent_task_tool_usage FROM PUBLIC;
GRANT SELECT,INSERT ON {{schema}}.tf_agent_task_tool_usage TO {{runtime}};

CREATE TABLE {{schema}}.tf_slack_dm_roots (
  conversation_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_conversations(id),
  identity_id uuid NOT NULL REFERENCES {{schema}}.tf_slack_identities(id),
  installation_id uuid NOT NULL REFERENCES {{schema}}.tf_slack_installations(id),
  generation integer NOT NULL,
  channel text NOT NULL CHECK (channel ~ '^D[A-Z0-9]+$'),
  root_ts text NOT NULL CHECK (root_ts ~ '^[0-9]{1,16}\.[0-9]{6}$'),
  UNIQUE (installation_id,generation,channel,root_ts)
);
CREATE TABLE {{schema}}.tf_slack_dm_events (
  event_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_slack_events(id),
  conversation_id uuid NOT NULL REFERENCES {{schema}}.tf_slack_dm_roots(conversation_id),
  turn_id uuid NOT NULL UNIQUE REFERENCES {{schema}}.tf_conversation_turns(id),
  model_started boolean NOT NULL DEFAULT false,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sending','retry','sent','unknown','blocked')),
  attempt_id uuid,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  delivered_ts text,
  CHECK ((state='sent') = (delivered_ts IS NOT NULL)),
  CHECK (state<>'sending' OR attempt_id IS NOT NULL)
);
REVOKE ALL ON {{schema}}.tf_slack_dm_roots, {{schema}}.tf_slack_dm_events FROM PUBLIC;
GRANT SELECT,INSERT ON {{schema}}.tf_slack_dm_roots, {{schema}}.tf_slack_dm_events TO {{runtime}};
GRANT UPDATE (model_started,state,attempt_id,next_attempt_at,delivered_ts) ON {{schema}}.tf_slack_dm_events TO {{runtime}};

CREATE FUNCTION {{schema}}.tf_slack_dm_receipt_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF OLD.model_started AND NOT NEW.model_started THEN
    RAISE EXCEPTION 'Slack execution cannot be replayed';
  END IF;
  IF OLD.state IN ('sent','unknown','blocked') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Slack delivery is terminal';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER tf_slack_dm_receipt_guard BEFORE UPDATE ON {{schema}}.tf_slack_dm_events
FOR EACH ROW EXECUTE FUNCTION {{schema}}.tf_slack_dm_receipt_guard();
REVOKE ALL ON FUNCTION {{schema}}.tf_slack_dm_receipt_guard() FROM PUBLIC;

CREATE TABLE {{schema}}.tf_slack_dm_rejections (
  event_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_slack_events(id),
  reason text NOT NULL CHECK (reason IN ('invalid-message','root-owner-mismatch'))
);
REVOKE ALL ON {{schema}}.tf_slack_dm_rejections FROM PUBLIC;
GRANT SELECT,INSERT ON {{schema}}.tf_slack_dm_rejections TO {{runtime}};

CREATE TABLE {{schema}}.tf_google_heartbeats (
  id uuid PRIMARY KEY,
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  user_id text NOT NULL,
  connection_id uuid NOT NULL REFERENCES {{schema}}.tf_google_connections(id),
  account_id text NOT NULL,
  generation integer NOT NULL CHECK (generation > 0),
  revision integer NOT NULL CHECK (revision > 0),
  settings jsonb NOT NULL CHECK (octet_length(settings::text) <= 65536),
  enabled boolean NOT NULL DEFAULT false,
  enabled_at timestamptz NOT NULL,
  checkpoint jsonb NOT NULL,
  epoch integer NOT NULL DEFAULT 0,
  lease_until timestamptz,
  due_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  gap_notice text,
  last_error text,
  UNIQUE (membership_id)
);
CREATE TABLE {{schema}}.tf_google_heartbeat_commands (
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  command_id uuid NOT NULL,
  digest text NOT NULL,
  result jsonb NOT NULL,
  PRIMARY KEY (membership_id,command_id)
);
CREATE TABLE {{schema}}.tf_google_heartbeat_candidates (
  heartbeat_id uuid NOT NULL REFERENCES {{schema}}.tf_google_heartbeats(id),
  cycle_id uuid NOT NULL,
  message_id text NOT NULL,
  PRIMARY KEY (heartbeat_id,cycle_id,message_id)
);
CREATE TABLE {{schema}}.tf_google_heartbeat_retries (
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  command_id uuid NOT NULL,
  digest text NOT NULL,
  PRIMARY KEY (membership_id,command_id)
);
CREATE TABLE {{schema}}.tf_google_heartbeat_items (
  id uuid PRIMARY KEY,
  heartbeat_id uuid NOT NULL REFERENCES {{schema}}.tf_google_heartbeats(id),
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  user_id text NOT NULL,
  connection_id uuid NOT NULL REFERENCES {{schema}}.tf_google_connections(id),
  account_id text NOT NULL,
  generation integer NOT NULL,
  message_id text NOT NULL,
  revision integer NOT NULL,
  instructions text NOT NULL CHECK (length(instructions)<=8000),
  message jsonb NOT NULL CHECK (octet_length(message::text)<=262144),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','succeeded','failed','cancelled')),
  epoch integer NOT NULL DEFAULT 0,
  attempts integer NOT NULL DEFAULT 0,
  retry_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_until timestamptz,
  answer text CHECK (length(answer)<=16000),
  error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (connection_id,account_id,message_id)
);
CREATE INDEX tf_google_heartbeat_due ON {{schema}}.tf_google_heartbeats(due_at) WHERE enabled;
CREATE INDEX tf_google_heartbeat_pending ON {{schema}}.tf_google_heartbeat_items(heartbeat_id,status);
CREATE FUNCTION {{schema}}.tf_google_heartbeat_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['status','epoch','attempts','lease_until','answer','error','retry_at']) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['status','epoch','attempts','lease_until','answer','error','retry_at']) THEN
    RAISE EXCEPTION 'Heartbeat intake is immutable';
  END IF;
  IF OLD.status IN ('succeeded','cancelled') THEN RAISE EXCEPTION 'Heartbeat result is terminal'; END IF;
  IF OLD.status='failed' AND NOT (NEW.status='queued' AND NEW.epoch=OLD.epoch+1 AND NEW.attempts=OLD.attempts AND NEW.answer IS NULL AND NEW.error IS NULL AND NEW.lease_until IS NULL) THEN RAISE EXCEPTION 'Heartbeat retry must preserve intake and attempts'; END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER tf_google_heartbeat_item_immutable BEFORE UPDATE ON {{schema}}.tf_google_heartbeat_items FOR EACH ROW EXECUTE FUNCTION {{schema}}.tf_google_heartbeat_immutable();
REVOKE ALL ON FUNCTION {{schema}}.tf_google_heartbeat_immutable() FROM PUBLIC;
REVOKE ALL ON {{schema}}.tf_google_heartbeats,{{schema}}.tf_google_heartbeat_commands,{{schema}}.tf_google_heartbeat_candidates,{{schema}}.tf_google_heartbeat_items FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON {{schema}}.tf_google_heartbeats TO {{runtime}};
GRANT SELECT,INSERT ON {{schema}}.tf_google_heartbeat_commands TO {{runtime}};
GRANT SELECT,INSERT,DELETE ON {{schema}}.tf_google_heartbeat_candidates TO {{runtime}};
GRANT SELECT,INSERT ON {{schema}}.tf_google_heartbeat_items TO {{runtime}};
GRANT UPDATE(status,epoch,attempts,lease_until,answer,error,retry_at) ON {{schema}}.tf_google_heartbeat_items TO {{runtime}};
REVOKE ALL ON {{schema}}.tf_google_heartbeat_retries FROM PUBLIC;
GRANT SELECT,INSERT ON {{schema}}.tf_google_heartbeat_retries TO {{runtime}};

CREATE TABLE {{schema}}.tf_slack_channel_attachments (
  installation_id uuid NOT NULL REFERENCES {{schema}}.tf_slack_installations(id),
  generation integer NOT NULL,
  channel text NOT NULL CHECK (channel ~ '^[CG][A-Z0-9]+$'),
  agent_id uuid NOT NULL REFERENCES {{schema}}.tf_agents(id),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  PRIMARY KEY (installation_id,generation,channel)
);
CREATE TABLE {{schema}}.tf_slack_channel_roots (
  id uuid PRIMARY KEY,
  installation_id uuid NOT NULL REFERENCES {{schema}}.tf_slack_installations(id),
  generation integer NOT NULL,
  channel text NOT NULL CHECK (channel ~ '^[CG][A-Z0-9]+$'),
  root_ts text NOT NULL CHECK (root_ts ~ '^[0-9]{1,16}\.[0-9]{6}$'),
  agent_id uuid NOT NULL REFERENCES {{schema}}.tf_agents(id),
  UNIQUE (installation_id,generation,channel,root_ts)
);
CREATE TABLE {{schema}}.tf_slack_channel_invocations (
  event_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_slack_events(id),
  root_id uuid NOT NULL REFERENCES {{schema}}.tf_slack_channel_roots(id)
);
CREATE TABLE {{schema}}.tf_slack_agent_branches (
  id uuid PRIMARY KEY,
  root_id uuid NOT NULL REFERENCES {{schema}}.tf_slack_channel_roots(id),
  identity_id uuid NOT NULL REFERENCES {{schema}}.tf_slack_identities(id),
  dm_channel text NOT NULL CHECK (dm_channel ~ '^D[A-Z0-9]+$'),
  dm_root text CHECK (dm_root ~ '^[0-9]{1,16}\.[0-9]{6}$'),
  UNIQUE (root_id,identity_id),
  UNIQUE (dm_channel,dm_root)
);
CREATE TABLE {{schema}}.tf_slack_agent_turns (
  event_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_slack_events(id),
  branch_id uuid NOT NULL REFERENCES {{schema}}.tf_slack_agent_branches(id),
  run_id uuid NOT NULL UNIQUE REFERENCES {{schema}}.tf_agent_runs(id),
  thread_snapshot jsonb NOT NULL,
  request_snapshot jsonb NOT NULL,
  history_run_ids uuid[] NOT NULL DEFAULT '{}',
  model_started boolean NOT NULL DEFAULT false,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sending','retry','sent','unknown','blocked')),
  attempt_id uuid,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  delivered_ts text,
  CHECK ((state='sent') = (delivered_ts IS NOT NULL)),
  CHECK (state<>'sending' OR attempt_id IS NOT NULL)
);
CREATE TRIGGER tf_slack_agent_receipt_guard BEFORE UPDATE ON {{schema}}.tf_slack_agent_turns
FOR EACH ROW EXECUTE FUNCTION {{schema}}.tf_slack_dm_receipt_guard();
REVOKE ALL ON {{schema}}.tf_slack_channel_attachments, {{schema}}.tf_slack_channel_roots,
  {{schema}}.tf_slack_channel_invocations, {{schema}}.tf_slack_agent_branches, {{schema}}.tf_slack_agent_turns FROM PUBLIC;
GRANT SELECT,INSERT ON {{schema}}.tf_slack_channel_attachments, {{schema}}.tf_slack_channel_roots,
  {{schema}}.tf_slack_channel_invocations, {{schema}}.tf_slack_agent_branches, {{schema}}.tf_slack_agent_turns TO {{runtime}};
GRANT UPDATE (agent_id,version) ON {{schema}}.tf_slack_channel_attachments TO {{runtime}};
GRANT UPDATE (dm_root) ON {{schema}}.tf_slack_agent_branches TO {{runtime}};
GRANT UPDATE (model_started,state,attempt_id,next_attempt_at,delivered_ts) ON {{schema}}.tf_slack_agent_turns TO {{runtime}};

CREATE FUNCTION {{schema}}.tf_slack_branch_root_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF OLD.dm_root IS NOT NULL AND NEW.dm_root IS DISTINCT FROM OLD.dm_root THEN
    RAISE EXCEPTION 'Slack private root is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER tf_slack_branch_root_guard BEFORE UPDATE ON {{schema}}.tf_slack_agent_branches
FOR EACH ROW EXECUTE FUNCTION {{schema}}.tf_slack_branch_root_guard();
REVOKE ALL ON FUNCTION {{schema}}.tf_slack_branch_root_guard() FROM PUBLIC;

CREATE TABLE {{schema}}.tf_slack_agent_rejections (
  event_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_slack_events(id)
);
REVOKE ALL ON {{schema}}.tf_slack_agent_rejections FROM PUBLIC;
GRANT SELECT,INSERT ON {{schema}}.tf_slack_agent_rejections TO {{runtime}};

CREATE TABLE {{schema}}.tf_slack_message_changes (
  installation_id uuid NOT NULL REFERENCES {{schema}}.tf_slack_installations(id),
  generation integer NOT NULL,
  channel text NOT NULL,
  message_ts text NOT NULL,
  changed_at numeric NOT NULL,
  message jsonb,
  PRIMARY KEY (installation_id,generation,channel,message_ts)
);
REVOKE ALL ON {{schema}}.tf_slack_message_changes FROM PUBLIC;
GRANT SELECT,INSERT ON {{schema}}.tf_slack_message_changes TO {{runtime}};
GRANT UPDATE (changed_at,message) ON {{schema}}.tf_slack_message_changes TO {{runtime}};

CREATE TABLE {{schema}}.tf_slack_agent_admission_waits (
  event_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_slack_events(id),
  state text NOT NULL CHECK (state IN ('retry','reauthorization-required')),
  next_attempt_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 1
);
REVOKE ALL ON {{schema}}.tf_slack_agent_admission_waits FROM PUBLIC;
GRANT SELECT,INSERT ON {{schema}}.tf_slack_agent_admission_waits TO {{runtime}};
GRANT UPDATE (state,next_attempt_at,attempts) ON {{schema}}.tf_slack_agent_admission_waits TO {{runtime}};

ALTER TABLE {{schema}}.tf_slack_channel_attachments ALTER COLUMN agent_id DROP NOT NULL;
ALTER TABLE {{schema}}.tf_slack_channel_roots ALTER COLUMN agent_id DROP NOT NULL;
ALTER TABLE {{schema}}.tf_slack_agent_turns ADD COLUMN delivered_channel text;
GRANT UPDATE (delivered_channel) ON {{schema}}.tf_slack_agent_turns TO {{runtime}};

CREATE TABLE {{schema}}.tf_slack_default_turns (
  event_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_slack_events(id),
  branch_id uuid NOT NULL REFERENCES {{schema}}.tf_slack_agent_branches(id),
  conversation_id uuid NOT NULL UNIQUE REFERENCES {{schema}}.tf_conversations(id),
  turn_id uuid NOT NULL UNIQUE REFERENCES {{schema}}.tf_conversation_turns(id),
  thread_snapshot jsonb NOT NULL,
  request_snapshot jsonb NOT NULL,
  history_event_ids uuid[] NOT NULL DEFAULT '{}',
  context_kind text NOT NULL CHECK (context_kind IN ('channel','private')),
  model_started boolean NOT NULL DEFAULT false,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sending','retry','sent','unknown','blocked')),
  attempt_id uuid,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  delivered_ts text,
  delivered_channel text,
  CHECK ((state='sent') = (delivered_ts IS NOT NULL)),
  CHECK (state<>'sending' OR attempt_id IS NOT NULL)
);
CREATE TRIGGER tf_slack_default_receipt_guard BEFORE UPDATE ON {{schema}}.tf_slack_default_turns
FOR EACH ROW EXECUTE FUNCTION {{schema}}.tf_slack_dm_receipt_guard();
REVOKE ALL ON {{schema}}.tf_slack_default_turns FROM PUBLIC;
GRANT SELECT,INSERT ON {{schema}}.tf_slack_default_turns TO {{runtime}};
GRANT UPDATE (model_started,state,attempt_id,next_attempt_at,delivered_ts,delivered_channel)
  ON {{schema}}.tf_slack_default_turns TO {{runtime}};

CREATE TABLE {{schema}}.tf_slack_publications (
  installation_id uuid NOT NULL REFERENCES {{schema}}.tf_slack_installations(id),
  generation integer NOT NULL,
  channel text NOT NULL,
  message_ts text NOT NULL,
  event_id uuid NOT NULL REFERENCES {{schema}}.tf_slack_events(id),
  text text NOT NULL,
  PRIMARY KEY (installation_id,generation,channel,message_ts)
);
REVOKE ALL ON {{schema}}.tf_slack_publications FROM PUBLIC;
GRANT SELECT,INSERT ON {{schema}}.tf_slack_publications TO {{runtime}};

CREATE TABLE {{schema}}.tf_slack_tool_sources (
  call_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_agent_tool_calls(id),
  sources jsonb NOT NULL
);
REVOKE ALL ON {{schema}}.tf_slack_tool_sources FROM PUBLIC;
GRANT SELECT,INSERT ON {{schema}}.tf_slack_tool_sources TO {{runtime}};

ALTER TABLE {{schema}}.tf_agents ADD COLUMN slack_approval text NOT NULL DEFAULT 'required' CHECK(slack_approval IN ('required','direct'));
GRANT UPDATE(slack_approval) ON {{schema}}.tf_agents TO {{runtime}};
CREATE TABLE {{schema}}.tf_slack_destinations (
  id uuid PRIMARY KEY,
  installation_id uuid NOT NULL REFERENCES {{schema}}.tf_slack_installations(id),
  generation integer NOT NULL,
  channel text NOT NULL,
  name text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  enabled boolean NOT NULL DEFAULT true,
  approval_required boolean NOT NULL DEFAULT true,
  UNIQUE(installation_id,generation,channel)
);
CREATE TABLE {{schema}}.tf_slack_conversation_actions (
  id uuid PRIMARY KEY REFERENCES {{schema}}.tf_conversation_tool_calls(id),
  conversation_id uuid NOT NULL,
  turn_id uuid NOT NULL,
  action jsonb NOT NULL,
  sources jsonb NOT NULL,
  FOREIGN KEY(conversation_id,turn_id) REFERENCES {{schema}}.tf_conversation_turns(conversation_id,id),
  UNIQUE(turn_id)
);
REVOKE ALL ON {{schema}}.tf_slack_conversation_actions FROM PUBLIC;
GRANT SELECT,INSERT ON {{schema}}.tf_slack_conversation_actions TO {{runtime}};
CREATE TABLE {{schema}}.tf_slack_actions (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL,
  user_id text NOT NULL,
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  identity_id uuid NOT NULL REFERENCES {{schema}}.tf_slack_identities(id),
  destination_id uuid NOT NULL REFERENCES {{schema}}.tf_slack_destinations(id),
  destination_version integer NOT NULL,
  agent_policy_version integer NOT NULL,
  installation_id uuid NOT NULL,
  generation integer NOT NULL,
  channel text NOT NULL,
  action jsonb NOT NULL,
  digest text NOT NULL,
  provider_digest text NOT NULL,
  approval_required boolean NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '24 hours',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(id,digest,membership_id)
);
CREATE TABLE {{schema}}.tf_slack_action_decisions (
  action_id uuid PRIMARY KEY,
  digest text NOT NULL,
  membership_id uuid NOT NULL,
  decision text NOT NULL CHECK(decision IN ('approve','reject')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(action_id,digest,membership_id) REFERENCES {{schema}}.tf_slack_actions(id,digest,membership_id)
);
CREATE FUNCTION {{schema}}.tf_slack_action_origin() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM {{schema}}.tf_agent_tool_calls WHERE id=NEW.id AND run_id=NEW.run_id AND call=NEW.action)
     AND NOT EXISTS (SELECT 1 FROM {{schema}}.tf_slack_conversation_actions WHERE id=NEW.id AND turn_id=NEW.run_id AND action=NEW.action) THEN
    RAISE EXCEPTION 'Slack action requires an exact persisted origin';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION {{schema}}.tf_slack_action_origin() FROM PUBLIC;
CREATE TRIGGER tf_slack_action_origin BEFORE INSERT ON {{schema}}.tf_slack_actions
  FOR EACH ROW EXECUTE FUNCTION {{schema}}.tf_slack_action_origin();
CREATE TABLE {{schema}}.tf_slack_action_effects (
  action_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_slack_actions(id),
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','sent','retry','reauthorization-required','unknown','revoked','stale','expired','rejected')),
  attempt_id uuid,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE {{schema}}.tf_slack_action_cards (
  action_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_slack_actions(id),
  state text NOT NULL CHECK(state IN ('sending','sent','retry','unknown','blocked')),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  channel text,
  message_ts text,
  presented_status text
);
REVOKE ALL ON {{schema}}.tf_slack_action_cards FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON {{schema}}.tf_slack_action_cards TO {{runtime}};
CREATE FUNCTION {{schema}}.tf_slack_action_effect_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF OLD.state IN ('sent','unknown','revoked','stale','expired','rejected') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Slack effect is terminal';
  END IF;
  IF OLD.state='sending' AND NEW.state NOT IN ('sending','sent','unknown','retry','reauthorization-required','revoked','stale','expired') THEN
    RAISE EXCEPTION 'Slack effect cannot be replayed';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION {{schema}}.tf_slack_action_effect_transition() FROM PUBLIC;
CREATE TRIGGER tf_slack_action_effect_transition BEFORE UPDATE ON {{schema}}.tf_slack_action_effects
  FOR EACH ROW EXECUTE FUNCTION {{schema}}.tf_slack_action_effect_transition();
REVOKE ALL ON {{schema}}.tf_slack_destinations,{{schema}}.tf_slack_actions,{{schema}}.tf_slack_action_decisions,{{schema}}.tf_slack_action_effects FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON {{schema}}.tf_slack_destinations TO {{runtime}};
GRANT SELECT,INSERT ON {{schema}}.tf_slack_actions TO {{runtime}};
GRANT SELECT,INSERT,UPDATE ON {{schema}}.tf_slack_action_effects TO {{runtime}};
GRANT SELECT ON {{schema}}.tf_slack_action_decisions TO {{runtime}};
GRANT SELECT ON {{schema}}.tf_slack_actions,{{schema}}.tf_slack_action_decisions TO {{confirmation}};
GRANT INSERT(action_id,digest,membership_id,decision) ON {{schema}}.tf_slack_action_decisions TO {{confirmation}};

CREATE TABLE {{schema}}.tf_agent_task_activity (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES {{schema}}.tf_agent_tasks(id),
  kind text NOT NULL CHECK (kind IN ('files','tool')),
  reserved_milliseconds bigint NOT NULL CHECK (reserved_milliseconds > 0),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  settled_milliseconds bigint CHECK (settled_milliseconds >= 0),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','settled','abandoned')),
  CHECK ((status='settled') = (settled_milliseconds IS NOT NULL))
);
CREATE UNIQUE INDEX tf_task_active_work ON {{schema}}.tf_agent_task_activity(task_id) WHERE status='running';
REVOKE ALL ON {{schema}}.tf_agent_task_activity FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE (status,settled_milliseconds) ON {{schema}}.tf_agent_task_activity TO {{runtime}};

CREATE TABLE {{schema}}.tf_agent_task_model_accounting (
  attempt_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_model_attempts(id),
  task_id uuid NOT NULL REFERENCES {{schema}}.tf_agent_tasks(id),
  reserved_milliseconds bigint NOT NULL CHECK (reserved_milliseconds > 0),
  observation jsonb,
  observed_milliseconds bigint CHECK (observed_milliseconds >= 0),
  settled_milliseconds bigint CHECK (settled_milliseconds >= 0),
  pending boolean NOT NULL DEFAULT false,
  CHECK ((observation IS NULL) = (observed_milliseconds IS NULL)),
  CHECK (NOT pending OR observation IS NOT NULL)
);
CREATE INDEX tf_task_model_accounting_pending ON {{schema}}.tf_agent_task_model_accounting(task_id) WHERE pending;
REVOKE ALL ON {{schema}}.tf_agent_task_model_accounting FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE (observation,observed_milliseconds,settled_milliseconds,pending) ON {{schema}}.tf_agent_task_model_accounting TO {{runtime}};

CREATE TABLE {{schema}}.tf_github_accounts (
  id uuid PRIMARY KEY,
  owner_membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  generation integer NOT NULL DEFAULT 1 CHECK (generation > 0),
  state text NOT NULL CHECK (state IN ('authorizing', 'active', 'reconnect-required', 'disconnected')),
  config_hash text NOT NULL,
  identity jsonb,
  scopes text[] NOT NULL DEFAULT '{}',
  credential jsonb,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (state <> 'active' OR (credential IS NOT NULL AND identity IS NOT NULL)),
  CHECK (state = 'active' OR credential IS NULL)
);
CREATE UNIQUE INDEX tf_github_account_identity ON {{schema}}.tf_github_accounts (owner_membership_id, (identity->>'id')) WHERE identity IS NOT NULL;
CREATE TABLE {{schema}}.tf_github_account_attempts (
  account_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_github_accounts(id),
  generation integer NOT NULL CHECK (generation > 0),
  state_hash text NOT NULL UNIQUE,
  session_hash text NOT NULL,
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  state text NOT NULL CHECK (state IN ('reserved', 'exchanging', 'consumed')),
  verifier jsonb,
  expires_at timestamptz NOT NULL,
  CHECK ((state = 'reserved') = (verifier IS NOT NULL))
);
REVOKE ALL ON {{schema}}.tf_github_accounts, {{schema}}.tf_github_account_attempts FROM PUBLIC;
GRANT SELECT, INSERT ON {{schema}}.tf_github_accounts, {{schema}}.tf_github_account_attempts TO {{runtime}};
GRANT UPDATE (generation, state, config_hash, identity, scopes, credential, expires_at) ON {{schema}}.tf_github_accounts TO {{runtime}};
GRANT UPDATE (generation, state_hash, session_hash, membership_id, state, verifier, expires_at) ON {{schema}}.tf_github_account_attempts TO {{runtime}};

CREATE TABLE {{schema}}.tf_github_chat_selection (
  conversation_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_conversations(id),
  account_id uuid REFERENCES {{schema}}.tf_github_accounts(id),
  account_generation integer,
  version integer NOT NULL CHECK (version > 0),
  context_start integer NOT NULL CHECK (context_start > 0),
  CHECK ((account_id IS NULL) = (account_generation IS NULL)),
  CHECK (account_generation IS NULL OR account_generation > 0)
);
REVOKE ALL ON {{schema}}.tf_github_chat_selection FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON {{schema}}.tf_github_chat_selection TO {{runtime}};

CREATE TABLE {{schema}}.tf_github_batches (
  id uuid PRIMARY KEY,
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  command_id uuid NOT NULL,
  account_id uuid NOT NULL REFERENCES {{schema}}.tf_github_accounts(id),
  conversation_id uuid NOT NULL REFERENCES {{schema}}.tf_conversations(id),
  snapshot jsonb NOT NULL CHECK (octet_length(snapshot::text) <= 262144),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (membership_id, command_id),
  UNIQUE (id, membership_id, digest)
);
CREATE TABLE {{schema}}.tf_github_batch_decisions (
  batch_id uuid PRIMARY KEY,
  membership_id uuid NOT NULL,
  digest text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('approve','reject')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (batch_id,membership_id,digest) REFERENCES {{schema}}.tf_github_batches(id,membership_id,digest)
);
CREATE TABLE {{schema}}.tf_github_action_receipts (
  batch_id uuid NOT NULL REFERENCES {{schema}}.tf_github_batches(id),
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 9),
  status text NOT NULL DEFAULT 'unknown' CHECK (status IN ('unknown','succeeded','rejected')),
  result jsonb CHECK (octet_length(result::text) <= 131072),
  reconciliation jsonb CHECK (octet_length(reconciliation::text) <= 16384),
  claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (batch_id,ordinal),
  CHECK ((status='succeeded')=(result IS NOT NULL))
);
CREATE FUNCTION {{schema}}.tf_github_action_transition() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF OLD.status <> 'unknown' OR NEW.batch_id <> OLD.batch_id OR NEW.ordinal <> OLD.ordinal OR NEW.claimed_at <> OLD.claimed_at THEN
    RAISE EXCEPTION 'GitHub receipt is immutable after resolution';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER tf_github_action_terminal BEFORE UPDATE ON {{schema}}.tf_github_action_receipts FOR EACH ROW EXECUTE FUNCTION {{schema}}.tf_github_action_transition();
REVOKE ALL ON FUNCTION {{schema}}.tf_github_action_transition() FROM PUBLIC;
REVOKE ALL ON {{schema}}.tf_github_batches, {{schema}}.tf_github_batch_decisions, {{schema}}.tf_github_action_receipts FROM PUBLIC;
GRANT SELECT ON {{schema}}.tf_github_batches, {{schema}}.tf_github_batch_decisions, {{schema}}.tf_github_action_receipts TO {{runtime}}, {{confirmation}};
GRANT INSERT ON {{schema}}.tf_github_batches TO {{runtime}};
GRANT INSERT (batch_id,ordinal) ON {{schema}}.tf_github_action_receipts TO {{runtime}};
GRANT UPDATE (status,result,reconciliation) ON {{schema}}.tf_github_action_receipts TO {{runtime}};
GRANT INSERT (batch_id,membership_id,digest,decision) ON {{schema}}.tf_github_batch_decisions TO {{confirmation}};
GRANT SELECT ON {{schema}}.tf_github_chat_selection TO {{confirmation}};
GRANT SELECT (conversation_id) ON {{schema}}.tf_slack_dm_roots, {{schema}}.tf_slack_default_turns TO {{confirmation}};
GRANT SELECT (id,owner_membership_id,generation,state,expires_at) ON {{schema}}.tf_github_accounts TO {{confirmation}};

CREATE TABLE {{schema}}.tf_files (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('file', 'folder')),
  creator_membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  parent_id uuid REFERENCES {{schema}}.tf_files(id),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 255),
  trashed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  object_key uuid UNIQUE,
  media_type text,
  size integer,
  sha256 text,
  ready boolean NOT NULL,
  CHECK (parent_id IS DISTINCT FROM id),
  CHECK ((kind = 'folder' AND object_key IS NULL AND media_type IS NULL AND size IS NULL AND sha256 IS NULL AND ready)
    OR (kind = 'file' AND object_key IS NOT NULL AND media_type IS NOT NULL AND size IS NOT NULL AND sha256 IS NOT NULL AND size BETWEEN 1 AND 10485760 AND sha256 ~ '^[a-f0-9]{64}$'))
);
CREATE INDEX tf_files_parent ON {{schema}}.tf_files(parent_id);
CREATE TABLE {{schema}}.tf_file_grants (
  item_id uuid NOT NULL REFERENCES {{schema}}.tf_files(id),
  subject_kind text NOT NULL CHECK (subject_kind IN ('individual', 'team')),
  subject_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('viewer', 'editor', 'manager')),
  PRIMARY KEY (item_id, subject_kind, subject_id)
);
CREATE INDEX tf_file_grants_subject ON {{schema}}.tf_file_grants(subject_kind, subject_id);
REVOKE ALL ON {{schema}}.tf_files, {{schema}}.tf_file_grants FROM PUBLIC;
GRANT SELECT, INSERT ON {{schema}}.tf_files TO {{runtime}};
GRANT UPDATE (parent_id, name, trashed_at, ready) ON {{schema}}.tf_files TO {{runtime}};
GRANT SELECT, INSERT, UPDATE, DELETE ON {{schema}}.tf_file_grants TO {{runtime}};

CREATE TABLE {{schema}}.tf_table_person_grants (
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships (id),
  asset_id uuid NOT NULL,
  permission text NOT NULL CHECK (permission IN (
    'table.create', 'table.schema.manage', 'table.row.create',
    'table.row.read', 'table.row.update', 'table.row.delete'
  )),
  PRIMARY KEY (membership_id, asset_id, permission)
);
GRANT SELECT, INSERT, DELETE ON {{schema}}.tf_table_person_grants TO {{runtime}};
GRANT SELECT ON {{schema}}.tf_table_person_grants TO {{migration}}, {{customOwner}}, {{confirmation}};

CREATE TABLE {{schema}}.tf_table_proposals (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL,
  turn_id uuid NOT NULL,
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  user_id text NOT NULL,
  input_digest text NOT NULL CHECK(input_digest ~ '^[a-f0-9]{64}$'),
  digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),
  manifest jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(id,digest,membership_id),
  FOREIGN KEY(conversation_id,turn_id) REFERENCES {{schema}}.tf_conversation_turns(conversation_id,id),
  CHECK(expires_at > created_at AND expires_at <= created_at + interval '24 hours')
);
CREATE INDEX tf_table_proposals_chat ON {{schema}}.tf_table_proposals(conversation_id,id);
CREATE TABLE {{schema}}.tf_table_blocked_reports (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL,
  turn_id uuid NOT NULL,
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  user_id text NOT NULL,
  input_digest text NOT NULL CHECK(input_digest ~ '^[a-f0-9]{64}$'),
  report jsonb NOT NULL CHECK(jsonb_typeof(report)='object' AND octet_length(report::text)<=32768),
  sources jsonb NOT NULL CHECK(jsonb_typeof(sources)='array' AND jsonb_array_length(sources)<=1000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(conversation_id,turn_id) REFERENCES {{schema}}.tf_conversation_turns(conversation_id,id)
);
REVOKE ALL ON {{schema}}.tf_table_blocked_reports FROM PUBLIC;
GRANT SELECT,INSERT ON {{schema}}.tf_table_blocked_reports TO {{runtime}};
CREATE TABLE {{schema}}.tf_table_proposal_effects (
  proposal_id uuid NOT NULL REFERENCES {{schema}}.tf_table_proposals(id),
  table_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK(ordinal BETWEEN 0 AND 99999),
  effect jsonb NOT NULL,
  PRIMARY KEY(proposal_id,table_id,ordinal)
);
CREATE TABLE {{schema}}.tf_table_proposal_decisions (
  proposal_id uuid PRIMARY KEY,
  digest text NOT NULL,
  membership_id uuid NOT NULL,
  command_id uuid NOT NULL,
  decision text NOT NULL CHECK(decision IN ('approve','reject')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(membership_id,command_id),
  FOREIGN KEY(proposal_id,digest,membership_id) REFERENCES {{schema}}.tf_table_proposals(id,digest,membership_id)
);
CREATE TABLE {{schema}}.tf_table_proposal_controls (
  proposal_id uuid NOT NULL,
  digest text NOT NULL,
  membership_id uuid NOT NULL,
  command_id uuid NOT NULL,
  sequence integer NOT NULL CHECK(sequence >= 0),
  operation text NOT NULL CHECK(operation IN ('cancel','resume')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(proposal_id,sequence),
  UNIQUE(membership_id,command_id),
  FOREIGN KEY(proposal_id,digest,membership_id) REFERENCES {{schema}}.tf_table_proposals(id,digest,membership_id)
);
CREATE TABLE {{schema}}.tf_table_proposal_receipts (
  proposal_id uuid NOT NULL REFERENCES {{schema}}.tf_table_proposals(id),
  table_id uuid NOT NULL,
  attempt integer NOT NULL CHECK(attempt >= 0),
  receipt jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(proposal_id,table_id,attempt)
);
CREATE UNIQUE INDEX tf_table_proposal_completed ON {{schema}}.tf_table_proposal_receipts(proposal_id,table_id) WHERE receipt->>'status'='completed';
REVOKE ALL ON {{schema}}.tf_table_proposals,{{schema}}.tf_table_proposal_effects,
  {{schema}}.tf_table_proposal_decisions,{{schema}}.tf_table_proposal_controls,{{schema}}.tf_table_proposal_receipts FROM PUBLIC;
GRANT SELECT,INSERT ON {{schema}}.tf_table_proposals,{{schema}}.tf_table_proposal_effects TO {{runtime}};
GRANT SELECT ON {{schema}}.tf_table_proposals,{{schema}}.tf_table_proposal_effects TO {{confirmation}},{{migration}};
GRANT SELECT ON {{schema}}.tf_table_proposal_decisions,{{schema}}.tf_table_proposal_controls TO {{runtime}},{{migration}},{{confirmation}};
GRANT INSERT ON {{schema}}.tf_table_proposal_decisions,{{schema}}.tf_table_proposal_controls TO {{confirmation}};
GRANT SELECT ON {{schema}}.tf_table_proposal_receipts TO {{runtime}},{{confirmation}},{{migration}};
GRANT INSERT ON {{schema}}.tf_table_proposal_receipts TO {{runtime}},{{migration}};

ALTER TABLE {{schema}}.tf_table_proposals
  ADD COLUMN redacted_at timestamptz,
  ADD COLUMN redacted_digest text CHECK(redacted_digest ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT tf_table_proposal_redaction CHECK((redacted_at IS NULL)=(redacted_digest IS NULL));
GRANT UPDATE(manifest,redacted_at,redacted_digest) ON {{schema}}.tf_table_proposals TO {{migration}},{{customOwner}};
GRANT UPDATE(effect) ON {{schema}}.tf_table_proposal_effects TO {{migration}},{{customOwner}};

CREATE FUNCTION {{schema}}.tf_table_redact_closed_proposal() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF OLD.redacted_at IS NOT NULL OR OLD.expires_at>clock_timestamp()-interval '30 days'
    OR NEW.redacted_at IS NULL OR NEW.redacted_digest IS NULL
    OR NEW.manifest->>'originalDigest' IS DISTINCT FROM OLD.digest
    OR NEW.manifest->>'originalInputDigest' IS DISTINCT FROM OLD.input_digest
    OR NEW.manifest->>'id' IS DISTINCT FROM OLD.id::text THEN
    RAISE EXCEPTION 'proposal-retention-conflict';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION {{schema}}.tf_table_redact_closed_proposal() FROM PUBLIC;
CREATE TRIGGER tf_table_redact_closed_proposal BEFORE UPDATE OF manifest,redacted_at,redacted_digest ON {{schema}}.tf_table_proposals
  FOR EACH ROW EXECUTE FUNCTION {{schema}}.tf_table_redact_closed_proposal();

CREATE TABLE {{schema}}.tf_table_generations (
  id uuid PRIMARY KEY,
  table_id uuid NOT NULL REFERENCES {{schema}}.tf_table_catalog(id),
  revision text NOT NULL,
  definition jsonb NOT NULL CHECK (definition->>'formatVersion' = '2'),
  physical_table text NOT NULL UNIQUE CHECK (physical_table ~ '^g_[a-f0-9]{32}$'),
  state text NOT NULL DEFAULT 'building' CHECK (state IN ('building', 'active', 'retired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  UNIQUE(table_id, revision), UNIQUE(table_id, id)
);
CREATE UNIQUE INDEX tf_table_generation_active ON {{schema}}.tf_table_generations(table_id) WHERE state='active';
CREATE TABLE {{schema}}.tf_table_identities (
  table_id uuid NOT NULL REFERENCES {{schema}}.tf_table_catalog(id),
  row_id uuid NOT NULL,
  token uuid NOT NULL,
  incarnation uuid NOT NULL DEFAULT gen_random_uuid(),
  field_versions jsonb NOT NULL DEFAULT '{}',
  live boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(table_id, row_id), UNIQUE(table_id, row_id, live)
);
CREATE TABLE {{schema}}.tf_table_links (
  source_table uuid NOT NULL,
  source_row uuid NOT NULL,
  field_id uuid NOT NULL,
  target_table uuid NOT NULL,
  target_row uuid NOT NULL,
  live boolean NOT NULL DEFAULT true CHECK(live),
  inverse_one boolean NOT NULL,
  PRIMARY KEY(source_table, source_row, field_id, target_row),
  FOREIGN KEY(source_table, source_row, live) REFERENCES {{schema}}.tf_table_identities(table_id, row_id, live),
  FOREIGN KEY(target_table, target_row, live) REFERENCES {{schema}}.tf_table_identities(table_id, row_id, live)
);
CREATE UNIQUE INDEX tf_table_link_inverse_one ON {{schema}}.tf_table_links(source_table, field_id, target_table, target_row) WHERE inverse_one;
CREATE INDEX tf_table_link_incoming ON {{schema}}.tf_table_links(target_table, target_row);
CREATE TABLE {{schema}}.tf_table_reverse_fields (
  target_table uuid NOT NULL REFERENCES {{schema}}.tf_table_catalog(id),
  field_id uuid NOT NULL,
  source_table uuid NOT NULL REFERENCES {{schema}}.tf_table_catalog(id),
  source_field uuid NOT NULL,
  label text NOT NULL,
  cardinality text NOT NULL CHECK(cardinality IN ('one','many')),
  PRIMARY KEY(target_table, field_id), UNIQUE(source_table, source_field)
);
CREATE TABLE {{schema}}.tf_table_unique_values (
  generation_id uuid NOT NULL REFERENCES {{schema}}.tf_table_generations(id),
  key_id uuid NOT NULL,
  row_id uuid NOT NULL,
  digest text NOT NULL,
  value jsonb NOT NULL,
  PRIMARY KEY(generation_id, key_id, row_id)
);
CREATE INDEX tf_table_unique_lookup ON {{schema}}.tf_table_unique_values(generation_id, key_id, digest);
CREATE TABLE {{schema}}.tf_table_row_history (
  id uuid PRIMARY KEY,
  table_id uuid NOT NULL,
  row_id uuid NOT NULL,
  generation_id uuid NOT NULL REFERENCES {{schema}}.tf_table_generations(id),
  token uuid NOT NULL,
  actor jsonb NOT NULL,
  operation text NOT NULL CHECK(operation IN ('create','update','delete','restore')),
  field_ids uuid[] NOT NULL,
  outcome text NOT NULL DEFAULT 'applied' CHECK(outcome='applied'),
  created_at timestamptz NOT NULL DEFAULT now(),
  recoverable_until timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  values jsonb,
  before_values jsonb,
  FOREIGN KEY(table_id, row_id) REFERENCES {{schema}}.tf_table_identities(table_id, row_id)
);
CREATE INDEX tf_table_row_history_lookup ON {{schema}}.tf_table_row_history(table_id, row_id, created_at, id);
CREATE TABLE {{schema}}.tf_table_history_holds (
  history_id uuid NOT NULL REFERENCES {{schema}}.tf_table_row_history(id),
  holder_id uuid NOT NULL,
  PRIMARY KEY(history_id, holder_id)
);
GRANT SELECT ON {{schema}}.tf_table_generations, {{schema}}.tf_table_reverse_fields TO {{runtime}};
GRANT SELECT, INSERT, UPDATE ON {{schema}}.tf_table_identities TO {{runtime}};
GRANT SELECT, INSERT, UPDATE, DELETE ON {{schema}}.tf_table_links, {{schema}}.tf_table_unique_values TO {{runtime}};
GRANT SELECT, INSERT ON {{schema}}.tf_table_row_history TO {{runtime}};
GRANT SELECT ON {{schema}}.tf_table_history_holds TO {{runtime}};
GRANT SELECT, INSERT, UPDATE, DELETE ON {{schema}}.tf_table_generations, {{schema}}.tf_table_identities,
  {{schema}}.tf_table_links, {{schema}}.tf_table_reverse_fields, {{schema}}.tf_table_unique_values,
  {{schema}}.tf_table_row_history, {{schema}}.tf_table_history_holds TO {{migration}}, {{customOwner}};
GRANT INSERT (id, owning_team_id, physical_table, display_name, target_revision) ON {{schema}}.tf_table_catalog TO {{migration}}, {{customOwner}};

ALTER TABLE {{schema}}.tf_row_tokens
  ADD COLUMN incarnation uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN field_versions jsonb NOT NULL DEFAULT '{}';
CREATE OR REPLACE FUNCTION {{schema}}.tf_row_token_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE next_token uuid := gen_random_uuid(); versions jsonb;
BEGIN
  IF TG_NARGS=1 THEN
    UPDATE {{schema}}.tf_row_tokens SET field_versions=field_versions || jsonb_build_object(TG_ARGV[0],next_token)
      WHERE physical_table=TG_TABLE_NAME AND row_id=NEW.id;
  ELSE
    SELECT COALESCE(jsonb_object_agg(key,next_token),'{}') INTO versions
      FROM jsonb_each(CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END) WHERE key<>'id';
    INSERT INTO {{schema}}.tf_row_tokens AS t (physical_table,row_id,token,incarnation,field_versions)
    VALUES (TG_TABLE_NAME,CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END,next_token,next_token,versions)
    ON CONFLICT (physical_table,row_id) DO UPDATE SET token=EXCLUDED.token,
      incarnation=CASE WHEN TG_OP='UPDATE' THEN t.incarnation ELSE EXCLUDED.incarnation END,
      field_versions=CASE WHEN TG_OP='UPDATE' THEN t.field_versions ELSE EXCLUDED.field_versions END;
  END IF;
  RETURN NULL;
END
$$;
DO $$
DECLARE item record; field record;
BEGIN
  FOR item IN SELECT physical_table FROM {{schema}}.tf_table_catalog WHERE applied_definition->>'formatVersion'='1' LOOP
    EXECUTE format('INSERT INTO %I.tf_row_tokens(physical_table,row_id,token) SELECT %L,id,gen_random_uuid() FROM %I.%I ON CONFLICT DO NOTHING', '{{schema}}'::regnamespace::text,item.physical_table,'{{schema}}'::regnamespace::text,item.physical_table);
    FOR field IN SELECT a.attname FROM pg_attribute a WHERE a.attrelid=format('%I.%I','{{schema}}'::regnamespace::text,item.physical_table)::regclass AND a.attname ~ '^f_[a-f0-9]{32}$' AND NOT a.attisdropped LOOP
      UPDATE {{schema}}.tf_row_tokens SET field_versions=field_versions || jsonb_build_object(field.attname,token) WHERE physical_table=item.physical_table;
      EXECUTE format('CREATE OR REPLACE TRIGGER %I AFTER UPDATE OF %I ON %I.%I FOR EACH ROW EXECUTE FUNCTION %I.tf_row_token_changed(%L)', 'tf_version_'||field.attname,field.attname,'{{schema}}'::regnamespace::text,item.physical_table,'{{schema}}'::regnamespace::text,field.attname);
    END LOOP;
  END LOOP;
END
$$;

CREATE TABLE {{schema}}.tf_table_executions (
  proposal_id uuid NOT NULL REFERENCES {{schema}}.tf_table_proposals(id),
  table_id uuid NOT NULL,
  id uuid NOT NULL UNIQUE,
  phase text NOT NULL DEFAULT 'publishing' CHECK(phase IN ('publishing','copying','reconciling','completed','blocked')),
  source_generation uuid REFERENCES {{schema}}.tf_table_generations(id),
  target_generation uuid REFERENCES {{schema}}.tf_table_generations(id),
  checkpoint uuid,
  checked_effects integer NOT NULL DEFAULT 0,
  expected_freshness integer NOT NULL DEFAULT 0,
  checked_freshness integer NOT NULL DEFAULT 0,
  publication_id uuid NOT NULL UNIQUE,
  parent_revision text,
  revision text,
  projection jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  error_code text,
  PRIMARY KEY(proposal_id,table_id)
);
CREATE UNIQUE INDEX tf_table_execution_live ON {{schema}}.tf_table_executions(table_id) WHERE phase IN ('publishing','copying','reconciling');
CREATE TABLE {{schema}}.tf_table_execution_dirty (
  execution_id uuid NOT NULL REFERENCES {{schema}}.tf_table_executions(id),
  row_id uuid NOT NULL,
  version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY(execution_id,row_id)
);
CREATE TABLE {{schema}}.tf_table_execution_checks (
  execution_id uuid NOT NULL REFERENCES {{schema}}.tf_table_executions(id),
  row_id uuid NOT NULL,
  has_effect boolean NOT NULL,
  has_freshness boolean NOT NULL,
  PRIMARY KEY(execution_id,row_id)
);
CREATE UNIQUE INDEX tf_table_effect_identity ON {{schema}}.tf_table_proposal_effects(proposal_id,table_id,(effect->>'recordId'));
CREATE TABLE {{schema}}.tf_table_proposal_freshness (
  proposal_id uuid NOT NULL REFERENCES {{schema}}.tf_table_proposals(id),
  table_id uuid NOT NULL,
  row_id uuid NOT NULL,
  snapshot jsonb NOT NULL,
  PRIMARY KEY(proposal_id,table_id,row_id)
);
GRANT SELECT,INSERT ON {{schema}}.tf_table_proposal_freshness TO {{runtime}};
GRANT SELECT ON {{schema}}.tf_table_proposal_freshness TO {{migration}},{{customOwner}},{{confirmation}};
CREATE FUNCTION {{schema}}.tf_table_execution_capture() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  INSERT INTO {{schema}}.tf_table_execution_dirty(execution_id,row_id)
  SELECT id,NEW.row_id FROM {{schema}}.tf_table_executions
  WHERE table_id=NEW.table_id AND phase IN ('copying','reconciling')
  ON CONFLICT(execution_id,row_id) DO UPDATE SET version={{schema}}.tf_table_execution_dirty.version+1;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION {{schema}}.tf_table_execution_capture() FROM PUBLIC,{{runtime}},{{migration}},{{customOwner}},{{confirmation}};
CREATE TRIGGER tf_table_execution_capture AFTER INSERT OR UPDATE ON {{schema}}.tf_table_identities
FOR EACH ROW EXECUTE FUNCTION {{schema}}.tf_table_execution_capture();
ALTER TABLE {{schema}}.tf_soul_revisions ADD COLUMN table_execution_id uuid UNIQUE REFERENCES {{schema}}.tf_table_executions(publication_id);
ALTER TABLE {{schema}}.tf_soul_revisions DROP CONSTRAINT tf_soul_revision_command;
ALTER TABLE {{schema}}.tf_soul_revisions ADD CONSTRAINT tf_soul_revision_command CHECK(num_nonnulls(command_id,agent_command_id,table_execution_id)=1);
GRANT SELECT,INSERT ON {{schema}}.tf_table_executions TO {{runtime}};
GRANT UPDATE(parent_revision,revision,projection,publication_id) ON {{schema}}.tf_table_executions TO {{runtime}};
GRANT SELECT,INSERT,UPDATE ON {{schema}}.tf_table_executions TO {{migration}},{{customOwner}};
GRANT SELECT,INSERT,UPDATE,DELETE ON {{schema}}.tf_table_execution_dirty,{{schema}}.tf_table_execution_checks TO {{migration}},{{customOwner}};
GRANT SELECT ON {{schema}}.tf_table_proposals,{{schema}}.tf_table_proposal_effects,{{schema}}.tf_table_proposal_decisions,{{schema}}.tf_table_proposal_controls,{{schema}}.tf_table_proposal_receipts TO {{customOwner}};
REVOKE INSERT ON {{schema}}.tf_table_proposal_receipts FROM {{runtime}};
GRANT INSERT ON {{schema}}.tf_table_proposal_receipts TO {{customOwner}};
GRANT UPDATE(physical_table,display_name,target_revision) ON {{schema}}.tf_table_catalog TO {{migration}},{{customOwner}};

ALTER TABLE {{schema}}.tf_table_executions
  ADD COLUMN effect_checkpoint integer NOT NULL DEFAULT -1,
  ADD COLUMN resumed_sequence integer NOT NULL DEFAULT -1,
  ADD COLUMN batch_limit integer NOT NULL DEFAULT 1000 CHECK(batch_limit BETWEEN 1 AND 1000),
  ADD COLUMN timeout_failures integer NOT NULL DEFAULT 0;
CREATE INDEX tf_table_effect_kind ON {{schema}}.tf_table_proposal_effects(proposal_id,table_id,(effect->>'kind'));

ALTER TABLE {{schema}}.tf_table_generations ADD COLUMN activated_at timestamptz;
ALTER TABLE {{schema}}.tf_table_generations ADD COLUMN physical_removed_at timestamptz;
UPDATE {{schema}}.tf_table_generations SET activated_at=created_at WHERE state IN ('active','retired');

ALTER TABLE {{schema}}.tf_table_links RENAME TO tf_table_generation_links;
ALTER TABLE {{schema}}.tf_table_generation_links ADD COLUMN generation_id uuid REFERENCES {{schema}}.tf_table_generations(id);
UPDATE {{schema}}.tf_table_generation_links l SET generation_id=g.id
  FROM {{schema}}.tf_table_generations g WHERE g.table_id=l.source_table AND g.state='active';
ALTER TABLE {{schema}}.tf_table_generation_links ALTER COLUMN generation_id SET NOT NULL;
ALTER TABLE {{schema}}.tf_table_generation_links DROP CONSTRAINT tf_table_links_pkey;
ALTER TABLE {{schema}}.tf_table_generation_links ADD PRIMARY KEY(generation_id,source_row,field_id,target_row);
DROP INDEX {{schema}}.tf_table_link_inverse_one;
CREATE UNIQUE INDEX tf_table_link_inverse_one ON {{schema}}.tf_table_generation_links(generation_id,field_id,target_table,target_row) WHERE inverse_one;
CREATE VIEW {{schema}}.tf_table_links AS SELECT l.* FROM {{schema}}.tf_table_generation_links l
  WHERE EXISTS(SELECT 1 FROM {{schema}}.tf_table_generations g WHERE g.id=l.generation_id AND g.state='active');
GRANT SELECT ON {{schema}}.tf_table_links TO {{runtime}},{{migration}},{{customOwner}};

ALTER TABLE {{schema}}.tf_table_row_history RENAME TO tf_table_row_history_data;
ALTER TABLE {{schema}}.tf_table_row_history_data DROP CONSTRAINT tf_table_row_history_operation_check;
ALTER TABLE {{schema}}.tf_table_row_history_data ADD CHECK(operation IN ('create','update','delete','restore','transform'));
CREATE UNIQUE INDEX tf_table_transform_history ON {{schema}}.tf_table_row_history_data(generation_id,row_id) WHERE operation='transform';
CREATE VIEW {{schema}}.tf_table_row_history AS
  SELECT h.id,h.table_id,h.row_id,h.generation_id,h.token,h.actor,h.operation,h.field_ids,h.outcome,
    CASE WHEN h.operation='transform' THEN g.activated_at ELSE h.created_at END AS created_at,
    CASE WHEN h.operation='transform' THEN g.activated_at+interval '30 days' ELSE h.recoverable_until END AS recoverable_until,
    h.values,h.before_values
  FROM {{schema}}.tf_table_row_history_data h JOIN {{schema}}.tf_table_generations g ON g.id=h.generation_id
  WHERE h.operation<>'transform' OR g.activated_at IS NOT NULL;
GRANT SELECT ON {{schema}}.tf_table_row_history TO {{runtime}},{{migration}},{{customOwner}};
REVOKE SELECT ON {{schema}}.tf_table_row_history_data FROM {{runtime}};
CREATE RULE tf_table_history_retention AS ON UPDATE TO {{schema}}.tf_table_row_history
  DO INSTEAD UPDATE {{schema}}.tf_table_row_history_data SET
    recoverable_until=NEW.recoverable_until,values=NEW.values,before_values=NEW.before_values WHERE id=OLD.id;
CREATE RULE tf_table_history_delete AS ON DELETE TO {{schema}}.tf_table_row_history
  DO INSTEAD DELETE FROM {{schema}}.tf_table_row_history_data WHERE id=OLD.id;
GRANT UPDATE(recoverable_until,values,before_values) ON {{schema}}.tf_table_row_history TO {{migration}},{{customOwner}};

CREATE TABLE {{schema}}.tf_table_import_receipts (
  execution_id uuid NOT NULL REFERENCES {{schema}}.tf_table_executions(id),
  ordinal integer NOT NULL,
  row_id uuid NOT NULL,
  token uuid NOT NULL,
  applied_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(execution_id,ordinal), UNIQUE(execution_id,row_id)
);
GRANT SELECT ON {{schema}}.tf_table_import_receipts TO {{runtime}},{{confirmation}};
GRANT SELECT,INSERT ON {{schema}}.tf_table_import_receipts TO {{migration}},{{customOwner}};

CREATE TABLE {{schema}}.tf_table_execution_files (
  execution_id uuid NOT NULL REFERENCES {{schema}}.tf_table_executions(id),
  row_id uuid NOT NULL,
  file_id uuid NOT NULL,
  authority_epoch bigint NOT NULL,
  PRIMARY KEY(execution_id,row_id,file_id)
);
CREATE INDEX tf_table_execution_files_pending ON {{schema}}.tf_table_execution_files(execution_id,authority_epoch);
GRANT SELECT,INSERT,UPDATE,DELETE ON {{schema}}.tf_table_execution_files TO {{migration}},{{customOwner}};

CREATE TABLE {{schema}}.tf_table_generation_conflicts (
  generation_id uuid NOT NULL REFERENCES {{schema}}.tf_table_generations(id),
  key_id uuid NOT NULL,
  digest text NOT NULL,
  PRIMARY KEY(generation_id,key_id,digest)
);
GRANT SELECT,INSERT,DELETE ON {{schema}}.tf_table_generation_conflicts TO {{migration}},{{customOwner}};
CREATE INDEX tf_table_unique_row ON {{schema}}.tf_table_unique_values(generation_id,row_id);

CREATE TABLE {{schema}}.tf_table_generation_versions (
  generation_id uuid NOT NULL REFERENCES {{schema}}.tf_table_generations(id),
  row_id uuid NOT NULL,
  base_token uuid NOT NULL,
  field_versions jsonb NOT NULL,
  PRIMARY KEY(generation_id,row_id)
);
GRANT SELECT ON {{schema}}.tf_table_generation_versions TO {{runtime}};
GRANT SELECT,INSERT,UPDATE,DELETE ON {{schema}}.tf_table_generation_versions TO {{migration}},{{customOwner}};

CREATE FUNCTION {{schema}}.tf_table_file_authority_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  UPDATE {{schema}}.tf_authorization_lock SET lock_version=lock_version+1 WHERE id=1;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION {{schema}}.tf_table_file_authority_changed() FROM PUBLIC;
CREATE TRIGGER tf_table_file_authority_changed AFTER INSERT OR UPDATE OR DELETE ON {{schema}}.tf_memberships
FOR EACH STATEMENT EXECUTE FUNCTION {{schema}}.tf_table_file_authority_changed();
CREATE TRIGGER tf_table_file_authority_changed AFTER INSERT OR UPDATE OR DELETE ON {{schema}}.tf_member_teams
FOR EACH STATEMENT EXECUTE FUNCTION {{schema}}.tf_table_file_authority_changed();
CREATE TRIGGER tf_table_file_authority_changed AFTER INSERT OR UPDATE OR DELETE ON {{schema}}.tf_teams
FOR EACH STATEMENT EXECUTE FUNCTION {{schema}}.tf_table_file_authority_changed();

-- Files can be installed after the resource common stream. Install its capture
-- before recording any file check, under the same authority fence as file writes.
CREATE FUNCTION {{schema}}.tf_table_install_file_capture() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE relation_name text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('{{schema}}.tf_table_install_file_capture',7704));
  FOR relation_name IN SELECT unnest(ARRAY['tf_files','tf_file_grants']) LOOP
    IF to_regclass(format('%I.%I','{{schema}}'::regnamespace::text,relation_name)) IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass(format('%I.%I','{{schema}}'::regnamespace::text,relation_name)) AND tgname='tf_table_file_authority_changed') THEN
      EXECUTE format('CREATE TRIGGER tf_table_file_authority_changed AFTER INSERT OR UPDATE OR DELETE ON %I.%I FOR EACH STATEMENT EXECUTE FUNCTION %I.tf_table_file_authority_changed()', '{{schema}}'::regnamespace::text,relation_name,'{{schema}}'::regnamespace::text);
    END IF;
  END LOOP;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION {{schema}}.tf_table_install_file_capture() FROM PUBLIC;
CREATE TRIGGER tf_table_install_file_capture AFTER INSERT ON {{schema}}.tf_table_executions
FOR EACH STATEMENT EXECUTE FUNCTION {{schema}}.tf_table_install_file_capture();

-- A top-level transaction snapshot includes writers already in flight. Sequence
-- watermarks alone would miss a writer that commits after the preview starts.
CREATE TABLE {{schema}}.tf_table_proposal_capture (
  proposal_id uuid NOT NULL REFERENCES {{schema}}.tf_table_proposals(id),
  table_id uuid NOT NULL,
  snapshot pg_snapshot NOT NULL,
  scan_fields text[] NOT NULL,
  PRIMARY KEY(proposal_id,table_id)
);
CREATE TABLE {{schema}}.tf_table_proposal_matches (
  proposal_id uuid NOT NULL REFERENCES {{schema}}.tf_table_proposals(id),
  table_id uuid NOT NULL,
  source_index integer NOT NULL,
  row_id uuid NOT NULL,
  matched boolean NOT NULL,
  key_id uuid NOT NULL,
  key_value jsonb NOT NULL,
  mapped jsonb NOT NULL,
  PRIMARY KEY(proposal_id,table_id,source_index),
  UNIQUE(proposal_id,table_id,row_id)
);
CREATE TABLE {{schema}}.tf_table_proposal_changes (
  table_id uuid NOT NULL,
  xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
  row_id uuid NOT NULL,
  lifecycle boolean NOT NULL,
  fields text[] NOT NULL,
  key_id uuid,
  key_value jsonb
);
CREATE INDEX tf_table_proposal_changes_since ON {{schema}}.tf_table_proposal_changes(table_id,xid);
CREATE INDEX tf_table_proposal_match_predicate ON {{schema}}.tf_table_proposal_matches(proposal_id,table_id,key_id,md5(key_value::text));
GRANT SELECT,INSERT ON {{schema}}.tf_table_proposal_capture,{{schema}}.tf_table_proposal_matches TO {{runtime}};
GRANT SELECT ON {{schema}}.tf_table_proposal_capture,{{schema}}.tf_table_proposal_matches,{{schema}}.tf_table_proposal_changes TO {{runtime}},{{confirmation}},{{migration}},{{customOwner}};

CREATE FUNCTION {{schema}}.tf_table_proposal_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE fields text[]; resource uuid; item record;
BEGIN
  IF TG_TABLE_NAME='tf_table_identities' THEN
    SELECT COALESCE(array_agg(key),ARRAY[]::text[]) INTO fields FROM jsonb_each(NEW.field_versions)
      WHERE TG_OP='INSERT' OR value IS DISTINCT FROM OLD.field_versions->key;
    INSERT INTO {{schema}}.tf_table_proposal_changes(table_id,row_id,lifecycle,fields)
      VALUES(NEW.table_id,NEW.row_id,TG_OP='INSERT' OR NEW.live IS DISTINCT FROM OLD.live OR NEW.incarnation IS DISTINCT FROM OLD.incarnation,fields);
  ELSE
    IF TG_OP='DELETE' THEN item := OLD; ELSE item := NEW; END IF;
    SELECT table_id INTO resource FROM {{schema}}.tf_table_generations WHERE id=item.generation_id AND state='active';
    IF resource IS NOT NULL THEN
      INSERT INTO {{schema}}.tf_table_proposal_changes(table_id,row_id,lifecycle,fields,key_id,key_value)
        VALUES(resource,item.row_id,false,ARRAY[]::text[],item.key_id,item.value);
    END IF;
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION {{schema}}.tf_table_proposal_changed() FROM PUBLIC;
CREATE TRIGGER tf_table_proposal_changed AFTER INSERT OR UPDATE ON {{schema}}.tf_table_identities
  FOR EACH ROW EXECUTE FUNCTION {{schema}}.tf_table_proposal_changed();
CREATE TRIGGER tf_table_proposal_changed AFTER INSERT OR DELETE ON {{schema}}.tf_table_unique_values
  FOR EACH ROW EXECUTE FUNCTION {{schema}}.tf_table_proposal_changed();

CREATE FUNCTION {{schema}}.tf_table_proposal_capture_current(proposal uuid,resource uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM {{schema}}.tf_table_proposal_capture c
    JOIN {{schema}}.tf_table_proposal_changes d ON d.table_id=c.table_id
      AND d.xid>=pg_snapshot_xmin(c.snapshot) AND NOT pg_visible_in_snapshot(d.xid,c.snapshot)
    WHERE c.proposal_id=proposal AND c.table_id=resource
      AND NOT EXISTS(SELECT 1 FROM {{schema}}.tf_table_import_receipts r JOIN {{schema}}.tf_table_executions e ON e.id=r.execution_id
        WHERE e.proposal_id=proposal AND e.table_id=resource AND r.row_id=d.row_id AND r.applied_xid=d.xid)
      AND (
        (cardinality(c.scan_fields)>0 AND (d.lifecycle OR d.fields && c.scan_fields))
        OR EXISTS(SELECT 1 FROM {{schema}}.tf_table_proposal_freshness f WHERE f.proposal_id=proposal AND f.table_id=resource AND f.row_id=d.row_id
          AND (d.lifecycle OR (f.snapshot->'fields') ?| d.fields))
        OR EXISTS(SELECT 1 FROM {{schema}}.tf_table_proposal_matches m WHERE m.proposal_id=proposal AND m.table_id=resource
          AND m.key_id=d.key_id AND md5(m.key_value::text)=md5(d.key_value::text) AND m.key_value=d.key_value AND (NOT m.matched OR m.row_id<>d.row_id))
      )
  )
$$;
REVOKE ALL ON FUNCTION {{schema}}.tf_table_proposal_capture_current(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION {{schema}}.tf_table_proposal_capture_current(uuid,uuid) TO {{runtime}},{{confirmation}},{{migration}},{{customOwner}};

CREATE FUNCTION {{schema}}.tf_table_import_completion_current() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.receipt->>'status'='completed' AND EXISTS(SELECT 1 FROM {{schema}}.tf_table_proposal_matches WHERE proposal_id=NEW.proposal_id AND table_id=NEW.table_id)
    AND NOT {{schema}}.tf_table_proposal_capture_current(NEW.proposal_id,NEW.table_id) THEN
    RAISE EXCEPTION 'proposal-stale';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION {{schema}}.tf_table_import_completion_current() FROM PUBLIC;
CREATE TRIGGER tf_table_import_completion_current BEFORE INSERT ON {{schema}}.tf_table_proposal_receipts
  FOR EACH ROW EXECUTE FUNCTION {{schema}}.tf_table_import_completion_current();

ALTER TABLE {{schema}}.tf_table_proposal_changes ADD COLUMN created_at timestamptz NOT NULL DEFAULT clock_timestamp();
CREATE INDEX tf_table_proposal_changes_retention ON {{schema}}.tf_table_proposal_changes(created_at);
GRANT DELETE ON {{schema}}.tf_table_proposal_matches,{{schema}}.tf_table_proposal_capture,
  {{schema}}.tf_table_proposal_freshness,{{schema}}.tf_table_proposal_changes TO {{migration}},{{customOwner}};

-- A reservation commits before object IO. Pending/deleted receipts prevent resurrection.
-- Only keys in the import-owned namespace can be registered, never source attachments.
CREATE TABLE {{schema}}.tf_table_import_objects (
  object_key text PRIMARY KEY CHECK(object_key ~ '^[0-9a-f-]{36}/resource-imports/[0-9a-f-]{36}/[0-9a-f-]{36}/([0-9a-f-]{36}/file-[0-9a-f-]{36}-[0-9a-f]{64}|result-[0-9a-f-]{36})\.json$'),
  membership_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  turn_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('file','connection')),
  reference_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_used_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  cleanup_pending_at timestamptz,
  removed_at timestamptz,
  CHECK(removed_at IS NULL OR cleanup_pending_at IS NOT NULL)
);
GRANT SELECT,INSERT ON {{schema}}.tf_table_import_objects TO {{runtime}};
GRANT UPDATE(last_used_at) ON {{schema}}.tf_table_import_objects TO {{runtime}};
GRANT SELECT,UPDATE(cleanup_pending_at,removed_at) ON {{schema}}.tf_table_import_objects TO {{migration}},{{customOwner}};
GRANT SELECT(id,status) ON {{schema}}.tf_conversation_turns TO {{migration}},{{customOwner}};
GRANT UPDATE(removed_at) ON {{schema}}.tf_table_import_objects TO {{runtime}};

CREATE FUNCTION {{schema}}.tf_table_import_object_retention() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF OLD.cleanup_pending_at IS NOT NULL AND NEW.last_used_at IS DISTINCT FROM OLD.last_used_at
    OR OLD.removed_at IS NOT NULL
    OR NEW.removed_at IS NOT NULL AND NEW.cleanup_pending_at IS NULL THEN
    RAISE EXCEPTION 'import-object-retention-conflict';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION {{schema}}.tf_table_import_object_retention() FROM PUBLIC;
CREATE TRIGGER tf_table_import_object_retention BEFORE UPDATE ON {{schema}}.tf_table_import_objects
  FOR EACH ROW EXECUTE FUNCTION {{schema}}.tf_table_import_object_retention();

ALTER TABLE {{schema}}.tf_conversation_tool_calls DROP CONSTRAINT tf_conversation_tool_calls_tool_check;
ALTER TABLE {{schema}}.tf_conversation_tool_calls ADD CONSTRAINT tf_conversation_tool_calls_tool_check CHECK(tool ~ '^[a-z][a-z0-9.]{0,63}$');

CREATE FUNCTION {{schema}}.tf_table_source_allowed(member_id uuid, actor_user text, source jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  connection_row record;
  source_row record;
  admin boolean;
BEGIN
  PERFORM id FROM {{schema}}.tf_authorization_lock WHERE id=1 FOR SHARE;
  SELECT role='admin' INTO admin FROM {{schema}}.tf_memberships
    WHERE id=member_id AND user_id=actor_user AND removed_at IS NULL;
  IF admin IS NULL THEN RETURN false; END IF;
  CASE source->>'kind'
  WHEN 'private-conversation' THEN
    RETURN EXISTS(SELECT 1 FROM {{schema}}.tf_conversations WHERE id=(source->>'conversationId')::uuid
      AND kind='private' AND owner_user_id=actor_user AND owner_membership_id=member_id);
  WHEN 'github-source', 'connection-source' THEN
    SELECT * INTO connection_row FROM {{schema}}.tf_connections WHERE id=(source->>'connectionId')::uuid FOR SHARE;
    IF NOT FOUND OR NOT connection_row.enabled OR connection_row.deleted_at IS NOT NULL THEN RETURN false; END IF;
    IF source->>'kind'='github-source' AND (connection_row.generation<>(source->>'generation')::integer
      OR connection_row.grants_version<>(source->>'grantsVersion')::integer) THEN RETURN false; END IF;
    RETURN EXISTS(SELECT 1 FROM {{schema}}.tf_connection_sources WHERE id=(source->>'sourceId')::uuid AND connection_id=connection_row.id)
      AND (admin OR (NOT EXISTS(SELECT permission FROM (VALUES ('read'),('use')) p(permission)
        WHERE NOT EXISTS(SELECT 1 FROM {{schema}}.tf_connection_grants g JOIN {{schema}}.tf_member_teams mt ON mt.team_id=g.team_id
          WHERE mt.membership_id=member_id AND g.connection_id=connection_row.id AND g.permission=p.permission))
        AND EXISTS(SELECT 1 FROM {{schema}}.tf_connection_source_grants g JOIN {{schema}}.tf_member_teams mt ON mt.team_id=g.team_id
          WHERE mt.membership_id=member_id AND g.source_id=(source->>'sourceId')::uuid AND g.permission='github.issue.read')));
  WHEN 'google-connection' THEN
    IF source->>'membershipId'<>member_id::text THEN RETURN false; END IF;
    SELECT * INTO connection_row FROM {{schema}}.tf_google_connections WHERE id=(source->>'connectionId')::uuid FOR SHARE;
    IF NOT FOUND THEN RETURN false; END IF;
    RETURN connection_row.account_id=source->>'accountId' AND connection_row.membership_id=member_id
      AND connection_row.user_id=actor_user AND connection_row.generation=(source->>'generation')::integer
      AND connection_row.status='connected'
      AND to_jsonb(connection_row.scopes) @> (source->'scopes') AND (source->'scopes') @> to_jsonb(connection_row.scopes)
      AND to_jsonb(connection_row.scopes) @> (source->'requiredScopes');
  WHEN 'atlassian-source' THEN
    IF source->>'membershipId'<>member_id::text THEN RETURN false; END IF;
    SELECT * INTO connection_row FROM {{schema}}.tf_atlassian_accounts WHERE id=(source->>'accountId')::uuid FOR SHARE;
    IF NOT FOUND THEN RETURN false; END IF;
    SELECT * INTO source_row FROM {{schema}}.tf_atlassian_sources WHERE id=(source->>'sourceId')::uuid FOR SHARE;
    IF NOT FOUND THEN RETURN false; END IF;
    RETURN source_row.account_id=connection_row.id AND source_row.membership_id=member_id AND source_row.enabled
      AND source_row.binding=(source->>'binding')::jsonb AND connection_row.state='active'
      AND connection_row.generation=(source->>'generation')::integer AND connection_row.grants_version=(source->>'grantsVersion')::integer
      AND connection_row.expires_at>clock_timestamp()
      AND ((connection_row.ownership='personal' AND connection_row.owner_membership_id=member_id)
        OR (connection_row.ownership='business' AND (EXISTS(SELECT 1 FROM {{schema}}.tf_atlassian_account_member_grants g WHERE g.account_id=connection_row.id AND g.membership_id=member_id)
          OR EXISTS(SELECT 1 FROM {{schema}}.tf_atlassian_account_team_grants g JOIN {{schema}}.tf_member_teams mt ON mt.team_id=g.team_id WHERE g.account_id=connection_row.id AND mt.membership_id=member_id))));
  ELSE RETURN false;
  END CASE;
END
$$;
REVOKE ALL ON FUNCTION {{schema}}.tf_table_source_allowed(uuid,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION {{schema}}.tf_table_source_allowed(uuid,text,jsonb) TO {{runtime}},{{confirmation}},{{migration}},{{customOwner}};

CREATE FUNCTION {{schema}}.tf_table_file_allowed(member_id uuid, actor_user text, file_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE allowed boolean;
BEGIN
  PERFORM id FROM {{schema}}.tf_authorization_lock WHERE id=1 FOR SHARE;
  IF to_regclass('{{schema}}.tf_files') IS NULL THEN RETURN false; END IF;
  WITH RECURSIVE ancestors AS (
    SELECT id,parent_id,creator_membership_id,ready,trashed_at,kind FROM {{schema}}.tf_files WHERE id=file_id
    UNION SELECT f.id,f.parent_id,f.creator_membership_id,f.ready,f.trashed_at,f.kind
      FROM {{schema}}.tf_files f JOIN ancestors a ON f.id=a.parent_id
  ) SELECT EXISTS(SELECT 1 FROM {{schema}}.tf_memberships WHERE id=member_id AND user_id=actor_user AND removed_at IS NULL)
    AND EXISTS(SELECT 1 FROM ancestors WHERE id=file_id AND kind='file')
    AND NOT EXISTS(SELECT 1 FROM ancestors WHERE NOT ready OR trashed_at IS NOT NULL)
    AND (EXISTS(SELECT 1 FROM ancestors WHERE creator_membership_id=member_id)
      OR EXISTS(SELECT 1 FROM {{schema}}.tf_file_grants g JOIN ancestors a ON a.id=g.item_id
        WHERE (g.subject_kind='individual' AND g.subject_id=member_id)
          OR (g.subject_kind='team' AND EXISTS(SELECT 1 FROM {{schema}}.tf_member_teams mt JOIN {{schema}}.tf_teams t ON t.id=mt.team_id WHERE mt.membership_id=member_id AND mt.team_id=g.subject_id)))) INTO allowed;
  RETURN allowed;
END
$$;
REVOKE ALL ON FUNCTION {{schema}}.tf_table_file_allowed(uuid,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION {{schema}}.tf_table_file_allowed(uuid,text,uuid) TO {{runtime}},{{confirmation}},{{migration}},{{customOwner}};

CREATE FUNCTION {{schema}}.tf_table_attachment_allowed(member_id uuid, actor_user text, chat_id uuid, attachment_id uuid, content_digest text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM id FROM {{schema}}.tf_authorization_lock WHERE id=1 FOR SHARE;
  RETURN EXISTS(SELECT 1 FROM {{schema}}.tf_memberships WHERE id=member_id AND user_id=actor_user AND removed_at IS NULL)
    AND EXISTS(SELECT 1 FROM {{schema}}.tf_conversations c JOIN {{schema}}.tf_conversation_attachments a ON a.conversation_id=c.id
      JOIN {{schema}}.tf_conversation_parts p ON p.attachment_id=a.id AND p.message_id=a.message_id AND p.conversation_id=c.id
      WHERE c.id=chat_id AND c.kind='private' AND c.owner_user_id=actor_user AND c.owner_membership_id=member_id
        AND a.id=tf_table_attachment_allowed.attachment_id AND a.membership_id=member_id AND a.sha256=content_digest AND a.state='bound');
END
$$;
REVOKE ALL ON FUNCTION {{schema}}.tf_table_attachment_allowed(uuid,text,uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION {{schema}}.tf_table_attachment_allowed(uuid,text,uuid,uuid,text) TO {{runtime}},{{confirmation}},{{migration}},{{customOwner}};

CREATE FUNCTION {{schema}}.tf_table_import_result_allowed(member_id uuid, actor_user text, chat_id uuid, result_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM id FROM {{schema}}.tf_authorization_lock WHERE id=1 FOR SHARE;
  RETURN EXISTS(SELECT 1 FROM {{schema}}.tf_memberships WHERE id=member_id AND user_id=actor_user AND removed_at IS NULL)
    AND EXISTS(SELECT 1 FROM {{schema}}.tf_conversations c JOIN {{schema}}.tf_conversation_tool_calls t ON t.conversation_id=c.id
      WHERE c.id=chat_id AND c.kind='private' AND c.owner_user_id=actor_user AND c.owner_membership_id=member_id
        AND t.id=result_id AND t.status='completed' AND t.tool IN ('github.issue.read','google.read','atlassian.read'));
END
$$;
REVOKE ALL ON FUNCTION {{schema}}.tf_table_import_result_allowed(uuid,text,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION {{schema}}.tf_table_import_result_allowed(uuid,text,uuid,uuid) TO {{runtime}},{{confirmation}},{{migration}},{{customOwner}};

CREATE TABLE {{schema}}.tf_table_row_requests (
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  table_id uuid NOT NULL,
  request_id uuid NOT NULL,
  input_digest text NOT NULL CHECK(input_digest ~ '^[a-f0-9]{64}$'),
  input jsonb,
  permission text NOT NULL CHECK(permission IN ('table.row.create','table.row.update','table.row.delete')),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(membership_id,table_id,request_id),
  CHECK ((input IS NOT NULL AND result->>'kind'='available') OR (input IS NULL AND result->>'kind'='expired'))
);
CREATE INDEX tf_table_row_requests_retention ON {{schema}}.tf_table_row_requests(created_at) WHERE input IS NOT NULL;
REVOKE ALL ON {{schema}}.tf_table_row_requests FROM PUBLIC;
GRANT SELECT,INSERT ON {{schema}}.tf_table_row_requests TO {{runtime}};
GRANT SELECT,UPDATE(input,result) ON {{schema}}.tf_table_row_requests TO {{migration}},{{customOwner}};

ALTER TABLE {{schema}}.tf_table_generations DROP CONSTRAINT tf_table_generations_physical_table_check;
ALTER TABLE {{schema}}.tf_table_generations ADD CHECK(physical_table ~ '^[gr]_[a-f0-9]{32}$');
CREATE TABLE {{schema}}.tf_table_legacy_adoptions (
  generation_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_table_generations(id),
  checkpoint uuid,
  completed boolean NOT NULL DEFAULT false
);
GRANT SELECT ON {{schema}}.tf_table_legacy_adoptions TO {{runtime}};
GRANT SELECT,INSERT,UPDATE ON {{schema}}.tf_table_legacy_adoptions TO {{migration}},{{customOwner}};
GRANT SELECT ON {{schema}}.tf_row_tokens TO {{migration}},{{customOwner}};

-- A published v1 maintenance worker must not change the source schema once an
-- execution has adopted it. Its DDL and catalog update roll back together.
CREATE FUNCTION {{schema}}.tf_table_legacy_schema_fence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM {{schema}}.tf_table_legacy_adoptions a JOIN {{schema}}.tf_table_generations g ON g.id=a.generation_id WHERE g.table_id=OLD.id)
    AND (TG_OP='DELETE' OR NEW.applied_definition->>'formatVersion' IS DISTINCT FROM '2') THEN
    RAISE EXCEPTION 'legacy-schema-adopted';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION {{schema}}.tf_table_legacy_schema_fence() FROM PUBLIC;
CREATE TRIGGER tf_table_legacy_schema_fence BEFORE UPDATE OF applied_revision,applied_definition,physical_table OR DELETE ON {{schema}}.tf_table_catalog
  FOR EACH ROW EXECUTE FUNCTION {{schema}}.tf_table_legacy_schema_fence();

-- Every actual v1 write already changes tf_row_tokens, including UPDATE OF
-- captures for unchanged assigned fields. Mirror those versions, not row hashes.
CREATE FUNCTION {{schema}}.tf_table_legacy_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE catalog record; generation uuid; versions jsonb; fields text[]; alive boolean;
  field jsonb; key_value jsonb; raw jsonb;
BEGIN
  SELECT * INTO catalog FROM {{schema}}.tf_table_catalog
    WHERE physical_table=NEW.physical_table AND applied_definition->>'formatVersion'='1';
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT COALESCE(jsonb_object_agg(f->>'id',COALESCE(NEW.field_versions->(f->>'columnName'),to_jsonb(NEW.incarnation))),'{}'),
    COALESCE(array_agg(f->>'id') FILTER(WHERE TG_OP='INSERT' OR NEW.field_versions->(f->>'columnName') IS DISTINCT FROM OLD.field_versions->(f->>'columnName')),ARRAY[]::text[])
    INTO versions,fields FROM jsonb_array_elements(catalog.applied_definition->'fields') f;
  EXECUTE format('SELECT to_jsonb(r) FROM %I.%I r WHERE id=$1','{{schema}}'::regnamespace::text,NEW.physical_table) INTO raw USING NEW.row_id;
  alive := raw IS NOT NULL;
  INSERT INTO {{schema}}.tf_table_proposal_changes(table_id,row_id,lifecycle,fields)
    VALUES(catalog.id,NEW.row_id,TG_OP='INSERT' OR NEW.incarnation IS DISTINCT FROM OLD.incarnation,fields);
  FOR field IN SELECT f FROM jsonb_array_elements(catalog.applied_definition->'fields') f WHERE (f->>'unique')::boolean LOOP
    IF raw->(field->>'columnName') IS NOT NULL AND raw->(field->>'columnName')<>'null'::jsonb THEN
      key_value := raw->(field->>'columnName');
      IF field->>'kind'='numeric' THEN key_value := to_jsonb(regexp_replace(regexp_replace(key_value#>>'{}','(\.[0-9]*?)0+$','\1'),'\.$','')); END IF;
      INSERT INTO {{schema}}.tf_table_proposal_changes(table_id,row_id,lifecycle,fields,key_id,key_value)
        VALUES(catalog.id,NEW.row_id,false,ARRAY[]::text[],(field->>'id')::uuid,jsonb_build_array(key_value));
    END IF;
  END LOOP;
  SELECT id INTO generation FROM {{schema}}.tf_table_generations WHERE table_id=catalog.id AND physical_table=NEW.physical_table AND state='active';
  IF generation IS NOT NULL THEN
    INSERT INTO {{schema}}.tf_table_identities AS i(table_id,row_id,token,incarnation,field_versions,live)
      VALUES(catalog.id,NEW.row_id,NEW.token,NEW.incarnation,versions,alive)
      ON CONFLICT(table_id,row_id) DO UPDATE SET token=EXCLUDED.token,incarnation=EXCLUDED.incarnation,field_versions=EXCLUDED.field_versions,live=EXCLUDED.live,updated_at=clock_timestamp();
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION {{schema}}.tf_table_legacy_changed() FROM PUBLIC;
CREATE TRIGGER tf_table_legacy_changed AFTER INSERT OR UPDATE ON {{schema}}.tf_row_tokens
  FOR EACH ROW EXECUTE FUNCTION {{schema}}.tf_table_legacy_changed();

-- Legacy writes are captured above, so copying an existing token into the
-- identity index is not itself a record change.
CREATE OR REPLACE FUNCTION {{schema}}.tf_table_proposal_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE fields text[]; resource uuid; item record;
BEGIN
  IF TG_TABLE_NAME='tf_table_identities' THEN
    IF EXISTS(SELECT 1 FROM {{schema}}.tf_table_generations WHERE table_id=NEW.table_id AND state='active' AND physical_table ~ '^r_') THEN RETURN NULL; END IF;
    SELECT COALESCE(array_agg(key),ARRAY[]::text[]) INTO fields FROM jsonb_each(NEW.field_versions)
      WHERE TG_OP='INSERT' OR value IS DISTINCT FROM OLD.field_versions->key;
    INSERT INTO {{schema}}.tf_table_proposal_changes(table_id,row_id,lifecycle,fields)
      VALUES(NEW.table_id,NEW.row_id,TG_OP='INSERT' OR NEW.live IS DISTINCT FROM OLD.live OR NEW.incarnation IS DISTINCT FROM OLD.incarnation,fields);
  ELSE
    IF TG_OP='DELETE' THEN item := OLD; ELSE item := NEW; END IF;
    SELECT table_id INTO resource FROM {{schema}}.tf_table_generations WHERE id=item.generation_id AND state='active';
    IF resource IS NOT NULL THEN
      INSERT INTO {{schema}}.tf_table_proposal_changes(table_id,row_id,lifecycle,fields,key_id,key_value)
        VALUES(resource,item.row_id,false,ARRAY[]::text[],item.key_id,item.value);
    END IF;
  END IF;
  RETURN NULL;
END $$;

ALTER TABLE {{schema}}.tf_slack_link_prompts
  DROP CONSTRAINT tf_slack_link_prompts_installation_id_generation_slack_user_key;
CREATE INDEX tf_slack_link_prompts_sender ON {{schema}}.tf_slack_link_prompts (installation_id,generation,slack_user_id);

CREATE TABLE {{schema}}.tf_mcp_connections (
  id uuid PRIMARY KEY,
  ownership text NOT NULL CHECK (ownership IN ('personal','shared')),
  owner_membership_id uuid REFERENCES {{schema}}.tf_memberships(id),
  name text NOT NULL,
  endpoint text NOT NULL,
  server_identity text NOT NULL,
  descriptor_approved boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1,
  auth_method text NOT NULL CHECK (auth_method IN ('none','bearer','headers','oauth')),
  credential_expires_at timestamptz,
  lifecycle text NOT NULL CHECK (lifecycle IN ('active','disabled','disconnected','deleted','authorizing','reconnect-required')),
  authorization_epoch integer NOT NULL DEFAULT 1 CHECK (authorization_epoch > 0),
  secret_version integer NOT NULL DEFAULT 1 CHECK (secret_version > 0),
  grants_version integer NOT NULL DEFAULT 1 CHECK (grants_version > 0),
  credential jsonb,
  refresh_claim uuid,
  refresh_started_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((ownership='personal') = (owner_membership_id IS NOT NULL)),
  CHECK (lifecycle <> 'active' OR credential IS NOT NULL),
  CHECK ((refresh_claim IS NULL) = (refresh_started_at IS NULL))
);
CREATE TABLE {{schema}}.tf_mcp_member_grants (
  connection_id uuid NOT NULL REFERENCES {{schema}}.tf_mcp_connections(id),
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  PRIMARY KEY (connection_id,membership_id)
);
CREATE TABLE {{schema}}.tf_mcp_team_grants (
  connection_id uuid NOT NULL REFERENCES {{schema}}.tf_mcp_connections(id),
  team_id uuid NOT NULL REFERENCES {{schema}}.tf_teams(id) ON DELETE CASCADE,
  PRIMARY KEY (connection_id,team_id)
);
CREATE TABLE {{schema}}.tf_mcp_tool_revisions (
  connection_id uuid NOT NULL REFERENCES {{schema}}.tf_mcp_connections(id),
  name text NOT NULL,
  revision text NOT NULL,
  tool jsonb NOT NULL,
  compatibility_reason text,
  PRIMARY KEY (connection_id,name,revision)
);
CREATE TABLE {{schema}}.tf_mcp_tool_policies (
  connection_id uuid NOT NULL REFERENCES {{schema}}.tf_mcp_connections(id),
  name text NOT NULL,
  discovered_revision text NOT NULL,
  enabled_revision text,
  standing_exception boolean NOT NULL DEFAULT false,
  policy_version integer NOT NULL DEFAULT 1,
  present boolean NOT NULL DEFAULT true,
  PRIMARY KEY (connection_id,name),
  FOREIGN KEY (connection_id,name,discovered_revision) REFERENCES {{schema}}.tf_mcp_tool_revisions(connection_id,name,revision),
  CHECK (NOT standing_exception OR enabled_revision IS NOT NULL)
);
CREATE TABLE {{schema}}.tf_mcp_selections (
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  origin_key text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  bindings jsonb NOT NULL,
  subject jsonb,
  claimed_task_id uuid,
  PRIMARY KEY (membership_id,origin_key)
);
CREATE TABLE {{schema}}.tf_mcp_commands (
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  request_id uuid NOT NULL,
  kind text NOT NULL,
  digest text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (membership_id,request_id)
);
CREATE TABLE {{schema}}.tf_mcp_actions (
  id uuid PRIMARY KEY,
  requester jsonb NOT NULL,
  origin jsonb NOT NULL,
  connection_id uuid NOT NULL REFERENCES {{schema}}.tf_mcp_connections(id),
  authorization_epoch integer NOT NULL,
  selection_version integer NOT NULL,
  tool_name text NOT NULL,
  tool_revision text NOT NULL,
  policy_version integer NOT NULL,
  arguments jsonb NOT NULL,
  sources jsonb NOT NULL,
  digest text NOT NULL,
  requires_consent boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '24 hours',
  CHECK (expires_at <= created_at+interval '24 hours 1 second'),
  UNIQUE (requester,origin),
  FOREIGN KEY (connection_id,tool_name,tool_revision) REFERENCES {{schema}}.tf_mcp_tool_revisions(connection_id,name,revision)
);
CREATE TABLE {{schema}}.tf_mcp_decisions (
  action_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_mcp_actions(id),
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  digest text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('approve','reject')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE {{schema}}.tf_mcp_policy_evaluations (
  action_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_mcp_actions(id),
  policy_version integer NOT NULL,
  digest text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE {{schema}}.tf_mcp_cancellations (
  action_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_mcp_actions(id),
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE {{schema}}.tf_mcp_claims (
  action_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_mcp_actions(id),
  connection_id uuid NOT NULL REFERENCES {{schema}}.tf_mcp_connections(id),
  token uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deadline timestamptz NOT NULL DEFAULT clock_timestamp()+interval '30 seconds'
);
CREATE TABLE {{schema}}.tf_mcp_receipts (
  action_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_mcp_claims(action_id),
  status text NOT NULL CHECK (status IN ('succeeded','outcome-unknown')),
  result jsonb,
  sources jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((status='succeeded') = (result IS NOT NULL))
);
CREATE TABLE {{schema}}.tf_mcp_reconciliations (
  id uuid PRIMARY KEY,
  action_id uuid NOT NULL REFERENCES {{schema}}.tf_mcp_receipts(action_id),
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  observation text NOT NULL CHECK (observation IN ('completed','not-performed','still-unknown')),
  administrative boolean NOT NULL,
  notes text NOT NULL CHECK (octet_length(notes) <= 8192),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX tf_mcp_one_resolution ON {{schema}}.tf_mcp_reconciliations(action_id) WHERE observation <> 'still-unknown';
CREATE TABLE {{schema}}.tf_mcp_oauth_attempts (
  id uuid PRIMARY KEY,
  connection_id uuid NOT NULL REFERENCES {{schema}}.tf_mcp_connections(id),
  authorization_epoch integer NOT NULL,
  secret_version integer NOT NULL,
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  state_hash text NOT NULL UNIQUE,
  session_hash text NOT NULL,
  material jsonb,
  state text NOT NULL CHECK (state IN ('pending','exchanging','consumed')),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '10 minutes'
);

GRANT SELECT ON {{schema}}.tf_mcp_connections, {{schema}}.tf_mcp_member_grants, {{schema}}.tf_mcp_team_grants,
  {{schema}}.tf_mcp_tool_revisions, {{schema}}.tf_mcp_tool_policies, {{schema}}.tf_mcp_selections,
  {{schema}}.tf_mcp_actions, {{schema}}.tf_mcp_decisions, {{schema}}.tf_mcp_policy_evaluations,
  {{schema}}.tf_mcp_cancellations, {{schema}}.tf_mcp_claims, {{schema}}.tf_mcp_receipts,
  {{schema}}.tf_mcp_reconciliations TO {{runtime}}, {{confirmation}};
GRANT SELECT, INSERT ON {{schema}}.tf_mcp_oauth_attempts TO {{runtime}};
GRANT INSERT ON {{schema}}.tf_mcp_connections, {{schema}}.tf_mcp_tool_revisions,
  {{schema}}.tf_mcp_tool_policies, {{schema}}.tf_mcp_selections, {{schema}}.tf_mcp_actions,
  {{schema}}.tf_mcp_policy_evaluations, {{schema}}.tf_mcp_cancellations,
  {{schema}}.tf_mcp_claims, {{schema}}.tf_mcp_receipts TO {{runtime}};
GRANT INSERT ON {{schema}}.tf_mcp_decisions, {{schema}}.tf_mcp_reconciliations TO {{confirmation}};
GRANT SELECT, INSERT, DELETE ON {{schema}}.tf_mcp_member_grants, {{schema}}.tf_mcp_team_grants TO {{runtime}};
GRANT SELECT, INSERT ON {{schema}}.tf_mcp_commands TO {{runtime}}, {{confirmation}};
GRANT UPDATE (endpoint,server_identity,descriptor_approved,version,auth_method,credential_expires_at,lifecycle,authorization_epoch,secret_version,grants_version,credential,refresh_claim,refresh_started_at) ON {{schema}}.tf_mcp_connections TO {{runtime}};
GRANT UPDATE (discovered_revision,enabled_revision,standing_exception,policy_version,present) ON {{schema}}.tf_mcp_tool_policies TO {{runtime}};
GRANT UPDATE (version,bindings,claimed_task_id) ON {{schema}}.tf_mcp_selections TO {{runtime}};
GRANT UPDATE (state,material) ON {{schema}}.tf_mcp_oauth_attempts TO {{runtime}};
GRANT UPDATE (grants_version) ON {{schema}}.tf_mcp_connections TO {{confirmation}};

CREATE FUNCTION {{schema}}.tf_mcp_validate_claim() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  PERFORM 1 FROM {{schema}}.tf_mcp_connections WHERE id=NEW.connection_id FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM {{schema}}.tf_mcp_actions WHERE id=NEW.action_id AND connection_id=NEW.connection_id AND expires_at>clock_timestamp()) THEN
    RAISE EXCEPTION 'Invalid MCP claim';
  END IF;
  IF EXISTS (SELECT 1 FROM {{schema}}.tf_mcp_claims c LEFT JOIN {{schema}}.tf_mcp_receipts r ON r.action_id=c.action_id
    WHERE c.connection_id=NEW.connection_id AND (r.action_id IS NULL OR (r.status='outcome-unknown' AND NOT EXISTS
      (SELECT 1 FROM {{schema}}.tf_mcp_reconciliations h WHERE h.action_id=c.action_id AND h.observation<>'still-unknown')))) THEN
    RAISE EXCEPTION 'MCP connection blocked';
  END IF;
  IF EXISTS (SELECT 1 FROM {{schema}}.tf_mcp_cancellations WHERE action_id=NEW.action_id) OR
     EXISTS (SELECT 1 FROM {{schema}}.tf_mcp_decisions WHERE action_id=NEW.action_id AND decision='reject') THEN
    RAISE EXCEPTION 'MCP action cancelled';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM {{schema}}.tf_mcp_actions a JOIN {{schema}}.tf_mcp_decisions d ON d.action_id=a.id
    WHERE a.id=NEW.action_id AND d.decision='approve' AND d.digest=a.digest AND d.membership_id=(a.requester->>'membershipId')::uuid)
    AND NOT EXISTS (SELECT 1 FROM {{schema}}.tf_mcp_actions a JOIN {{schema}}.tf_mcp_policy_evaluations e ON e.action_id=a.id
      JOIN {{schema}}.tf_mcp_tool_policies p ON p.connection_id=a.connection_id AND p.name=a.tool_name
      WHERE a.id=NEW.action_id AND NOT a.requires_consent AND e.digest=a.digest AND e.policy_version=a.policy_version
      AND p.policy_version=a.policy_version AND p.standing_exception AND p.enabled_revision=a.tool_revision) THEN
    RAISE EXCEPTION 'MCP approval required';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION {{schema}}.tf_mcp_validate_claim() FROM PUBLIC;
CREATE TRIGGER tf_mcp_claim_guard BEFORE INSERT ON {{schema}}.tf_mcp_claims FOR EACH ROW EXECUTE FUNCTION {{schema}}.tf_mcp_validate_claim();

CREATE FUNCTION {{schema}}.tf_mcp_invalidate_team_access() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE affected uuid;
BEGIN
  PERFORM id FROM {{schema}}.tf_authorization_lock WHERE id=1 FOR UPDATE;
  FOR affected IN SELECT connection_id FROM {{schema}}.tf_mcp_team_grants WHERE team_id=OLD.team_id ORDER BY connection_id LOOP
    UPDATE {{schema}}.tf_mcp_connections SET authorization_epoch=authorization_epoch+1,version=version+1,grants_version=grants_version+1,refresh_claim=NULL,refresh_started_at=NULL WHERE id=affected;
    UPDATE {{schema}}.tf_mcp_tool_policies SET enabled_revision=NULL,standing_exception=false,policy_version=policy_version+1 WHERE connection_id=affected;
    UPDATE {{schema}}.tf_mcp_oauth_attempts SET state='consumed',material=NULL WHERE connection_id=affected;
  END LOOP;
  RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION {{schema}}.tf_mcp_invalidate_team_access() FROM PUBLIC;
CREATE TRIGGER tf_mcp_team_membership_revocation AFTER DELETE OR UPDATE ON {{schema}}.tf_member_teams FOR EACH ROW EXECUTE FUNCTION {{schema}}.tf_mcp_invalidate_team_access();

CREATE FUNCTION {{schema}}.tf_mcp_invalidate_team_grant() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  PERFORM id FROM {{schema}}.tf_authorization_lock WHERE id=1 FOR UPDATE;
  UPDATE {{schema}}.tf_mcp_connections SET authorization_epoch=authorization_epoch+1,version=version+1,grants_version=grants_version+1,refresh_claim=NULL,refresh_started_at=NULL WHERE id=OLD.connection_id;
  UPDATE {{schema}}.tf_mcp_tool_policies SET enabled_revision=NULL,standing_exception=false,policy_version=policy_version+1 WHERE connection_id=OLD.connection_id;
  UPDATE {{schema}}.tf_mcp_oauth_attempts SET state='consumed',material=NULL WHERE connection_id=OLD.connection_id;
  RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION {{schema}}.tf_mcp_invalidate_team_grant() FROM PUBLIC;
CREATE TRIGGER tf_mcp_team_grant_revocation AFTER DELETE ON {{schema}}.tf_mcp_team_grants FOR EACH ROW EXECUTE FUNCTION {{schema}}.tf_mcp_invalidate_team_grant();

CREATE TABLE {{schema}}.tf_conversation_execution_steps (
  call_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_conversation_tool_calls(id),
  turn_id uuid NOT NULL REFERENCES {{schema}}.tf_conversation_turns(id),
  call jsonb NOT NULL CHECK (jsonb_typeof(call) = 'object'),
  sources jsonb NOT NULL CHECK (jsonb_typeof(sources) = 'array'),
  output jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX tf_conversation_execution_turn ON {{schema}}.tf_conversation_execution_steps(turn_id);
REVOKE ALL ON {{schema}}.tf_conversation_execution_steps FROM PUBLIC;
GRANT SELECT, INSERT ON {{schema}}.tf_conversation_execution_steps TO {{runtime}};
GRANT UPDATE (output) ON {{schema}}.tf_conversation_execution_steps TO {{runtime}};

CREATE TABLE {{schema}}.tf_conversation_model_sources (
  turn_id uuid NOT NULL REFERENCES {{schema}}.tf_conversation_turns(id),
  epoch integer NOT NULL,
  step integer NOT NULL,
  sources jsonb NOT NULL CHECK (jsonb_typeof(sources) = 'array'),
  PRIMARY KEY (turn_id, epoch, step)
);
REVOKE ALL ON {{schema}}.tf_conversation_model_sources FROM PUBLIC;
GRANT SELECT, INSERT ON {{schema}}.tf_conversation_model_sources TO {{runtime}};

ALTER TABLE {{schema}}.tf_agent_task_steps ADD COLUMN mcp_sources jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(mcp_sources) = 'array');
GRANT UPDATE (mcp_sources) ON {{schema}}.tf_agent_task_steps TO {{runtime}};
GRANT SELECT ON {{schema}}.tf_agent_definitions, {{schema}}.tf_agent_activations,
  {{schema}}.tf_agent_runs, {{schema}}.tf_agent_tool_calls, {{schema}}.tf_agents,
  {{schema}}.tf_agent_limits, {{schema}}.tf_agent_teams TO {{confirmation}};
GRANT SELECT ON {{schema}}.tf_conversation_execution_steps, {{schema}}.tf_conversation_model_sources,
  {{schema}}.tf_agent_task_steps, {{schema}}.tf_agent_task_messages,
  {{schema}}.tf_conversation_tool_calls TO {{confirmation}};
GRANT SELECT ON {{schema}}.tf_conversation_results, {{schema}}.tf_conversations,
  {{schema}}.tf_conversation_turns, {{schema}}.tf_conversation_messages,
  {{schema}}.tf_agent_grants, {{schema}}.tf_agent_saved_revisions,
  {{schema}}.tf_chat_authoring_drafts, {{schema}}.tf_chat_authoring_decisions,
  {{schema}}.tf_agent_commands, {{schema}}.tf_workspace_skills,
  {{schema}}.tf_workspace_skill_revisions, {{schema}}.tf_workspace_skill_reviews,
  {{schema}}.tf_slack_default_turns, {{schema}}.tf_slack_dm_roots
TO {{confirmation}};

ALTER TABLE {{schema}}.tf_conversation_tool_calls ADD COLUMN activity text CHECK (activity IS NULL OR char_length(activity) BETWEEN 1 AND 120);

CREATE TABLE {{schema}}.tf_github_task_selection (
  task_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_agent_tasks(id),
  account_id uuid REFERENCES {{schema}}.tf_github_accounts(id),
  account_generation integer,
  task_generation integer NOT NULL,
  context_start integer NOT NULL DEFAULT 0,
  version integer NOT NULL CHECK (version > 0),
  CHECK ((account_id IS NULL) = (account_generation IS NULL))
);
ALTER TABLE {{schema}}.tf_github_batches ALTER COLUMN conversation_id DROP NOT NULL;
ALTER TABLE {{schema}}.tf_github_batches ADD COLUMN task_id uuid REFERENCES {{schema}}.tf_agent_tasks(id);
ALTER TABLE {{schema}}.tf_github_batches ADD CONSTRAINT tf_github_batch_origin CHECK ((conversation_id IS NULL) <> (task_id IS NULL));
REVOKE ALL ON {{schema}}.tf_github_task_selection FROM PUBLIC;
GRANT SELECT ON {{schema}}.tf_github_task_selection TO {{runtime}}, {{confirmation}};
GRANT INSERT, UPDATE ON {{schema}}.tf_github_task_selection TO {{runtime}};

CREATE TABLE {{schema}}.tf_projects (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 160),
  instructions text NOT NULL DEFAULT '' CHECK (octet_length(instructions) <= 65536),
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  creator_membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE {{schema}}.tf_project_members (
  project_id uuid NOT NULL REFERENCES {{schema}}.tf_projects(id),
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  role text NOT NULL CHECK (role IN ('manager', 'member')),
  removed_at timestamptz,
  PRIMARY KEY (project_id, membership_id)
);
CREATE TABLE {{schema}}.tf_project_knowledge (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES {{schema}}.tf_projects(id),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 255),
  pinned boolean NOT NULL DEFAULT false,
  current_revision uuid NOT NULL,
  removed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE {{schema}}.tf_project_knowledge_revisions (
  id uuid PRIMARY KEY,
  knowledge_id uuid NOT NULL REFERENCES {{schema}}.tf_project_knowledge(id) DEFERRABLE INITIALLY DEFERRED,
  filename text NOT NULL CHECK (char_length(filename) BETWEEN 1 AND 255),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  bytes integer NOT NULL CHECK (bytes BETWEEN 0 AND 10485760),
  content text NOT NULL CHECK (octet_length(content) <= 1048576),
  created_by uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (knowledge_id, id)
);
ALTER TABLE {{schema}}.tf_project_knowledge ADD FOREIGN KEY (id, current_revision) REFERENCES {{schema}}.tf_project_knowledge_revisions(knowledge_id, id) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX tf_project_knowledge_project ON {{schema}}.tf_project_knowledge(project_id) WHERE removed_at IS NULL;
ALTER TABLE {{schema}}.tf_conversations ADD COLUMN project_id uuid REFERENCES {{schema}}.tf_projects(id);
CREATE INDEX tf_conversations_project ON {{schema}}.tf_conversations(project_id, activity_at DESC, id DESC) WHERE project_id IS NOT NULL;
ALTER TABLE {{schema}}.tf_conversation_turns ADD COLUMN project_context jsonb CHECK (project_context IS NULL OR jsonb_typeof(project_context) = 'object');
ALTER TABLE {{schema}}.tf_conversation_commands
  DROP CONSTRAINT tf_conversation_commands_operation_check,
  ADD CONSTRAINT tf_conversation_commands_operation_check
    CHECK (operation IN ('create', 'send', 'rename', 'archive', 'retry', 'cancel', 'answer', 'cancel-request', 'approval', 'move'));
REVOKE ALL ON {{schema}}.tf_projects, {{schema}}.tf_project_members, {{schema}}.tf_project_knowledge, {{schema}}.tf_project_knowledge_revisions FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON {{schema}}.tf_projects, {{schema}}.tf_project_members, {{schema}}.tf_project_knowledge TO {{runtime}};
GRANT SELECT, INSERT ON {{schema}}.tf_project_knowledge_revisions TO {{runtime}};
GRANT SELECT ON {{schema}}.tf_projects, {{schema}}.tf_project_members TO {{confirmation}};
GRANT UPDATE (project_id) ON {{schema}}.tf_conversations TO {{runtime}};
GRANT UPDATE (project_context) ON {{schema}}.tf_conversation_turns TO {{runtime}};

CREATE TABLE {{schema}}.tf_knowledge_sources (
  id uuid PRIMARY KEY,
  provider text NOT NULL CHECK (provider IN ('note','file','google','slack','github','confluence','jira')),
  account_namespace text NOT NULL CHECK (octet_length(account_namespace) BETWEEN 1 AND 8192),
  selection text NOT NULL CHECK (octet_length(selection) BETWEEN 1 AND 8192),
  owner_membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','paused','disconnected','removed')),
  access_epoch integer NOT NULL DEFAULT 1 CHECK (access_epoch > 0),
  removed_at timestamptz,
  retain_until timestamptz,
  UNIQUE (provider, account_namespace, selection, owner_membership_id),
  CHECK ((state = 'removed') = (removed_at IS NOT NULL)),
  CHECK ((removed_at IS NULL AND retain_until IS NULL) OR retain_until >= removed_at + interval '30 days')
);
CREATE TABLE {{schema}}.tf_knowledge_documents (
  id uuid PRIMARY KEY,
  source_id uuid NOT NULL REFERENCES {{schema}}.tf_knowledge_sources(id),
  native_id text NOT NULL CHECK (octet_length(native_id) BETWEEN 1 AND 8192),
  observed_revision_id uuid,
  lexical_publication_id uuid,
  vector_publication_id uuid,
  tombstoned_at timestamptz,
  retain_until timestamptz,
  UNIQUE (source_id, native_id),
  UNIQUE (id, source_id),
  CHECK ((tombstoned_at IS NULL AND retain_until IS NULL) OR retain_until >= tombstoned_at + interval '30 days')
);
CREATE TABLE {{schema}}.tf_knowledge_revisions (
  id uuid PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES {{schema}}.tf_knowledge_documents(id),
  source_revision text NOT NULL CHECK (octet_length(source_revision) BETWEEN 1 AND 8192),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 512),
  canonical_url text,
  original jsonb NOT NULL,
  original_bytes integer NOT NULL CHECK (original_bytes BETWEEN 1 AND 10485760),
  parser_profile jsonb NOT NULL,
  sources jsonb NOT NULL CHECK (jsonb_typeof(sources) = 'array' AND jsonb_array_length(sources) <= 1000),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (document_id, source_revision),
  UNIQUE (id, document_id)
);
CREATE TABLE {{schema}}.tf_knowledge_publications (
  id uuid PRIMARY KEY,
  document_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  markdown text NOT NULL CHECK (octet_length(markdown) BETWEEN 1 AND 10485760),
  pages integer NOT NULL CHECK (pages BETWEEN 0 AND 500),
  tokens integer NOT NULL CHECK (tokens BETWEEN 1 AND 250000),
  chunk_count integer NOT NULL CHECK (chunk_count BETWEEN 1 AND 4096),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (revision_id, document_id) REFERENCES {{schema}}.tf_knowledge_revisions(id, document_id),
  UNIQUE (id, document_id, revision_id)
);
CREATE TABLE {{schema}}.tf_knowledge_chunks (
  publication_id uuid NOT NULL REFERENCES {{schema}}.tf_knowledge_publications(id),
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 4095),
  heading text NOT NULL,
  passage text NOT NULL CHECK (octet_length(passage) BETWEEN 1 AND 32768),
  tokens integer NOT NULL CHECK (tokens BETWEEN 1 AND 8192),
  source_offset jsonb NOT NULL,
  input_hash text NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (publication_id, ordinal)
);
CREATE TABLE {{schema}}.tf_knowledge_vector_publications (
  id uuid PRIMARY KEY,
  document_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  lexical_publication_id uuid NOT NULL,
  profile jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (lexical_publication_id, document_id, revision_id) REFERENCES {{schema}}.tf_knowledge_publications(id, document_id, revision_id),
  UNIQUE (id, document_id, revision_id)
);
ALTER TABLE {{schema}}.tf_knowledge_documents
  ADD FOREIGN KEY (observed_revision_id, id) REFERENCES {{schema}}.tf_knowledge_revisions(id, document_id),
  ADD FOREIGN KEY (lexical_publication_id, id, observed_revision_id) REFERENCES {{schema}}.tf_knowledge_publications(id, document_id, revision_id),
  ADD FOREIGN KEY (vector_publication_id, id, observed_revision_id) REFERENCES {{schema}}.tf_knowledge_vector_publications(id, document_id, revision_id),
  ADD CHECK (lexical_publication_id IS NULL OR observed_revision_id IS NOT NULL),
  ADD CHECK (vector_publication_id IS NULL OR lexical_publication_id IS NOT NULL);
CREATE TABLE {{schema}}.tf_knowledge_work (
  revision_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_knowledge_revisions(id),
  parsing text NOT NULL DEFAULT 'queued' CHECK (parsing IN ('queued','ready','failed','ocr-unavailable')),
  embedding text NOT NULL DEFAULT 'pending' CHECK (embedding IN ('pending','failed','credits-blocked','ready')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 8),
  failure text CHECK (failure IN ('unsupported','encrypted','malformed','resource-limited','ocr-required','provider','credits'))
);
CREATE TABLE {{schema}}.tf_knowledge_access_proofs (
  id uuid PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES {{schema}}.tf_knowledge_documents(id),
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  access_epoch integer NOT NULL CHECK (access_epoch > 0),
  principal text NOT NULL,
  acl_version text NOT NULL,
  membership_version text NOT NULL,
  acl_checked_at timestamptz NOT NULL,
  membership_checked_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CHECK (expires_at > greatest(acl_checked_at, membership_checked_at)),
  CHECK (expires_at <= least(acl_checked_at, membership_checked_at) + interval '5 minutes'),
  UNIQUE (document_id, membership_id)
);
REVOKE ALL ON {{schema}}.tf_knowledge_sources, {{schema}}.tf_knowledge_documents,
  {{schema}}.tf_knowledge_revisions, {{schema}}.tf_knowledge_publications,
  {{schema}}.tf_knowledge_chunks, {{schema}}.tf_knowledge_vector_publications,
  {{schema}}.tf_knowledge_work, {{schema}}.tf_knowledge_access_proofs FROM PUBLIC;
GRANT SELECT, INSERT ON {{schema}}.tf_knowledge_sources, {{schema}}.tf_knowledge_documents,
  {{schema}}.tf_knowledge_revisions, {{schema}}.tf_knowledge_publications,
  {{schema}}.tf_knowledge_chunks, {{schema}}.tf_knowledge_work,
  {{schema}}.tf_knowledge_access_proofs TO {{runtime}};
GRANT SELECT ON {{schema}}.tf_knowledge_vector_publications TO {{runtime}};
GRANT UPDATE (state, access_epoch, removed_at, retain_until) ON {{schema}}.tf_knowledge_sources TO {{runtime}};
GRANT UPDATE (observed_revision_id, lexical_publication_id, tombstoned_at, retain_until) ON {{schema}}.tf_knowledge_documents TO {{runtime}};
GRANT UPDATE (parsing, embedding, attempts, failure) ON {{schema}}.tf_knowledge_work TO {{runtime}};
GRANT UPDATE ON {{schema}}.tf_knowledge_access_proofs TO {{runtime}};

ALTER TABLE {{schema}}.tf_knowledge_work DROP CONSTRAINT tf_knowledge_work_parsing_check;
ALTER TABLE {{schema}}.tf_knowledge_work ADD CHECK (parsing IN ('queued','parsing','ready','failed','ocr-unavailable'));

CREATE TABLE {{schema}}.tf_knowledge_local_revisions (
  revision_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_knowledge_revisions(id),
  owner_membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  owner_user_id text NOT NULL,
  filename text NOT NULL CHECK (char_length(filename) BETWEEN 1 AND 255),
  media_type text NOT NULL CHECK (char_length(media_type) BETWEEN 1 AND 127),
  command_fingerprint text NOT NULL CHECK (command_fingerprint ~ '^[a-f0-9]{64}$')
);
CREATE TABLE {{schema}}.tf_knowledge_note_originals (
  revision_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_knowledge_local_revisions(revision_id),
  bytes bytea NOT NULL CHECK (octet_length(bytes) BETWEEN 1 AND 10485760)
);
CREATE TABLE {{schema}}.tf_knowledge_jobs (
  revision_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_knowledge_local_revisions(revision_id),
  generation integer NOT NULL DEFAULT 1 CHECK (generation > 0),
  lease_token uuid,
  lease_until timestamptz,
  dispatched_at timestamptz,
  dispatch_after timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((lease_token IS NULL) = (lease_until IS NULL))
);
CREATE INDEX tf_knowledge_jobs_dispatch ON {{schema}}.tf_knowledge_jobs (dispatch_after);
CREATE TABLE {{schema}}.tf_knowledge_commands (
  command_id uuid PRIMARY KEY,
  revision_id uuid NOT NULL REFERENCES {{schema}}.tf_knowledge_local_revisions(revision_id),
  action text NOT NULL CHECK (action IN ('retry','remove')),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$')
);
ALTER TABLE {{schema}}.tf_knowledge_chunks
  ADD COLUMN search_title text NOT NULL DEFAULT '',
  ADD COLUMN identifiers text[] NOT NULL DEFAULT '{}',
  ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english'::regconfig,search_title),'A') ||
    setweight(to_tsvector('english'::regconfig,heading),'B') ||
    setweight(to_tsvector('english'::regconfig,passage),'C')
  ) STORED;
CREATE INDEX tf_knowledge_search_english_gin ON {{schema}}.tf_knowledge_chunks USING gin (search_vector);
CREATE INDEX tf_knowledge_search_identifiers_gin ON {{schema}}.tf_knowledge_chunks USING gin (identifiers);
CREATE TABLE {{schema}}.tf_knowledge_parse_profiles (
  publication_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_knowledge_publications(id),
  profile jsonb NOT NULL
);
REVOKE ALL ON {{schema}}.tf_knowledge_local_revisions, {{schema}}.tf_knowledge_note_originals,
  {{schema}}.tf_knowledge_jobs, {{schema}}.tf_knowledge_commands, {{schema}}.tf_knowledge_parse_profiles FROM PUBLIC;
GRANT SELECT, INSERT ON {{schema}}.tf_knowledge_local_revisions, {{schema}}.tf_knowledge_note_originals,
  {{schema}}.tf_knowledge_jobs, {{schema}}.tf_knowledge_commands, {{schema}}.tf_knowledge_parse_profiles TO {{runtime}};
GRANT UPDATE (generation,lease_token,lease_until,dispatch_after,dispatched_at) ON {{schema}}.tf_knowledge_jobs TO {{runtime}};

CREATE TABLE {{schema}}.tf_knowledge_credit_group (
  version integer PRIMARY KEY CHECK (version = 1),
  known numeric(30,0) NOT NULL DEFAULT 0 CHECK (known >= 0),
  pending numeric(30,0) NOT NULL DEFAULT 0 CHECK (pending >= 0),
  unfunded numeric(30,0) NOT NULL DEFAULT 0 CHECK (unfunded >= 0)
);
INSERT INTO {{schema}}.tf_knowledge_credit_group (version) VALUES (1);

CREATE TABLE {{schema}}.tf_knowledge_credit_attempts (
  id text PRIMARY KEY,
  group_version integer NOT NULL REFERENCES {{schema}}.tf_knowledge_credit_group(version),
  operation_id text NOT NULL,
  model_id text NOT NULL,
  profile_id text NOT NULL,
  pricing_revision text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('ingestion','query','reindex')),
  attribution_kind text NOT NULL CHECK (attribution_kind IN ('member','source')),
  attribution_id text NOT NULL,
  task_flow_id text,
  upper_provider_pico_usd numeric(30,0) NOT NULL CHECK (upper_provider_pico_usd >= 0),
  state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved','dispatched','unknown','released','known')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX tf_knowledge_credit_attempts_task ON {{schema}}.tf_knowledge_credit_attempts (task_flow_id) WHERE task_flow_id IS NOT NULL;

CREATE TABLE {{schema}}.tf_knowledge_credit_observations (
  attempt_id text PRIMARY KEY REFERENCES {{schema}}.tf_knowledge_credit_attempts(id),
  provider_pico_usd numeric(30,0) NOT NULL CHECK (provider_pico_usd >= 0),
  input_tokens numeric(30,0) NOT NULL CHECK (input_tokens >= 0),
  provider_request_id text,
  charged numeric(30,0) NOT NULL CHECK (charged >= 0),
  above_bound boolean NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX tf_knowledge_credit_observations_day ON {{schema}}.tf_knowledge_credit_observations (observed_at);

REVOKE ALL ON {{schema}}.tf_knowledge_credit_group, {{schema}}.tf_knowledge_credit_attempts,
  {{schema}}.tf_knowledge_credit_observations FROM PUBLIC;
GRANT SELECT ON {{schema}}.tf_knowledge_credit_group TO {{runtime}};
GRANT UPDATE (known,pending,unfunded) ON {{schema}}.tf_knowledge_credit_group TO {{runtime}};
GRANT SELECT, INSERT ON {{schema}}.tf_knowledge_credit_attempts, {{schema}}.tf_knowledge_credit_observations TO {{runtime}};
GRANT UPDATE (state) ON {{schema}}.tf_knowledge_credit_attempts TO {{runtime}};

CREATE TABLE {{schema}}.tf_knowledge_embedding_profiles (
  id text PRIMARY KEY,
  profile jsonb NOT NULL
);
CREATE TABLE {{schema}}.tf_knowledge_embedding_jobs (
  id uuid PRIMARY KEY,
  purpose text NOT NULL CHECK (purpose IN ('query','ingestion')),
  owner_membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  owner_user_id text NOT NULL,
  profile_id text NOT NULL REFERENCES {{schema}}.tf_knowledge_embedding_profiles(id),
  command_id uuid,
  query_fingerprint text,
  document_id uuid,
  revision_id uuid,
  publication_id uuid,
  access_epoch integer,
  total_chunks integer NOT NULL CHECK (total_chunks BETWEEN 1 AND 4096),
  generation integer NOT NULL DEFAULT 1 CHECK (generation BETWEEN 1 AND 8),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','ready','disabled','credits-blocked','capacity-blocked','failed','unknown','invalid-input')),
  dispatch_after timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (publication_id,document_id,revision_id) REFERENCES {{schema}}.tf_knowledge_publications(id,document_id,revision_id),
  UNIQUE (owner_membership_id,command_id),
  UNIQUE (publication_id,profile_id),
  CHECK ((purpose='query' AND command_id IS NOT NULL AND query_fingerprint IS NOT NULL AND document_id IS NULL AND revision_id IS NULL AND publication_id IS NULL AND access_epoch IS NULL AND total_chunks=1)
    OR (purpose='ingestion' AND command_id IS NULL AND query_fingerprint IS NULL AND document_id IS NOT NULL AND revision_id IS NOT NULL AND publication_id IS NOT NULL AND access_epoch>0))
);
CREATE INDEX tf_knowledge_embedding_jobs_due ON {{schema}}.tf_knowledge_embedding_jobs (dispatch_after,id) WHERE state IN ('queued','capacity-blocked');
CREATE TABLE {{schema}}.tf_knowledge_embedding_cache (
  profile_id text NOT NULL REFERENCES {{schema}}.tf_knowledge_embedding_profiles(id),
  input_hash text NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','claimed','dispatched','ready','failed','unknown')),
  attempt_id uuid,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 8),
  lease_until timestamptz,
  PRIMARY KEY (profile_id,input_hash)
);
CREATE TABLE {{schema}}.tf_knowledge_embedding_items (
  job_id uuid NOT NULL REFERENCES {{schema}}.tf_knowledge_embedding_jobs(id),
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 4095),
  profile_id text NOT NULL,
  input_hash text NOT NULL,
  input_text text NOT NULL CHECK (octet_length(input_text) BETWEEN 1 AND 131072),
  tokens integer NOT NULL CHECK (tokens BETWEEN 1 AND 8192),
  PRIMARY KEY (job_id,ordinal),
  FOREIGN KEY (profile_id,input_hash) REFERENCES {{schema}}.tf_knowledge_embedding_cache(profile_id,input_hash)
);
CREATE TABLE {{schema}}.tf_knowledge_embedding_vectors (
  profile_id text NOT NULL,
  input_hash text NOT NULL,
  vector jsonb NOT NULL CHECK (jsonb_typeof(vector)='array' AND jsonb_array_length(vector)=1536),
  attempt_id text NOT NULL REFERENCES {{schema}}.tf_knowledge_credit_attempts(id),
  PRIMARY KEY (profile_id,input_hash),
  FOREIGN KEY (profile_id,input_hash) REFERENCES {{schema}}.tf_knowledge_embedding_cache(profile_id,input_hash)
);
CREATE TABLE {{schema}}.tf_knowledge_embedding_retries (
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  command_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES {{schema}}.tf_knowledge_embedding_jobs(id),
  expected_generation integer NOT NULL,
  PRIMARY KEY (membership_id,command_id)
);
REVOKE ALL ON {{schema}}.tf_knowledge_embedding_profiles, {{schema}}.tf_knowledge_embedding_jobs,
  {{schema}}.tf_knowledge_embedding_cache, {{schema}}.tf_knowledge_embedding_items,
  {{schema}}.tf_knowledge_embedding_vectors, {{schema}}.tf_knowledge_embedding_retries FROM PUBLIC;
GRANT SELECT, INSERT ON {{schema}}.tf_knowledge_embedding_profiles, {{schema}}.tf_knowledge_embedding_jobs,
  {{schema}}.tf_knowledge_embedding_cache, {{schema}}.tf_knowledge_embedding_items,
  {{schema}}.tf_knowledge_embedding_vectors, {{schema}}.tf_knowledge_embedding_retries TO {{runtime}};
GRANT UPDATE (generation,state,dispatch_after) ON {{schema}}.tf_knowledge_embedding_jobs TO {{runtime}};
GRANT UPDATE (state,attempt_id,attempts,lease_until) ON {{schema}}.tf_knowledge_embedding_cache TO {{runtime}};

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid=e.extnamespace
    WHERE e.extname='vector' AND n.nspname='extensions'
      AND string_to_array(e.extversion,'.')::int[] >= ARRAY[0,8,0]) THEN
    RAISE EXCEPTION 'Knowledge search requires pgvector >= 0.8.0 in extensions';
  END IF;
END $$;

ALTER TABLE {{schema}}.tf_knowledge_vector_publications
  ADD COLUMN profile_id text REFERENCES {{schema}}.tf_knowledge_embedding_profiles(id),
  ADD CONSTRAINT tf_knowledge_vector_publications_profile_required CHECK (profile_id IS NOT NULL) NOT VALID,
  ADD UNIQUE (lexical_publication_id,profile_id),
  ADD UNIQUE (id,lexical_publication_id,profile_id),
  ADD UNIQUE (id,lexical_publication_id);
ALTER TABLE {{schema}}.tf_knowledge_documents
  ADD FOREIGN KEY (vector_publication_id,lexical_publication_id)
    REFERENCES {{schema}}.tf_knowledge_vector_publications(id,lexical_publication_id);

CREATE TABLE {{schema}}.tf_knowledge_search_vectors (
  vector_publication_id uuid NOT NULL,
  lexical_publication_id uuid NOT NULL,
  ordinal integer NOT NULL,
  profile_id text NOT NULL,
  input_hash text NOT NULL,
  embedding extensions.vector(1536) NOT NULL,
  PRIMARY KEY (vector_publication_id,ordinal),
  FOREIGN KEY (vector_publication_id,lexical_publication_id,profile_id)
    REFERENCES {{schema}}.tf_knowledge_vector_publications(id,lexical_publication_id,profile_id),
  FOREIGN KEY (lexical_publication_id,ordinal)
    REFERENCES {{schema}}.tf_knowledge_chunks(publication_id,ordinal),
  FOREIGN KEY (profile_id,input_hash)
    REFERENCES {{schema}}.tf_knowledge_embedding_vectors(profile_id,input_hash)
);
CREATE INDEX tf_knowledge_search_vectors_cosine ON {{schema}}.tf_knowledge_search_vectors
  USING hnsw (embedding extensions.vector_cosine_ops);
REVOKE ALL ON {{schema}}.tf_knowledge_search_vectors FROM PUBLIC;
GRANT SELECT, INSERT ON {{schema}}.tf_knowledge_search_vectors TO {{runtime}};
GRANT INSERT ON {{schema}}.tf_knowledge_vector_publications TO {{runtime}};
GRANT UPDATE (vector_publication_id) ON {{schema}}.tf_knowledge_documents TO {{runtime}};
GRANT USAGE ON SCHEMA extensions TO {{runtime}};
GRANT USAGE ON TYPE extensions.vector TO {{runtime}};
GRANT EXECUTE ON FUNCTION extensions.vector_in(cstring,oid,integer), extensions.vector_out(extensions.vector),
  extensions.vector_typmod_in(cstring[]), extensions.vector(extensions.vector,integer,boolean),
  extensions.cosine_distance(extensions.vector,extensions.vector) TO {{runtime}};

CREATE TABLE {{schema}}.tf_knowledge_search_queries (
  job_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_knowledge_embedding_jobs(id),
  filters jsonb NOT NULL CHECK (jsonb_typeof(filters)='object'),
  cancelled boolean NOT NULL DEFAULT false,
  expires_at timestamptz NOT NULL
);
CREATE TABLE {{schema}}.tf_knowledge_search_sessions (
  id uuid NOT NULL,
  owner_membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  owner_user_id text NOT NULL,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  filters jsonb NOT NULL CHECK (jsonb_typeof(filters)='object'),
  candidates jsonb NOT NULL CHECK (jsonb_typeof(candidates)='array' AND jsonb_array_length(candidates)<=100 AND octet_length(candidates::text)<=131072),
  mode text NOT NULL CHECK (mode IN ('keyword-only','hybrid')),
  reason text,
  coverage text NOT NULL CHECK (coverage IN ('complete','partial','keyword-only')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (id,owner_membership_id),
  CHECK (expires_at<=created_at+interval '5 minutes'),
  CHECK ((mode='hybrid' AND reason IS NULL) OR (mode='keyword-only' AND reason IN
    ('semantic-not-enabled','typing','no-semantic-content','embedding-pending','credits-blocked','capacity-blocked','provider-unavailable','deadline')))
);
CREATE INDEX tf_knowledge_search_sessions_expiry ON {{schema}}.tf_knowledge_search_sessions(expires_at);
CREATE INDEX tf_knowledge_search_sessions_owner ON {{schema}}.tf_knowledge_search_sessions(owner_membership_id);
REVOKE ALL ON {{schema}}.tf_knowledge_search_queries, {{schema}}.tf_knowledge_search_sessions FROM PUBLIC;
GRANT SELECT,INSERT ON {{schema}}.tf_knowledge_search_queries, {{schema}}.tf_knowledge_search_sessions TO {{runtime}};
GRANT DELETE ON {{schema}}.tf_knowledge_search_sessions TO {{runtime}};
GRANT UPDATE(cancelled) ON {{schema}}.tf_knowledge_search_queries TO {{runtime}};

ALTER TABLE {{schema}}.tf_knowledge_sources
  DROP CONSTRAINT tf_knowledge_sources_provider_account_namespace_selection_o_key;
CREATE UNIQUE INDEX tf_knowledge_sources_live_selection ON {{schema}}.tf_knowledge_sources
  (provider,account_namespace,selection,owner_membership_id) WHERE state <> 'removed';
ALTER TABLE {{schema}}.tf_knowledge_embedding_jobs
  DROP CONSTRAINT tf_knowledge_embedding_jobs_generation_check,
  ADD CHECK (generation > 0),
  ADD COLUMN retry_count integer NOT NULL DEFAULT 0 CHECK (retry_count BETWEEN 0 AND 7);
UPDATE {{schema}}.tf_knowledge_embedding_jobs SET retry_count=generation-1;
GRANT UPDATE (access_epoch,retry_count) ON {{schema}}.tf_knowledge_embedding_jobs TO {{runtime}};
CREATE TABLE {{schema}}.tf_knowledge_google_sources (
  source_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_knowledge_sources(id),
  binding jsonb NOT NULL,
  selection jsonb NOT NULL,
  title text NOT NULL,
  fingerprint text NOT NULL,
  generation integer NOT NULL DEFAULT 1 CHECK (generation > 0),
  reconciliation integer NOT NULL DEFAULT 1 CHECK (reconciliation > 0),
  cursor jsonb NOT NULL,
  lease_token uuid,
  lease_until timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  failure text,
  sync_state text NOT NULL DEFAULT 'queued' CHECK (sync_state IN ('queued','syncing','ready','failed')),
  CHECK ((lease_token IS NULL) = (lease_until IS NULL)),
  CHECK (octet_length(cursor::text) <= 4194304)
);
CREATE TABLE {{schema}}.tf_knowledge_google_members (
  source_id uuid NOT NULL REFERENCES {{schema}}.tf_knowledge_google_sources(source_id),
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  PRIMARY KEY (source_id,membership_id)
);
CREATE TABLE {{schema}}.tf_knowledge_google_items (
  source_id uuid NOT NULL REFERENCES {{schema}}.tf_knowledge_google_sources(source_id),
  native_id text NOT NULL,
  document_id uuid,
  source_revision text NOT NULL,
  seen_generation integer NOT NULL,
  failure text,
  PRIMARY KEY (source_id,native_id)
);
CREATE TABLE {{schema}}.tf_knowledge_google_originals (
  revision_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_knowledge_revisions(id),
  bytes bytea NOT NULL CHECK (octet_length(bytes) BETWEEN 1 AND 10485760),
  filename text NOT NULL CHECK (char_length(filename) BETWEEN 1 AND 2048),
  media_type text NOT NULL,
  normalized_content text CHECK (octet_length(normalized_content) <= 10485760)
);
CREATE TABLE {{schema}}.tf_knowledge_google_proof_bindings (
  document_id uuid NOT NULL REFERENCES {{schema}}.tf_knowledge_documents(id),
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  binding jsonb NOT NULL,
  PRIMARY KEY (document_id,membership_id)
);
CREATE TABLE {{schema}}.tf_knowledge_google_proof_fences (
  document_id uuid NOT NULL REFERENCES {{schema}}.tf_knowledge_documents(id),
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
  observed_at timestamptz,
  PRIMARY KEY (document_id,membership_id)
);
CREATE TABLE {{schema}}.tf_knowledge_google_commands (
  command_id uuid PRIMARY KEY,
  source_id uuid NOT NULL REFERENCES {{schema}}.tf_knowledge_google_sources(source_id),
  fingerprint text NOT NULL
);
CREATE TABLE {{schema}}.tf_knowledge_google_refresh (
  source_id uuid NOT NULL REFERENCES {{schema}}.tf_knowledge_google_sources(source_id),
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  after_id uuid,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (source_id,membership_id)
);
CREATE VIEW {{schema}}.tf_knowledge_google_readers WITH (security_invoker=true) AS
SELECT s.id AS source_id,m.id AS membership_id,m.user_id,g.binding AS manager_binding,g.selection,
  c.id AS connection_id,c.account_id,c.generation,c.scopes
FROM {{schema}}.tf_knowledge_sources s
JOIN {{schema}}.tf_knowledge_google_sources g ON g.source_id=s.id
JOIN {{schema}}.tf_knowledge_google_members a ON a.source_id=s.id
JOIN {{schema}}.tf_memberships m ON m.id=a.membership_id AND m.removed_at IS NULL
JOIN {{schema}}.tf_memberships owner ON owner.id=s.owner_membership_id AND owner.removed_at IS NULL
JOIN {{schema}}.tf_google_connections manager ON manager.membership_id=owner.id AND manager.user_id=owner.user_id
JOIN {{schema}}.tf_google_connections c ON c.membership_id=m.id AND c.user_id=m.user_id
WHERE s.provider='google' AND s.state IN ('active','paused')
  AND s.account_namespace=g.binding->>'accountId' AND s.selection=g.selection::text
  AND (g.selection->>'kind'<>'gmail' OR m.id=owner.id)
  AND manager.status='connected' AND manager.id::text=g.binding->>'connectionId'
  AND manager.account_id=g.binding->>'accountId' AND manager.generation=(g.binding->>'generation')::int
  AND manager.scopes @> ARRAY(SELECT jsonb_array_elements_text(g.binding->'requiredScopes'))
  AND c.status='connected' AND CASE WHEN g.selection->>'kind'='gmail'
    THEN c.scopes && ARRAY['https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/gmail.modify','https://mail.google.com/']
    ELSE c.scopes && ARRAY['https://www.googleapis.com/auth/drive.readonly','https://www.googleapis.com/auth/drive'] END;
CREATE VIEW {{schema}}.tf_knowledge_google_eligible WITH (security_invoker=true) AS
SELECT d.id AS document_id,a.membership_id,a.user_id,p.expires_at
FROM {{schema}}.tf_knowledge_documents d
JOIN {{schema}}.tf_knowledge_sources s ON s.id=d.source_id
JOIN {{schema}}.tf_knowledge_revisions r ON r.id=d.observed_revision_id
JOIN {{schema}}.tf_knowledge_google_readers a ON a.source_id=s.id
JOIN {{schema}}.tf_knowledge_access_proofs p ON p.document_id=d.id AND p.membership_id=a.membership_id AND p.access_epoch=s.access_epoch
JOIN {{schema}}.tf_knowledge_google_proof_bindings b ON b.document_id=d.id AND b.membership_id=a.membership_id
WHERE d.tombstoned_at IS NULL AND p.expires_at>clock_timestamp()
  AND p.acl_version=r.source_revision
  AND p.acl_checked_at<=clock_timestamp() AND p.membership_checked_at<=clock_timestamp()
  AND a.connection_id::text=b.binding->>'connectionId' AND a.account_id=b.binding->>'accountId'
  AND a.generation=(b.binding->>'generation')::int
  AND a.scopes @> ARRAY(SELECT jsonb_array_elements_text(b.binding->'requiredScopes'));
REVOKE ALL ON {{schema}}.tf_knowledge_google_sources,{{schema}}.tf_knowledge_google_members,
  {{schema}}.tf_knowledge_google_items,{{schema}}.tf_knowledge_google_originals,
  {{schema}}.tf_knowledge_google_proof_bindings,{{schema}}.tf_knowledge_google_proof_fences,{{schema}}.tf_knowledge_google_commands,
  {{schema}}.tf_knowledge_google_readers,{{schema}}.tf_knowledge_google_eligible,{{schema}}.tf_knowledge_google_refresh FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON {{schema}}.tf_knowledge_google_sources,{{schema}}.tf_knowledge_google_items,
  {{schema}}.tf_knowledge_google_proof_bindings,{{schema}}.tf_knowledge_google_proof_fences,{{schema}}.tf_knowledge_google_refresh TO {{runtime}};
GRANT DELETE ON {{schema}}.tf_knowledge_access_proofs TO {{runtime}};
GRANT SELECT,INSERT ON {{schema}}.tf_knowledge_google_members,{{schema}}.tf_knowledge_google_originals,
  {{schema}}.tf_knowledge_google_commands TO {{runtime}};
GRANT SELECT ON {{schema}}.tf_knowledge_google_readers,{{schema}}.tf_knowledge_google_eligible TO {{runtime}};
CREATE INDEX tf_knowledge_google_due ON {{schema}}.tf_knowledge_google_sources(next_attempt_at);

-- Resource execution runs as the workspace owner role and rechecks MCP provenance
-- (packages/access/src/mcp-provenance.ts) before publishing. Grant exactly the
-- columns that source closure reads. The closure requires table-level SELECT on
-- tf_conversation_results because it checks has_table_privilege before reading.
GRANT SELECT(conversation_id) ON {{schema}}.tf_conversation_turns TO {{migration}},{{customOwner}};
GRANT SELECT(turn_id,sources) ON {{schema}}.tf_conversation_model_sources TO {{migration}},{{customOwner}};
GRANT SELECT(turn_id,sources,output) ON {{schema}}.tf_conversation_execution_steps TO {{migration}},{{customOwner}};
GRANT SELECT ON {{schema}}.tf_conversation_results TO {{migration}},{{customOwner}};
GRANT SELECT(id,conversation_id,message_id,state) ON {{schema}}.tf_conversation_attachments TO {{migration}},{{customOwner}};
GRANT SELECT(conversation_id,message_id,attachment_id) ON {{schema}}.tf_conversation_parts TO {{migration}},{{customOwner}};
GRANT SELECT(id,connection_id,authorization_epoch,sources,origin) ON {{schema}}.tf_mcp_actions TO {{migration}},{{customOwner}};
GRANT SELECT(action_id,sources) ON {{schema}}.tf_mcp_receipts TO {{migration}},{{customOwner}};
GRANT SELECT(skill_id,revision,definition) ON {{schema}}.tf_workspace_skill_revisions TO {{migration}},{{customOwner}};
GRANT SELECT(id,sources,proposal) ON {{schema}}.tf_chat_authoring_drafts TO {{migration}},{{customOwner}};
GRANT SELECT(draft_id,outcome) ON {{schema}}.tf_chat_authoring_decisions TO {{migration}},{{customOwner}};
GRANT SELECT(agent_id,revision,definition) ON {{schema}}.tf_agent_definitions TO {{migration}},{{customOwner}};
GRANT SELECT(agent_id,definition_revision,soul_revision) ON {{schema}}.tf_agent_saved_revisions TO {{migration}},{{customOwner}};
GRANT SELECT(id,agent_id,accepted_revision) ON {{schema}}.tf_agent_commands TO {{migration}},{{customOwner}};
GRANT SELECT(id,agent_id,definition_revision,skills) ON {{schema}}.tf_agent_tasks TO {{migration}},{{customOwner}};
GRANT SELECT(task_id,sequence,sources) ON {{schema}}.tf_agent_task_messages TO {{migration}},{{customOwner}};
GRANT SELECT(task_id,mcp_sources,source_tables) ON {{schema}}.tf_agent_task_steps TO {{migration}},{{customOwner}};
GRANT SELECT(run_id,call,result) ON {{schema}}.tf_agent_tool_calls TO {{migration}},{{customOwner}};
GRANT SELECT(run_id,task_id,generation) ON {{schema}}.tf_agent_task_runs TO {{migration}},{{customOwner}};
GRANT SELECT(task_id,task_generation,context_start) ON {{schema}}.tf_github_task_selection TO {{migration}},{{customOwner}};

CREATE TABLE {{schema}}.tf_knowledge_slack_sources (
  source_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_knowledge_sources(id),
  binding jsonb NOT NULL,
  selection jsonb NOT NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 2048),
  fingerprint text NOT NULL,
  generation integer NOT NULL DEFAULT 1 CHECK (generation > 0),
  reconciliation integer NOT NULL DEFAULT 1 CHECK (reconciliation > 0),
  cursor jsonb NOT NULL,
  lease_token uuid,
  lease_until timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  failure text,
  sync_state text NOT NULL DEFAULT 'queued' CHECK (sync_state IN ('queued','syncing','ready','failed')),
  CHECK ((lease_token IS NULL) = (lease_until IS NULL)),
  CHECK (octet_length(cursor::text) <= 65536)
);
CREATE TABLE {{schema}}.tf_knowledge_slack_members (
  source_id uuid NOT NULL REFERENCES {{schema}}.tf_knowledge_slack_sources(source_id),
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  PRIMARY KEY (source_id,membership_id)
);
CREATE TABLE {{schema}}.tf_knowledge_slack_conversations (
  source_id uuid NOT NULL REFERENCES {{schema}}.tf_knowledge_slack_sources(source_id),
  conversation_id text NOT NULL CHECK (conversation_id ~ '^[CDG][A-Z0-9]{2,63}$'),
  kind text NOT NULL CHECK (kind IN ('public','private','im','mpim')),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 512),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','unavailable')),
  failure text CHECK (char_length(failure) <= 128),
  PRIMARY KEY (source_id,conversation_id),
  CHECK ((state='active') = (failure IS NULL))
);
CREATE TABLE {{schema}}.tf_knowledge_slack_items (
  source_id uuid NOT NULL,
  native_id text NOT NULL CHECK (char_length(native_id) <= 128),
  conversation_id text NOT NULL,
  document_id uuid REFERENCES {{schema}}.tf_knowledge_documents(id),
  source_revision text NOT NULL,
  seen_generation integer NOT NULL,
  failure text,
  PRIMARY KEY (source_id,native_id),
  FOREIGN KEY (source_id,conversation_id) REFERENCES {{schema}}.tf_knowledge_slack_conversations(source_id,conversation_id)
);
CREATE INDEX tf_knowledge_slack_items_document ON {{schema}}.tf_knowledge_slack_items(document_id);
CREATE INDEX tf_knowledge_slack_items_conversation ON {{schema}}.tf_knowledge_slack_items(source_id,conversation_id);
CREATE TABLE {{schema}}.tf_knowledge_slack_originals (
  revision_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_knowledge_revisions(id),
  markdown text NOT NULL CHECK (octet_length(markdown) BETWEEN 1 AND 1048576)
);
CREATE TABLE {{schema}}.tf_knowledge_slack_access (
  source_id uuid NOT NULL,
  conversation_id text NOT NULL,
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  binding jsonb,
  generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
  observed_at timestamptz,
  expires_at timestamptz,
  PRIMARY KEY (source_id,conversation_id,membership_id),
  FOREIGN KEY (source_id,conversation_id) REFERENCES {{schema}}.tf_knowledge_slack_conversations(source_id,conversation_id),
  CHECK ((observed_at IS NULL) = (expires_at IS NULL) AND (observed_at IS NULL) = (binding IS NULL)),
  CHECK (expires_at IS NULL OR (expires_at > observed_at AND expires_at <= observed_at + interval '5 minutes'))
);
CREATE TABLE {{schema}}.tf_knowledge_slack_commands (
  command_id uuid PRIMARY KEY,
  source_id uuid NOT NULL REFERENCES {{schema}}.tf_knowledge_slack_sources(source_id),
  fingerprint text NOT NULL
);
CREATE VIEW {{schema}}.tf_knowledge_slack_readers WITH (security_invoker=true) AS
SELECT s.id AS source_id,m.id AS membership_id,m.user_id,g.selection,
  p.id AS identity_id,p.installation_id,p.generation AS installation_generation,p.slack_user_id,p.scopes,
  COALESCE(floor(extract(epoch FROM p.authorized_at)*1000000)::bigint,0)::text AS authorization_version
FROM {{schema}}.tf_knowledge_sources s
JOIN {{schema}}.tf_knowledge_slack_sources g ON g.source_id=s.id
JOIN {{schema}}.tf_knowledge_slack_members a ON a.source_id=s.id
JOIN {{schema}}.tf_memberships m ON m.id=a.membership_id AND m.removed_at IS NULL
JOIN {{schema}}.tf_memberships owner ON owner.id=s.owner_membership_id AND owner.removed_at IS NULL
JOIN {{schema}}.tf_slack_installations i ON i.id::text=g.binding->>'installationId'
  AND i.generation=(g.binding->>'installationGeneration')::int AND i.state='active' AND i.team_id=s.account_namespace
JOIN {{schema}}.tf_slack_identities manager ON manager.id::text=g.binding->>'identityId'
  AND manager.installation_id=i.id AND manager.generation=i.generation AND manager.state='authorized'
  AND manager.membership_id=owner.id AND manager.user_id=owner.user_id AND manager.slack_user_id=g.binding->>'slackUserId'
JOIN {{schema}}.tf_slack_identities p ON p.installation_id=i.id AND p.generation=i.generation
  AND p.membership_id=m.id AND p.user_id=m.user_id AND p.state='authorized'
WHERE s.provider='slack' AND s.state IN ('active','paused') AND s.selection=g.selection::text
  AND (g.selection->>'kind'<>'personal' OR m.id=owner.id)
  AND NOT EXISTS (SELECT 1 FROM {{schema}}.tf_slack_user_revocations v
    WHERE v.installation_id=i.id AND v.generation=i.generation AND v.slack_user_id IN (p.slack_user_id,manager.slack_user_id));
-- Reader authority is evaluated once per conversation access row by a cached-plan function, keeping search planning small.
CREATE FUNCTION {{schema}}.tf_knowledge_slack_reader(source uuid,membership uuid,binding jsonb,kind text) RETURNS text
LANGUAGE plpgsql STABLE SET search_path=pg_catalog SET plan_cache_mode=force_generic_plan AS $$
BEGIN
  RETURN (SELECT r.user_id FROM {{schema}}.tf_knowledge_slack_readers r
    WHERE r.source_id=source AND r.membership_id=membership
      AND r.identity_id::text=binding->>'identityId' AND r.installation_generation::text=binding->>'installationGeneration'
      AND r.authorization_version=binding->>'authorizationVersion' AND r.slack_user_id=binding->>'slackUserId'
      AND r.scopes @> CASE kind WHEN 'public' THEN ARRAY['channels:history','channels:read'] WHEN 'private' THEN ARRAY['groups:history','groups:read']
        WHEN 'im' THEN ARRAY['im:history','im:read'] ELSE ARRAY['mpim:history','mpim:read'] END);
END $$;
CREATE VIEW {{schema}}.tf_knowledge_slack_eligible WITH (security_invoker=true) AS
SELECT d.id AS document_id,x.membership_id,x.user_id,LEAST(p.expires_at,x.expires_at) AS expires_at,
  d.source_id,d.observed_revision_id AS revision_id,d.lexical_publication_id AS publication_id,d.vector_publication_id,s.access_epoch,s.provider
FROM (SELECT a.source_id,a.conversation_id,a.membership_id,a.binding,a.expires_at,
    {{schema}}.tf_knowledge_slack_reader(a.source_id,a.membership_id,a.binding,c.kind) AS user_id
  FROM {{schema}}.tf_knowledge_slack_access a
  JOIN {{schema}}.tf_knowledge_slack_conversations c ON c.source_id=a.source_id AND c.conversation_id=a.conversation_id AND c.state='active'
  WHERE a.expires_at>clock_timestamp() AND a.observed_at<=clock_timestamp()) x
JOIN {{schema}}.tf_knowledge_slack_items i ON i.source_id=x.source_id AND i.conversation_id=x.conversation_id
JOIN {{schema}}.tf_knowledge_documents d ON d.id=i.document_id AND d.source_id=x.source_id AND d.tombstoned_at IS NULL
JOIN {{schema}}.tf_knowledge_sources s ON s.id=d.source_id AND s.provider='slack'
JOIN {{schema}}.tf_knowledge_revisions r ON r.id=d.observed_revision_id
JOIN {{schema}}.tf_knowledge_access_proofs p ON p.document_id=d.id AND p.membership_id=x.membership_id AND p.access_epoch=s.access_epoch
WHERE x.user_id IS NOT NULL AND p.expires_at>clock_timestamp() AND r.document_id=d.id AND r.sources='[]'::jsonb
  AND r.original->>'kind'='object' AND r.original->>'key'=r.id::text
  AND p.acl_version=r.source_revision AND p.principal=x.binding->>'slackUserId'
  AND p.acl_checked_at<=clock_timestamp() AND p.membership_checked_at<=clock_timestamp();
CREATE FUNCTION {{schema}}.tf_knowledge_slack_eligible_for(membership uuid,actor text)
RETURNS TABLE (document_id uuid,source_id uuid,revision_id uuid,publication_id uuid,vector_publication_id uuid,access_epoch integer,expires_at timestamptz,provider text)
LANGUAGE plpgsql STABLE SET search_path=pg_catalog SET plan_cache_mode=force_generic_plan AS $$
BEGIN
  RETURN QUERY SELECT e.document_id,e.source_id,e.revision_id,e.publication_id,e.vector_publication_id,e.access_epoch,e.expires_at,e.provider
    FROM {{schema}}.tf_knowledge_slack_eligible e WHERE e.membership_id=membership AND e.user_id=actor;
END $$;
REVOKE ALL ON {{schema}}.tf_knowledge_slack_sources,{{schema}}.tf_knowledge_slack_members,{{schema}}.tf_knowledge_slack_conversations,
  {{schema}}.tf_knowledge_slack_items,{{schema}}.tf_knowledge_slack_originals,{{schema}}.tf_knowledge_slack_access,
  {{schema}}.tf_knowledge_slack_commands,{{schema}}.tf_knowledge_slack_readers,{{schema}}.tf_knowledge_slack_eligible FROM PUBLIC;
REVOKE ALL ON FUNCTION {{schema}}.tf_knowledge_slack_reader(uuid,uuid,jsonb,text),{{schema}}.tf_knowledge_slack_eligible_for(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION {{schema}}.tf_knowledge_slack_reader(uuid,uuid,jsonb,text),{{schema}}.tf_knowledge_slack_eligible_for(uuid,text) TO {{runtime}};
GRANT SELECT,INSERT,UPDATE ON {{schema}}.tf_knowledge_slack_sources,{{schema}}.tf_knowledge_slack_conversations,
  {{schema}}.tf_knowledge_slack_items,{{schema}}.tf_knowledge_slack_access TO {{runtime}};
GRANT SELECT,INSERT ON {{schema}}.tf_knowledge_slack_members,{{schema}}.tf_knowledge_slack_originals,
  {{schema}}.tf_knowledge_slack_commands TO {{runtime}};
GRANT SELECT ON {{schema}}.tf_knowledge_slack_readers,{{schema}}.tf_knowledge_slack_eligible TO {{runtime}};
CREATE INDEX tf_knowledge_slack_due ON {{schema}}.tf_knowledge_slack_sources(next_attempt_at);

CREATE TABLE {{schema}}.tf_knowledge_github_sources (
  source_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_knowledge_sources(id),
  binding jsonb NOT NULL,
  selection jsonb NOT NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 2048),
  fingerprint text NOT NULL,
  generation integer NOT NULL DEFAULT 1 CHECK (generation > 0),
  reconciliation integer NOT NULL DEFAULT 1 CHECK (reconciliation > 0),
  cursor jsonb NOT NULL,
  lease_token uuid,
  lease_until timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  failure text,
  sync_state text NOT NULL DEFAULT 'queued' CHECK (sync_state IN ('queued','syncing','ready','failed')),
  CHECK ((lease_token IS NULL) = (lease_until IS NULL)),
  CHECK (octet_length(cursor::text) <= 65536)
);
CREATE TABLE {{schema}}.tf_knowledge_github_members (
  source_id uuid NOT NULL REFERENCES {{schema}}.tf_knowledge_github_sources(source_id),
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  PRIMARY KEY (source_id,membership_id)
);
CREATE INDEX tf_knowledge_github_members_membership ON {{schema}}.tf_knowledge_github_members(membership_id);
-- Repositories are keyed by GitHub's numeric repository ID, which survives renames and transfers.
CREATE TABLE {{schema}}.tf_knowledge_github_repositories (
  source_id uuid NOT NULL REFERENCES {{schema}}.tf_knowledge_github_sources(source_id),
  repository_id text NOT NULL CHECK (repository_id ~ '^[1-9][0-9]{0,19}$'),
  full_name text NOT NULL CHECK (char_length(full_name) BETWEEN 3 AND 140),
  visibility text NOT NULL CHECK (visibility IN ('public','private','internal')),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 512),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','unavailable')),
  failure text CHECK (char_length(failure) <= 128),
  PRIMARY KEY (source_id,repository_id),
  CHECK ((state='active') = (failure IS NULL))
);
CREATE TABLE {{schema}}.tf_knowledge_github_items (
  source_id uuid NOT NULL,
  native_id text NOT NULL CHECK (char_length(native_id) <= 1200),
  repository_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('doc','issue','pull','discussion')),
  document_id uuid REFERENCES {{schema}}.tf_knowledge_documents(id),
  source_revision text NOT NULL,
  seen_generation integer NOT NULL,
  failure text,
  PRIMARY KEY (source_id,native_id),
  FOREIGN KEY (source_id,repository_id) REFERENCES {{schema}}.tf_knowledge_github_repositories(source_id,repository_id)
);
CREATE INDEX tf_knowledge_github_items_document ON {{schema}}.tf_knowledge_github_items(document_id);
CREATE INDEX tf_knowledge_github_items_repository ON {{schema}}.tf_knowledge_github_items(source_id,repository_id);
CREATE TABLE {{schema}}.tf_knowledge_github_originals (
  revision_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_knowledge_revisions(id),
  markdown text NOT NULL CHECK (octet_length(markdown) BETWEEN 1 AND 1048576)
);
CREATE TABLE {{schema}}.tf_knowledge_github_access (
  source_id uuid NOT NULL,
  repository_id text NOT NULL,
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  binding jsonb,
  generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
  observed_at timestamptz,
  expires_at timestamptz,
  PRIMARY KEY (source_id,repository_id,membership_id),
  FOREIGN KEY (source_id,repository_id) REFERENCES {{schema}}.tf_knowledge_github_repositories(source_id,repository_id),
  CHECK ((observed_at IS NULL) = (expires_at IS NULL) AND (observed_at IS NULL) = (binding IS NULL)),
  CHECK (expires_at IS NULL OR (expires_at > observed_at AND expires_at <= observed_at + interval '5 minutes'))
);
CREATE TABLE {{schema}}.tf_knowledge_github_commands (
  command_id uuid PRIMARY KEY,
  source_id uuid NOT NULL REFERENCES {{schema}}.tf_knowledge_github_sources(source_id),
  fingerprint text NOT NULL
);
-- One row per selected reader and each of that reader's own active personal GitHub accounts.
-- The owner's bound account must also remain active at the bound generation.
CREATE VIEW {{schema}}.tf_knowledge_github_readers WITH (security_invoker=true) AS
SELECT s.id AS source_id,m.id AS membership_id,m.user_id,g.selection,
  a.id AS account_id,a.generation AS account_generation,a.identity->>'id' AS github_user_id,a.identity->>'login' AS login,a.scopes,a.created_at
FROM {{schema}}.tf_knowledge_sources s
JOIN {{schema}}.tf_knowledge_github_sources g ON g.source_id=s.id
JOIN {{schema}}.tf_knowledge_github_members gm ON gm.source_id=s.id
JOIN {{schema}}.tf_memberships m ON m.id=gm.membership_id AND m.removed_at IS NULL
JOIN {{schema}}.tf_memberships owner ON owner.id=s.owner_membership_id AND owner.removed_at IS NULL
JOIN {{schema}}.tf_github_accounts manager ON manager.id::text=g.binding->>'accountId'
  AND manager.generation=(g.binding->>'accountGeneration')::int AND manager.state='active' AND manager.owner_membership_id=owner.id
  AND manager.identity->>'id'=g.binding->>'githubUserId' AND (manager.expires_at IS NULL OR manager.expires_at>clock_timestamp())
JOIN {{schema}}.tf_github_accounts a ON a.owner_membership_id=m.id AND a.state='active' AND a.identity IS NOT NULL AND a.credential IS NOT NULL
  AND (a.expires_at IS NULL OR a.expires_at>clock_timestamp())
WHERE s.provider='github' AND s.state IN ('active','paused') AND s.selection=g.selection::text;
-- Reader authority is evaluated once per repository access row by a cached-plan function, keeping search planning small.
CREATE FUNCTION {{schema}}.tf_knowledge_github_reader(source uuid,membership uuid,binding jsonb) RETURNS text
LANGUAGE plpgsql STABLE SET search_path=pg_catalog SET plan_cache_mode=force_generic_plan AS $$
BEGIN
  RETURN (SELECT r.user_id FROM {{schema}}.tf_knowledge_github_readers r
    WHERE r.source_id=source AND r.membership_id=membership
      AND r.account_id::text=binding->>'accountId' AND r.account_generation::text=binding->>'accountGeneration'
      AND r.github_user_id=binding->>'githubUserId' LIMIT 1);
END $$;
CREATE VIEW {{schema}}.tf_knowledge_github_eligible WITH (security_invoker=true) AS
SELECT d.id AS document_id,x.membership_id,x.user_id,LEAST(p.expires_at,x.expires_at) AS expires_at,
  d.source_id,d.observed_revision_id AS revision_id,d.lexical_publication_id AS publication_id,d.vector_publication_id,s.access_epoch,s.provider
FROM (SELECT a.source_id,a.repository_id,a.membership_id,a.binding,a.expires_at,
    {{schema}}.tf_knowledge_github_reader(a.source_id,a.membership_id,a.binding) AS user_id
  FROM {{schema}}.tf_knowledge_github_access a
  JOIN {{schema}}.tf_knowledge_github_repositories c ON c.source_id=a.source_id AND c.repository_id=a.repository_id AND c.state='active'
  WHERE a.expires_at>clock_timestamp() AND a.observed_at<=clock_timestamp()) x
JOIN {{schema}}.tf_knowledge_github_items i ON i.source_id=x.source_id AND i.repository_id=x.repository_id
JOIN {{schema}}.tf_knowledge_documents d ON d.id=i.document_id AND d.source_id=x.source_id AND d.tombstoned_at IS NULL
JOIN {{schema}}.tf_knowledge_sources s ON s.id=d.source_id AND s.provider='github'
JOIN {{schema}}.tf_knowledge_revisions r ON r.id=d.observed_revision_id
JOIN {{schema}}.tf_knowledge_access_proofs p ON p.document_id=d.id AND p.membership_id=x.membership_id AND p.access_epoch=s.access_epoch
WHERE x.user_id IS NOT NULL AND p.expires_at>clock_timestamp() AND r.document_id=d.id AND r.sources='[]'::jsonb
  AND r.original->>'kind'='object' AND r.original->>'key'=r.id::text
  AND p.acl_version=r.source_revision AND p.principal=x.binding->>'githubUserId'
  AND p.acl_checked_at<=clock_timestamp() AND p.membership_checked_at<=clock_timestamp();
CREATE FUNCTION {{schema}}.tf_knowledge_github_eligible_for(membership uuid,actor text)
RETURNS TABLE (document_id uuid,source_id uuid,revision_id uuid,publication_id uuid,vector_publication_id uuid,access_epoch integer,expires_at timestamptz,provider text)
LANGUAGE plpgsql STABLE SET search_path=pg_catalog SET plan_cache_mode=force_generic_plan AS $$
BEGIN
  RETURN QUERY SELECT e.document_id,e.source_id,e.revision_id,e.publication_id,e.vector_publication_id,e.access_epoch,e.expires_at,e.provider
    FROM {{schema}}.tf_knowledge_github_eligible e WHERE e.membership_id=membership AND e.user_id=actor;
END $$;
REVOKE ALL ON {{schema}}.tf_knowledge_github_sources,{{schema}}.tf_knowledge_github_members,{{schema}}.tf_knowledge_github_repositories,
  {{schema}}.tf_knowledge_github_items,{{schema}}.tf_knowledge_github_originals,{{schema}}.tf_knowledge_github_access,
  {{schema}}.tf_knowledge_github_commands,{{schema}}.tf_knowledge_github_readers,{{schema}}.tf_knowledge_github_eligible FROM PUBLIC;
REVOKE ALL ON FUNCTION {{schema}}.tf_knowledge_github_reader(uuid,uuid,jsonb),{{schema}}.tf_knowledge_github_eligible_for(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION {{schema}}.tf_knowledge_github_reader(uuid,uuid,jsonb),{{schema}}.tf_knowledge_github_eligible_for(uuid,text) TO {{runtime}};
GRANT SELECT,INSERT,UPDATE ON {{schema}}.tf_knowledge_github_sources,{{schema}}.tf_knowledge_github_repositories,
  {{schema}}.tf_knowledge_github_items,{{schema}}.tf_knowledge_github_access TO {{runtime}};
GRANT SELECT,INSERT ON {{schema}}.tf_knowledge_github_members,{{schema}}.tf_knowledge_github_originals,
  {{schema}}.tf_knowledge_github_commands TO {{runtime}};
GRANT SELECT ON {{schema}}.tf_knowledge_github_readers,{{schema}}.tf_knowledge_github_eligible TO {{runtime}};
CREATE INDEX tf_knowledge_github_due ON {{schema}}.tf_knowledge_github_sources(next_attempt_at);

CREATE TABLE {{schema}}.tf_knowledge_atlassian_sources (
  source_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_knowledge_sources(id),
  product text NOT NULL CHECK (product IN ('confluence','jira')),
  binding jsonb NOT NULL,
  selection jsonb NOT NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 2048),
  fingerprint text NOT NULL,
  generation integer NOT NULL DEFAULT 1 CHECK (generation > 0),
  reconciliation integer NOT NULL DEFAULT 1 CHECK (reconciliation > 0),
  cursor jsonb NOT NULL,
  lease_token uuid,
  lease_until timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  failure text,
  sync_state text NOT NULL DEFAULT 'queued' CHECK (sync_state IN ('queued','syncing','ready','failed')),
  CHECK ((lease_token IS NULL) = (lease_until IS NULL)),
  CHECK (octet_length(cursor::text) <= 65536)
);
CREATE TABLE {{schema}}.tf_knowledge_atlassian_members (
  source_id uuid NOT NULL REFERENCES {{schema}}.tf_knowledge_atlassian_sources(source_id),
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  PRIMARY KEY (source_id,membership_id)
);
-- A target is one selected space, page subtree or project.
CREATE TABLE {{schema}}.tf_knowledge_atlassian_targets (
  source_id uuid NOT NULL REFERENCES {{schema}}.tf_knowledge_atlassian_sources(source_id),
  target_id text NOT NULL CHECK (target_id ~ '^(space|page|project):[1-9][0-9]{0,30}$'),
  kind text NOT NULL CHECK (kind IN ('space','page','project')),
  key text CHECK (char_length(key) <= 255),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 512),
  descendants boolean NOT NULL DEFAULT false,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','unavailable')),
  failure text CHECK (char_length(failure) <= 128),
  PRIMARY KEY (source_id,target_id),
  CHECK ((state='active') = (failure IS NULL)),
  CHECK (split_part(target_id,':',1) = kind)
);
CREATE TABLE {{schema}}.tf_knowledge_atlassian_items (
  source_id uuid NOT NULL,
  native_id text NOT NULL CHECK (native_id ~ '^(page|issue):[1-9][0-9]{0,30}$'),
  target_id text NOT NULL,
  document_id uuid REFERENCES {{schema}}.tf_knowledge_documents(id),
  source_revision text NOT NULL CHECK (char_length(source_revision) BETWEEN 1 AND 128),
  seen_generation integer NOT NULL,
  failure text CHECK (char_length(failure) <= 128),
  PRIMARY KEY (source_id,native_id),
  FOREIGN KEY (source_id,target_id) REFERENCES {{schema}}.tf_knowledge_atlassian_targets(source_id,target_id)
);
CREATE INDEX tf_knowledge_atlassian_items_document ON {{schema}}.tf_knowledge_atlassian_items(document_id);
CREATE INDEX tf_knowledge_atlassian_items_target ON {{schema}}.tf_knowledge_atlassian_items(source_id,target_id);
CREATE TABLE {{schema}}.tf_knowledge_atlassian_originals (
  revision_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_knowledge_revisions(id),
  markdown text NOT NULL CHECK (octet_length(markdown) BETWEEN 1 AND 1048576)
);
-- One authoritative per-item check made with the reader's own Atlassian account. Expiry is at most five minutes after the observation.
CREATE TABLE {{schema}}.tf_knowledge_atlassian_access (
  source_id uuid NOT NULL,
  native_id text NOT NULL,
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  binding jsonb,
  generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
  observed_at timestamptz,
  expires_at timestamptz,
  PRIMARY KEY (source_id,native_id,membership_id),
  FOREIGN KEY (source_id,native_id) REFERENCES {{schema}}.tf_knowledge_atlassian_items(source_id,native_id),
  CHECK ((observed_at IS NULL) = (expires_at IS NULL) AND (observed_at IS NULL) = (binding IS NULL)),
  CHECK (expires_at IS NULL OR (expires_at > observed_at AND expires_at <= observed_at + interval '5 minutes'))
);
CREATE INDEX tf_knowledge_atlassian_access_member ON {{schema}}.tf_knowledge_atlassian_access(membership_id,source_id,expires_at);
CREATE TABLE {{schema}}.tf_knowledge_atlassian_commands (
  command_id uuid PRIMARY KEY,
  source_id uuid NOT NULL REFERENCES {{schema}}.tf_knowledge_atlassian_sources(source_id),
  fingerprint text NOT NULL
);
-- Reader authority: current membership, selected audience, the active owner account, and the reader's own active personal
-- REST account with a verified Atlassian identity on the source's site.
CREATE VIEW {{schema}}.tf_knowledge_atlassian_readers WITH (security_invoker=true) AS
SELECT s.id AS source_id,m.id AS membership_id,m.user_id,g.product,
  a.id AS account_id,a.generation AS account_generation,a.identity->>'id' AS atlassian_account_id,a.scopes
FROM {{schema}}.tf_knowledge_sources s
JOIN {{schema}}.tf_knowledge_atlassian_sources g ON g.source_id=s.id
JOIN {{schema}}.tf_knowledge_atlassian_members x ON x.source_id=s.id
JOIN {{schema}}.tf_memberships m ON m.id=x.membership_id AND m.removed_at IS NULL
JOIN {{schema}}.tf_memberships owner ON owner.id=s.owner_membership_id AND owner.removed_at IS NULL
JOIN {{schema}}.tf_atlassian_accounts manager ON manager.id::text=g.binding->>'accountId'
  AND manager.protocol='atlassian-rest' AND manager.ownership='personal' AND manager.owner_membership_id=owner.id
  AND manager.state IN ('active','refreshing') AND manager.identity->>'qualification'='verified'
  AND manager.identity->>'id'=g.binding->>'atlassianAccountId'
  AND manager.resources @> jsonb_build_array(jsonb_build_object('id',g.binding->>'cloudId'))
JOIN {{schema}}.tf_atlassian_accounts a ON a.protocol='atlassian-rest' AND a.ownership='personal' AND a.owner_membership_id=m.id
  AND a.state IN ('active','refreshing') AND a.identity->>'qualification'='verified'
  AND a.resources @> jsonb_build_array(jsonb_build_object('id',g.binding->>'cloudId'))
WHERE s.provider=g.product AND s.state IN ('active','paused') AND s.selection=g.selection::text AND s.account_namespace=g.binding->>'cloudId';
-- Reader authority is evaluated once per access row by a cached-plan function, keeping search planning small.
CREATE FUNCTION {{schema}}.tf_knowledge_atlassian_reader(source uuid,membership uuid,binding jsonb,source_product text) RETURNS text
LANGUAGE plpgsql STABLE SET search_path=pg_catalog SET plan_cache_mode=force_generic_plan AS $$
BEGIN
  RETURN (SELECT r.user_id FROM {{schema}}.tf_knowledge_atlassian_readers r
    WHERE r.source_id=source AND r.membership_id=membership
      AND r.account_id::text=binding->>'accountId' AND r.account_generation::text=binding->>'accountGeneration'
      AND r.atlassian_account_id=binding->>'atlassianAccountId'
      AND r.scopes @> CASE source_product WHEN 'confluence' THEN ARRAY['read:page:confluence'] ELSE ARRAY['read:jira-work'] END
    LIMIT 1);
END $$;
CREATE VIEW {{schema}}.tf_knowledge_atlassian_eligible WITH (security_invoker=true) AS
SELECT d.id AS document_id,x.membership_id,x.user_id,LEAST(p.expires_at,x.expires_at) AS expires_at,
  d.source_id,d.observed_revision_id AS revision_id,d.lexical_publication_id AS publication_id,d.vector_publication_id,s.access_epoch,s.provider
FROM (SELECT a.source_id,a.native_id,a.membership_id,a.binding,a.expires_at,
    {{schema}}.tf_knowledge_atlassian_reader(a.source_id,a.membership_id,a.binding,g.product) AS user_id
  FROM {{schema}}.tf_knowledge_atlassian_access a
  JOIN {{schema}}.tf_knowledge_atlassian_sources g ON g.source_id=a.source_id
  WHERE a.expires_at>clock_timestamp() AND a.observed_at<=clock_timestamp()) x
JOIN {{schema}}.tf_knowledge_atlassian_items i ON i.source_id=x.source_id AND i.native_id=x.native_id
JOIN {{schema}}.tf_knowledge_atlassian_targets t ON t.source_id=i.source_id AND t.target_id=i.target_id AND t.state='active'
JOIN {{schema}}.tf_knowledge_documents d ON d.id=i.document_id AND d.source_id=x.source_id AND d.tombstoned_at IS NULL
JOIN {{schema}}.tf_knowledge_sources s ON s.id=d.source_id AND s.provider IN ('confluence','jira')
JOIN {{schema}}.tf_knowledge_revisions r ON r.id=d.observed_revision_id
JOIN {{schema}}.tf_knowledge_access_proofs p ON p.document_id=d.id AND p.membership_id=x.membership_id AND p.access_epoch=s.access_epoch
WHERE x.user_id IS NOT NULL AND p.expires_at>clock_timestamp() AND r.document_id=d.id AND r.sources='[]'::jsonb
  AND r.original->>'kind'='object' AND r.original->>'key'=r.id::text
  AND p.acl_version=r.source_revision AND p.principal=x.binding->>'atlassianAccountId'
  AND p.membership_version=x.binding->>'accountGeneration'
  AND p.acl_checked_at<=clock_timestamp() AND p.membership_checked_at<=clock_timestamp();
CREATE FUNCTION {{schema}}.tf_knowledge_atlassian_eligible_for(membership uuid,actor text)
RETURNS TABLE (document_id uuid,source_id uuid,revision_id uuid,publication_id uuid,vector_publication_id uuid,access_epoch integer,expires_at timestamptz,provider text)
LANGUAGE plpgsql STABLE SET search_path=pg_catalog SET plan_cache_mode=force_generic_plan AS $$
BEGIN
  RETURN QUERY SELECT e.document_id,e.source_id,e.revision_id,e.publication_id,e.vector_publication_id,e.access_epoch,e.expires_at,e.provider
    FROM {{schema}}.tf_knowledge_atlassian_eligible e WHERE e.membership_id=membership AND e.user_id=actor;
END $$;
REVOKE ALL ON {{schema}}.tf_knowledge_atlassian_sources,{{schema}}.tf_knowledge_atlassian_members,{{schema}}.tf_knowledge_atlassian_targets,
  {{schema}}.tf_knowledge_atlassian_items,{{schema}}.tf_knowledge_atlassian_originals,{{schema}}.tf_knowledge_atlassian_access,
  {{schema}}.tf_knowledge_atlassian_commands,{{schema}}.tf_knowledge_atlassian_readers,{{schema}}.tf_knowledge_atlassian_eligible FROM PUBLIC;
REVOKE ALL ON FUNCTION {{schema}}.tf_knowledge_atlassian_reader(uuid,uuid,jsonb,text),{{schema}}.tf_knowledge_atlassian_eligible_for(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION {{schema}}.tf_knowledge_atlassian_reader(uuid,uuid,jsonb,text),{{schema}}.tf_knowledge_atlassian_eligible_for(uuid,text) TO {{runtime}};
GRANT SELECT,INSERT,UPDATE ON {{schema}}.tf_knowledge_atlassian_sources,{{schema}}.tf_knowledge_atlassian_targets,
  {{schema}}.tf_knowledge_atlassian_items,{{schema}}.tf_knowledge_atlassian_access TO {{runtime}};
GRANT SELECT,INSERT ON {{schema}}.tf_knowledge_atlassian_members,{{schema}}.tf_knowledge_atlassian_originals,
  {{schema}}.tf_knowledge_atlassian_commands TO {{runtime}};
GRANT SELECT ON {{schema}}.tf_knowledge_atlassian_readers,{{schema}}.tf_knowledge_atlassian_eligible TO {{runtime}};
CREATE INDEX tf_knowledge_atlassian_due ON {{schema}}.tf_knowledge_atlassian_sources(next_attempt_at);

ALTER TABLE {{schema}}.tf_files
  ADD COLUMN deleting_at timestamptz,
  ADD COLUMN deletion_failed_at timestamptz,
  ADD CONSTRAINT tf_files_deletion_check CHECK (deletion_failed_at IS NULL OR deleting_at IS NOT NULL);
CREATE INDEX tf_files_deleting ON {{schema}}.tf_files(deleting_at) WHERE deleting_at IS NOT NULL;

-- Rows from the reserve-first upload path were never verified and never readable. Cleanup removes any partial object and releases their quota.
UPDATE {{schema}}.tf_files SET deleting_at = clock_timestamp(), trashed_at = COALESCE(trashed_at, clock_timestamp()) WHERE NOT ready;

CREATE FUNCTION {{schema}}.tf_files_delete_tombstoned() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF OLD.deleting_at IS NULL THEN
    RAISE EXCEPTION 'Files rows are deleted only after a durable deletion tombstone' USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER tf_files_delete_tombstoned BEFORE DELETE ON {{schema}}.tf_files
  FOR EACH ROW EXECUTE FUNCTION {{schema}}.tf_files_delete_tombstoned();

CREATE TABLE {{schema}}.tf_file_copy_sources (
  file_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_files(id),
  provider text NOT NULL CHECK (provider = 'google-drive'),
  account_id text NOT NULL CHECK (char_length(account_id) BETWEEN 1 AND 512),
  source_file_id text NOT NULL CHECK (char_length(source_file_id) BETWEEN 1 AND 512),
  format text NOT NULL CHECK (char_length(format) BETWEEN 1 AND 64),
  source_version text CHECK (source_version IS NULL OR char_length(source_version) BETWEEN 1 AND 64),
  read_at timestamptz NOT NULL
);

REVOKE ALL ON {{schema}}.tf_file_copy_sources FROM PUBLIC;
REVOKE ALL ON FUNCTION {{schema}}.tf_files_delete_tombstoned() FROM PUBLIC;
GRANT SELECT, INSERT, DELETE ON {{schema}}.tf_file_copy_sources TO {{runtime}};
GRANT UPDATE (deleting_at, deletion_failed_at) ON {{schema}}.tf_files TO {{runtime}};
GRANT DELETE ON {{schema}}.tf_files TO {{runtime}};

ALTER TABLE {{schema}}.tf_conversation_parts
  DROP CONSTRAINT tf_conversation_parts_kind_check,
  ADD COLUMN file_id uuid,
  ADD CONSTRAINT tf_conversation_parts_kind_check CHECK (
    (kind = 'text' AND text IS NOT NULL AND attachment_id IS NULL AND request_id IS NULL AND response_id IS NULL AND approval_id IS NULL AND file_id IS NULL) OR
    (kind = 'attachment' AND text IS NULL AND attachment_id IS NOT NULL AND request_id IS NULL AND response_id IS NULL AND approval_id IS NULL AND file_id IS NULL) OR
    (kind = 'request' AND text IS NULL AND attachment_id IS NULL AND request_id IS NOT NULL AND response_id IS NULL AND approval_id IS NULL AND file_id IS NULL) OR
    (kind = 'response' AND text IS NULL AND attachment_id IS NULL AND request_id IS NULL AND response_id IS NOT NULL AND approval_id IS NULL AND file_id IS NULL) OR
    (kind IN ('approval','approval-resolution') AND text IS NULL AND attachment_id IS NULL AND request_id IS NULL AND response_id IS NULL AND approval_id IS NOT NULL AND file_id IS NULL) OR
    (kind = 'file' AND text IS NULL AND attachment_id IS NULL AND request_id IS NULL AND response_id IS NULL AND approval_id IS NULL AND file_id IS NOT NULL));
CREATE INDEX tf_conversation_parts_file ON {{schema}}.tf_conversation_parts(conversation_id, file_id) WHERE file_id IS NOT NULL;

-- Files listing orders names with COLLATE "und-x-icu". Stop the rollout here, before any query can fail, when this server cannot provide it.
DO $$
DECLARE
  collation_name text := 'und-x-icu';
  database_encoding text := pg_catalog.getdatabaseencoding();
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_collation
    WHERE collname = collation_name AND collprovider = 'i' AND collnamespace = 'pg_catalog'::regnamespace
      AND collencoding IN (-1, pg_catalog.pg_char_to_encoding(database_encoding))
  ) THEN
    RAISE EXCEPTION 'Files requires the ICU collation pg_catalog."%" for database encoding %', collation_name, database_encoding
      USING ERRCODE = '42704', HINT = 'Use a PostgreSQL server built with ICU and a UTF8 database, then retry the rollout.';
  END IF;
  BEGIN
    EXECUTE pg_catalog.format('SELECT %L COLLATE pg_catalog.%I < %L', 'a', collation_name, 'b');
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'Files requires the ICU collation pg_catalog."%" for database encoding %, but it is unusable: %', collation_name, database_encoding, SQLERRM
      USING ERRCODE = '42704', HINT = 'Use a PostgreSQL server built with ICU and a UTF8 database, then retry the rollout.';
  END;
END $$;

ALTER TABLE {{schema}}.tf_conversation_parts
  DROP CONSTRAINT tf_conversation_parts_kind_check,
  ADD COLUMN google_file jsonb,
  ADD CONSTRAINT tf_conversation_parts_kind_check CHECK (
    (kind = 'text' AND text IS NOT NULL AND attachment_id IS NULL AND request_id IS NULL AND response_id IS NULL AND approval_id IS NULL AND file_id IS NULL AND google_file IS NULL) OR
    (kind = 'attachment' AND text IS NULL AND attachment_id IS NOT NULL AND request_id IS NULL AND response_id IS NULL AND approval_id IS NULL AND file_id IS NULL AND google_file IS NULL) OR
    (kind = 'request' AND text IS NULL AND attachment_id IS NULL AND request_id IS NOT NULL AND response_id IS NULL AND approval_id IS NULL AND file_id IS NULL AND google_file IS NULL) OR
    (kind = 'response' AND text IS NULL AND attachment_id IS NULL AND request_id IS NULL AND response_id IS NOT NULL AND approval_id IS NULL AND file_id IS NULL AND google_file IS NULL) OR
    (kind IN ('approval','approval-resolution') AND text IS NULL AND attachment_id IS NULL AND request_id IS NULL AND response_id IS NULL AND approval_id IS NOT NULL AND file_id IS NULL AND google_file IS NULL) OR
    (kind = 'file' AND text IS NULL AND attachment_id IS NULL AND request_id IS NULL AND response_id IS NULL AND approval_id IS NULL AND file_id IS NOT NULL AND google_file IS NULL) OR
    (kind = 'google-file' AND text IS NULL AND attachment_id IS NULL AND request_id IS NULL AND response_id IS NULL AND approval_id IS NULL AND file_id IS NULL
      AND jsonb_typeof(google_file) = 'object' AND google_file ?& ARRAY['fileId','connectionId','accountId','generation','name','mimeType']
      AND octet_length(google_file::text) <= 4096));

-- modified_at records when a file's name or bytes last changed. Moving, sharing, trashing, and restoring leave it alone.
-- Rows that existed before this migration keep NULL, which the library shows as unknown; their created_at is not a modified time.
ALTER TABLE {{schema}}.tf_files ADD COLUMN modified_at timestamptz;
ALTER TABLE {{schema}}.tf_files ALTER COLUMN modified_at SET DEFAULT clock_timestamp();
CREATE INDEX tf_files_modified ON {{schema}}.tf_files(modified_at, id);

-- A trigger, not the rename command, owns the stamp, so a server still on the previous release also records renames during rollout.
CREATE FUNCTION {{schema}}.tf_files_stamp_modified() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.name IS DISTINCT FROM OLD.name OR NEW.sha256 IS DISTINCT FROM OLD.sha256 THEN
    NEW.modified_at := clock_timestamp();
  ELSE
    NEW.modified_at := OLD.modified_at;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tf_files_stamp_modified BEFORE UPDATE ON {{schema}}.tf_files
  FOR EACH ROW EXECUTE FUNCTION {{schema}}.tf_files_stamp_modified();
REVOKE ALL ON FUNCTION {{schema}}.tf_files_stamp_modified() FROM PUBLIC;

ALTER TABLE {{schema}}.tf_workspace_skills
  ADD COLUMN archived_at timestamptz,
  ADD COLUMN deleted_at timestamptz,
  ADD CONSTRAINT tf_workspace_skills_deleted_disabled CHECK (deleted_at IS NULL OR NOT enabled);
CREATE FUNCTION {{schema}}.tf_workspace_skill_tombstone() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Deleted workspace skills are final';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION {{schema}}.tf_workspace_skill_tombstone() FROM PUBLIC;
CREATE TRIGGER tf_workspace_skill_tombstone BEFORE UPDATE ON {{schema}}.tf_workspace_skills
  FOR EACH ROW WHEN (OLD.deleted_at IS NOT NULL) EXECUTE FUNCTION {{schema}}.tf_workspace_skill_tombstone();
GRANT UPDATE (archived_at, deleted_at) ON {{schema}}.tf_workspace_skills TO {{runtime}};

ALTER TABLE {{schema}}.tf_conversation_parts
  DROP CONSTRAINT tf_conversation_parts_kind_check,
  ADD COLUMN skill_id text,
  ADD COLUMN skill_revision text,
  ADD COLUMN skill_name text,
  ADD CONSTRAINT tf_conversation_parts_skill_reference CHECK (
    (skill_id IS NULL AND skill_revision IS NULL AND skill_name IS NULL) OR
    (skill_id IS NOT NULL AND skill_revision IS NOT NULL AND skill_name IS NOT NULL
      AND skill_id ~ '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z][a-z0-9-]{0,63})$'
      AND skill_revision ~ '^([a-f0-9]{64}|[1-9][0-9]{0,8})$'
      AND char_length(skill_name) BETWEEN 1 AND 120)),
  ADD CONSTRAINT tf_conversation_parts_kind_check CHECK (
    (kind = 'text' AND text IS NOT NULL AND attachment_id IS NULL AND request_id IS NULL AND response_id IS NULL AND approval_id IS NULL AND file_id IS NULL AND google_file IS NULL AND skill_id IS NULL) OR
    (kind = 'attachment' AND text IS NULL AND attachment_id IS NOT NULL AND request_id IS NULL AND response_id IS NULL AND approval_id IS NULL AND file_id IS NULL AND google_file IS NULL AND skill_id IS NULL) OR
    (kind = 'request' AND text IS NULL AND attachment_id IS NULL AND request_id IS NOT NULL AND response_id IS NULL AND approval_id IS NULL AND file_id IS NULL AND google_file IS NULL AND skill_id IS NULL) OR
    (kind = 'response' AND text IS NULL AND attachment_id IS NULL AND request_id IS NULL AND response_id IS NOT NULL AND approval_id IS NULL AND file_id IS NULL AND google_file IS NULL AND skill_id IS NULL) OR
    (kind IN ('approval','approval-resolution') AND text IS NULL AND attachment_id IS NULL AND request_id IS NULL AND response_id IS NULL AND approval_id IS NOT NULL AND file_id IS NULL AND google_file IS NULL AND skill_id IS NULL) OR
    (kind = 'file' AND text IS NULL AND attachment_id IS NULL AND request_id IS NULL AND response_id IS NULL AND approval_id IS NULL AND file_id IS NOT NULL AND google_file IS NULL AND skill_id IS NULL) OR
    (kind = 'google-file' AND text IS NULL AND attachment_id IS NULL AND request_id IS NULL AND response_id IS NULL AND approval_id IS NULL AND file_id IS NULL AND skill_id IS NULL
      AND jsonb_typeof(google_file) = 'object' AND google_file ?& ARRAY['fileId','connectionId','accountId','generation','name','mimeType']
      AND octet_length(google_file::text) <= 4096) OR
    (kind IN ('skill','skill-use') AND text IS NULL AND attachment_id IS NULL AND request_id IS NULL AND response_id IS NULL AND approval_id IS NULL AND file_id IS NULL AND google_file IS NULL AND skill_id IS NOT NULL));
CREATE UNIQUE INDEX tf_conversation_parts_one_skill ON {{schema}}.tf_conversation_parts(message_id) WHERE skill_id IS NOT NULL;

ALTER TABLE {{schema}}.tf_member_teams
  ADD COLUMN role text NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'manager'));
ALTER TABLE {{schema}}.tf_teams
  ADD COLUMN creator_membership_id uuid REFERENCES {{schema}}.tf_memberships (id);

WITH creators AS (
  SELECT subject_id, min(actor_id) AS actor_id
  FROM {{schema}}.tf_audit_events
  WHERE operation = 'team.create'
  GROUP BY subject_id HAVING count(*) = 1
)
UPDATE {{schema}}.tf_teams t SET creator_membership_id = m.id
FROM creators c JOIN {{schema}}.tf_memberships m ON m.id::text = c.actor_id
WHERE t.id = c.subject_id;

-- A recorded creator who is still enrolled becomes the manager. Creators are never
-- enrolled by this migration; teams without such a member stay managerless.
UPDATE {{schema}}.tf_member_teams mt SET role = 'manager'
FROM {{schema}}.tf_teams t
JOIN {{schema}}.tf_memberships m ON m.id = t.creator_membership_id AND m.removed_at IS NULL
WHERE mt.team_id = t.id AND mt.membership_id = m.id;

GRANT UPDATE (role) ON {{schema}}.tf_member_teams TO {{runtime}};

ALTER TABLE {{schema}}.tf_agents
  ADD COLUMN creator_id uuid REFERENCES {{schema}}.tf_memberships(id),
  DROP CONSTRAINT tf_agent_saved_owner;
ALTER TABLE {{schema}}.tf_agents ADD CONSTRAINT tf_agent_saved_owner
  CHECK (saved_revision IS NULL OR deleted_at IS NOT NULL OR display_name IS NOT NULL);

ALTER TABLE {{schema}}.tf_agent_grants DROP CONSTRAINT tf_agent_grants_permission_check;
ALTER TABLE {{schema}}.tf_agent_grants ADD CHECK (permission IN ('read','edit','delete','invoke','manage'));
CREATE TABLE {{schema}}.tf_agent_person_grants (
  agent_id uuid NOT NULL REFERENCES {{schema}}.tf_agents(id),
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  permission text NOT NULL CHECK (permission IN ('read','edit','delete','invoke','manage')),
  PRIMARY KEY (agent_id,membership_id,permission)
);
CREATE TABLE {{schema}}.tf_skill_person_grants (
  skill_id uuid NOT NULL REFERENCES {{schema}}.tf_workspace_skills(id),
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  permission text NOT NULL CHECK (permission IN ('read','use','manage')),
  PRIMARY KEY (skill_id,membership_id,permission)
);
CREATE TABLE {{schema}}.tf_skill_team_grants (
  skill_id uuid NOT NULL REFERENCES {{schema}}.tf_workspace_skills(id),
  team_id uuid NOT NULL REFERENCES {{schema}}.tf_teams(id) ON DELETE CASCADE,
  permission text NOT NULL CHECK (permission IN ('read','use','manage')),
  PRIMARY KEY (skill_id,team_id,permission)
);

UPDATE {{schema}}.tf_agents a SET creator_id=c.membership_id
FROM {{schema}}.tf_agent_commands c
WHERE c.agent_id=a.id AND c.status='accepted' AND c.input->'expectedSavedRevision'='null'::jsonb
  AND EXISTS (SELECT 1 FROM {{schema}}.tf_agent_saved_revisions r WHERE r.agent_id=a.id AND r.soul_revision=c.accepted_revision)
  AND NOT EXISTS (SELECT 1 FROM {{schema}}.tf_agent_commands other WHERE other.agent_id=a.id AND other.status='accepted'
    AND other.input->'expectedSavedRevision'='null'::jsonb AND other.membership_id<>c.membership_id);
-- Recorded creators receive the same grants as new creators. Other existing access remains exactly as granted.
INSERT INTO {{schema}}.tf_agent_person_grants (agent_id,membership_id,permission)
SELECT a.id,a.creator_id,p.permission FROM {{schema}}.tf_agents a
CROSS JOIN unnest(ARRAY['read','edit','delete','invoke','manage']) AS p(permission)
WHERE a.creator_id IS NOT NULL;
INSERT INTO {{schema}}.tf_skill_person_grants (skill_id,membership_id,permission)
SELECT s.id,s.creator_id,p.permission FROM {{schema}}.tf_workspace_skills s
CROSS JOIN unnest(ARRAY['read','use','manage']) AS p(permission);
-- Skills that were reviewed and enabled were available to every member. Those members keep
-- read and use through grants bound to their current membership; later members get no access.
INSERT INTO {{schema}}.tf_skill_person_grants (skill_id,membership_id,permission)
SELECT s.id,m.id,p.permission FROM {{schema}}.tf_workspace_skills s
JOIN {{schema}}.tf_workspace_skill_reviews r ON r.skill_id=s.id AND r.revision=s.active_revision
CROSS JOIN {{schema}}.tf_memberships m
CROSS JOIN unnest(ARRAY['read','use']) AS p(permission)
WHERE s.enabled AND m.removed_at IS NULL
ON CONFLICT DO NOTHING;

ALTER TABLE {{schema}}.tf_agent_schedules
  ADD COLUMN sponsor_membership_id uuid REFERENCES {{schema}}.tf_memberships(id),
  ADD COLUMN paused_at timestamptz;
UPDATE {{schema}}.tf_agent_schedules SET paused_at=now();
ALTER TABLE {{schema}}.tf_agent_runs ADD COLUMN sponsor_membership_id uuid REFERENCES {{schema}}.tf_memberships(id);
CREATE TABLE {{schema}}.tf_agent_schedule_audience (
  schedule_id uuid NOT NULL REFERENCES {{schema}}.tf_agent_schedules(id),
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  PRIMARY KEY (schedule_id,membership_id)
);
CREATE TABLE {{schema}}.tf_agent_run_audience (
  run_id uuid NOT NULL REFERENCES {{schema}}.tf_agent_runs(id),
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  PRIMARY KEY (run_id,membership_id)
);

DO $private_agent_grants$
DECLARE
  workspace_schema text := '{{schema}}'::regnamespace::text;
  relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['tf_agent_person_grants','tf_skill_person_grants','tf_skill_team_grants','tf_agent_schedule_audience','tf_agent_run_audience'] LOOP
    EXECUTE format('REVOKE ALL ON %I.%I FROM PUBLIC',workspace_schema,relation);
    EXECUTE format('GRANT SELECT, INSERT, DELETE ON %I.%I TO %I',workspace_schema,relation,workspace_schema || '_runtime');
    EXECUTE format('GRANT SELECT ON %I.%I TO %I, %I, %I',workspace_schema,relation,workspace_schema || '_migration',workspace_schema || '_owner',workspace_schema || '_confirmation');
  END LOOP;
  EXECUTE format('GRANT UPDATE (paused_at,sponsor_membership_id) ON %I.tf_agent_schedules TO %I',workspace_schema,workspace_schema || '_runtime');
END
$private_agent_grants$;

CREATE TABLE {{schema}}.tf_workflow_grants (
  workflow_id uuid NOT NULL REFERENCES {{schema}}.tf_workflows(id),
  membership_id uuid REFERENCES {{schema}}.tf_memberships(id),
  team_id uuid REFERENCES {{schema}}.tf_teams(id) ON DELETE CASCADE,
  permission text NOT NULL CHECK (permission IN ('read','invoke','manage')),
  CHECK ((membership_id IS NULL) <> (team_id IS NULL))
);
CREATE UNIQUE INDEX tf_workflow_person_grant ON {{schema}}.tf_workflow_grants (workflow_id,membership_id,permission) WHERE membership_id IS NOT NULL;
CREATE UNIQUE INDEX tf_workflow_team_grant ON {{schema}}.tf_workflow_grants (workflow_id,team_id,permission) WHERE team_id IS NOT NULL;

-- Only an unambiguous first revision supplies creator evidence.
INSERT INTO {{schema}}.tf_workflow_grants (workflow_id,membership_id,permission)
SELECT r.workflow_id,r.author_membership_id,p.permission
FROM {{schema}}.tf_workflow_revisions r
CROSS JOIN (VALUES ('read'),('invoke'),('manage')) p(permission)
WHERE r.created_at=(SELECT min(first.created_at) FROM {{schema}}.tf_workflow_revisions first WHERE first.workflow_id=r.workflow_id)
AND 1=(SELECT count(*) FROM {{schema}}.tf_workflow_revisions first WHERE first.workflow_id=r.workflow_id AND first.created_at=r.created_at)
ON CONFLICT DO NOTHING;

CREATE TABLE {{schema}}.tf_workflow_provider_grants (
  connection_id uuid NOT NULL REFERENCES {{schema}}.tf_provider_connections(id),
  membership_id uuid REFERENCES {{schema}}.tf_memberships(id),
  team_id uuid REFERENCES {{schema}}.tf_teams(id) ON DELETE CASCADE,
  permission text NOT NULL CHECK (permission IN ('use','manage')),
  CHECK ((membership_id IS NULL) <> (team_id IS NULL))
);
CREATE UNIQUE INDEX tf_workflow_provider_person_grant ON {{schema}}.tf_workflow_provider_grants (connection_id,membership_id,permission) WHERE membership_id IS NOT NULL;
CREATE UNIQUE INDEX tf_workflow_provider_team_grant ON {{schema}}.tf_workflow_provider_grants (connection_id,team_id,permission) WHERE team_id IS NOT NULL;
INSERT INTO {{schema}}.tf_workflow_provider_grants (connection_id,membership_id,permission)
SELECT c.id,c.membership_id,p.permission FROM {{schema}}.tf_provider_connections c
CROSS JOIN (VALUES ('use'),('manage')) p(permission) ON CONFLICT DO NOTHING;

ALTER TABLE {{schema}}.tf_workflows ADD COLUMN sponsor_membership_id uuid REFERENCES {{schema}}.tf_memberships(id), ADD COLUMN sponsorship_id uuid, ADD COLUMN sponsorship_revision uuid;
ALTER TABLE {{schema}}.tf_workflows ADD FOREIGN KEY (id,sponsorship_revision) REFERENCES {{schema}}.tf_workflow_revisions(workflow_id,id);
CREATE TABLE {{schema}}.tf_workflow_history_audience (
  workflow_id uuid NOT NULL REFERENCES {{schema}}.tf_workflows(id),
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  PRIMARY KEY (workflow_id,membership_id)
);
ALTER TABLE {{schema}}.tf_workflow_runs ADD COLUMN sponsorship_id uuid;
CREATE TABLE {{schema}}.tf_workflow_run_audience (
  run_id uuid NOT NULL REFERENCES {{schema}}.tf_workflow_runs(id),
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  PRIMARY KEY (run_id,membership_id)
);
UPDATE {{schema}}.tf_workflows w SET enabled=false,next_run_at=NULL
FROM {{schema}}.tf_workflow_revisions r WHERE r.workflow_id=w.id AND r.id=w.active_revision
AND r.definition->'trigger'->>'kind' NOT IN ('manual','event');
UPDATE {{schema}}.tf_workflow_runs SET status='blocked',error='sponsor-required'
WHERE status IN ('queued','running','waiting') AND (membership_id IS NULL OR request_key LIKE 'provider:%');

REVOKE ALL ON {{schema}}.tf_workflow_grants,{{schema}}.tf_workflow_provider_grants,{{schema}}.tf_workflow_history_audience,{{schema}}.tf_workflow_run_audience FROM PUBLIC;
GRANT SELECT,INSERT,DELETE ON {{schema}}.tf_workflow_grants,{{schema}}.tf_workflow_provider_grants,{{schema}}.tf_workflow_history_audience TO {{runtime}};
GRANT SELECT,INSERT ON {{schema}}.tf_workflow_run_audience TO {{runtime}};
GRANT UPDATE (sponsor_membership_id,sponsorship_id,sponsorship_revision) ON {{schema}}.tf_workflows TO {{runtime}};
GRANT DELETE ON {{schema}}.tf_provider_events TO {{runtime}};

CREATE TABLE {{schema}}.tf_connection_person_grants (
  connection_id uuid NOT NULL REFERENCES {{schema}}.tf_connections(id),
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  permission text NOT NULL CHECK (permission IN ('read','use','manage')),
  PRIMARY KEY(connection_id,membership_id,permission)
);
CREATE TABLE {{schema}}.tf_connection_source_person_grants (
  connection_id uuid NOT NULL,
  source_id uuid NOT NULL,
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  permission text NOT NULL DEFAULT 'github.issue.read' CHECK(permission='github.issue.read'),
  PRIMARY KEY(source_id,membership_id),
  FOREIGN KEY(connection_id,source_id) REFERENCES {{schema}}.tf_connection_sources(connection_id,id)
);
CREATE TABLE {{schema}}.tf_mcp_managers (
  connection_id uuid NOT NULL REFERENCES {{schema}}.tf_mcp_connections(id),
  membership_id uuid REFERENCES {{schema}}.tf_memberships(id),
  team_id uuid REFERENCES {{schema}}.tf_teams(id) ON DELETE CASCADE,
  CHECK ((membership_id IS NULL) <> (team_id IS NULL)),
  UNIQUE NULLS NOT DISTINCT(connection_id,membership_id,team_id)
);
CREATE TABLE {{schema}}.tf_atlassian_account_managers (
  account_id uuid NOT NULL REFERENCES {{schema}}.tf_atlassian_accounts(id),
  membership_id uuid REFERENCES {{schema}}.tf_memberships(id),
  team_id uuid REFERENCES {{schema}}.tf_teams(id) ON DELETE CASCADE,
  CHECK ((membership_id IS NULL) <> (team_id IS NULL)),
  UNIQUE NULLS NOT DISTINCT(account_id,membership_id,team_id)
);
CREATE TABLE {{schema}}.tf_slack_installation_managers (
  installation_id uuid NOT NULL REFERENCES {{schema}}.tf_slack_installations(id),
  membership_id uuid REFERENCES {{schema}}.tf_memberships(id),
  team_id uuid REFERENCES {{schema}}.tf_teams(id) ON DELETE CASCADE,
  CHECK ((membership_id IS NULL) <> (team_id IS NULL)),
  UNIQUE NULLS NOT DISTINCT(installation_id,membership_id,team_id)
);
CREATE TABLE {{schema}}.tf_slack_installation_grants (
  installation_id uuid NOT NULL REFERENCES {{schema}}.tf_slack_installations(id),
  membership_id uuid REFERENCES {{schema}}.tf_memberships(id),
  team_id uuid REFERENCES {{schema}}.tf_teams(id) ON DELETE CASCADE,
  CHECK ((membership_id IS NULL) <> (team_id IS NULL)),
  UNIQUE NULLS NOT DISTINCT(installation_id,membership_id,team_id)
);

-- Creation evidence is tied to a membership incarnation, never to an admin role.
INSERT INTO {{schema}}.tf_connection_person_grants(connection_id,membership_id,permission)
SELECT c.id,m.id,p.permission FROM {{schema}}.tf_connections c
JOIN {{schema}}.tf_memberships m ON c.created_by->>'kind'='human'
  AND c.created_by->>'membershipId'=m.id::text AND c.created_by->>'userId'=m.user_id
CROSS JOIN (VALUES ('read'),('use'),('manage')) p(permission);
INSERT INTO {{schema}}.tf_connection_person_grants(connection_id,membership_id,permission)
SELECT c.id,m.id,p.permission FROM {{schema}}.tf_connections c
JOIN {{schema}}.tf_agent_runs r ON c.created_by->>'kind'='agent' AND c.created_by->>'runId'=r.id::text AND r.kind='delegated'
JOIN {{schema}}.tf_memberships m ON m.id=r.membership_id AND m.user_id=r.user_id
CROSS JOIN (VALUES ('read'),('use'),('manage')) p(permission) ON CONFLICT DO NOTHING;
INSERT INTO {{schema}}.tf_mcp_managers(connection_id,membership_id)
SELECT c.id,min(cmd.membership_id::text)::uuid FROM {{schema}}.tf_mcp_connections c
JOIN {{schema}}.tf_mcp_commands cmd ON cmd.kind='create' AND cmd.result->>'id'=c.id::text
WHERE c.ownership='shared' GROUP BY c.id HAVING count(DISTINCT cmd.membership_id)=1;
INSERT INTO {{schema}}.tf_atlassian_account_managers(account_id,membership_id)
SELECT c.id,min(e.actor_id::text)::uuid FROM {{schema}}.tf_atlassian_accounts c
JOIN {{schema}}.tf_audit_events e ON e.subject_id::text=c.id::text AND e.operation='atlassian-account.begin'
JOIN {{schema}}.tf_memberships m ON m.id::text=e.actor_id::text
WHERE c.ownership='business' GROUP BY c.id HAVING count(DISTINCT e.actor_id)=1;
-- Existing Slack identity consent remains an explicit use grant. Installer
-- evidence lives in the platform schema, so the Slack service adopts it at runtime.
INSERT INTO {{schema}}.tf_slack_installation_grants(installation_id,membership_id)
SELECT DISTINCT installation_id,membership_id FROM {{schema}}.tf_slack_identities WHERE state='authorized';

GRANT SELECT,INSERT,DELETE ON {{schema}}.tf_connection_person_grants,{{schema}}.tf_connection_source_person_grants,
  {{schema}}.tf_mcp_managers,{{schema}}.tf_atlassian_account_managers,
  {{schema}}.tf_slack_installation_managers,{{schema}}.tf_slack_installation_grants TO {{runtime}};
GRANT SELECT ON {{schema}}.tf_connection_person_grants,{{schema}}.tf_connection_source_person_grants,
  {{schema}}.tf_mcp_managers,{{schema}}.tf_atlassian_account_managers,
  {{schema}}.tf_slack_installation_managers,{{schema}}.tf_slack_installation_grants TO {{confirmation}};

CREATE OR REPLACE FUNCTION {{schema}}.tf_table_source_allowed(member_id uuid, actor_user text, source jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE connection_row record; source_row record;
BEGIN
  PERFORM id FROM {{schema}}.tf_authorization_lock WHERE id=1 FOR SHARE;
  IF NOT EXISTS(SELECT 1 FROM {{schema}}.tf_memberships WHERE id=member_id AND user_id=actor_user AND removed_at IS NULL) THEN RETURN false; END IF;
  CASE source->>'kind'
  WHEN 'private-conversation' THEN
    RETURN EXISTS(SELECT 1 FROM {{schema}}.tf_conversations WHERE id=(source->>'conversationId')::uuid AND kind='private' AND owner_user_id=actor_user AND owner_membership_id=member_id);
  WHEN 'github-source','connection-source' THEN
    SELECT * INTO connection_row FROM {{schema}}.tf_connections WHERE id=(source->>'connectionId')::uuid FOR SHARE;
    IF NOT FOUND OR NOT connection_row.enabled OR connection_row.deleted_at IS NOT NULL THEN RETURN false; END IF;
    IF source->>'kind'='github-source' AND (connection_row.generation<>(source->>'generation')::integer OR connection_row.grants_version<>(source->>'grantsVersion')::integer) THEN RETURN false; END IF;
    RETURN EXISTS(SELECT 1 FROM {{schema}}.tf_connection_sources WHERE id=(source->>'sourceId')::uuid AND connection_id=connection_row.id)
      AND NOT EXISTS(SELECT permission FROM (VALUES ('read'),('use')) p(permission) WHERE NOT (
        EXISTS(SELECT 1 FROM {{schema}}.tf_connection_person_grants g WHERE g.connection_id=connection_row.id AND g.membership_id=member_id AND g.permission=p.permission)
        OR EXISTS(SELECT 1 FROM {{schema}}.tf_connection_grants g JOIN {{schema}}.tf_member_teams mt ON mt.team_id=g.team_id WHERE mt.membership_id=member_id AND g.connection_id=connection_row.id AND g.permission=p.permission)))
      AND (EXISTS(SELECT 1 FROM {{schema}}.tf_connection_source_person_grants g WHERE g.source_id=(source->>'sourceId')::uuid AND g.membership_id=member_id)
        OR EXISTS(SELECT 1 FROM {{schema}}.tf_connection_source_grants g JOIN {{schema}}.tf_member_teams mt ON mt.team_id=g.team_id WHERE mt.membership_id=member_id AND g.source_id=(source->>'sourceId')::uuid AND g.permission='github.issue.read'));
  WHEN 'google-connection' THEN
    IF source->>'membershipId'<>member_id::text THEN RETURN false; END IF;
    SELECT * INTO connection_row FROM {{schema}}.tf_google_connections WHERE id=(source->>'connectionId')::uuid FOR SHARE;
    IF NOT FOUND THEN RETURN false; END IF;
    RETURN connection_row.account_id=source->>'accountId' AND connection_row.membership_id=member_id AND connection_row.user_id=actor_user AND connection_row.generation=(source->>'generation')::integer AND connection_row.status='connected'
      AND to_jsonb(connection_row.scopes) @> (source->'scopes') AND (source->'scopes') @> to_jsonb(connection_row.scopes) AND to_jsonb(connection_row.scopes) @> (source->'requiredScopes');
  WHEN 'atlassian-source' THEN
    IF source->>'membershipId'<>member_id::text THEN RETURN false; END IF;
    SELECT * INTO connection_row FROM {{schema}}.tf_atlassian_accounts WHERE id=(source->>'accountId')::uuid FOR SHARE;
    IF NOT FOUND THEN RETURN false; END IF;
    SELECT * INTO source_row FROM {{schema}}.tf_atlassian_sources WHERE id=(source->>'sourceId')::uuid FOR SHARE;
    IF NOT FOUND THEN RETURN false; END IF;
    RETURN source_row.account_id=connection_row.id AND source_row.membership_id=member_id AND source_row.enabled AND source_row.binding=(source->>'binding')::jsonb AND connection_row.state='active'
      AND connection_row.generation=(source->>'generation')::integer AND connection_row.grants_version=(source->>'grantsVersion')::integer AND connection_row.expires_at>clock_timestamp()
      AND ((connection_row.ownership='personal' AND connection_row.owner_membership_id=member_id) OR (connection_row.ownership='business' AND (
        EXISTS(SELECT 1 FROM {{schema}}.tf_atlassian_account_member_grants g WHERE g.account_id=connection_row.id AND g.membership_id=member_id)
        OR EXISTS(SELECT 1 FROM {{schema}}.tf_atlassian_account_team_grants g JOIN {{schema}}.tf_member_teams mt ON mt.team_id=g.team_id WHERE g.account_id=connection_row.id AND mt.membership_id=member_id))));
  ELSE RETURN false;
  END CASE;
END $$;

-- A file published from a sent chat attachment shares the attachment's id and borrows its object instead of storing a copy.
-- object_owner names who stores the bytes: 'files' at <workspace>/files/<object_key>, 'attachment' at <workspace>/<object_key>.
-- A borrowed object is removed by whichever side lets go last, under the storage advisory lock: Files purge skips it while the
-- attachment is live, and attachment cleanup skips it while the file row is not being deleted.
-- Files published before this migration keep their own copies as 'files'; their attachments keep theirs.
ALTER TABLE {{schema}}.tf_files ADD COLUMN object_owner text NOT NULL DEFAULT 'files',
  ADD CONSTRAINT tf_files_object_owner_check CHECK (object_owner = 'files' OR (object_owner = 'attachment' AND kind = 'file'));

-- The library sorts and filters modified_at after its access walk, so no listing reads this index. 0103 added it.
DROP INDEX {{schema}}.tf_files_modified;

ALTER TABLE {{schema}}.tf_conversation_parts
  ADD COLUMN rich_content jsonb,
  ADD CONSTRAINT tf_conversation_parts_rich_content CHECK (
    rich_content IS NULL OR (
      kind = 'text'
      AND jsonb_typeof(rich_content) = 'object'
      AND rich_content->>'version' = '1'
      AND jsonb_typeof(rich_content->'doc') = 'object'
      AND octet_length(rich_content::text) <= 131072
    )
  );

CREATE TABLE {{schema}}.tf_file_usage (
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  file_id uuid NOT NULL REFERENCES {{schema}}.tf_files(id) ON DELETE CASCADE,
  used_at timestamptz NOT NULL,
  PRIMARY KEY (membership_id, file_id)
);
CREATE INDEX tf_file_usage_recent ON {{schema}}.tf_file_usage(membership_id, used_at DESC, file_id DESC);

REVOKE ALL ON {{schema}}.tf_file_usage FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON {{schema}}.tf_file_usage TO {{runtime}};

CREATE TABLE {{schema}}.tf_compaction_policy (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  automatic boolean NOT NULL,
  trigger_percent integer NOT NULL,
  target_percent integer NOT NULL,
  model_family_id text NOT NULL CHECK (model_family_id ~ '^[a-z][a-z0-9-]{0,99}$'),
  fallback_family_id text CHECK (fallback_family_id ~ '^[a-z][a-z0-9-]{0,99}$'),
  output_prompt text CHECK (char_length(output_prompt) BETWEEN 1 AND 2000),
  revision integer NOT NULL CHECK (revision > 0),
  editor_membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships (id),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (0 < target_percent AND target_percent < trigger_percent AND trigger_percent < 100),
  CHECK (fallback_family_id IS NULL OR fallback_family_id <> model_family_id)
);

CREATE TABLE {{schema}}.tf_compaction_policy_commands (
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships (id),
  request_id uuid NOT NULL,
  input jsonb NOT NULL,
  receipt jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (membership_id, request_id)
);

CREATE TABLE {{schema}}.tf_conversation_compactions (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES {{schema}}.tf_conversations (id),
  turn_id uuid NOT NULL,
  trigger text NOT NULL CHECK (trigger IN ('manual', 'automatic', 'handoff-retry')),
  state text NOT NULL CHECK (state IN ('compacted', 'cleaned', 'unchanged', 'failed')),
  previous_id uuid REFERENCES {{schema}}.tf_conversation_compactions (id),
  covered_through integer CHECK (covered_through > 0),
  policy_revision integer NOT NULL CHECK (policy_revision >= 0),
  model_family_id text CHECK (model_family_id ~ '^[a-z][a-z0-9-]{0,99}$'),
  fallback_from_family_id text CHECK (fallback_from_family_id ~ '^[a-z][a-z0-9-]{0,99}$'),
  before_tokens integer CHECK (before_tokens >= 0),
  after_tokens integer CHECK (after_tokens >= 0),
  window_tokens integer CHECK (window_tokens > 0),
  trigger_percent integer NOT NULL CHECK (trigger_percent BETWEEN 1 AND 99),
  target_percent integer NOT NULL CHECK (target_percent BETWEEN 1 AND 99),
  usage jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(usage) = 'array' AND octet_length(usage::text) <= 16384),
  error_code text CHECK (error_code ~ '^[a-z][a-z0-9-]{0,99}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (conversation_id, id),
  FOREIGN KEY (conversation_id, turn_id) REFERENCES {{schema}}.tf_conversation_turns (conversation_id, id),
  CHECK ((state = 'failed') = (error_code IS NOT NULL)),
  CHECK (state <> 'compacted' OR covered_through IS NOT NULL)
);
CREATE INDEX tf_conversation_compactions_conversation ON {{schema}}.tf_conversation_compactions (conversation_id, created_at DESC);
CREATE UNIQUE INDEX tf_conversation_compactions_turn ON {{schema}}.tf_conversation_compactions (turn_id) WHERE state <> 'failed';

CREATE TABLE {{schema}}.tf_conversation_working_summaries (
  compaction_id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  covered_through integer NOT NULL CHECK (covered_through > 0),
  summary jsonb NOT NULL CHECK (jsonb_typeof(summary) = 'object' AND octet_length(summary::text) <= 262144),
  protected_message_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(protected_message_ids) <= 32),
  sources jsonb NOT NULL CHECK (jsonb_typeof(sources) = 'array' AND octet_length(sources::text) <= 1048576),
  active boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (conversation_id, revision),
  FOREIGN KEY (conversation_id, compaction_id) REFERENCES {{schema}}.tf_conversation_compactions (conversation_id, id)
);
CREATE UNIQUE INDEX tf_conversation_working_summaries_active ON {{schema}}.tf_conversation_working_summaries (conversation_id) WHERE active;

CREATE TABLE {{schema}}.tf_conversation_handoffs (
  compaction_id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
  prompt text CHECK (char_length(prompt) BETWEEN 1 AND 2000),
  text text CHECK (octet_length(text) BETWEEN 1 AND 65536),
  model_family_id text CHECK (model_family_id ~ '^[a-z][a-z0-9-]{0,99}$'),
  fallback_from_family_id text CHECK (fallback_from_family_id ~ '^[a-z][a-z0-9-]{0,99}$'),
  error_code text CHECK (error_code ~ '^[a-z][a-z0-9-]{0,99}$'),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  sources jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(sources) = 'array' AND octet_length(sources::text) <= 1048576),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (conversation_id, compaction_id) REFERENCES {{schema}}.tf_conversation_compactions (conversation_id, id),
  CHECK ((status = 'completed') = (text IS NOT NULL)),
  CHECK ((status = 'failed') = (error_code IS NOT NULL))
);

CREATE TABLE {{schema}}.tf_conversation_context_cleanups (
  message_id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL,
  compaction_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (conversation_id, message_id) REFERENCES {{schema}}.tf_conversation_messages (conversation_id, id),
  FOREIGN KEY (conversation_id, compaction_id) REFERENCES {{schema}}.tf_conversation_compactions (conversation_id, id)
);

CREATE TABLE {{schema}}.tf_conversation_compaction_breakers (
  conversation_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_conversations (id),
  failures integer NOT NULL DEFAULT 0 CHECK (failures >= 0),
  ineffective integer NOT NULL DEFAULT 0 CHECK (ineffective >= 0),
  last_error text CHECK (last_error ~ '^[a-z][a-z0-9-]{0,99}$'),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE {{schema}}.tf_conversation_turns ADD COLUMN compaction_requested boolean NOT NULL DEFAULT false;

ALTER TABLE {{schema}}.tf_conversation_parts
  DROP CONSTRAINT tf_conversation_parts_kind_check,
  ADD COLUMN compaction_id uuid,
  ADD CONSTRAINT tf_conversation_parts_compaction_reference FOREIGN KEY (conversation_id, compaction_id) REFERENCES {{schema}}.tf_conversation_compactions (conversation_id, id),
  ADD CONSTRAINT tf_conversation_parts_kind_check CHECK (
    (kind = 'text' AND text IS NOT NULL AND attachment_id IS NULL AND request_id IS NULL AND response_id IS NULL AND approval_id IS NULL AND file_id IS NULL AND google_file IS NULL AND skill_id IS NULL AND compaction_id IS NULL) OR
    (kind = 'attachment' AND text IS NULL AND attachment_id IS NOT NULL AND request_id IS NULL AND response_id IS NULL AND approval_id IS NULL AND file_id IS NULL AND google_file IS NULL AND skill_id IS NULL AND compaction_id IS NULL) OR
    (kind = 'request' AND text IS NULL AND attachment_id IS NULL AND request_id IS NOT NULL AND response_id IS NULL AND approval_id IS NULL AND file_id IS NULL AND google_file IS NULL AND skill_id IS NULL AND compaction_id IS NULL) OR
    (kind = 'response' AND text IS NULL AND attachment_id IS NULL AND request_id IS NULL AND response_id IS NOT NULL AND approval_id IS NULL AND file_id IS NULL AND google_file IS NULL AND skill_id IS NULL AND compaction_id IS NULL) OR
    (kind IN ('approval','approval-resolution') AND text IS NULL AND attachment_id IS NULL AND request_id IS NULL AND response_id IS NULL AND approval_id IS NOT NULL AND file_id IS NULL AND google_file IS NULL AND skill_id IS NULL AND compaction_id IS NULL) OR
    (kind = 'file' AND text IS NULL AND attachment_id IS NULL AND request_id IS NULL AND response_id IS NULL AND approval_id IS NULL AND file_id IS NOT NULL AND google_file IS NULL AND skill_id IS NULL AND compaction_id IS NULL) OR
    (kind = 'google-file' AND text IS NULL AND attachment_id IS NULL AND request_id IS NULL AND response_id IS NULL AND approval_id IS NULL AND file_id IS NULL AND skill_id IS NULL AND compaction_id IS NULL
      AND jsonb_typeof(google_file) = 'object' AND google_file ?& ARRAY['fileId','connectionId','accountId','generation','name','mimeType']
      AND octet_length(google_file::text) <= 4096) OR
    (kind IN ('skill','skill-use') AND text IS NULL AND attachment_id IS NULL AND request_id IS NULL AND response_id IS NULL AND approval_id IS NULL AND file_id IS NULL AND google_file IS NULL AND skill_id IS NOT NULL AND compaction_id IS NULL) OR
    (kind = 'compact' AND attachment_id IS NULL AND request_id IS NULL AND response_id IS NULL AND approval_id IS NULL AND file_id IS NULL AND google_file IS NULL AND skill_id IS NULL
      AND (text IS NULL OR compaction_id IS NULL) AND char_length(COALESCE(text, 'x')) <= 2000) OR
    (kind = 'compaction' AND text IS NULL AND attachment_id IS NULL AND request_id IS NULL AND response_id IS NULL AND approval_id IS NULL AND file_id IS NULL AND google_file IS NULL AND skill_id IS NULL AND compaction_id IS NOT NULL));
CREATE UNIQUE INDEX tf_conversation_parts_one_compaction ON {{schema}}.tf_conversation_parts (message_id) WHERE kind IN ('compact', 'compaction');

REVOKE ALL ON {{schema}}.tf_compaction_policy, {{schema}}.tf_compaction_policy_commands, {{schema}}.tf_conversation_compactions,
  {{schema}}.tf_conversation_working_summaries, {{schema}}.tf_conversation_handoffs, {{schema}}.tf_conversation_context_cleanups,
  {{schema}}.tf_conversation_compaction_breakers FROM PUBLIC;
GRANT SELECT, INSERT ON {{schema}}.tf_compaction_policy, {{schema}}.tf_compaction_policy_commands, {{schema}}.tf_conversation_compactions,
  {{schema}}.tf_conversation_working_summaries, {{schema}}.tf_conversation_handoffs, {{schema}}.tf_conversation_context_cleanups,
  {{schema}}.tf_conversation_compaction_breakers TO {{runtime}};
GRANT UPDATE (automatic, trigger_percent, target_percent, model_family_id, fallback_family_id, output_prompt, revision, editor_membership_id, updated_at)
  ON {{schema}}.tf_compaction_policy TO {{runtime}};
GRANT UPDATE (active) ON {{schema}}.tf_conversation_working_summaries TO {{runtime}};
GRANT UPDATE (status, text, model_family_id, fallback_from_family_id, error_code, attempts, sources, updated_at) ON {{schema}}.tf_conversation_handoffs TO {{runtime}};
GRANT UPDATE (failures, ineffective, last_error, updated_at) ON {{schema}}.tf_conversation_compaction_breakers TO {{runtime}};
GRANT UPDATE (compaction_requested) ON {{schema}}.tf_conversation_turns TO {{runtime}};

-- 0002_workflow_skipped_runs.sql
ALTER TABLE {{schema}}.tf_workflow_runs DROP CONSTRAINT tf_workflow_runs_status_check;
ALTER TABLE {{schema}}.tf_workflow_runs ADD CONSTRAINT tf_workflow_runs_status_check CHECK (status IN ('queued','running','waiting','completed','cancelled','blocked','failed','skipped'));

-- 0003_workflow_schedule_index.sql
CREATE INDEX tf_workflow_schedule_due ON {{schema}}.tf_workflows (next_run_at, id) WHERE enabled AND next_run_at IS NOT NULL;

-- 0004_workflow_archive.sql
ALTER TABLE {{schema}}.tf_workflows ADD COLUMN archived_at timestamptz;
ALTER TABLE {{schema}}.tf_workflows ADD CONSTRAINT tf_workflows_archived_disabled CHECK (archived_at IS NULL OR NOT enabled);
GRANT UPDATE (archived_at) ON {{schema}}.tf_workflows TO {{runtime}};

-- 0005_workflow_webhook_signing.sql
ALTER TABLE {{schema}}.tf_workflows
  ADD COLUMN webhook_secret jsonb,
  ADD COLUMN webhook_previous jsonb,
  ADD COLUMN webhook_previous_expires_at timestamptz,
  ADD CONSTRAINT tf_workflows_webhook_one_current CHECK (webhook_digest IS NULL OR webhook_secret IS NULL),
  ADD CONSTRAINT tf_workflows_webhook_previous_expiry CHECK ((webhook_previous IS NULL) = (webhook_previous_expires_at IS NULL));
GRANT UPDATE (webhook_secret,webhook_previous,webhook_previous_expires_at) ON {{schema}}.tf_workflows TO {{runtime}};
CREATE TABLE {{schema}}.tf_workflow_webhook_signatures (
  workflow_id uuid NOT NULL REFERENCES {{schema}}.tf_workflows(id),
  signature text NOT NULL CHECK (signature ~ '^[a-f0-9]{64}$'),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workflow_id, signature)
);
CREATE INDEX tf_workflow_webhook_signatures_received ON {{schema}}.tf_workflow_webhook_signatures (workflow_id, received_at);
REVOKE ALL ON {{schema}}.tf_workflow_webhook_signatures FROM PUBLIC;
GRANT SELECT, INSERT, DELETE ON {{schema}}.tf_workflow_webhook_signatures TO {{runtime}};

-- 0006_workflow_record_occurrences.sql
CREATE TABLE {{schema}}.tf_workflow_record_occurrences (
  workflow_id uuid NOT NULL,
  revision uuid NOT NULL,
  record_id uuid NOT NULL,
  due_at timestamptz NOT NULL,
  fired_at timestamptz,
  PRIMARY KEY (workflow_id, revision, record_id, due_at),
  FOREIGN KEY (workflow_id, revision) REFERENCES {{schema}}.tf_workflow_revisions(workflow_id, id)
);
CREATE INDEX tf_workflow_record_occurrences_due ON {{schema}}.tf_workflow_record_occurrences (workflow_id, due_at) WHERE fired_at IS NULL;
ALTER TABLE {{schema}}.tf_workflows ADD COLUMN activated_at timestamptz;
REVOKE ALL ON {{schema}}.tf_workflow_record_occurrences FROM PUBLIC;
GRANT SELECT, INSERT, DELETE ON {{schema}}.tf_workflow_record_occurrences TO {{runtime}};
GRANT UPDATE (fired_at) ON {{schema}}.tf_workflow_record_occurrences TO {{runtime}};
GRANT UPDATE (activated_at) ON {{schema}}.tf_workflows TO {{runtime}};

-- 0007_workflow_webhook_deliveries.sql
CREATE TABLE {{schema}}.tf_workflow_webhook_deliveries (
  id uuid PRIMARY KEY,
  workflow_id uuid NOT NULL REFERENCES {{schema}}.tf_workflows(id),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  status smallint NOT NULL CHECK (status BETWEEN 100 AND 599),
  outcome text NOT NULL CHECK (outcome ~ '^[a-z0-9-]{1,64}$'),
  request_id text CHECK (char_length(request_id) BETWEEN 1 AND 200),
  body_bytes integer CHECK (body_bytes >= 0),
  run_id uuid,
  test boolean NOT NULL DEFAULT false
);
CREATE INDEX tf_workflow_webhook_deliveries_recent ON {{schema}}.tf_workflow_webhook_deliveries (workflow_id, received_at DESC, id DESC);
REVOKE ALL ON {{schema}}.tf_workflow_webhook_deliveries FROM PUBLIC;
GRANT SELECT, INSERT, DELETE ON {{schema}}.tf_workflow_webhook_deliveries TO {{runtime}};

-- 0008_agent_task_schedules.sql
ALTER TABLE {{schema}}.tf_agent_tasks ADD COLUMN schedule_id uuid REFERENCES {{schema}}.tf_agent_schedules(id);
CREATE INDEX tf_agent_tasks_schedule ON {{schema}}.tf_agent_tasks (schedule_id, created_at DESC, id DESC) WHERE schedule_id IS NOT NULL;

-- 0009_agent_schedule_interval_edit.sql
GRANT UPDATE (interval_minutes) ON {{schema}}.tf_agent_schedules TO {{runtime}};

-- 0010_agent_task_limit_caps.sql
ALTER TABLE {{schema}}.tf_agent_limits ADD COLUMN task_limits jsonb NOT NULL DEFAULT '{"toolCalls":1000,"activeMilliseconds":3600000,"credits":10000}'::jsonb CHECK (jsonb_typeof(task_limits) = 'object');
GRANT UPDATE (task_limits) ON {{schema}}.tf_agent_limits TO {{runtime}};

-- 0011_workflow_row_history_sweep.sql
CREATE INDEX tf_table_row_history_sweep ON {{schema}}.tf_table_row_history_data (table_id, created_at) WHERE operation <> 'transform';

-- 0012_workflow_history_index.sql
CREATE INDEX tf_workflow_runs_history ON {{schema}}.tf_workflow_runs (workflow_id, created_at DESC, id DESC);

-- 0013_agent_schedule_cron.sql
ALTER TABLE {{schema}}.tf_agent_schedules
  ADD COLUMN cron_expression text,
  ADD COLUMN timezone text;
ALTER TABLE {{schema}}.tf_agent_schedules DROP CONSTRAINT tf_schedule_trigger;
ALTER TABLE {{schema}}.tf_agent_schedules
  ADD CONSTRAINT tf_schedule_trigger CHECK (
    (interval_minutes IS NULL AND cron_expression IS NULL AND timezone IS NULL AND call IS NULL AND next_run_at IS NULL)
    OR (interval_minutes IS NOT NULL AND cron_expression IS NULL AND timezone IS NULL AND call IS NOT NULL AND next_run_at IS NOT NULL)
    OR (interval_minutes IS NULL AND cron_expression IS NOT NULL AND timezone IS NOT NULL AND call IS NOT NULL AND next_run_at IS NOT NULL)
  );
GRANT UPDATE (interval_minutes, cron_expression, timezone) ON {{schema}}.tf_agent_schedules TO {{runtime}};

-- 0014_table_archive.sql
ALTER TABLE {{schema}}.tf_table_catalog ADD COLUMN archived_at timestamptz;
CREATE INDEX tf_table_catalog_unarchived ON {{schema}}.tf_table_catalog (id) WHERE archived_at IS NULL;
GRANT UPDATE (archived_at) ON {{schema}}.tf_table_catalog TO {{migration}}, {{customOwner}};

-- 0015_recommendation_snapshots.sql
CREATE TABLE {{schema}}.tf_recommendation_snapshots (
  membership_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_memberships (id),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  items jsonb NOT NULL CHECK (jsonb_typeof(items) = 'array'),
  generated_at timestamptz NOT NULL DEFAULT now(),
  refresh_after timestamptz NOT NULL DEFAULT (now() + interval '1 day')
);
CREATE INDEX tf_recommendation_snapshots_refresh ON {{schema}}.tf_recommendation_snapshots (refresh_after);
REVOKE ALL ON TABLE {{schema}}.tf_recommendation_snapshots FROM PUBLIC, {{migration}}, {{customOwner}}, {{confirmation}};
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE {{schema}}.tf_recommendation_snapshots TO {{runtime}};
CREATE TABLE {{schema}}.tf_platform_recommendation_spend (
  id text PRIMARY KEY CHECK (id ~ '^recommendation:[a-zA-Z0-9:_-]{1,200}$'),
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships (id),
  model_id text NOT NULL,
  provider_pico_usd numeric(30,0) NOT NULL CHECK (provider_pico_usd >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON TABLE {{schema}}.tf_platform_recommendation_spend FROM PUBLIC, {{migration}}, {{customOwner}}, {{confirmation}};
GRANT SELECT, INSERT ON TABLE {{schema}}.tf_platform_recommendation_spend TO {{runtime}};

-- 0016_workflow_run_timestamps.sql
ALTER TABLE {{schema}}.tf_workflow_runs
  ADD COLUMN scheduled_for timestamptz,
  ADD COLUMN started_at timestamptz,
  ADD COLUMN finished_at timestamptz;

UPDATE {{schema}}.tf_workflow_runs
SET scheduled_for = (input->>'scheduledFor')::timestamptz
WHERE (request_key LIKE 'schedule:%' OR request_key LIKE 'record:%')
  AND input ? 'scheduledFor';

CREATE FUNCTION {{schema}}.tf_workflow_run_timestamps() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.status IN ('running','waiting','completed','failed') THEN
    NEW.started_at := COALESCE(NEW.started_at, clock_timestamp());
  END IF;
  IF NEW.status IN ('completed','cancelled','blocked','failed','skipped') THEN
    NEW.finished_at := COALESCE(NEW.finished_at, clock_timestamp());
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tf_workflow_run_timestamps
BEFORE INSERT OR UPDATE OF status ON {{schema}}.tf_workflow_runs
FOR EACH ROW EXECUTE FUNCTION {{schema}}.tf_workflow_run_timestamps();

-- 0017_agent_task_delegation.sql
ALTER TABLE {{schema}}.tf_agent_tasks
  DROP CONSTRAINT tf_agent_tasks_flow_id_key,
  ADD COLUMN parent_task_id uuid REFERENCES {{schema}}.tf_agent_tasks(id),
  ADD COLUMN delegation_depth integer NOT NULL DEFAULT 0 CHECK (delegation_depth BETWEEN 0 AND 3),
  ADD COLUMN delegation_tools jsonb CHECK (delegation_tools IS NULL OR jsonb_typeof(delegation_tools) = 'array');

CREATE INDEX tf_agent_tasks_parent ON {{schema}}.tf_agent_tasks(parent_task_id, created_at, id)
  WHERE parent_task_id IS NOT NULL;

-- 0018_agent_plans.sql
CREATE TABLE {{schema}}.tf_agent_plans (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES {{schema}}.tf_conversations(id),
  starter_user_id text NOT NULL,
  starter_membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  source_turn_id uuid REFERENCES {{schema}}.tf_conversation_turns(id),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  brief text NOT NULL DEFAULT '' CHECK (char_length(brief) <= 4000),
  lifecycle text NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active', 'paused', 'stopped', 'completed', 'failed')),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  budget jsonb NOT NULL CHECK (jsonb_typeof(budget) = 'object'),
  tool_calls integer NOT NULL DEFAULT 0 CHECK (tool_calls >= 0),
  active_milliseconds bigint NOT NULL DEFAULT 0 CHECK (active_milliseconds >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX tf_agent_plans_chat ON {{schema}}.tf_agent_plans (conversation_id, created_at DESC, id DESC);
CREATE UNIQUE INDEX tf_agent_plans_open ON {{schema}}.tf_agent_plans (conversation_id, starter_membership_id) WHERE lifecycle IN ('active', 'paused');
CREATE INDEX tf_agent_plans_active ON {{schema}}.tf_agent_plans (updated_at, id) WHERE lifecycle = 'active';

CREATE TABLE {{schema}}.tf_agent_plan_specialists (
  plan_id uuid NOT NULL REFERENCES {{schema}}.tf_agent_plans(id),
  key text NOT NULL CHECK (key ~ '^[a-z0-9][a-z0-9-]{0,47}$'),
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object' AND octet_length(definition::text) <= 65536),
  created_version integer NOT NULL CHECK (created_version >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (plan_id, key)
);

CREATE TABLE {{schema}}.tf_agent_plan_tasks (
  id uuid PRIMARY KEY,
  plan_id uuid NOT NULL REFERENCES {{schema}}.tf_agent_plans(id),
  key text NOT NULL CHECK (key ~ '^[a-z0-9][a-z0-9-]{0,47}$'),
  parent_key text,
  position integer NOT NULL CHECK (position >= 0),
  kind text NOT NULL CHECK (kind IN ('group', 'work')),
  order_mode text NOT NULL CHECK (order_mode IN ('parallel', 'serial')),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  brief text NOT NULL DEFAULT '' CHECK (char_length(brief) <= 4000),
  criteria jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(criteria) = 'array' AND jsonb_array_length(criteria) <= 8),
  agent_id uuid REFERENCES {{schema}}.tf_agents(id),
  specialist_key text,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'ready', 'running', 'waiting-input', 'waiting-approval', 'blocked', 'completed', 'failed', 'cancelled')),
  reason text CHECK (char_length(reason) <= 600),
  created_version integer NOT NULL CHECK (created_version >= 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (plan_id, key),
  FOREIGN KEY (plan_id, parent_key) REFERENCES {{schema}}.tf_agent_plan_tasks(plan_id, key) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (plan_id, specialist_key) REFERENCES {{schema}}.tf_agent_plan_specialists(plan_id, key),
  CHECK (agent_id IS NULL OR specialist_key IS NULL),
  CHECK (kind = 'work' OR (agent_id IS NULL AND specialist_key IS NULL AND state = 'pending'))
);
CREATE INDEX tf_agent_plan_tasks_ready ON {{schema}}.tf_agent_plan_tasks (plan_id) WHERE state = 'ready';

CREATE TABLE {{schema}}.tf_agent_plan_dependencies (
  plan_id uuid NOT NULL,
  task_key text NOT NULL,
  depends_on_key text NOT NULL,
  PRIMARY KEY (plan_id, task_key, depends_on_key),
  CHECK (task_key <> depends_on_key),
  FOREIGN KEY (plan_id, task_key) REFERENCES {{schema}}.tf_agent_plan_tasks(plan_id, key) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (plan_id, depends_on_key) REFERENCES {{schema}}.tf_agent_plan_tasks(plan_id, key) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE {{schema}}.tf_agent_plan_attempts (
  id uuid PRIMARY KEY,
  plan_id uuid NOT NULL,
  task_key text NOT NULL,
  generation integer NOT NULL CHECK (generation >= 0),
  agent_id uuid REFERENCES {{schema}}.tf_agents(id),
  activation_id uuid,
  definition_revision text,
  specialist_key text,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'waiting-input', 'waiting-approval', 'yielded', 'completed', 'failed', 'cancelled')),
  lease_until timestamptz,
  agent_task_id uuid REFERENCES {{schema}}.tf_agent_tasks(id),
  result text CHECK (char_length(result) <= 16000),
  failure_code text CHECK (failure_code ~ '^[a-z0-9-]{1,64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  settled_at timestamptz,
  UNIQUE (plan_id, task_key, generation),
  FOREIGN KEY (plan_id, task_key) REFERENCES {{schema}}.tf_agent_plan_tasks(plan_id, key),
  FOREIGN KEY (plan_id, specialist_key) REFERENCES {{schema}}.tf_agent_plan_specialists(plan_id, key),
  FOREIGN KEY (activation_id, agent_id, definition_revision) REFERENCES {{schema}}.tf_agent_activations(id, agent_id, definition_revision),
  CHECK ((agent_id IS NOT NULL AND activation_id IS NOT NULL AND definition_revision IS NOT NULL AND specialist_key IS NULL)
    OR (agent_id IS NULL AND activation_id IS NULL AND definition_revision IS NULL AND specialist_key IS NOT NULL)),
  CHECK ((status IN ('running', 'waiting-input', 'waiting-approval')) = (settled_at IS NULL))
);
CREATE UNIQUE INDEX tf_agent_plan_attempts_open ON {{schema}}.tf_agent_plan_attempts (plan_id, task_key) WHERE settled_at IS NULL;
CREATE INDEX tf_agent_plan_attempts_lease ON {{schema}}.tf_agent_plan_attempts (lease_until) WHERE status = 'running';

CREATE TABLE {{schema}}.tf_agent_plan_events (
  plan_id uuid NOT NULL REFERENCES {{schema}}.tf_agent_plans(id),
  version integer NOT NULL CHECK (version >= 0),
  actor text NOT NULL CHECK (actor ~ '^(coordinator|starter|runtime|worker:[a-z0-9][a-z0-9-]{0,47})$'),
  kind text NOT NULL CHECK (kind IN ('created', 'updated', 'advanced', 'controlled')),
  changes jsonb NOT NULL CHECK (jsonb_typeof(changes) = 'array' AND octet_length(changes::text) <= 262144),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (plan_id, version)
);

CREATE TABLE {{schema}}.tf_agent_plan_commands (
  plan_id uuid NOT NULL REFERENCES {{schema}}.tf_agent_plans(id),
  request_id uuid NOT NULL,
  input_digest text NOT NULL CHECK (input_digest ~ '^[a-f0-9]{64}$'),
  receipt jsonb NOT NULL,
  PRIMARY KEY (plan_id, request_id)
);
CREATE TABLE {{schema}}.tf_agent_plan_creations (
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  request_id uuid NOT NULL,
  input_digest text NOT NULL CHECK (input_digest ~ '^[a-f0-9]{64}$'),
  plan_id uuid NOT NULL UNIQUE REFERENCES {{schema}}.tf_agent_plans(id),
  PRIMARY KEY (membership_id, request_id)
);

REVOKE ALL ON {{schema}}.tf_agent_plans, {{schema}}.tf_agent_plan_specialists, {{schema}}.tf_agent_plan_tasks,
  {{schema}}.tf_agent_plan_dependencies, {{schema}}.tf_agent_plan_attempts, {{schema}}.tf_agent_plan_events,
  {{schema}}.tf_agent_plan_commands, {{schema}}.tf_agent_plan_creations FROM PUBLIC, {{migration}}, {{customOwner}}, {{confirmation}};
GRANT SELECT, INSERT ON {{schema}}.tf_agent_plans, {{schema}}.tf_agent_plan_specialists, {{schema}}.tf_agent_plan_tasks,
  {{schema}}.tf_agent_plan_dependencies, {{schema}}.tf_agent_plan_attempts, {{schema}}.tf_agent_plan_events,
  {{schema}}.tf_agent_plan_commands, {{schema}}.tf_agent_plan_creations TO {{runtime}};
GRANT UPDATE (lifecycle, version, tool_calls, active_milliseconds, updated_at) ON {{schema}}.tf_agent_plans TO {{runtime}};
GRANT UPDATE (title, brief, criteria, agent_id, specialist_key, state, reason, updated_at) ON {{schema}}.tf_agent_plan_tasks TO {{runtime}};
GRANT UPDATE (status, lease_until, agent_task_id, result, failure_code, settled_at) ON {{schema}}.tf_agent_plan_attempts TO {{runtime}};
GRANT DELETE ON {{schema}}.tf_agent_plan_dependencies TO {{runtime}};

-- 0019_personal_memory.sql
CREATE TABLE {{schema}}.tf_personal_memory (
  membership_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_memberships (id),
  content text NOT NULL CHECK (char_length(content) <= 16000),
  revision integer NOT NULL CHECK (revision > 0)
);
REVOKE ALL ON TABLE {{schema}}.tf_personal_memory FROM PUBLIC, {{migration}}, {{customOwner}}, {{confirmation}};
GRANT SELECT, INSERT, UPDATE ON TABLE {{schema}}.tf_personal_memory TO {{runtime}};

-- 0020_skill_packages.sql
CREATE TABLE {{schema}}.tf_skill_package_objects (
  digest text PRIMARY KEY CHECK (digest ~ '^[a-f0-9]{64}$'),
  size integer NOT NULL CHECK (size BETWEEN 0 AND 10485760),
  deleting boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE {{schema}}.tf_skill_packages (
  id uuid PRIMARY KEY,
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest) = 'object'),
  instructions text NOT NULL CHECK (length(instructions) BETWEEN 1 AND 32000),
  sources jsonb NOT NULL CHECK (jsonb_typeof(sources) = 'array'),
  ready boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours')
);
CREATE TABLE {{schema}}.tf_skill_package_files (
  package_id uuid NOT NULL REFERENCES {{schema}}.tf_skill_packages(id),
  path text NOT NULL,
  digest text NOT NULL REFERENCES {{schema}}.tf_skill_package_objects(digest),
  PRIMARY KEY (package_id, path)
);
CREATE TABLE {{schema}}.tf_skill_revision_packages (
  skill_id uuid NOT NULL,
  revision text NOT NULL,
  package_id uuid NOT NULL REFERENCES {{schema}}.tf_skill_packages(id),
  PRIMARY KEY (skill_id, revision),
  FOREIGN KEY (skill_id, revision) REFERENCES {{schema}}.tf_workspace_skill_revisions(skill_id, revision)
);
CREATE INDEX tf_skill_packages_expiry ON {{schema}}.tf_skill_packages(expires_at);
CREATE INDEX tf_skill_package_files_digest ON {{schema}}.tf_skill_package_files(digest);
CREATE INDEX tf_skill_revision_packages_package ON {{schema}}.tf_skill_revision_packages(package_id);
REVOKE ALL ON TABLE {{schema}}.tf_skill_package_objects, {{schema}}.tf_skill_packages,
  {{schema}}.tf_skill_package_files, {{schema}}.tf_skill_revision_packages
  FROM PUBLIC, {{migration}}, {{customOwner}}, {{confirmation}};
GRANT SELECT, INSERT, DELETE ON TABLE {{schema}}.tf_skill_package_objects,
  {{schema}}.tf_skill_package_files TO {{runtime}};
GRANT UPDATE(deleting) ON TABLE {{schema}}.tf_skill_package_objects TO {{runtime}};
GRANT SELECT, INSERT, DELETE ON TABLE {{schema}}.tf_skill_packages TO {{runtime}};
GRANT UPDATE(ready) ON {{schema}}.tf_skill_packages TO {{runtime}};
GRANT SELECT, INSERT ON TABLE {{schema}}.tf_skill_revision_packages TO {{runtime}};

CREATE TABLE {{schema}}.tf_skill_imports (
  id uuid PRIMARY KEY,
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  input jsonb NOT NULL,
  sources jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','preparing','discovered','pending-review','reviewing','ready','links','page','failed','cancelled','installed','unchanged')),
  candidates jsonb NOT NULL DEFAULT '[]',
  selected jsonb NOT NULL DEFAULT '[]',
  links jsonb NOT NULL DEFAULT '[]',
  digest text CHECK (digest ~ '^[a-f0-9]{64}$'),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours')
);
CREATE TABLE {{schema}}.tf_skill_import_decisions (
  import_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_skill_imports(id),
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  command_id uuid NOT NULL,
  input jsonb NOT NULL,
  receipts jsonb NOT NULL,
  UNIQUE(membership_id, command_id)
);
CREATE INDEX tf_skill_imports_pending ON {{schema}}.tf_skill_imports(status, created_at);
REVOKE ALL ON TABLE {{schema}}.tf_skill_imports, {{schema}}.tf_skill_import_decisions
  FROM PUBLIC, {{migration}}, {{customOwner}}, {{confirmation}};
GRANT SELECT, INSERT ON TABLE {{schema}}.tf_skill_imports, {{schema}}.tf_skill_import_decisions TO {{runtime}};
GRANT UPDATE(status, candidates, selected, links, digest, error, started_at) ON {{schema}}.tf_skill_imports TO {{runtime}};

CREATE TABLE {{schema}}.tf_skill_package_provenance (
  skill_id uuid NOT NULL,
  revision text NOT NULL,
  import_id uuid NOT NULL REFERENCES {{schema}}.tf_skill_imports(id),
  provenance jsonb NOT NULL CHECK (jsonb_typeof(provenance) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (skill_id, revision),
  FOREIGN KEY (skill_id, revision) REFERENCES {{schema}}.tf_workspace_skill_revisions(skill_id, revision)
);
REVOKE ALL ON TABLE {{schema}}.tf_skill_package_provenance FROM PUBLIC, {{migration}}, {{customOwner}}, {{confirmation}};
GRANT SELECT, INSERT ON TABLE {{schema}}.tf_skill_package_provenance TO {{runtime}};

CREATE TABLE {{schema}}.tf_skill_invocations (
  id uuid PRIMARY KEY,
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  skill_id uuid NOT NULL,
  revision text NOT NULL,
  request jsonb NOT NULL,
  sources jsonb NOT NULL,
  scope jsonb NOT NULL,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (skill_id, revision) REFERENCES {{schema}}.tf_workspace_skill_revisions(skill_id, revision)
);
CREATE TABLE {{schema}}.tf_file_skill_sources (
  file_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_files(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  invocation_id uuid NOT NULL REFERENCES {{schema}}.tf_skill_invocations(id),
  sources jsonb NOT NULL CHECK (jsonb_typeof(sources) = 'array')
);
REVOKE ALL ON TABLE {{schema}}.tf_skill_invocations, {{schema}}.tf_file_skill_sources FROM PUBLIC, {{migration}}, {{customOwner}}, {{confirmation}};
GRANT SELECT, INSERT ON TABLE {{schema}}.tf_skill_invocations, {{schema}}.tf_file_skill_sources TO {{runtime}};
GRANT UPDATE(result) ON TABLE {{schema}}.tf_skill_invocations TO {{runtime}};

-- 0021_agent_plan_allowances.sql
-- Each plan attempt holds its share of the plan budget, so parallel workers cannot jointly spend more than the plan allows.
ALTER TABLE {{schema}}.tf_agent_plan_attempts
  ADD COLUMN allowance jsonb CHECK (allowance IS NULL OR jsonb_typeof(allowance) = 'object'),
  ADD COLUMN tool_calls integer NOT NULL DEFAULT 0 CHECK (tool_calls >= 0),
  ADD COLUMN active_milliseconds bigint NOT NULL DEFAULT 0 CHECK (active_milliseconds >= 0),
  ADD COLUMN sources jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(sources) = 'array' AND octet_length(sources::text) <= 262144);

GRANT UPDATE (tool_calls, active_milliseconds, sources) ON {{schema}}.tf_agent_plan_attempts TO {{runtime}};

-- 0022_table_search_credit_activity.sql
ALTER TABLE {{schema}}.tf_credit_usage
  DROP CONSTRAINT tf_credit_usage_activity_check,
  ADD CONSTRAINT tf_credit_usage_activity_check CHECK (activity IN ('chat','agent','other','table-search'));

-- 0023_table_query_translations.sql
CREATE TABLE {{schema}}.tf_table_query_translations (
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships (id),
  request_id uuid NOT NULL,
  user_id text NOT NULL,
  table_id uuid NOT NULL,
  revision text NOT NULL CHECK (revision ~ '^[a-f0-9]{40}$'),
  input_digest text NOT NULL CHECK (input_digest ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('dispatching','completed','failed','uncertain')),
  billing text NOT NULL DEFAULT 'held' CHECK (billing IN ('held','settled','released')),
  billing_flow_id text NOT NULL CHECK (billing_flow_id ~ '^table-search:[0-9a-f-]{36}:[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  billing_attempt_id text NOT NULL UNIQUE CHECK (char_length(billing_attempt_id) BETWEEN 1 AND 200),
  model_id text NOT NULL CHECK (char_length(model_id) BETWEEN 1 AND 100),
  pricing_revision text NOT NULL CHECK (char_length(pricing_revision) BETWEEN 1 AND 100),
  result jsonb CHECK (result IS NULL OR (jsonb_typeof(result) = 'object' AND octet_length(result::text) <= 65536)),
  failure text CHECK (failure IS NULL OR failure ~ '^[a-z][a-z-]{0,63}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  cleared_at timestamptz,
  PRIMARY KEY (membership_id, request_id),
  CHECK (state <> 'completed' OR result IS NOT NULL OR cleared_at IS NOT NULL)
);
CREATE INDEX tf_table_query_translations_recent ON {{schema}}.tf_table_query_translations (created_at);
CREATE INDEX tf_table_query_translations_member ON {{schema}}.tf_table_query_translations (membership_id, created_at);
CREATE INDEX tf_table_query_translations_flow ON {{schema}}.tf_table_query_translations (billing_flow_id);
REVOKE ALL ON TABLE {{schema}}.tf_table_query_translations FROM PUBLIC, {{migration}}, {{customOwner}}, {{confirmation}};
GRANT SELECT, INSERT ON TABLE {{schema}}.tf_table_query_translations TO {{runtime}};
GRANT UPDATE (state, billing, result, failure, updated_at, cleared_at) ON TABLE {{schema}}.tf_table_query_translations TO {{runtime}};

-- 0024_agent_plan_controls.sql
-- The plan starter may raise a paused plan's budget when they resume it. Budgets never fall below what was spent.
GRANT UPDATE (budget) ON {{schema}}.tf_agent_plans TO {{runtime}};

-- 0025_conversation_delete.sql
ALTER TABLE {{schema}}.tf_conversations ADD COLUMN deleted_at timestamptz;
DROP INDEX {{schema}}.tf_conversations_owner_activity;
CREATE INDEX tf_conversations_owner_activity ON {{schema}}.tf_conversations
  (owner_membership_id, (archived_at IS NOT NULL), activity_at DESC, id DESC) WHERE deleted_at IS NULL;
GRANT UPDATE (deleted_at) ON {{schema}}.tf_conversations TO {{runtime}};
ALTER TABLE {{schema}}.tf_conversation_commands
  DROP CONSTRAINT tf_conversation_commands_operation_check,
  ADD CONSTRAINT tf_conversation_commands_operation_check
    CHECK (operation IN ('create', 'send', 'rename', 'archive', 'delete', 'retry', 'cancel', 'answer', 'cancel-request', 'approval', 'move'));

-- 0026_internal_admin_team.sql
-- Internal teams are named with a leading underscore and are hidden from team management.
-- _admin holds every active admin so a workspace can own assets before anyone creates a team.
INSERT INTO {{schema}}.tf_teams (id, name)
SELECT gen_random_uuid(), '_admin'
WHERE NOT EXISTS (SELECT 1 FROM {{schema}}.tf_teams WHERE name = '_admin');

INSERT INTO {{schema}}.tf_member_teams (membership_id, team_id)
SELECT m.id, t.id
FROM {{schema}}.tf_memberships m
JOIN {{schema}}.tf_teams t ON t.name = '_admin'
WHERE m.role = 'admin' AND m.removed_at IS NULL
ON CONFLICT DO NOTHING;

-- 0027_agent_task_pause_reasons.sql
ALTER TABLE {{schema}}.tf_agent_tasks
  ADD COLUMN pause_reason text CHECK (pause_reason IN (
    'user', 'limit.toolCalls', 'limit.activeTime', 'limit.credits',
    'limit.steps', 'limit.workspaceCredits', 'model', 'context', 'file', 'plan', 'approval'
  ));

GRANT UPDATE (pause_reason) ON {{schema}}.tf_agent_tasks TO {{runtime}};

CREATE FUNCTION {{schema}}.tf_clear_task_pause_reason() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.status <> 'paused' THEN
    NEW.pause_reason := NULL;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION {{schema}}.tf_clear_task_pause_reason() FROM PUBLIC;

CREATE TRIGGER tf_clear_task_pause_reason
BEFORE INSERT OR UPDATE OF status, pause_reason ON {{schema}}.tf_agent_tasks
FOR EACH ROW EXECUTE FUNCTION {{schema}}.tf_clear_task_pause_reason();

-- 0028_workflow_slack_actions.sql
CREATE TABLE {{schema}}.tf_slack_workflow_actions (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES {{schema}}.tf_workflow_runs(id),
  workflow_id uuid NOT NULL,
  revision uuid NOT NULL,
  step_id text NOT NULL,
  action jsonb NOT NULL,
  UNIQUE(run_id,step_id),
  FOREIGN KEY(workflow_id,revision) REFERENCES {{schema}}.tf_workflow_revisions(workflow_id,id),
  FOREIGN KEY(run_id,step_id) REFERENCES {{schema}}.tf_workflow_steps(run_id,step_id)
);
REVOKE ALL ON {{schema}}.tf_slack_workflow_actions FROM PUBLIC;
GRANT SELECT,INSERT ON {{schema}}.tf_slack_workflow_actions TO {{runtime}};
GRANT UPDATE(due_at) ON {{schema}}.tf_workflow_steps TO {{runtime}};

CREATE OR REPLACE FUNCTION {{schema}}.tf_slack_action_origin() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM {{schema}}.tf_agent_tool_calls WHERE id=NEW.id AND run_id=NEW.run_id AND call=NEW.action)
     AND NOT EXISTS (SELECT 1 FROM {{schema}}.tf_slack_conversation_actions WHERE id=NEW.id AND turn_id=NEW.run_id AND action=NEW.action)
     AND NOT EXISTS (
       SELECT 1 FROM {{schema}}.tf_slack_workflow_actions o
       JOIN {{schema}}.tf_workflow_runs r ON r.id=o.run_id AND r.workflow_id=o.workflow_id AND r.revision=o.revision
       JOIN {{schema}}.tf_workflow_revisions d ON d.workflow_id=r.workflow_id AND d.id=r.revision
       JOIN {{schema}}.tf_workflow_steps s ON s.run_id=r.id AND s.step_id=o.step_id
       WHERE o.id=NEW.id AND o.run_id=NEW.run_id AND o.action=NEW.action
         AND NEW.action->>'tool'='slack.message.send'
         AND NEW.approval_required
         AND r.membership_id=NEW.membership_id AND s.status='waiting'
         AND EXISTS (SELECT 1 FROM jsonb_array_elements(d.definition->'steps') step
           WHERE step->>'id'=o.step_id AND step->>'kind'='slack-message'
             AND step->>'destinationId'=NEW.action->>'destinationId')
     ) THEN
    RAISE EXCEPTION 'Slack action requires an exact persisted origin';
  END IF;
  RETURN NEW;
END
$$;
ALTER TABLE {{schema}}.tf_slack_action_effects ADD COLUMN sent_message_ts text
  CHECK(sent_message_ts IS NULL OR sent_message_ts ~ '^[0-9]{1,16}\.[0-9]{6}$');

-- 0029_workflow_row_events.sql
CREATE TABLE {{schema}}.tf_workflow_row_events (
  workflow_id uuid NOT NULL,
  revision uuid NOT NULL,
  history_id uuid NOT NULL,
  table_id uuid NOT NULL,
  changed_at timestamptz NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  snapshot jsonb,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','blocked','admitted','ignored','cancelled')),
  reason text CHECK (reason IN ('capacity','values-too-large','values-unavailable','workflow-disabled','revision-replaced','workflow-archived','user-cancelled')),
  attempted_at timestamptz,
  settled_at timestamptz,
  run_id uuid REFERENCES {{schema}}.tf_workflow_runs(id),
  PRIMARY KEY (workflow_id,revision,history_id),
  FOREIGN KEY (workflow_id,revision) REFERENCES {{schema}}.tf_workflow_revisions(workflow_id,id),
  CHECK ((state IN ('admitted','ignored','cancelled')) = (settled_at IS NOT NULL))
);
CREATE INDEX tf_workflow_row_events_pending ON {{schema}}.tf_workflow_row_events
  (workflow_id,revision,attempted_at NULLS FIRST,changed_at,history_id) WHERE settled_at IS NULL;
REVOKE ALL ON {{schema}}.tf_workflow_row_events FROM PUBLIC;
GRANT SELECT ON {{schema}}.tf_workflow_row_events TO {{runtime}};
GRANT UPDATE (state,reason,attempted_at,settled_at,run_id,snapshot) ON {{schema}}.tf_workflow_row_events TO {{runtime}};

-- The snapshot, not table history or a generation, owns pending-event retention.
-- Capture shares the mutation transaction, including imports and restores.
CREATE FUNCTION {{schema}}.tf_workflow_capture_row_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  workflow record;
  files jsonb;
BEGIN
  IF NEW.operation='transform' THEN RETURN NEW; END IF;
  SELECT COALESCE(jsonb_agg(f->>'id'),'[]'::jsonb) INTO files
    FROM {{schema}}.tf_table_generations g CROSS JOIN LATERAL jsonb_array_elements(g.definition->'fields') f
    WHERE g.id=NEW.generation_id AND f->>'kind'='file';
  FOR workflow IN
    SELECT w.id,w.active_revision,r.definition->'trigger' AS trigger
    FROM {{schema}}.tf_workflows w JOIN {{schema}}.tf_workflow_revisions r ON r.workflow_id=w.id AND r.id=w.active_revision
    WHERE w.enabled AND w.archived_at IS NULL AND r.definition->'trigger'->>'kind'='row'
      AND r.definition->'trigger'->>'tableId'=NEW.table_id::text
      AND EXISTS (SELECT 1 FROM {{schema}}.tf_table_generations g WHERE g.id=NEW.generation_id AND g.state='active')
    ORDER BY w.id FOR SHARE OF w
  LOOP
    IF NOT (
      (workflow.trigger->>'event'='created' AND (NEW.operation='create' OR NEW.operation='restore' AND NEW.before_values IS NULL))
      OR (workflow.trigger->>'event'='updated' AND (NEW.operation='update' OR NEW.operation='restore' AND NEW.before_values IS NOT NULL) AND cardinality(NEW.field_ids)>0)
      OR (workflow.trigger->>'event'='deleted' AND NEW.operation='delete')
    ) THEN CONTINUE; END IF;
    IF workflow.trigger ? 'fieldIds' AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(workflow.trigger->'fieldIds') f WHERE f::uuid=ANY(NEW.field_ids)
    ) THEN CONTINUE; END IF;
    INSERT INTO {{schema}}.tf_workflow_row_events(workflow_id,revision,history_id,table_id,changed_at,snapshot)
      VALUES(workflow.id,workflow.active_revision,NEW.id,NEW.table_id,NEW.created_at,
        jsonb_build_object('row_id',NEW.row_id,'token',NEW.token,'field_ids',NEW.field_ids,
          'values',NEW.values,'before_values',NEW.before_values,'file_fields',files))
      ON CONFLICT DO NOTHING;
  END LOOP;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION {{schema}}.tf_workflow_capture_row_event() FROM PUBLIC;
CREATE TRIGGER tf_workflow_capture_row_event AFTER INSERT ON {{schema}}.tf_table_row_history_data
  FOR EACH ROW EXECUTE FUNCTION {{schema}}.tf_workflow_capture_row_event();

-- Only already accepted occurrences migrate; activation never replays old history.
INSERT INTO {{schema}}.tf_workflow_row_events(workflow_id,revision,history_id,table_id,changed_at,snapshot,state,reason,settled_at)
  SELECT o.workflow_id,o.revision,o.record_id,(r.definition->'trigger'->>'tableId')::uuid,o.due_at,
    CASE WHEN h.values IS NOT NULL THEN
      jsonb_build_object('row_id',h.row_id,'token',h.token,'field_ids',h.field_ids,'values',h.values,'before_values',h.before_values,
        'file_fields',COALESCE((SELECT jsonb_agg(f->>'id') FROM jsonb_array_elements(g.definition->'fields') f WHERE f->>'kind'='file'),'[]'::jsonb)) END,
    CASE WHEN w.archived_at IS NOT NULL OR w.active_revision IS DISTINCT FROM o.revision OR NOT w.enabled OR h.values IS NULL THEN 'blocked' ELSE 'pending' END,
    CASE WHEN w.archived_at IS NOT NULL THEN 'workflow-archived' WHEN w.active_revision IS DISTINCT FROM o.revision THEN 'revision-replaced'
      WHEN NOT w.enabled THEN 'workflow-disabled' WHEN h.values IS NULL THEN 'values-unavailable' END,
    NULL
  FROM {{schema}}.tf_workflow_record_occurrences o
  JOIN {{schema}}.tf_workflow_revisions r ON r.workflow_id=o.workflow_id AND r.id=o.revision
  JOIN {{schema}}.tf_workflows w ON w.id=o.workflow_id
  LEFT JOIN {{schema}}.tf_table_row_history_data h ON h.id=o.record_id
  LEFT JOIN {{schema}}.tf_table_generations g ON g.id=h.generation_id
  WHERE o.fired_at IS NULL AND r.definition->'trigger'->>'kind'='row'
  ON CONFLICT DO NOTHING;
DELETE FROM {{schema}}.tf_workflow_record_occurrences o USING {{schema}}.tf_workflow_revisions r
  WHERE r.workflow_id=o.workflow_id AND r.id=o.revision AND r.definition->'trigger'->>'kind'='row';

CREATE FUNCTION {{schema}}.tf_workflow_row_event_lifecycle() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.archived_at IS NOT NULL OR NEW.active_revision IS DISTINCT FROM OLD.active_revision THEN
    UPDATE {{schema}}.tf_workflow_row_events SET state='blocked',
      reason=CASE WHEN NEW.archived_at IS NOT NULL THEN 'workflow-archived' ELSE 'revision-replaced' END
      WHERE workflow_id=NEW.id AND settled_at IS NULL
        AND (NEW.archived_at IS NOT NULL OR revision IS DISTINCT FROM NEW.active_revision);
  END IF;
  IF NOT NEW.enabled THEN
    UPDATE {{schema}}.tf_workflow_row_events SET state='blocked',reason='workflow-disabled'
      WHERE workflow_id=NEW.id AND revision=NEW.active_revision AND settled_at IS NULL AND NEW.archived_at IS NULL;
  ELSIF NOT OLD.enabled THEN
    UPDATE {{schema}}.tf_workflow_row_events SET state='pending',reason=NULL,attempted_at=NULL
      WHERE workflow_id=NEW.id AND revision=NEW.active_revision AND settled_at IS NULL AND reason='workflow-disabled';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION {{schema}}.tf_workflow_row_event_lifecycle() FROM PUBLIC;
CREATE TRIGGER tf_workflow_row_event_lifecycle AFTER UPDATE OF enabled,active_revision,archived_at ON {{schema}}.tf_workflows
  FOR EACH ROW EXECUTE FUNCTION {{schema}}.tf_workflow_row_event_lifecycle();

-- 0030_event_driven_recommendations.sql
ALTER TABLE {{schema}}.tf_recommendation_snapshots
  ADD COLUMN onboarding boolean NOT NULL DEFAULT false,
  ADD COLUMN generation bigint NOT NULL DEFAULT 0,
  ADD COLUMN policy text NOT NULL DEFAULT 'legacy',
  ADD COLUMN sources jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(sources) = 'array');

CREATE TABLE {{schema}}.tf_recommendation_refresh (
  membership_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_memberships(id),
  generation bigint NOT NULL CHECK (generation > 0),
  status text NOT NULL CHECK (status IN ('pending','running','ready','failed','budget-paused','unavailable')),
  first_event_at timestamptz,
  due_at timestamptz,
  claimed_generation bigint,
  attempt_id uuid,
  claimed_at timestamptz,
  error_code text,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((claimed_generation IS NULL) = (attempt_id IS NULL)),
  CHECK ((claimed_generation IS NULL) = (claimed_at IS NULL))
);
CREATE INDEX tf_recommendation_refresh_due ON {{schema}}.tf_recommendation_refresh(due_at,membership_id)
  WHERE due_at IS NOT NULL;

CREATE TABLE {{schema}}.tf_recommendation_events (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('definition','connection','memory','knowledge','file','rows','membership','project','settings','seed','repair')),
  source_id text NOT NULL CHECK (length(source_id) BETWEEN 1 AND 256),
  membership_ids uuid[] NOT NULL,
  audience_digest bytea NOT NULL CHECK (octet_length(audience_digest)=32),
  invalidate boolean NOT NULL,
  compacted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX tf_recommendation_events_created ON {{schema}}.tf_recommendation_events(created_at,id);
CREATE INDEX tf_recommendation_events_compaction ON {{schema}}.tf_recommendation_events(created_at,id)
  WHERE compacted_at IS NULL;

CREATE TABLE {{schema}}.tf_recommendation_expiries (
  invitation_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_invitations(id),
  expires_at timestamptz NOT NULL,
  delivered_at timestamptz
);
CREATE INDEX tf_recommendation_expiries_due ON {{schema}}.tf_recommendation_expiries(expires_at,invitation_id)
  WHERE delivered_at IS NULL;

CREATE TABLE {{schema}}.tf_recommendation_results (
  membership_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_memberships(id),
  attempt_id uuid UNIQUE NOT NULL,
  generation bigint NOT NULL CHECK (generation > 0),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  onboarding boolean NOT NULL,
  items jsonb NOT NULL CHECK (jsonb_typeof(items)='array'),
  sources jsonb NOT NULL CHECK (jsonb_typeof(sources)='array')
);

CREATE TABLE {{schema}}.tf_recommendation_dependencies (
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  source_id text NOT NULL CHECK (length(source_id) BETWEEN 1 AND 256),
  PRIMARY KEY(membership_id,source_id)
);
CREATE INDEX tf_recommendation_dependencies_source ON {{schema}}.tf_recommendation_dependencies(source_id,membership_id);

CREATE FUNCTION {{schema}}.record_recommendation_change(
  event_id uuid, event_kind text, event_source_id text, members uuid[], invalidate boolean
) RETURNS boolean LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE
  member_id uuid;
  next_generation bigint;
  workspace_id uuid := regexp_replace(replace('{{schema}}','"',''),'^ws_','')::uuid;
  event_time timestamptz := clock_timestamp();
  audience uuid[];
BEGIN
  INSERT INTO {{schema}}.tf_recommendation_events(id,kind,source_id,membership_ids,audience_digest,invalidate)
    VALUES(event_id,event_kind,event_source_id,members,sha256(convert_to(members::text,'UTF8')),invalidate) ON CONFLICT(id) DO NOTHING;
  IF NOT FOUND THEN
    IF NOT EXISTS(SELECT 1 FROM {{schema}}.tf_recommendation_events e WHERE e.id=event_id
      AND e.kind=event_kind AND e.source_id=event_source_id AND e.audience_digest=sha256(convert_to(members::text,'UTF8'))
      AND e.invalidate=record_recommendation_change.invalidate) THEN
      RAISE EXCEPTION 'recommendation-event-conflict' USING ERRCODE='23505';
    END IF;
    RETURN false;
  END IF;
  SELECT array_agg(id ORDER BY id) INTO audience FROM (
    SELECT unnest(members) AS id
    UNION SELECT d.membership_id FROM {{schema}}.tf_recommendation_dependencies d
      WHERE record_recommendation_change.invalidate AND event_kind<>'memory'
        AND (d.source_id=event_source_id OR (event_kind='membership' AND d.source_id=ANY(members::text[])))
  ) recipients;
  FOREACH member_id IN ARRAY COALESCE(audience,'{}'::uuid[]) LOOP
    IF NOT EXISTS(SELECT 1 FROM {{schema}}.tf_memberships WHERE id=member_id) THEN CONTINUE; END IF;
    INSERT INTO {{schema}}.tf_recommendation_refresh AS r
      (membership_id,generation,status,first_event_at,due_at,updated_at)
      VALUES(member_id,1,'pending',event_time,event_time+interval '30 seconds',event_time)
      ON CONFLICT(membership_id) DO UPDATE SET
        generation=r.generation+1,status='pending',
        first_event_at=COALESCE(r.first_event_at,EXCLUDED.first_event_at),
        due_at=COALESCE(r.due_at,EXCLUDED.due_at),error_code=NULL,updated_at=event_time
      RETURNING generation INTO next_generation;
    IF invalidate THEN
      DELETE FROM {{schema}}.tf_recommendation_snapshots WHERE membership_id=member_id;
      DELETE FROM {{schema}}.tf_recommendation_results WHERE membership_id=member_id;
      DELETE FROM {{schema}}.tf_recommendation_dependencies WHERE membership_id=member_id;
    END IF;
    PERFORM pg_notify('tulipfarm_recommendations_v1',json_build_object(
      'workspaceId',workspace_id,'membershipId',member_id,'version',next_generation,
      'kind',CASE WHEN invalidate THEN 'invalidated' ELSE 'changed' END)::text);
  END LOOP;
  RETURN true;
END
$$;
REVOKE ALL ON FUNCTION {{schema}}.record_recommendation_change(uuid,text,text,uuid[],boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION {{schema}}.record_recommendation_change(uuid,text,text,uuid[],boolean) TO {{runtime}},{{migration}},{{customOwner}};
REVOKE ALL ON TABLE {{schema}}.tf_recommendation_refresh,{{schema}}.tf_recommendation_events,{{schema}}.tf_recommendation_expiries,{{schema}}.tf_recommendation_results,{{schema}}.tf_recommendation_dependencies
  FROM PUBLIC,{{runtime}},{{migration}},{{customOwner}},{{confirmation}};
GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE
  {{schema}}.tf_recommendation_refresh,{{schema}}.tf_recommendation_events,{{schema}}.tf_recommendation_expiries,{{schema}}.tf_recommendation_results,{{schema}}.tf_recommendation_dependencies TO {{runtime}};
GRANT SELECT,INSERT,UPDATE ON TABLE {{schema}}.tf_recommendation_refresh TO {{migration}},{{customOwner}};
GRANT SELECT,INSERT ON TABLE {{schema}}.tf_recommendation_events TO {{migration}},{{customOwner}};
GRANT SELECT(membership_id),DELETE ON TABLE {{schema}}.tf_recommendation_snapshots TO {{migration}},{{customOwner}};
GRANT SELECT(membership_id),DELETE ON TABLE {{schema}}.tf_recommendation_results TO {{migration}},{{customOwner}};
GRANT SELECT,DELETE ON TABLE {{schema}}.tf_recommendation_dependencies TO {{migration}},{{customOwner}};

-- 0031_slack_direct_actions.sql
-- Slack send, reply, and reaction no longer require approval.
UPDATE {{schema}}.tf_agents SET slack_approval='direct' WHERE slack_approval<>'direct';
ALTER TABLE {{schema}}.tf_agents ALTER COLUMN slack_approval SET DEFAULT 'direct';
UPDATE {{schema}}.tf_slack_destinations SET approval_required=false WHERE approval_required;
ALTER TABLE {{schema}}.tf_slack_destinations ALTER COLUMN approval_required SET DEFAULT false;

CREATE OR REPLACE FUNCTION {{schema}}.tf_slack_action_origin() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM {{schema}}.tf_agent_tool_calls WHERE id=NEW.id AND run_id=NEW.run_id AND call=NEW.action)
     AND NOT EXISTS (SELECT 1 FROM {{schema}}.tf_slack_conversation_actions WHERE id=NEW.id AND turn_id=NEW.run_id AND action=NEW.action)
     AND NOT EXISTS (
       SELECT 1 FROM {{schema}}.tf_slack_workflow_actions o
       JOIN {{schema}}.tf_workflow_runs r ON r.id=o.run_id AND r.workflow_id=o.workflow_id AND r.revision=o.revision
       JOIN {{schema}}.tf_workflow_revisions d ON d.workflow_id=r.workflow_id AND d.id=r.revision
       JOIN {{schema}}.tf_workflow_steps s ON s.run_id=r.id AND s.step_id=o.step_id
       WHERE o.id=NEW.id AND o.run_id=NEW.run_id AND o.action=NEW.action
         AND NEW.action->>'tool'='slack.message.send'
         AND r.membership_id=NEW.membership_id AND s.status='waiting'
         AND EXISTS (SELECT 1 FROM jsonb_array_elements(d.definition->'steps') step
           WHERE step->>'id'=o.step_id AND step->>'kind'='slack-message'
             AND step->>'destinationId'=NEW.action->>'destinationId')
     ) THEN
    RAISE EXCEPTION 'Slack action requires an exact persisted origin';
  END IF;
  RETURN NEW;
END
$$;

-- 0032_slack_sender.sql
-- Who appears as the Slack author: the requester's linked account or the TulipFarm app.
-- Existing agents and actions keep the linked account they already used.
ALTER TABLE {{schema}}.tf_agents ADD COLUMN slack_sender text NOT NULL DEFAULT 'user' CHECK(slack_sender IN ('user','app'));
GRANT UPDATE(slack_sender) ON {{schema}}.tf_agents TO {{runtime}};
ALTER TABLE {{schema}}.tf_slack_actions ADD COLUMN sender text NOT NULL DEFAULT 'user' CHECK(sender IN ('user','app'));

-- 0033_workflow_slack_approval.sql
CREATE OR REPLACE FUNCTION {{schema}}.tf_slack_action_origin() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM {{schema}}.tf_agent_tool_calls WHERE id=NEW.id AND run_id=NEW.run_id AND call=NEW.action)
     AND NOT EXISTS (SELECT 1 FROM {{schema}}.tf_slack_conversation_actions WHERE id=NEW.id AND turn_id=NEW.run_id AND action=NEW.action)
     AND NOT EXISTS (
       SELECT 1 FROM {{schema}}.tf_slack_workflow_actions o
       JOIN {{schema}}.tf_workflow_runs r ON r.id=o.run_id AND r.workflow_id=o.workflow_id AND r.revision=o.revision
       JOIN {{schema}}.tf_workflow_revisions d ON d.workflow_id=r.workflow_id AND d.id=r.revision
       JOIN {{schema}}.tf_workflow_steps s ON s.run_id=r.id AND s.step_id=o.step_id
       WHERE o.id=NEW.id AND o.run_id=NEW.run_id AND o.action=NEW.action
         AND NEW.action->>'tool'='slack.message.send'
         AND NEW.approval_required
         AND r.membership_id=NEW.membership_id AND s.status='waiting'
         AND EXISTS (SELECT 1 FROM jsonb_array_elements(d.definition->'steps') step
           WHERE step->>'id'=o.step_id AND step->>'kind'='slack-message'
             AND step->>'destinationId'=NEW.action->>'destinationId')
     ) THEN
    RAISE EXCEPTION 'Slack action requires an exact persisted origin';
  END IF;
  RETURN NEW;
END
$$;

UPDATE {{schema}}.tf_slack_actions a
SET approval_required=true
FROM {{schema}}.tf_slack_workflow_actions o, {{schema}}.tf_slack_action_effects e
WHERE o.id=a.id AND o.run_id=a.run_id AND e.action_id=a.id
  AND NOT a.approval_required
  AND e.state IN ('pending','retry','sending','reauthorization-required');

-- 0034_knowledge_query_task_flow.sql
-- Background embedding workers read the task flow from the search row, so task budgets include their cost.
ALTER TABLE {{schema}}.tf_knowledge_search_queries ADD COLUMN task_flow_id text;

-- 0035_chat_choices.sql
ALTER TABLE {{schema}}.tf_conversation_requests ALTER COLUMN internal_id DROP NOT NULL;
CREATE UNIQUE INDEX tf_conversation_chat_request_producer
  ON {{schema}}.tf_conversation_requests(turn_id, producer_id) WHERE internal_id IS NULL;

-- 0036_chat_latency.sql
ALTER TABLE {{schema}}.tf_conversation_turns
  ADD COLUMN timing_started_at timestamptz,
  ADD COLUMN timing_state_since timestamptz,
  ADD COLUMN timing_claimed_at timestamptz,
  ADD COLUMN timing_dispatched_at timestamptz,
  ADD COLUMN timing_first_text_at timestamptz,
  ADD COLUMN timing_first_text_seconds double precision,
  ADD COLUMN timing_finished_at timestamptz,
  ADD COLUMN timing_queue_seconds double precision NOT NULL DEFAULT 0,
  ADD COLUMN timing_processing_seconds double precision NOT NULL DEFAULT 0,
  ADD COLUMN timing_human_wait_seconds double precision NOT NULL DEFAULT 0,
  ADD COLUMN timing_external_wait_seconds double precision NOT NULL DEFAULT 0,
  ADD COLUMN timing_inactive_seconds double precision NOT NULL DEFAULT 0,
  ADD COLUMN timing_attempts integer NOT NULL DEFAULT 0;

CREATE FUNCTION {{schema}}.tf_conversation_timing() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE
  stamp timestamptz := clock_timestamp();
  elapsed double precision;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT created_at INTO NEW.timing_started_at FROM {{schema}}.tf_conversation_messages WHERE id=NEW.source_message_id;
    NEW.timing_state_since := NEW.timing_started_at;
    NEW.timing_attempts := NEW.attempts;
  ELSE
    -- Old turns have no measured wait history; do not invent it during rollout.
    IF OLD.timing_started_at IS NULL THEN RETURN NEW; END IF;
    IF OLD.status IN ('completed','failed','cancelled','blocked') AND NEW.status IN ('completed','failed','cancelled','blocked') THEN RETURN NEW; END IF;
    elapsed := greatest(0,extract(epoch FROM stamp-OLD.timing_state_since));
    IF OLD.status='queued' THEN
      NEW.timing_queue_seconds := OLD.timing_queue_seconds+elapsed;
    ELSIF OLD.status='processing' THEN
      NEW.timing_processing_seconds := OLD.timing_processing_seconds+elapsed;
    ELSIF OLD.status='waiting' AND COALESCE(OLD.error_code,'') NOT IN ('slack-action-waiting','mcp-action-waiting') THEN
      NEW.timing_human_wait_seconds := OLD.timing_human_wait_seconds+elapsed;
    ELSIF OLD.status IN ('waiting','reconciling') THEN
      NEW.timing_external_wait_seconds := OLD.timing_external_wait_seconds+elapsed;
    ELSE
      NEW.timing_inactive_seconds := OLD.timing_inactive_seconds+elapsed;
    END IF;
    NEW.timing_state_since := stamp;
    NEW.timing_attempts := OLD.timing_attempts+greatest(0,NEW.attempts-OLD.attempts);
  END IF;
  IF NEW.status='processing' THEN NEW.timing_claimed_at := COALESCE(NEW.timing_claimed_at,stamp); END IF;
  IF NEW.status IN ('completed','failed','cancelled','blocked') THEN
    NEW.timing_finished_at := COALESCE(NEW.timing_finished_at,stamp);
  ELSE
    NEW.timing_finished_at := NULL;
  END IF;
  IF NEW.status='completed' THEN NEW.timing_first_text_at := COALESCE(NEW.timing_first_text_at,stamp); END IF;
  IF NEW.timing_first_text_at IS NOT NULL AND NEW.timing_first_text_seconds IS NULL THEN
    NEW.timing_first_text_seconds := greatest(0,extract(epoch FROM NEW.timing_first_text_at-NEW.timing_started_at)
      -NEW.timing_human_wait_seconds-NEW.timing_inactive_seconds);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tf_conversation_timing
BEFORE INSERT OR UPDATE OF status,error_code,attempts,timing_first_text_at ON {{schema}}.tf_conversation_turns
FOR EACH ROW EXECUTE FUNCTION {{schema}}.tf_conversation_timing();

GRANT UPDATE(timing_first_text_at,timing_dispatched_at) ON {{schema}}.tf_conversation_turns TO {{runtime}};
CREATE INDEX tf_conversation_timing_finished ON {{schema}}.tf_conversation_turns(timing_finished_at)
  WHERE timing_started_at IS NOT NULL;

-- 0037_conversation_maintenance.sql
ALTER TABLE {{schema}}.tf_conversations
  ADD COLUMN is_closed boolean NOT NULL DEFAULT false,
  ADD COLUMN activity_generation integer NOT NULL DEFAULT 0 CHECK (activity_generation >= 0);
GRANT UPDATE (is_closed, activity_generation) ON {{schema}}.tf_conversations TO {{runtime}};
CREATE INDEX tf_conversations_inactivity ON {{schema}}.tf_conversations (activity_at, id)
  WHERE kind = 'private' AND deleted_at IS NULL AND NOT is_closed;

ALTER TABLE {{schema}}.tf_conversation_compactions ALTER COLUMN turn_id DROP NOT NULL;
ALTER TABLE {{schema}}.tf_conversation_compactions DROP CONSTRAINT tf_conversation_compactions_trigger_check;
ALTER TABLE {{schema}}.tf_conversation_compactions ADD CONSTRAINT tf_conversation_compactions_trigger_check
  CHECK (trigger IN ('manual', 'automatic', 'handoff-retry', 'inactivity'));
ALTER TABLE {{schema}}.tf_conversation_compactions ADD CONSTRAINT tf_conversation_compactions_origin_check
  CHECK ((trigger = 'inactivity') = (turn_id IS NULL));

CREATE TABLE {{schema}}.tf_conversation_maintenance (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES {{schema}}.tf_conversations (id),
  generation integer NOT NULL CHECK (generation >= 0),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','publishing','ready','blocked','failed','stale')),
  requester_user_id text NOT NULL,
  requester_membership_id uuid NOT NULL,
  epoch integer NOT NULL DEFAULT 0,
  attempts integer NOT NULL DEFAULT 0,
  resume_command_id uuid,
  compaction_policy jsonb,
  summary_progress jsonb,
  lease_until timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  dispatched_at timestamptz,
  error_code text,
  covered_through integer,
  coverage_message_id uuid,
  previous_compaction_id uuid,
  compaction_id uuid REFERENCES {{schema}}.tf_conversation_compactions (id),
  sources jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(sources) = 'array'),
  recap text,
  embedding_status text,
  document_id uuid,
  revision_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (conversation_id, generation)
);
CREATE INDEX tf_conversation_maintenance_due ON {{schema}}.tf_conversation_maintenance (next_attempt_at, id)
  WHERE state IN ('queued','running','publishing','failed','blocked');
CREATE TABLE {{schema}}.tf_conversation_maintenance_steps (
  job_id uuid NOT NULL REFERENCES {{schema}}.tf_conversation_maintenance (id),
  purpose text NOT NULL,
  step integer NOT NULL,
  family text NOT NULL,
  response jsonb NOT NULL,
  PRIMARY KEY (job_id, purpose, step, family)
);
CREATE TABLE {{schema}}.tf_conversation_maintenance_sweep (
  id integer PRIMARY KEY CHECK (id = 1),
  close_after uuid,
  close_due_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  scan_after uuid,
  scan_due_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO {{schema}}.tf_conversation_maintenance_sweep (id) VALUES (1);
CREATE TABLE {{schema}}.tf_conversation_maintenance_commands (
  membership_id uuid NOT NULL,
  command_id uuid NOT NULL,
  conversation_id uuid NOT NULL REFERENCES {{schema}}.tf_conversations (id),
  PRIMARY KEY (membership_id, command_id)
);
REVOKE ALL ON {{schema}}.tf_conversation_maintenance, {{schema}}.tf_conversation_maintenance_steps,
  {{schema}}.tf_conversation_maintenance_sweep, {{schema}}.tf_conversation_maintenance_commands FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON {{schema}}.tf_conversation_maintenance, {{schema}}.tf_conversation_maintenance_sweep TO {{runtime}};
GRANT SELECT, INSERT ON {{schema}}.tf_conversation_maintenance_steps, {{schema}}.tf_conversation_maintenance_commands TO {{runtime}};

-- 0038_conversation_knowledge.sql
ALTER TABLE {{schema}}.tf_knowledge_sources DROP CONSTRAINT tf_knowledge_sources_provider_check;
ALTER TABLE {{schema}}.tf_knowledge_sources ADD CHECK (provider IN ('note','file','google','slack','github','confluence','jira','conversation'));
ALTER TABLE {{schema}}.tf_knowledge_sources ADD CHECK (provider<>'conversation' OR selection='conversations');
CREATE UNIQUE INDEX tf_knowledge_conversation_source ON {{schema}}.tf_knowledge_sources (provider) WHERE provider='conversation';

CREATE TABLE {{schema}}.tf_knowledge_conversation_revisions (
  revision_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_knowledge_revisions(id),
  conversation_id uuid NOT NULL REFERENCES {{schema}}.tf_conversations(id),
  generation integer NOT NULL CHECK (generation >= 0),
  covered_through integer NOT NULL CHECK (covered_through > 0),
  coverage_message_id uuid NOT NULL REFERENCES {{schema}}.tf_conversation_messages(id),
  requester_user_id text NOT NULL,
  requester_membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  original_text text NOT NULL CHECK (octet_length(original_text) BETWEEN 1 AND 10485760),
  UNIQUE (conversation_id, generation, covered_through)
);
REVOKE ALL ON {{schema}}.tf_knowledge_conversation_revisions FROM PUBLIC;
GRANT SELECT, INSERT ON {{schema}}.tf_knowledge_conversation_revisions TO {{runtime}};
GRANT SELECT ON {{schema}}.tf_knowledge_conversation_revisions TO {{confirmation}};
GRANT UPDATE (owner_membership_id, owner_user_id) ON {{schema}}.tf_knowledge_embedding_jobs TO {{runtime}};

CREATE VIEW {{schema}}.tf_knowledge_conversation_readers AS
SELECT s.id AS source_id,c.id AS conversation_id,m.id AS membership_id,m.user_id
FROM {{schema}}.tf_knowledge_sources s
JOIN {{schema}}.tf_conversations c ON s.selection='conversations'
JOIN {{schema}}.tf_memberships m ON m.removed_at IS NULL
WHERE s.provider='conversation' AND s.state IN ('active','paused')
  AND c.kind='private' AND c.deleted_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM {{schema}}.tf_slack_default_turns t WHERE t.conversation_id=c.id)
  AND NOT EXISTS (SELECT 1 FROM {{schema}}.tf_slack_dm_roots t WHERE t.conversation_id=c.id)
  AND ((c.project_id IS NULL AND c.owner_user_id=m.user_id AND c.owner_membership_id=m.id)
    OR EXISTS (SELECT 1 FROM {{schema}}.tf_projects p
      JOIN {{schema}}.tf_project_members pm ON pm.project_id=p.id
      WHERE p.id=c.project_id AND p.archived_at IS NULL AND pm.membership_id=m.id AND pm.removed_at IS NULL));
REVOKE ALL ON {{schema}}.tf_knowledge_conversation_readers FROM PUBLIC;
GRANT SELECT ON {{schema}}.tf_knowledge_conversation_readers TO {{runtime}}, {{confirmation}};

CREATE FUNCTION {{schema}}.tf_tombstone_conversation_knowledge() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $body$
DECLARE retired_at timestamptz := clock_timestamp();
BEGIN
  UPDATE {{schema}}.tf_knowledge_documents d
    SET tombstoned_at=COALESCE(d.tombstoned_at,retired_at),
        retain_until=COALESCE(d.retain_until,retired_at+interval '30 days'),
        lexical_publication_id=NULL,vector_publication_id=NULL
    FROM {{schema}}.tf_knowledge_sources s
    WHERE d.source_id=s.id AND s.provider='conversation' AND d.native_id=NEW.id::text;
  RETURN NEW;
END
$body$;
REVOKE ALL ON FUNCTION {{schema}}.tf_tombstone_conversation_knowledge() FROM PUBLIC;
CREATE TRIGGER tf_tombstone_conversation_knowledge
  AFTER UPDATE OF deleted_at ON {{schema}}.tf_conversations
  FOR EACH ROW WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
  EXECUTE FUNCTION {{schema}}.tf_tombstone_conversation_knowledge();

-- 0039_bud_assistant.sql
CREATE TABLE {{schema}}.tf_bud_state (
  membership_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_memberships(id),
  conversation_id uuid UNIQUE,
  onboarding text NOT NULL CHECK (onboarding IN ('active','completed','skipped','ineligible')),
  bubbles_enabled boolean NOT NULL DEFAULT true,
  snoozed_until timestamptz,
  last_presented_at timestamptz,
  active_nudge text,
  initial_connections jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE {{schema}}.tf_bud_nudges (
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  suggestion_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('presented','opened','answered','dismissed')),
  message_id uuid,
  PRIMARY KEY (membership_id,fingerprint)
);

CREATE TABLE {{schema}}.tf_bud_preferences (
  id uuid PRIMARY KEY,
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  conversation_id uuid NOT NULL,
  turn_id uuid NOT NULL,
  topic text NOT NULL CHECK (topic IN ('reply-style','role','goals')),
  question text NOT NULL CHECK (char_length(question) BETWEEN 1 AND 500),
  value text CHECK (char_length(value) BETWEEN 1 AND 2000),
  status text NOT NULL CHECK (status IN ('asking','proposed','saved','dismissed','undone')),
  expected_revision integer NOT NULL CHECK (expected_revision >= 0),
  saved_revision integer,
  previous_content text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX tf_bud_pending_preference
  ON {{schema}}.tf_bud_preferences(membership_id) WHERE status IN ('asking','proposed');
CREATE INDEX tf_bud_preferences_chat ON {{schema}}.tf_bud_preferences(conversation_id,created_at);

REVOKE ALL ON TABLE {{schema}}.tf_bud_state, {{schema}}.tf_bud_nudges, {{schema}}.tf_bud_preferences
  FROM PUBLIC, {{migration}}, {{customOwner}}, {{confirmation}};
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  {{schema}}.tf_bud_state, {{schema}}.tf_bud_nudges, {{schema}}.tf_bud_preferences TO {{runtime}};

CREATE FUNCTION {{schema}}.forget_removed_member_bud() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.removed_at IS NOT NULL AND OLD.removed_at IS NULL THEN
    DELETE FROM {{schema}}.tf_bud_preferences WHERE membership_id=NEW.id;
    DELETE FROM {{schema}}.tf_bud_nudges WHERE membership_id=NEW.id;
    DELETE FROM {{schema}}.tf_bud_state WHERE membership_id=NEW.id;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION {{schema}}.forget_removed_member_bud() FROM PUBLIC;
CREATE TRIGGER tf_bud_member_removed AFTER UPDATE OF removed_at ON {{schema}}.tf_memberships
  FOR EACH ROW EXECUTE FUNCTION {{schema}}.forget_removed_member_bud();

INSERT INTO {{schema}}.tf_recommendation_refresh(membership_id,generation,status,first_event_at,due_at)
  SELECT id,1,'pending',clock_timestamp(),clock_timestamp() FROM {{schema}}.tf_memberships WHERE removed_at IS NULL
  ON CONFLICT(membership_id) DO UPDATE SET generation=tf_recommendation_refresh.generation+1,
    status='pending',due_at=clock_timestamp(),first_event_at=clock_timestamp(),
    claimed_generation=NULL,attempt_id=NULL,claimed_at=NULL,error_code=NULL;

-- 0040_calendar_follows.sql
CREATE TABLE {{schema}}.tf_calendar_workflow_follows (
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  workflow_id uuid NOT NULL REFERENCES {{schema}}.tf_workflows(id),
  PRIMARY KEY (membership_id, workflow_id)
);
GRANT SELECT, INSERT, DELETE ON {{schema}}.tf_calendar_workflow_follows TO {{runtime}};

-- 0041_agent_setup.sql
CREATE TABLE {{schema}}.tf_agent_setup_drafts (
  agent_id uuid NOT NULL,
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  user_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  request_id uuid NOT NULL,
  input jsonb NOT NULL,
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (agent_id,membership_id,version),
  UNIQUE (membership_id,request_id)
);
CREATE TABLE {{schema}}.tf_agent_setup_commands (
  id uuid PRIMARY KEY,
  agent_id uuid NOT NULL,
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  user_id text NOT NULL,
  request_id uuid NOT NULL,
  version integer NOT NULL,
  input jsonb NOT NULL,
  digest text NOT NULL,
  definition_command_id uuid REFERENCES {{schema}}.tf_agent_commands(id),
  status text NOT NULL DEFAULT 'preparing' CHECK (status IN ('preparing','saved','active','blocked','conflict','failed')),
  saved_revision text,
  activation_id uuid,
  error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (membership_id,request_id),
  FOREIGN KEY (agent_id,membership_id,version)
    REFERENCES {{schema}}.tf_agent_setup_drafts(agent_id,membership_id,version)
);
CREATE INDEX tf_agent_setup_pending ON {{schema}}.tf_agent_setup_commands(created_at,id)
  WHERE status = 'preparing';
REVOKE ALL ON TABLE {{schema}}.tf_agent_setup_drafts, {{schema}}.tf_agent_setup_commands
  FROM PUBLIC, {{migration}}, {{customOwner}}, {{confirmation}};
GRANT SELECT, INSERT, UPDATE ON TABLE {{schema}}.tf_agent_setup_commands TO {{runtime}};
GRANT SELECT, INSERT ON TABLE {{schema}}.tf_agent_setup_drafts TO {{runtime}};

-- 0042_chat_tool_budget.sql
ALTER TABLE {{schema}}.tf_conversation_tool_calls
  DROP CONSTRAINT tf_conversation_tool_calls_sequence_check,
  ADD CONSTRAINT tf_conversation_tool_calls_sequence_check CHECK (sequence BETWEEN 1 AND 1000);

-- 0043_workflow_automation.sql
CREATE TABLE {{schema}}.tf_github_event_sources (
  id uuid PRIMARY KEY,
  app_id text NOT NULL CHECK (app_id ~ '^[1-9][0-9]{0,15}$'),
  installation_id text NOT NULL CHECK (installation_id ~ '^[1-9][0-9]{0,15}$'),
  account_id text NOT NULL CHECK (account_id ~ '^[1-9][0-9]{0,15}$'),
  account_kind text NOT NULL CHECK (account_kind IN ('user','organization')),
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  generation integer NOT NULL DEFAULT 1 CHECK (generation > 0),
  status text NOT NULL CHECK (status IN ('pending','active','suspended','revoked')),
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (status <> 'active' OR verified_at IS NOT NULL)
);
CREATE UNIQUE INDEX tf_github_event_active_source
  ON {{schema}}.tf_github_event_sources(app_id,installation_id) WHERE status <> 'revoked';
CREATE TABLE {{schema}}.tf_github_event_source_grants (
  source_id uuid NOT NULL REFERENCES {{schema}}.tf_github_event_sources(id),
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  permission text NOT NULL CHECK (permission IN ('use','manage','share')),
  granted_by uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (source_id,membership_id,permission)
);
CREATE TABLE {{schema}}.tf_workflow_automation_drafts (
  workflow_id uuid NOT NULL,
  revision uuid NOT NULL,
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  version integer NOT NULL CHECK (version > 0),
  command_id uuid NOT NULL,
  setup jsonb NOT NULL CHECK (jsonb_typeof(setup) = 'object'),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workflow_id,membership_id,version),
  UNIQUE (membership_id,command_id),
  UNIQUE (workflow_id,membership_id,version,revision),
  FOREIGN KEY (workflow_id,revision) REFERENCES {{schema}}.tf_workflow_revisions(workflow_id,id)
);
CREATE TABLE {{schema}}.tf_workflow_automation_grants (
  id uuid PRIMARY KEY,
  workflow_id uuid NOT NULL,
  revision uuid NOT NULL,
  membership_id uuid NOT NULL,
  draft_version integer NOT NULL,
  command_id uuid NOT NULL,
  source_id uuid NOT NULL REFERENCES {{schema}}.tf_github_event_sources(id),
  source_generation integer NOT NULL CHECK (source_generation > 0),
  destination_id uuid NOT NULL REFERENCES {{schema}}.tf_slack_destinations(id),
  destination_generation integer NOT NULL CHECK (destination_generation > 0),
  destination_version integer NOT NULL CHECK (destination_version > 0),
  sender text NOT NULL CHECK (sender IN ('user','app')),
  messages_per_hour integer NOT NULL CHECK (messages_per_hour > 0),
  sharing_membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  private_repository_export boolean NOT NULL,
  approval jsonb NOT NULL CHECK (jsonb_typeof(approval) = 'object'),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  policy_version integer NOT NULL CHECK (policy_version = 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  UNIQUE (membership_id,command_id),
  UNIQUE (id,workflow_id),
  FOREIGN KEY (workflow_id,membership_id,draft_version,revision)
    REFERENCES {{schema}}.tf_workflow_automation_drafts(workflow_id,membership_id,version,revision),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);
CREATE UNIQUE INDEX tf_workflow_automation_active_grant
  ON {{schema}}.tf_workflow_automation_grants(workflow_id) WHERE revoked_at IS NULL;
ALTER TABLE {{schema}}.tf_workflow_runs ADD CONSTRAINT tf_workflow_automation_run_identity
  UNIQUE (id,workflow_id,revision);
CREATE TABLE {{schema}}.tf_workflow_automation_events (
  id uuid PRIMARY KEY,
  source_id uuid NOT NULL REFERENCES {{schema}}.tf_github_event_sources(id),
  source_generation integer NOT NULL CHECK (source_generation > 0),
  delivery_id uuid NOT NULL,
  body_digest text NOT NULL CHECK (body_digest ~ '^[a-f0-9]{64}$'),
  workflow_id uuid NOT NULL,
  revision uuid NOT NULL,
  input jsonb CHECK (input IS NULL OR jsonb_typeof(input) = 'object'),
  received_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','admitted','blocked','expired')),
  error text CHECK (error ~ '^[a-z][a-z0-9-]{0,99}$'),
  run_id uuid,
  UNIQUE (source_id,workflow_id,delivery_id),
  FOREIGN KEY (workflow_id,revision) REFERENCES {{schema}}.tf_workflow_revisions(workflow_id,id),
  FOREIGN KEY (run_id,workflow_id,revision) REFERENCES {{schema}}.tf_workflow_runs(id,workflow_id,revision),
  CHECK (expires_at > received_at AND expires_at <= received_at + interval '720 hours'),
  CHECK (status <> 'expired' OR input IS NULL),
  CHECK (status <> 'pending' OR input IS NOT NULL),
  CHECK ((status = 'admitted') = (run_id IS NOT NULL))
);
CREATE INDEX tf_workflow_automation_event_expiry
  ON {{schema}}.tf_workflow_automation_events(expires_at,id) WHERE input IS NOT NULL;
CREATE INDEX tf_workflow_automation_event_pending
  ON {{schema}}.tf_workflow_automation_events(workflow_id,received_at,id) WHERE status = 'pending';
CREATE TABLE {{schema}}.tf_workflow_automation_reservations (
  action_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_slack_actions(id),
  grant_id uuid NOT NULL,
  workflow_id uuid NOT NULL,
  reserved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  status text NOT NULL CHECK (status IN ('reserved','confirmed','failed','uncertain')),
  FOREIGN KEY (grant_id,workflow_id) REFERENCES {{schema}}.tf_workflow_automation_grants(id,workflow_id)
);
CREATE INDEX tf_workflow_automation_rate_window
  ON {{schema}}.tf_workflow_automation_reservations(workflow_id,reserved_at)
  WHERE status IN ('reserved','confirmed','uncertain');

REVOKE ALL ON TABLE {{schema}}.tf_github_event_sources,
  {{schema}}.tf_github_event_source_grants, {{schema}}.tf_workflow_automation_drafts,
  {{schema}}.tf_workflow_automation_grants, {{schema}}.tf_workflow_automation_events,
  {{schema}}.tf_workflow_automation_reservations
  FROM PUBLIC, {{migration}}, {{customOwner}}, {{confirmation}};
GRANT SELECT, INSERT ON TABLE {{schema}}.tf_github_event_sources,
  {{schema}}.tf_github_event_source_grants, {{schema}}.tf_workflow_automation_drafts,
  {{schema}}.tf_workflow_automation_grants, {{schema}}.tf_workflow_automation_events,
  {{schema}}.tf_workflow_automation_reservations TO {{runtime}};
GRANT UPDATE (generation,status,verified_at) ON {{schema}}.tf_github_event_sources TO {{runtime}};
GRANT DELETE ON {{schema}}.tf_github_event_source_grants TO {{runtime}};
GRANT UPDATE (revoked_at) ON {{schema}}.tf_workflow_automation_grants TO {{runtime}};
GRANT UPDATE (input,status,error,run_id) ON {{schema}}.tf_workflow_automation_events TO {{runtime}};
GRANT UPDATE (status) ON {{schema}}.tf_workflow_automation_reservations TO {{runtime}};

-- 0044_workflow_automation_decisions.sql
ALTER TABLE {{schema}}.tf_workflow_automation_grants
  ADD COLUMN sponsorship_id uuid,
  ADD CONSTRAINT tf_workflow_automation_grant_draft UNIQUE (id,workflow_id,membership_id,draft_version);
CREATE TABLE {{schema}}.tf_workflow_automation_decisions (
  command_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_workflow_commands(id) DEFERRABLE INITIALLY DEFERRED,
  workflow_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  version integer NOT NULL,
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  decision text NOT NULL CHECK (decision IN ('approve','reject')),
  private_repository_export boolean NOT NULL,
  grant_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (workflow_id,membership_id,version),
  FOREIGN KEY (workflow_id,membership_id,version)
    REFERENCES {{schema}}.tf_workflow_automation_drafts(workflow_id,membership_id,version),
  FOREIGN KEY (grant_id,workflow_id,membership_id,version)
    REFERENCES {{schema}}.tf_workflow_automation_grants(id,workflow_id,membership_id,draft_version),
  CHECK ((decision = 'approve') = (grant_id IS NOT NULL))
);
REVOKE ALL ON TABLE {{schema}}.tf_workflow_automation_decisions
  FROM PUBLIC, {{migration}}, {{customOwner}}, {{confirmation}};
GRANT SELECT, INSERT ON TABLE {{schema}}.tf_workflow_automation_decisions TO {{runtime}};

-- 0045_github_investigation_grants.sql
ALTER TABLE {{schema}}.tf_connection_source_grants
  DROP CONSTRAINT tf_connection_source_grants_permission_check,
  DROP CONSTRAINT tf_connection_source_grants_pkey,
  ADD CONSTRAINT tf_connection_source_grants_permission_check CHECK (
    permission IN ('github.issue.read', 'github.code.read', 'github.issues.read',
      'github.pulls.read', 'github.actions.read', 'github.releases.read', 'github.discussions.read')
  ),
  ADD PRIMARY KEY (source_id, team_id, permission);

ALTER TABLE {{schema}}.tf_connection_source_person_grants
  DROP CONSTRAINT tf_connection_source_person_grants_permission_check,
  DROP CONSTRAINT tf_connection_source_person_grants_pkey,
  ADD CONSTRAINT tf_connection_source_person_grants_permission_check CHECK (
    permission IN ('github.issue.read', 'github.code.read', 'github.issues.read',
      'github.pulls.read', 'github.actions.read', 'github.releases.read', 'github.discussions.read')
  ),
  ADD PRIMARY KEY (source_id, membership_id, permission);

ALTER TABLE {{schema}}.tf_github_chat_selection
  ADD COLUMN connection_id uuid REFERENCES {{schema}}.tf_connections(id),
  ADD COLUMN connection_generation integer CHECK (connection_generation > 0),
  ADD COLUMN investigation boolean NOT NULL DEFAULT false,
  ADD CHECK ((connection_id IS NULL) = (connection_generation IS NULL)),
  ADD CHECK (account_id IS NULL OR connection_id IS NULL),
  ADD CHECK (connection_id IS NULL OR investigation);

ALTER TABLE {{schema}}.tf_github_task_selection
  ADD COLUMN connection_id uuid REFERENCES {{schema}}.tf_connections(id),
  ADD COLUMN connection_generation integer CHECK (connection_generation > 0),
  ADD COLUMN investigation boolean NOT NULL DEFAULT false,
  ADD CHECK ((connection_id IS NULL) = (connection_generation IS NULL)),
  ADD CHECK (account_id IS NULL OR connection_id IS NULL),
  ADD CHECK (connection_id IS NULL OR investigation);

-- 0046_planning.sql
ALTER TABLE {{schema}}.tf_agent_plans
  ADD COLUMN execution text NOT NULL DEFAULT 'execute' CHECK (execution IN ('plan-only', 'execute')),
  ADD COLUMN planning jsonb CHECK (planning IS NULL OR (jsonb_typeof(planning) = 'object' AND octet_length(planning::text) <= 262144)),
  DROP CONSTRAINT tf_agent_plans_lifecycle_check,
  ADD CONSTRAINT tf_agent_plans_lifecycle_check CHECK (lifecycle IN ('draft', 'active', 'paused', 'stopped', 'completed', 'failed'));

DROP INDEX {{schema}}.tf_agent_plans_open;
CREATE UNIQUE INDEX tf_agent_plans_open ON {{schema}}.tf_agent_plans (conversation_id, starter_membership_id)
  WHERE lifecycle IN ('draft', 'active', 'paused');

ALTER TABLE {{schema}}.tf_agent_plan_tasks
  ADD COLUMN coordinator boolean NOT NULL DEFAULT false,
  DROP CONSTRAINT tf_agent_plan_tasks_state_check,
  ADD CONSTRAINT tf_agent_plan_tasks_state_check CHECK (state IN ('pending', 'ready', 'running', 'verifying', 'waiting-input', 'waiting-approval', 'blocked', 'completed', 'failed', 'cancelled')),
  ADD CONSTRAINT tf_agent_plan_tasks_coordinator_check CHECK (NOT coordinator OR (kind = 'work' AND agent_id IS NULL AND specialist_key IS NULL));

ALTER TABLE {{schema}}.tf_agent_plan_attempts
  ADD COLUMN coordinator boolean NOT NULL DEFAULT false,
  ADD COLUMN turn_id uuid REFERENCES {{schema}}.tf_conversation_turns(id),
  ADD COLUMN turn_generation integer CHECK (turn_generation >= 0),
  ADD COLUMN turn_epoch integer CHECK (turn_epoch > 0),
  ADD COLUMN claim_sequence integer CHECK (claim_sequence > 0),
  ADD COLUMN report jsonb CHECK (report IS NULL OR (jsonb_typeof(report) = 'object' AND octet_length(report::text) <= 131072)),
  DROP CONSTRAINT tf_agent_plan_attempts_check,
  ADD CONSTRAINT tf_agent_plan_attempts_assignee_check CHECK (
    (coordinator AND agent_id IS NULL AND activation_id IS NULL AND definition_revision IS NULL AND specialist_key IS NULL)
    OR (NOT coordinator AND agent_id IS NOT NULL AND activation_id IS NOT NULL AND definition_revision IS NOT NULL AND specialist_key IS NULL)
    OR (NOT coordinator AND agent_id IS NULL AND activation_id IS NULL AND definition_revision IS NULL AND specialist_key IS NOT NULL)
  );

ALTER TABLE {{schema}}.tf_conversation_turns
  ADD COLUMN planning_mode boolean NOT NULL DEFAULT false,
  ADD COLUMN plan_id uuid REFERENCES {{schema}}.tf_agent_plans(id),
  ADD COLUMN planning_slices integer NOT NULL DEFAULT 0 CHECK (planning_slices BETWEEN 0 AND 100),
  ADD COLUMN planning_sequence integer NOT NULL DEFAULT 0 CHECK (planning_sequence >= 0);

GRANT UPDATE (plan_id, planning_slices, planning_sequence) ON {{schema}}.tf_conversation_turns TO {{runtime}};

ALTER TABLE {{schema}}.tf_conversation_parts
  DROP CONSTRAINT tf_conversation_parts_skill_reference,
  ADD CONSTRAINT tf_conversation_parts_skill_reference CHECK (
    (skill_id IS NULL AND skill_revision IS NULL AND skill_name IS NULL) OR
    (skill_id IS NOT NULL AND skill_revision IS NOT NULL AND skill_name IS NOT NULL
      AND skill_id ~ '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z][a-z0-9-]{0,63})$'
      AND skill_revision ~ '^(latest|[a-f0-9]{64}|[1-9][0-9]{0,8})$'
      AND char_length(skill_name) BETWEEN 1 AND 120));

GRANT UPDATE (execution, planning) ON {{schema}}.tf_agent_plans TO {{runtime}};
GRANT UPDATE (coordinator) ON {{schema}}.tf_agent_plan_tasks TO {{runtime}};
GRANT UPDATE (turn_id, turn_generation, turn_epoch, report) ON {{schema}}.tf_agent_plan_attempts TO {{runtime}};

CREATE UNIQUE INDEX tf_agent_plan_coordinator_turn ON {{schema}}.tf_agent_plan_attempts (turn_id)
  WHERE coordinator AND settled_at IS NULL;

ALTER TABLE {{schema}}.tf_credit_usage
  ADD COLUMN plan_attempt_id uuid REFERENCES {{schema}}.tf_agent_plan_attempts(id),
  ADD COLUMN plan_milliseconds bigint CHECK (plan_milliseconds >= 0);
GRANT UPDATE (plan_attempt_id, plan_milliseconds) ON {{schema}}.tf_credit_usage TO {{runtime}};
CREATE INDEX tf_credit_usage_plan_attempt ON {{schema}}.tf_credit_usage (plan_attempt_id) WHERE plan_attempt_id IS NOT NULL;

ALTER TABLE {{schema}}.tf_conversation_execution_steps
  ADD COLUMN plan_attempt_id uuid REFERENCES {{schema}}.tf_agent_plan_attempts(id),
  ADD COLUMN plan_milliseconds bigint CHECK (plan_milliseconds >= 0);
GRANT UPDATE (plan_attempt_id, plan_milliseconds) ON {{schema}}.tf_conversation_execution_steps TO {{runtime}};

-- 0047_knowledge_retrieval_budget.sql
ALTER TABLE {{schema}}.tf_conversation_turns
  ADD COLUMN knowledge_budget jsonb CHECK (knowledge_budget IS NULL OR
    (jsonb_typeof(knowledge_budget) = 'object' AND octet_length(knowledge_budget::text) <= 65536));
ALTER TABLE {{schema}}.tf_conversation_turns
  ALTER COLUMN knowledge_budget SET DEFAULT '{"version":1,"operations":[]}'::jsonb;

ALTER TABLE {{schema}}.tf_agent_task_messages
  ADD COLUMN knowledge_budget jsonb CHECK (knowledge_budget IS NULL OR
    (jsonb_typeof(knowledge_budget) = 'object' AND octet_length(knowledge_budget::text) <= 65536));
ALTER TABLE {{schema}}.tf_agent_task_messages
  ALTER COLUMN knowledge_budget SET DEFAULT '{"version":1,"operations":[]}'::jsonb;

ALTER TABLE {{schema}}.tf_agent_tasks
  ADD COLUMN knowledge_root jsonb CHECK (knowledge_root IS NULL OR
    (jsonb_typeof(knowledge_root) = 'object' AND octet_length(knowledge_root::text) <= 256));
ALTER TABLE {{schema}}.tf_agent_task_runs
  ADD COLUMN knowledge_root jsonb CHECK (knowledge_root IS NULL OR
    (jsonb_typeof(knowledge_root) = 'object' AND octet_length(knowledge_root::text) <= 256));
ALTER TABLE {{schema}}.tf_agent_tool_calls
  ADD COLUMN knowledge_root jsonb CHECK (knowledge_root IS NULL OR
    (jsonb_typeof(knowledge_root) = 'object' AND octet_length(knowledge_root::text) <= 256));
ALTER TABLE {{schema}}.tf_conversation_tool_calls
  ADD COLUMN plan_attempt_id uuid REFERENCES {{schema}}.tf_agent_plan_attempts(id);
CREATE INDEX tf_conversation_tool_plan_attempt ON {{schema}}.tf_conversation_tool_calls (plan_attempt_id)
  WHERE plan_attempt_id IS NOT NULL;

GRANT UPDATE (knowledge_budget) ON {{schema}}.tf_conversation_turns, {{schema}}.tf_agent_task_messages TO {{runtime}};
GRANT UPDATE (knowledge_root) ON {{schema}}.tf_agent_tasks, {{schema}}.tf_agent_task_runs TO {{runtime}};

-- 0048_personal_memory_reconciliation.sql
ALTER TABLE {{schema}}.tf_personal_memory
  ADD COLUMN manual_updated_at timestamptz,
  ADD COLUMN reconciled_through timestamptz;
UPDATE {{schema}}.tf_personal_memory SET manual_updated_at=clock_timestamp();
ALTER TABLE {{schema}}.tf_personal_memory
  DROP CONSTRAINT tf_personal_memory_content_check,
  ADD CONSTRAINT tf_personal_memory_content_check CHECK (char_length(content) <= 10000) NOT VALID;

ALTER TABLE {{schema}}.tf_conversation_maintenance
  ADD COLUMN memory_complete boolean NOT NULL DEFAULT false,
  ADD COLUMN memory_chunk integer NOT NULL DEFAULT 0 CHECK (memory_chunk >= 0),
  ADD COLUMN memory_step integer NOT NULL DEFAULT 0 CHECK (memory_step >= 0),
  ADD COLUMN memory_base_revision integer,
  ADD COLUMN memory_reconciled_through timestamptz,
  ADD COLUMN memory_manual_at timestamptz;
CREATE INDEX tf_conversation_maintenance_memory_pending ON {{schema}}.tf_conversation_maintenance (next_attempt_at,id)
  WHERE state='ready' AND NOT memory_complete;
GRANT DELETE ON {{schema}}.tf_conversation_maintenance_steps TO {{runtime}};

-- 0049_readable_table_names.sql
CREATE TABLE {{schema}}.tf_table_names (
  table_id uuid PRIMARY KEY,
  name text COLLATE "C" NOT NULL UNIQUE CHECK (
    char_length(name) BETWEEN 1 AND 80 AND name = lower(name) AND
    name !~ '(^_|_$|__)' AND translate(name, '_', '') !~ '[[:punct:][:space:][:cntrl:]]'
  ),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE {{schema}}.tf_table_soul_files (
  table_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_table_names(table_id),
  projection jsonb NOT NULL CHECK (jsonb_typeof(projection) = 'object'),
  revision text NOT NULL REFERENCES {{schema}}.tf_soul_revisions(revision)
);
CREATE TABLE {{schema}}.tf_table_name_conversions (
  id uuid PRIMARY KEY,
  table_id uuid NOT NULL REFERENCES {{schema}}.tf_table_names(table_id),
  parent_revision text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revision text UNIQUE REFERENCES {{schema}}.tf_soul_revisions(revision)
);
ALTER TABLE {{schema}}.tf_soul_revisions
  ADD COLUMN table_name_conversion_id uuid UNIQUE REFERENCES {{schema}}.tf_table_name_conversions(id);
ALTER TABLE {{schema}}.tf_soul_revisions DROP CONSTRAINT tf_soul_revision_command;
ALTER TABLE {{schema}}.tf_soul_revisions ADD CONSTRAINT tf_soul_revision_command
  CHECK (num_nonnulls(command_id, agent_command_id, table_execution_id, table_name_conversion_id) = 1);

CREATE FUNCTION {{schema}}.tf_reject_table_name_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $body$
DECLARE fixed_title text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT display_name INTO fixed_title FROM {{schema}}.tf_table_catalog WHERE id = NEW.table_id;
    IF fixed_title IS NOT NULL AND fixed_title IS DISTINCT FROM NEW.title THEN
      RAISE EXCEPTION 'table-title-immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'table-identity-immutable' USING ERRCODE = '23514';
END;
$body$;
CREATE TRIGGER tf_table_name_immutable BEFORE INSERT OR UPDATE OR DELETE ON {{schema}}.tf_table_names
  FOR EACH ROW EXECUTE FUNCTION {{schema}}.tf_reject_table_name_mutation();

CREATE FUNCTION {{schema}}.tf_check_table_title() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $body$
DECLARE fixed_title text;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.display_name IS DISTINCT FROM OLD.display_name) THEN
    RAISE EXCEPTION 'table-title-immutable' USING ERRCODE = '23514';
  END IF;
  SELECT title INTO fixed_title FROM {{schema}}.tf_table_names WHERE table_id = NEW.id;
  IF fixed_title IS NOT NULL AND fixed_title IS DISTINCT FROM NEW.display_name THEN
    RAISE EXCEPTION 'table-title-immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$body$;
CREATE TRIGGER tf_table_title_immutable BEFORE INSERT OR UPDATE OF id, display_name ON {{schema}}.tf_table_catalog
  FOR EACH ROW EXECUTE FUNCTION {{schema}}.tf_check_table_title();

CREATE FUNCTION {{schema}}.tf_check_generation_title() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $body$
DECLARE fixed_title text;
BEGIN
  SELECT display_name INTO fixed_title FROM {{schema}}.tf_table_catalog WHERE id = NEW.table_id;
  IF fixed_title IS DISTINCT FROM NEW.definition->>'label' THEN
    RAISE EXCEPTION 'table-title-immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$body$;
CREATE TRIGGER tf_generation_title_immutable BEFORE INSERT OR UPDATE OF table_id, definition ON {{schema}}.tf_table_generations
  FOR EACH ROW EXECUTE FUNCTION {{schema}}.tf_check_generation_title();

REVOKE ALL ON FUNCTION {{schema}}.tf_reject_table_name_mutation(), {{schema}}.tf_check_table_title(),
  {{schema}}.tf_check_generation_title() FROM PUBLIC;
GRANT SELECT ON {{schema}}.tf_table_names, {{schema}}.tf_table_soul_files, {{schema}}.tf_table_name_conversions
  TO {{runtime}}, {{migration}}, {{customOwner}}, {{confirmation}};
GRANT INSERT ON {{schema}}.tf_table_names, {{schema}}.tf_table_soul_files, {{schema}}.tf_table_name_conversions TO {{runtime}};
GRANT UPDATE (projection, revision) ON {{schema}}.tf_table_soul_files TO {{runtime}};
GRANT UPDATE (revision) ON {{schema}}.tf_table_name_conversions TO {{runtime}};

-- 0050_workspace_members.sql
CREATE TABLE {{schema}}.tf_system_tables (
  kind text PRIMARY KEY CHECK (kind = 'workspace-members'),
  table_id uuid NOT NULL UNIQUE REFERENCES {{schema}}.tf_table_catalog(id),
  core_definition jsonb NOT NULL CHECK (
    core_definition->>'formatVersion' = '2'
    AND core_definition->>'id' = table_id::text
    AND jsonb_typeof(core_definition->'fields') = 'array'
  )
);
GRANT SELECT ON {{schema}}.tf_system_tables TO {{runtime}}, {{migration}}, {{customOwner}}, {{confirmation}};

CREATE FUNCTION {{schema}}.tf_protect_system_table_catalog() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE core jsonb;
BEGIN
  SELECT core_definition INTO core FROM {{schema}}.tf_system_tables WHERE table_id=OLD.id;
  IF core IS NOT NULL AND (TG_OP='DELETE'
    OR NEW.id IS DISTINCT FROM OLD.id
    OR NEW.owning_team_id::text IS DISTINCT FROM core->>'owningTeamId'
    OR NEW.display_name IS DISTINCT FROM core->>'label'
    OR NEW.archived_at IS NOT NULL) THEN
    RAISE EXCEPTION 'member-table-protected';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION {{schema}}.tf_protect_system_table_catalog() FROM PUBLIC;
CREATE TRIGGER tf_protect_system_table_catalog BEFORE UPDATE OR DELETE ON {{schema}}.tf_table_catalog
  FOR EACH ROW EXECUTE FUNCTION {{schema}}.tf_protect_system_table_catalog();

CREATE FUNCTION {{schema}}.tf_protect_system_table_definition() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE core jsonb; field jsonb;
BEGIN
  SELECT core_definition INTO core FROM {{schema}}.tf_system_tables WHERE table_id=NEW.table_id;
  IF core IS NULL THEN RETURN NEW; END IF;
  IF NEW.definition->>'id' IS DISTINCT FROM core->>'id'
    OR NEW.definition->>'owningTeamId' IS DISTINCT FROM core->>'owningTeamId'
    OR NEW.definition->>'label' IS DISTINCT FROM core->>'label'
    OR NEW.definition->>'formatVersion' IS DISTINCT FROM '2' THEN
    RAISE EXCEPTION 'member-table-protected';
  END IF;
  FOR field IN SELECT value FROM jsonb_array_elements(core->'fields') LOOP
    IF (SELECT count(*) FROM jsonb_array_elements(NEW.definition->'fields') candidate
        WHERE candidate->>'id'=field->>'id')<>1
      OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.definition->'fields') candidate WHERE candidate=field)
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.definition->'uniqueKeys') key
        CROSS JOIN LATERAL jsonb_array_elements_text(key->'fieldIds') key_field
        WHERE key_field=field->>'id') THEN
      RAISE EXCEPTION 'member-field-protected';
    END IF;
  END LOOP;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION {{schema}}.tf_protect_system_table_definition() FROM PUBLIC;
CREATE TRIGGER tf_protect_system_table_definition BEFORE INSERT OR UPDATE ON {{schema}}.tf_table_generations
  FOR EACH ROW EXECUTE FUNCTION {{schema}}.tf_protect_system_table_definition();

DO $$
DECLARE
  table_id uuid := gen_random_uuid();
  generation_id uuid := gen_random_uuid();
  team_id uuid;
  physical_name text := 'g_' || replace(generation_id::text,'-','');
  revision text := 'cc016a0e2e6736d4e1c6f430db4c10f46cc79916';
  definition jsonb;
  schema_name text := '{{schema}}'::regnamespace::text;
BEGIN
  SELECT id INTO STRICT team_id FROM {{schema}}.tf_teams WHERE name='_admin';
  definition := jsonb_build_object(
    'formatVersion',2,'id',table_id,'owningTeamId',team_id,'label','Workspace members',
    'fields','[
      {"id":"4de907c4-8590-49f1-9c45-694e9fc36101","label":"Name","kind":"text","required":true,"maxLength":10000},
      {"id":"4de907c4-8590-49f1-9c45-694e9fc36102","label":"Photo","kind":"text","required":false,"maxLength":2048},
      {"id":"4de907c4-8590-49f1-9c45-694e9fc36103","label":"Contact email","kind":"text","required":false,"maxLength":320},
      {"id":"4de907c4-8590-49f1-9c45-694e9fc36104","label":"Account email","kind":"text","required":false,"maxLength":320},
      {"id":"4de907c4-8590-49f1-9c45-694e9fc36105","label":"Active","kind":"boolean","required":true},
      {"id":"4de907c4-8590-49f1-9c45-694e9fc36106","label":"Workspace access","kind":"single-select","required":true,"options":[
        {"id":"9670894c-cb62-45ab-8171-4e118c5cce01","label":"No access","retired":false},
        {"id":"9670894c-cb62-45ab-8171-4e118c5cce02","label":"Invited","retired":false},
        {"id":"9670894c-cb62-45ab-8171-4e118c5cce03","label":"Has access","retired":false}
      ]}
    ]'::jsonb,'uniqueKeys','[]'::jsonb
  );
  INSERT INTO {{schema}}.tf_table_catalog(id,owning_team_id,physical_table,display_name,target_revision,applied_revision,applied_definition)
    VALUES(table_id,team_id,physical_name,'Workspace members',revision,revision,definition);
  INSERT INTO {{schema}}.tf_system_tables(kind,table_id,core_definition) VALUES('workspace-members',table_id,definition);
  INSERT INTO {{schema}}.tf_table_generations(id,table_id,revision,definition,physical_table,state,activated_at)
    VALUES(generation_id,table_id,revision,definition,physical_name,'active',clock_timestamp());
  EXECUTE format('CREATE TABLE %I.%I (
    id uuid PRIMARY KEY, token uuid NOT NULL,
    f_4de907c4859049f19c45694e9fc36101 varchar(10000) COLLATE "C" NOT NULL,
    f_4de907c4859049f19c45694e9fc36102 varchar(2048) COLLATE "C",
    f_4de907c4859049f19c45694e9fc36103 varchar(320) COLLATE "C",
    f_4de907c4859049f19c45694e9fc36104 varchar(320) COLLATE "C",
    f_4de907c4859049f19c45694e9fc36105 boolean NOT NULL,
    f_4de907c4859049f19c45694e9fc36106 uuid NOT NULL CHECK(
      f_4de907c4859049f19c45694e9fc36106=ANY(ARRAY[
        ''9670894c-cb62-45ab-8171-4e118c5cce01''::uuid,
        ''9670894c-cb62-45ab-8171-4e118c5cce02''::uuid,
        ''9670894c-cb62-45ab-8171-4e118c5cce03''::uuid
      ]))
  )',schema_name,physical_name);
  EXECUTE format('ALTER TABLE %I.%I OWNER TO %I',schema_name,physical_name,'{{customOwner}}'::regrole::text);
  EXECUTE format('REVOKE ALL ON %I.%I FROM PUBLIC',schema_name,physical_name);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I.%I TO %I',schema_name,physical_name,'{{runtime}}'::regrole::text);
END
$$;

ALTER TABLE {{schema}}.tf_memberships ADD CONSTRAINT tf_memberships_identity UNIQUE(id,user_id);
CREATE TABLE {{schema}}.tf_workspace_member_accounts (
  member_id uuid PRIMARY KEY,
  table_id uuid NOT NULL REFERENCES {{schema}}.tf_system_tables(table_id),
  user_id text NOT NULL UNIQUE,
  membership_id uuid NOT NULL UNIQUE,
  profile_revision bigint NOT NULL DEFAULT 0 CHECK(profile_revision>=0),
  requested_revision bigint NOT NULL DEFAULT 0 CHECK(requested_revision>=0),
  profile_status text NOT NULL DEFAULT 'pending' CHECK(profile_status IN ('pending','current','failed','detached')),
  profile_error text CHECK(profile_error ~ '^[a-z][a-z0-9-]{0,99}$'),
  projected_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(table_id,member_id) REFERENCES {{schema}}.tf_table_identities(table_id,row_id),
  FOREIGN KEY(membership_id,user_id) REFERENCES {{schema}}.tf_memberships(id,user_id) DEFERRABLE INITIALLY DEFERRED,
  CHECK((profile_status='failed')=(profile_error IS NOT NULL))
);
CREATE INDEX tf_workspace_member_profile_pending ON {{schema}}.tf_workspace_member_accounts(next_attempt_at,member_id)
  WHERE profile_status IN ('pending','failed','current');
GRANT SELECT ON {{schema}}.tf_workspace_member_accounts TO {{runtime}}, {{migration}}, {{customOwner}}, {{confirmation}};
GRANT INSERT,UPDATE ON {{schema}}.tf_workspace_member_accounts TO {{runtime}};

CREATE TABLE {{schema}}.tf_workspace_member_images (
  member_id uuid NOT NULL,
  table_id uuid NOT NULL REFERENCES {{schema}}.tf_system_tables(table_id),
  digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),
  image text NOT NULL CHECK(octet_length(image)<=45000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(member_id,digest),
  FOREIGN KEY(table_id,member_id) REFERENCES {{schema}}.tf_table_identities(table_id,row_id)
);
CREATE INDEX tf_workspace_member_images_retention ON {{schema}}.tf_workspace_member_images(created_at,member_id,digest);
GRANT SELECT,INSERT ON {{schema}}.tf_workspace_member_images TO {{runtime}};
GRANT SELECT,DELETE ON {{schema}}.tf_workspace_member_images TO {{migration}}, {{customOwner}};

ALTER TABLE {{schema}}.tf_invitations ADD COLUMN workspace_member_id uuid;
ALTER TABLE {{schema}}.tf_invitation_operations ADD COLUMN workspace_member_id uuid;
GRANT INSERT(workspace_member_id) ON {{schema}}.tf_invitations TO {{runtime}};
GRANT INSERT(workspace_member_id) ON {{schema}}.tf_invitation_operations TO {{runtime}};

CREATE FUNCTION {{schema}}.tf_admit_workspace_member() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE target_table uuid; member_id uuid;
BEGIN
  IF NEW.removed_at IS NOT NULL THEN
    UPDATE {{schema}}.tf_workspace_member_accounts SET profile_status='detached',profile_error=NULL
      WHERE membership_id=NEW.id;
    RETURN NEW;
  END IF;
  IF TG_OP='UPDATE' THEN RETURN NEW; END IF;
  SELECT table_id INTO STRICT target_table FROM {{schema}}.tf_system_tables WHERE kind='workspace-members';
  SELECT a.member_id INTO member_id FROM {{schema}}.tf_workspace_member_accounts a WHERE a.user_id=NEW.user_id;
  IF member_id IS NULL THEN
    member_id := gen_random_uuid();
    INSERT INTO {{schema}}.tf_table_identities(table_id,row_id,token,live)
      VALUES(target_table,member_id,gen_random_uuid(),false);
    INSERT INTO {{schema}}.tf_workspace_member_accounts(member_id,table_id,user_id,membership_id)
      VALUES(member_id,target_table,NEW.user_id,NEW.id);
  ELSE
    UPDATE {{schema}}.tf_workspace_member_accounts SET membership_id=NEW.id,
      profile_status='pending',profile_error=NULL,next_attempt_at=clock_timestamp()
      WHERE user_id=NEW.user_id;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION {{schema}}.tf_admit_workspace_member() FROM PUBLIC;
CREATE TRIGGER tf_admit_workspace_member AFTER INSERT OR UPDATE OF removed_at ON {{schema}}.tf_memberships
  FOR EACH ROW EXECUTE FUNCTION {{schema}}.tf_admit_workspace_member();

WITH candidates AS MATERIALIZED (
  SELECT gen_random_uuid() AS member_id,s.table_id,m.user_id,m.id AS membership_id
  FROM {{schema}}.tf_memberships m CROSS JOIN {{schema}}.tf_system_tables s
  WHERE m.removed_at IS NULL AND s.kind='workspace-members'
), identities AS (
  INSERT INTO {{schema}}.tf_table_identities(table_id,row_id,token,live)
  SELECT table_id,member_id,gen_random_uuid(),false FROM candidates RETURNING table_id,row_id
)
INSERT INTO {{schema}}.tf_workspace_member_accounts(member_id,table_id,user_id,membership_id)
SELECT c.member_id,c.table_id,c.user_id,c.membership_id FROM candidates c
JOIN identities i ON i.table_id=c.table_id AND i.row_id=c.member_id;

DO $$
DECLARE profile_owner text;
BEGIN
  SELECT pg_get_userbyid(nspowner) INTO profile_owner FROM pg_namespace WHERE nspname='app';
  IF profile_owner IS NOT NULL THEN
    EXECUTE format('GRANT USAGE ON SCHEMA {{schema}} TO %I',profile_owner);
    EXECUTE format('GRANT SELECT ON {{schema}}.tf_memberships,{{schema}}.tf_workspace_member_accounts,{{schema}}.tf_authorization_lock TO %I',profile_owner);
    EXECUTE format('GRANT UPDATE(lock_version) ON {{schema}}.tf_authorization_lock TO %I',profile_owner);
  END IF;
END
$$;

-- 0051_default_connection_knowledge.sql
CREATE TABLE {{schema}}.tf_knowledge_default_intents (
  id uuid PRIMARY KEY,
  product text NOT NULL CHECK (product IN ('google-drive','gmail','slack','github','jira','confluence')),
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  account_key text NOT NULL CHECK (char_length(account_key) BETWEEN 1 AND 256),
  account_label text NOT NULL CHECK (char_length(account_label) BETWEEN 1 AND 256),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','opted-out')),
  sync_state text NOT NULL DEFAULT 'queued' CHECK (sync_state IN ('queued','discovering','ready','failed')),
  failure text CHECK (failure IS NULL OR char_length(failure) <= 128),
  cursor jsonb,
  pass bigint NOT NULL DEFAULT 0 CHECK (pass >= 0),
  generation bigint NOT NULL DEFAULT 1 CHECK (generation > 0),
  lease_token uuid,
  lease_until timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  discovered_at timestamptz,
  group_failures jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(group_failures) = 'array' AND jsonb_array_length(group_failures) <= 256),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (product, membership_id, account_key)
);
CREATE TABLE {{schema}}.tf_knowledge_default_scopes (
  intent_id uuid NOT NULL REFERENCES {{schema}}.tf_knowledge_default_intents(id),
  scope_key text NOT NULL CHECK (char_length(scope_key) BETWEEN 1 AND 512),
  group_key text NOT NULL CHECK (char_length(group_key) <= 256),
  title text NOT NULL CHECK (char_length(title) <= 512),
  seen_pass bigint NOT NULL CHECK (seen_pass >= 0),
  disposition text NOT NULL DEFAULT 'pending' CHECK (disposition IN ('pending','assigned','existing')),
  source_id uuid,
  PRIMARY KEY (intent_id, scope_key)
);
CREATE TABLE {{schema}}.tf_knowledge_default_sources (
  source_id uuid PRIMARY KEY,
  intent_id uuid NOT NULL REFERENCES {{schema}}.tf_knowledge_default_intents(id),
  ordinal integer NOT NULL CHECK (ordinal > 0),
  selection jsonb NOT NULL,
  state text NOT NULL DEFAULT 'planned' CHECK (state IN ('planned','created','failed')),
  failure text CHECK (failure IS NULL OR char_length(failure) <= 128),
  UNIQUE (intent_id, ordinal)
);
REVOKE ALL ON {{schema}}.tf_knowledge_default_intents, {{schema}}.tf_knowledge_default_scopes, {{schema}}.tf_knowledge_default_sources FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON {{schema}}.tf_knowledge_default_intents, {{schema}}.tf_knowledge_default_scopes, {{schema}}.tf_knowledge_default_sources TO {{runtime}};
CREATE INDEX tf_knowledge_default_intents_due ON {{schema}}.tf_knowledge_default_intents(next_attempt_at);
CREATE INDEX tf_knowledge_default_intents_member ON {{schema}}.tf_knowledge_default_intents(membership_id);

ALTER TABLE {{schema}}.tf_knowledge_github_items DROP CONSTRAINT tf_knowledge_github_items_kind_check;
ALTER TABLE {{schema}}.tf_knowledge_github_items ADD CONSTRAINT tf_knowledge_github_items_kind_check CHECK (kind IN ('doc','issue','pull','discussion','code'));

-- 0052_integrations.sql
-- Integrations were called connections. Rename every connection table, column, constraint, index, function, view,
-- default, and stored code to integration, so an upgraded workspace matches one built from history written with
-- integration names (test/integration/integration-rename.test.mjs). Overlong generated names use the name Postgres
-- itself derives for the renamed definition.

ALTER TABLE {{schema}}.tf_connection_creation_grants DROP CONSTRAINT tf_connection_creation_grants_permission_check;
ALTER TABLE {{schema}}.tf_conversation_parts DROP CONSTRAINT tf_conversation_parts_kind_check;
ALTER TABLE {{schema}}.tf_recommendation_events DROP CONSTRAINT tf_recommendation_events_kind_check;
ALTER TABLE {{schema}}.tf_table_import_objects DROP CONSTRAINT tf_table_import_objects_kind_check;
ALTER TABLE {{schema}}.tf_connection_creation_grants ALTER COLUMN permission DROP DEFAULT;

ALTER TABLE {{schema}}.tf_connection_creation_grants RENAME TO tf_integration_creation_grants;
ALTER TABLE {{schema}}.tf_connection_dispatches RENAME TO tf_integration_dispatches;
ALTER TABLE {{schema}}.tf_connection_grants RENAME TO tf_integration_grants;
ALTER TABLE {{schema}}.tf_connection_person_grants RENAME TO tf_integration_person_grants;
ALTER TABLE {{schema}}.tf_connection_source_grants RENAME TO tf_integration_source_grants;
ALTER TABLE {{schema}}.tf_connection_source_person_grants RENAME TO tf_integration_source_person_grants;
ALTER TABLE {{schema}}.tf_connection_sources RENAME TO tf_integration_sources;
ALTER TABLE {{schema}}.tf_connections RENAME TO tf_integrations;
ALTER TABLE {{schema}}.tf_google_connections RENAME TO tf_google_integrations;
ALTER TABLE {{schema}}.tf_mcp_connections RENAME TO tf_mcp_integrations;
ALTER TABLE {{schema}}.tf_provider_connections RENAME TO tf_provider_integrations;

ALTER TABLE {{schema}}.tf_bud_state RENAME COLUMN initial_connections TO initial_integrations;
ALTER TABLE {{schema}}.tf_integration_dispatches RENAME COLUMN connection_id TO integration_id;
ALTER TABLE {{schema}}.tf_integration_grants RENAME COLUMN connection_id TO integration_id;
ALTER TABLE {{schema}}.tf_integration_person_grants RENAME COLUMN connection_id TO integration_id;
ALTER TABLE {{schema}}.tf_integration_source_grants RENAME COLUMN connection_id TO integration_id;
ALTER TABLE {{schema}}.tf_integration_source_person_grants RENAME COLUMN connection_id TO integration_id;
ALTER TABLE {{schema}}.tf_integration_sources RENAME COLUMN connection_id TO integration_id;
ALTER TABLE {{schema}}.tf_github_chat_selection RENAME COLUMN connection_id TO integration_id;
ALTER TABLE {{schema}}.tf_github_chat_selection RENAME COLUMN connection_generation TO integration_generation;
ALTER TABLE {{schema}}.tf_github_task_selection RENAME COLUMN connection_id TO integration_id;
ALTER TABLE {{schema}}.tf_github_task_selection RENAME COLUMN connection_generation TO integration_generation;
ALTER TABLE {{schema}}.tf_google_heartbeat_items RENAME COLUMN connection_id TO integration_id;
ALTER TABLE {{schema}}.tf_google_heartbeats RENAME COLUMN connection_id TO integration_id;
ALTER TABLE {{schema}}.tf_google_oauth_states RENAME COLUMN connection_id TO integration_id;
ALTER TABLE {{schema}}.tf_google_proposals RENAME COLUMN connection_id TO integration_id;
ALTER VIEW {{schema}}.tf_knowledge_google_readers RENAME COLUMN connection_id TO integration_id;
ALTER TABLE {{schema}}.tf_mcp_actions RENAME COLUMN connection_id TO integration_id;
ALTER TABLE {{schema}}.tf_mcp_claims RENAME COLUMN connection_id TO integration_id;
ALTER TABLE {{schema}}.tf_mcp_managers RENAME COLUMN connection_id TO integration_id;
ALTER TABLE {{schema}}.tf_mcp_member_grants RENAME COLUMN connection_id TO integration_id;
ALTER TABLE {{schema}}.tf_mcp_oauth_attempts RENAME COLUMN connection_id TO integration_id;
ALTER TABLE {{schema}}.tf_mcp_team_grants RENAME COLUMN connection_id TO integration_id;
ALTER TABLE {{schema}}.tf_mcp_tool_policies RENAME COLUMN connection_id TO integration_id;
ALTER TABLE {{schema}}.tf_mcp_tool_revisions RENAME COLUMN connection_id TO integration_id;
ALTER TABLE {{schema}}.tf_provider_polls RENAME COLUMN connection_id TO integration_id;
ALTER TABLE {{schema}}.tf_workflow_provider_grants RENAME COLUMN connection_id TO integration_id;

ALTER TABLE {{schema}}.tf_bud_state RENAME CONSTRAINT tf_bud_state_initial_connections_not_null TO tf_bud_state_initial_integrations_not_null;
ALTER TABLE {{schema}}.tf_integration_creation_grants RENAME CONSTRAINT tf_connection_creation_grants_owning_team_id_fkey TO tf_integration_creation_grants_owning_team_id_fkey;
ALTER TABLE {{schema}}.tf_integration_creation_grants RENAME CONSTRAINT tf_connection_creation_grants_owning_team_id_not_null TO tf_integration_creation_grants_owning_team_id_not_null;
ALTER TABLE {{schema}}.tf_integration_creation_grants RENAME CONSTRAINT tf_connection_creation_grants_permission_not_null TO tf_integration_creation_grants_permission_not_null;
ALTER TABLE {{schema}}.tf_integration_creation_grants RENAME CONSTRAINT tf_connection_creation_grants_pkey TO tf_integration_creation_grants_pkey;
ALTER TABLE {{schema}}.tf_integration_creation_grants RENAME CONSTRAINT tf_connection_creation_grants_team_id_fkey TO tf_integration_creation_grants_team_id_fkey;
ALTER TABLE {{schema}}.tf_integration_creation_grants RENAME CONSTRAINT tf_connection_creation_grants_team_id_not_null TO tf_integration_creation_grants_team_id_not_null;
ALTER TABLE {{schema}}.tf_integration_dispatches RENAME CONSTRAINT tf_connection_dispatches_actor_not_null TO tf_integration_dispatches_actor_not_null;
ALTER TABLE {{schema}}.tf_integration_dispatches RENAME CONSTRAINT tf_connection_dispatches_attempt_check TO tf_integration_dispatches_attempt_check;
ALTER TABLE {{schema}}.tf_integration_dispatches RENAME CONSTRAINT tf_connection_dispatches_attempt_not_null TO tf_integration_dispatches_attempt_not_null;
ALTER TABLE {{schema}}.tf_integration_dispatches RENAME CONSTRAINT tf_connection_dispatches_check TO tf_integration_dispatches_check;
ALTER TABLE {{schema}}.tf_integration_dispatches RENAME CONSTRAINT tf_connection_dispatches_connection_id_not_null TO tf_integration_dispatches_integration_id_not_null;
ALTER TABLE {{schema}}.tf_integration_dispatches RENAME CONSTRAINT tf_connection_dispatches_connection_id_source_id_fkey TO tf_integration_dispatches_integration_id_source_id_fkey;
ALTER TABLE {{schema}}.tf_integration_dispatches RENAME CONSTRAINT tf_connection_dispatches_generation_check TO tf_integration_dispatches_generation_check;
ALTER TABLE {{schema}}.tf_integration_dispatches RENAME CONSTRAINT tf_connection_dispatches_generation_not_null TO tf_integration_dispatches_generation_not_null;
ALTER TABLE {{schema}}.tf_integration_dispatches RENAME CONSTRAINT tf_connection_dispatches_issue_number_check TO tf_integration_dispatches_issue_number_check;
ALTER TABLE {{schema}}.tf_integration_dispatches RENAME CONSTRAINT tf_connection_dispatches_issue_number_not_null TO tf_integration_dispatches_issue_number_not_null;
ALTER TABLE {{schema}}.tf_integration_dispatches RENAME CONSTRAINT tf_connection_dispatches_pkey TO tf_integration_dispatches_pkey;
ALTER TABLE {{schema}}.tf_integration_dispatches RENAME CONSTRAINT tf_connection_dispatches_request_id_not_null TO tf_integration_dispatches_request_id_not_null;
ALTER TABLE {{schema}}.tf_integration_dispatches RENAME CONSTRAINT tf_connection_dispatches_source_id_not_null TO tf_integration_dispatches_source_id_not_null;
ALTER TABLE {{schema}}.tf_integration_dispatches RENAME CONSTRAINT tf_connection_dispatches_started_at_not_null TO tf_integration_dispatches_started_at_not_null;
ALTER TABLE {{schema}}.tf_integration_dispatches RENAME CONSTRAINT tf_connection_dispatches_status_check TO tf_integration_dispatches_status_check;
ALTER TABLE {{schema}}.tf_integration_dispatches RENAME CONSTRAINT tf_connection_dispatches_status_not_null TO tf_integration_dispatches_status_not_null;
ALTER TABLE {{schema}}.tf_integration_grants RENAME CONSTRAINT tf_connection_grants_connection_id_fkey TO tf_integration_grants_integration_id_fkey;
ALTER TABLE {{schema}}.tf_integration_grants RENAME CONSTRAINT tf_connection_grants_connection_id_not_null TO tf_integration_grants_integration_id_not_null;
ALTER TABLE {{schema}}.tf_integration_grants RENAME CONSTRAINT tf_connection_grants_connection_id_team_id_read_permission_fkey TO tf_integration_grants_integration_id_team_id_read_permissi_fkey;
ALTER TABLE {{schema}}.tf_integration_grants RENAME CONSTRAINT tf_connection_grants_permission_check TO tf_integration_grants_permission_check;
ALTER TABLE {{schema}}.tf_integration_grants RENAME CONSTRAINT tf_connection_grants_permission_not_null TO tf_integration_grants_permission_not_null;
ALTER TABLE {{schema}}.tf_integration_grants RENAME CONSTRAINT tf_connection_grants_pkey TO tf_integration_grants_pkey;
ALTER TABLE {{schema}}.tf_integration_grants RENAME CONSTRAINT tf_connection_grants_read_permission_check TO tf_integration_grants_read_permission_check;
ALTER TABLE {{schema}}.tf_integration_grants RENAME CONSTRAINT tf_connection_grants_read_permission_not_null TO tf_integration_grants_read_permission_not_null;
ALTER TABLE {{schema}}.tf_integration_grants RENAME CONSTRAINT tf_connection_grants_team_id_fkey TO tf_integration_grants_team_id_fkey;
ALTER TABLE {{schema}}.tf_integration_grants RENAME CONSTRAINT tf_connection_grants_team_id_not_null TO tf_integration_grants_team_id_not_null;
ALTER TABLE {{schema}}.tf_integration_person_grants RENAME CONSTRAINT tf_connection_person_grants_connection_id_fkey TO tf_integration_person_grants_integration_id_fkey;
ALTER TABLE {{schema}}.tf_integration_person_grants RENAME CONSTRAINT tf_connection_person_grants_connection_id_not_null TO tf_integration_person_grants_integration_id_not_null;
ALTER TABLE {{schema}}.tf_integration_person_grants RENAME CONSTRAINT tf_connection_person_grants_membership_id_fkey TO tf_integration_person_grants_membership_id_fkey;
ALTER TABLE {{schema}}.tf_integration_person_grants RENAME CONSTRAINT tf_connection_person_grants_membership_id_not_null TO tf_integration_person_grants_membership_id_not_null;
ALTER TABLE {{schema}}.tf_integration_person_grants RENAME CONSTRAINT tf_connection_person_grants_permission_check TO tf_integration_person_grants_permission_check;
ALTER TABLE {{schema}}.tf_integration_person_grants RENAME CONSTRAINT tf_connection_person_grants_permission_not_null TO tf_integration_person_grants_permission_not_null;
ALTER TABLE {{schema}}.tf_integration_person_grants RENAME CONSTRAINT tf_connection_person_grants_pkey TO tf_integration_person_grants_pkey;
ALTER TABLE {{schema}}.tf_integration_source_grants RENAME CONSTRAINT tf_connection_source_grants_connection_id_not_null TO tf_integration_source_grants_integration_id_not_null;
ALTER TABLE {{schema}}.tf_integration_source_grants RENAME CONSTRAINT tf_connection_source_grants_connection_id_source_id_fkey TO tf_integration_source_grants_integration_id_source_id_fkey;
ALTER TABLE {{schema}}.tf_integration_source_grants RENAME CONSTRAINT tf_connection_source_grants_permission_check TO tf_integration_source_grants_permission_check;
ALTER TABLE {{schema}}.tf_integration_source_grants RENAME CONSTRAINT tf_connection_source_grants_permission_not_null TO tf_integration_source_grants_permission_not_null;
ALTER TABLE {{schema}}.tf_integration_source_grants RENAME CONSTRAINT tf_connection_source_grants_pkey TO tf_integration_source_grants_pkey;
ALTER TABLE {{schema}}.tf_integration_source_grants RENAME CONSTRAINT tf_connection_source_grants_source_id_not_null TO tf_integration_source_grants_source_id_not_null;
ALTER TABLE {{schema}}.tf_integration_source_grants RENAME CONSTRAINT tf_connection_source_grants_team_id_fkey TO tf_integration_source_grants_team_id_fkey;
ALTER TABLE {{schema}}.tf_integration_source_grants RENAME CONSTRAINT tf_connection_source_grants_team_id_not_null TO tf_integration_source_grants_team_id_not_null;
ALTER TABLE {{schema}}.tf_integration_source_person_grants RENAME CONSTRAINT tf_connection_source_person_grants_connection_id_not_null TO tf_integration_source_person_grants_integration_id_not_null;
ALTER TABLE {{schema}}.tf_integration_source_person_grants RENAME CONSTRAINT tf_connection_source_person_grants_connection_id_source_id_fkey TO tf_integration_source_person_gran_integration_id_source_id_fkey;
ALTER TABLE {{schema}}.tf_integration_source_person_grants RENAME CONSTRAINT tf_connection_source_person_grants_membership_id_fkey TO tf_integration_source_person_grants_membership_id_fkey;
ALTER TABLE {{schema}}.tf_integration_source_person_grants RENAME CONSTRAINT tf_connection_source_person_grants_membership_id_not_null TO tf_integration_source_person_grants_membership_id_not_null;
ALTER TABLE {{schema}}.tf_integration_source_person_grants RENAME CONSTRAINT tf_connection_source_person_grants_permission_check TO tf_integration_source_person_grants_permission_check;
ALTER TABLE {{schema}}.tf_integration_source_person_grants RENAME CONSTRAINT tf_connection_source_person_grants_permission_not_null TO tf_integration_source_person_grants_permission_not_null;
ALTER TABLE {{schema}}.tf_integration_source_person_grants RENAME CONSTRAINT tf_connection_source_person_grants_pkey TO tf_integration_source_person_grants_pkey;
ALTER TABLE {{schema}}.tf_integration_source_person_grants RENAME CONSTRAINT tf_connection_source_person_grants_source_id_not_null TO tf_integration_source_person_grants_source_id_not_null;
ALTER TABLE {{schema}}.tf_integration_sources RENAME CONSTRAINT tf_connection_sources_connection_id_fkey TO tf_integration_sources_integration_id_fkey;
ALTER TABLE {{schema}}.tf_integration_sources RENAME CONSTRAINT tf_connection_sources_connection_id_id_key TO tf_integration_sources_integration_id_id_key;
ALTER TABLE {{schema}}.tf_integration_sources RENAME CONSTRAINT tf_connection_sources_connection_id_not_null TO tf_integration_sources_integration_id_not_null;
ALTER TABLE {{schema}}.tf_integration_sources RENAME CONSTRAINT tf_connection_sources_id_not_null TO tf_integration_sources_id_not_null;
ALTER TABLE {{schema}}.tf_integration_sources RENAME CONSTRAINT tf_connection_sources_owner_check TO tf_integration_sources_owner_check;
ALTER TABLE {{schema}}.tf_integration_sources RENAME CONSTRAINT tf_connection_sources_owner_not_null TO tf_integration_sources_owner_not_null;
ALTER TABLE {{schema}}.tf_integration_sources RENAME CONSTRAINT tf_connection_sources_pkey TO tf_integration_sources_pkey;
ALTER TABLE {{schema}}.tf_integration_sources RENAME CONSTRAINT tf_connection_sources_repo_check TO tf_integration_sources_repo_check;
ALTER TABLE {{schema}}.tf_integration_sources RENAME CONSTRAINT tf_connection_sources_repo_not_null TO tf_integration_sources_repo_not_null;
ALTER TABLE {{schema}}.tf_integrations RENAME CONSTRAINT tf_connections_check TO tf_integrations_check;
ALTER TABLE {{schema}}.tf_integrations RENAME CONSTRAINT tf_connections_created_by_not_null TO tf_integrations_created_by_not_null;
ALTER TABLE {{schema}}.tf_integrations RENAME CONSTRAINT tf_connections_creation_intent_not_null TO tf_integrations_creation_intent_not_null;
ALTER TABLE {{schema}}.tf_integrations RENAME CONSTRAINT tf_connections_enabled_not_null TO tf_integrations_enabled_not_null;
ALTER TABLE {{schema}}.tf_integrations RENAME CONSTRAINT tf_connections_generation_check TO tf_integrations_generation_check;
ALTER TABLE {{schema}}.tf_integrations RENAME CONSTRAINT tf_connections_generation_not_null TO tf_integrations_generation_not_null;
ALTER TABLE {{schema}}.tf_integrations RENAME CONSTRAINT tf_connections_grants_version_check TO tf_integrations_grants_version_check;
ALTER TABLE {{schema}}.tf_integrations RENAME CONSTRAINT tf_connections_grants_version_not_null TO tf_integrations_grants_version_not_null;
ALTER TABLE {{schema}}.tf_integrations RENAME CONSTRAINT tf_connections_id_not_null TO tf_integrations_id_not_null;
ALTER TABLE {{schema}}.tf_integrations RENAME CONSTRAINT tf_connections_live_owning_team_id_fkey TO tf_integrations_live_owning_team_id_fkey;
ALTER TABLE {{schema}}.tf_integrations RENAME CONSTRAINT tf_connections_name_check TO tf_integrations_name_check;
ALTER TABLE {{schema}}.tf_integrations RENAME CONSTRAINT tf_connections_name_not_null TO tf_integrations_name_not_null;
ALTER TABLE {{schema}}.tf_integrations RENAME CONSTRAINT tf_connections_owning_team_id_not_null TO tf_integrations_owning_team_id_not_null;
ALTER TABLE {{schema}}.tf_integrations RENAME CONSTRAINT tf_connections_pkey TO tf_integrations_pkey;
ALTER TABLE {{schema}}.tf_github_chat_selection RENAME CONSTRAINT tf_github_chat_selection_connection_generation_check TO tf_github_chat_selection_integration_generation_check;
ALTER TABLE {{schema}}.tf_github_chat_selection RENAME CONSTRAINT tf_github_chat_selection_connection_id_fkey TO tf_github_chat_selection_integration_id_fkey;
ALTER TABLE {{schema}}.tf_github_task_selection RENAME CONSTRAINT tf_github_task_selection_connection_generation_check TO tf_github_task_selection_integration_generation_check;
ALTER TABLE {{schema}}.tf_github_task_selection RENAME CONSTRAINT tf_github_task_selection_connection_id_fkey TO tf_github_task_selection_integration_id_fkey;
ALTER TABLE {{schema}}.tf_google_integrations RENAME CONSTRAINT tf_google_connections_check TO tf_google_integrations_check;
ALTER TABLE {{schema}}.tf_google_integrations RENAME CONSTRAINT tf_google_connections_check1 TO tf_google_integrations_check1;
ALTER TABLE {{schema}}.tf_google_integrations RENAME CONSTRAINT tf_google_connections_generation_check TO tf_google_integrations_generation_check;
ALTER TABLE {{schema}}.tf_google_integrations RENAME CONSTRAINT tf_google_connections_generation_not_null TO tf_google_integrations_generation_not_null;
ALTER TABLE {{schema}}.tf_google_integrations RENAME CONSTRAINT tf_google_connections_id_not_null TO tf_google_integrations_id_not_null;
ALTER TABLE {{schema}}.tf_google_integrations RENAME CONSTRAINT tf_google_connections_membership_id_fkey TO tf_google_integrations_membership_id_fkey;
ALTER TABLE {{schema}}.tf_google_integrations RENAME CONSTRAINT tf_google_connections_membership_id_key TO tf_google_integrations_membership_id_key;
ALTER TABLE {{schema}}.tf_google_integrations RENAME CONSTRAINT tf_google_connections_membership_id_not_null TO tf_google_integrations_membership_id_not_null;
ALTER TABLE {{schema}}.tf_google_integrations RENAME CONSTRAINT tf_google_connections_pkey TO tf_google_integrations_pkey;
ALTER TABLE {{schema}}.tf_google_integrations RENAME CONSTRAINT tf_google_connections_scopes_not_null TO tf_google_integrations_scopes_not_null;
ALTER TABLE {{schema}}.tf_google_integrations RENAME CONSTRAINT tf_google_connections_status_check TO tf_google_integrations_status_check;
ALTER TABLE {{schema}}.tf_google_integrations RENAME CONSTRAINT tf_google_connections_status_not_null TO tf_google_integrations_status_not_null;
ALTER TABLE {{schema}}.tf_google_integrations RENAME CONSTRAINT tf_google_connections_user_id_not_null TO tf_google_integrations_user_id_not_null;
ALTER TABLE {{schema}}.tf_google_heartbeat_items RENAME CONSTRAINT tf_google_heartbeat_items_connection_id_account_id_message__key TO tf_google_heartbeat_items_integration_id_account_id_message_key;
ALTER TABLE {{schema}}.tf_google_heartbeat_items RENAME CONSTRAINT tf_google_heartbeat_items_connection_id_fkey TO tf_google_heartbeat_items_integration_id_fkey;
ALTER TABLE {{schema}}.tf_google_heartbeat_items RENAME CONSTRAINT tf_google_heartbeat_items_connection_id_not_null TO tf_google_heartbeat_items_integration_id_not_null;
ALTER TABLE {{schema}}.tf_google_heartbeats RENAME CONSTRAINT tf_google_heartbeats_connection_id_fkey TO tf_google_heartbeats_integration_id_fkey;
ALTER TABLE {{schema}}.tf_google_heartbeats RENAME CONSTRAINT tf_google_heartbeats_connection_id_not_null TO tf_google_heartbeats_integration_id_not_null;
ALTER TABLE {{schema}}.tf_google_oauth_states RENAME CONSTRAINT tf_google_oauth_states_connection_id_fkey TO tf_google_oauth_states_integration_id_fkey;
ALTER TABLE {{schema}}.tf_google_oauth_states RENAME CONSTRAINT tf_google_oauth_states_connection_id_not_null TO tf_google_oauth_states_integration_id_not_null;
ALTER TABLE {{schema}}.tf_google_proposals RENAME CONSTRAINT tf_google_proposals_connection_id_fkey TO tf_google_proposals_integration_id_fkey;
ALTER TABLE {{schema}}.tf_google_proposals RENAME CONSTRAINT tf_google_proposals_connection_id_not_null TO tf_google_proposals_integration_id_not_null;
ALTER TABLE {{schema}}.tf_mcp_actions RENAME CONSTRAINT tf_mcp_actions_connection_id_fkey TO tf_mcp_actions_integration_id_fkey;
ALTER TABLE {{schema}}.tf_mcp_actions RENAME CONSTRAINT tf_mcp_actions_connection_id_not_null TO tf_mcp_actions_integration_id_not_null;
ALTER TABLE {{schema}}.tf_mcp_actions RENAME CONSTRAINT tf_mcp_actions_connection_id_tool_name_tool_revision_fkey TO tf_mcp_actions_integration_id_tool_name_tool_revision_fkey;
ALTER TABLE {{schema}}.tf_mcp_claims RENAME CONSTRAINT tf_mcp_claims_connection_id_fkey TO tf_mcp_claims_integration_id_fkey;
ALTER TABLE {{schema}}.tf_mcp_claims RENAME CONSTRAINT tf_mcp_claims_connection_id_not_null TO tf_mcp_claims_integration_id_not_null;
ALTER TABLE {{schema}}.tf_mcp_integrations RENAME CONSTRAINT tf_mcp_connections_auth_method_check TO tf_mcp_integrations_auth_method_check;
ALTER TABLE {{schema}}.tf_mcp_integrations RENAME CONSTRAINT tf_mcp_connections_auth_method_not_null TO tf_mcp_integrations_auth_method_not_null;
ALTER TABLE {{schema}}.tf_mcp_integrations RENAME CONSTRAINT tf_mcp_connections_authorization_epoch_check TO tf_mcp_integrations_authorization_epoch_check;
ALTER TABLE {{schema}}.tf_mcp_integrations RENAME CONSTRAINT tf_mcp_connections_authorization_epoch_not_null TO tf_mcp_integrations_authorization_epoch_not_null;
ALTER TABLE {{schema}}.tf_mcp_integrations RENAME CONSTRAINT tf_mcp_connections_check TO tf_mcp_integrations_check;
ALTER TABLE {{schema}}.tf_mcp_integrations RENAME CONSTRAINT tf_mcp_connections_check1 TO tf_mcp_integrations_check1;
ALTER TABLE {{schema}}.tf_mcp_integrations RENAME CONSTRAINT tf_mcp_connections_check2 TO tf_mcp_integrations_check2;
ALTER TABLE {{schema}}.tf_mcp_integrations RENAME CONSTRAINT tf_mcp_connections_created_at_not_null TO tf_mcp_integrations_created_at_not_null;
ALTER TABLE {{schema}}.tf_mcp_integrations RENAME CONSTRAINT tf_mcp_connections_descriptor_approved_not_null TO tf_mcp_integrations_descriptor_approved_not_null;
ALTER TABLE {{schema}}.tf_mcp_integrations RENAME CONSTRAINT tf_mcp_connections_endpoint_not_null TO tf_mcp_integrations_endpoint_not_null;
ALTER TABLE {{schema}}.tf_mcp_integrations RENAME CONSTRAINT tf_mcp_connections_grants_version_check TO tf_mcp_integrations_grants_version_check;
ALTER TABLE {{schema}}.tf_mcp_integrations RENAME CONSTRAINT tf_mcp_connections_grants_version_not_null TO tf_mcp_integrations_grants_version_not_null;
ALTER TABLE {{schema}}.tf_mcp_integrations RENAME CONSTRAINT tf_mcp_connections_id_not_null TO tf_mcp_integrations_id_not_null;
ALTER TABLE {{schema}}.tf_mcp_integrations RENAME CONSTRAINT tf_mcp_connections_lifecycle_check TO tf_mcp_integrations_lifecycle_check;
ALTER TABLE {{schema}}.tf_mcp_integrations RENAME CONSTRAINT tf_mcp_connections_lifecycle_not_null TO tf_mcp_integrations_lifecycle_not_null;
ALTER TABLE {{schema}}.tf_mcp_integrations RENAME CONSTRAINT tf_mcp_connections_name_not_null TO tf_mcp_integrations_name_not_null;
ALTER TABLE {{schema}}.tf_mcp_integrations RENAME CONSTRAINT tf_mcp_connections_owner_membership_id_fkey TO tf_mcp_integrations_owner_membership_id_fkey;
ALTER TABLE {{schema}}.tf_mcp_integrations RENAME CONSTRAINT tf_mcp_connections_ownership_check TO tf_mcp_integrations_ownership_check;
ALTER TABLE {{schema}}.tf_mcp_integrations RENAME CONSTRAINT tf_mcp_connections_ownership_not_null TO tf_mcp_integrations_ownership_not_null;
ALTER TABLE {{schema}}.tf_mcp_integrations RENAME CONSTRAINT tf_mcp_connections_pkey TO tf_mcp_integrations_pkey;
ALTER TABLE {{schema}}.tf_mcp_integrations RENAME CONSTRAINT tf_mcp_connections_secret_version_check TO tf_mcp_integrations_secret_version_check;
ALTER TABLE {{schema}}.tf_mcp_integrations RENAME CONSTRAINT tf_mcp_connections_secret_version_not_null TO tf_mcp_integrations_secret_version_not_null;
ALTER TABLE {{schema}}.tf_mcp_integrations RENAME CONSTRAINT tf_mcp_connections_server_identity_not_null TO tf_mcp_integrations_server_identity_not_null;
ALTER TABLE {{schema}}.tf_mcp_integrations RENAME CONSTRAINT tf_mcp_connections_version_not_null TO tf_mcp_integrations_version_not_null;
ALTER TABLE {{schema}}.tf_mcp_managers RENAME CONSTRAINT tf_mcp_managers_connection_id_fkey TO tf_mcp_managers_integration_id_fkey;
ALTER TABLE {{schema}}.tf_mcp_managers RENAME CONSTRAINT tf_mcp_managers_connection_id_membership_id_team_id_key TO tf_mcp_managers_integration_id_membership_id_team_id_key;
ALTER TABLE {{schema}}.tf_mcp_managers RENAME CONSTRAINT tf_mcp_managers_connection_id_not_null TO tf_mcp_managers_integration_id_not_null;
ALTER TABLE {{schema}}.tf_mcp_member_grants RENAME CONSTRAINT tf_mcp_member_grants_connection_id_fkey TO tf_mcp_member_grants_integration_id_fkey;
ALTER TABLE {{schema}}.tf_mcp_member_grants RENAME CONSTRAINT tf_mcp_member_grants_connection_id_not_null TO tf_mcp_member_grants_integration_id_not_null;
ALTER TABLE {{schema}}.tf_mcp_oauth_attempts RENAME CONSTRAINT tf_mcp_oauth_attempts_connection_id_fkey TO tf_mcp_oauth_attempts_integration_id_fkey;
ALTER TABLE {{schema}}.tf_mcp_oauth_attempts RENAME CONSTRAINT tf_mcp_oauth_attempts_connection_id_not_null TO tf_mcp_oauth_attempts_integration_id_not_null;
ALTER TABLE {{schema}}.tf_mcp_team_grants RENAME CONSTRAINT tf_mcp_team_grants_connection_id_fkey TO tf_mcp_team_grants_integration_id_fkey;
ALTER TABLE {{schema}}.tf_mcp_team_grants RENAME CONSTRAINT tf_mcp_team_grants_connection_id_not_null TO tf_mcp_team_grants_integration_id_not_null;
ALTER TABLE {{schema}}.tf_mcp_tool_policies RENAME CONSTRAINT tf_mcp_tool_policies_connection_id_fkey TO tf_mcp_tool_policies_integration_id_fkey;
ALTER TABLE {{schema}}.tf_mcp_tool_policies RENAME CONSTRAINT tf_mcp_tool_policies_connection_id_name_discovered_revisio_fkey TO tf_mcp_tool_policies_integration_id_name_discovered_revisi_fkey;
ALTER TABLE {{schema}}.tf_mcp_tool_policies RENAME CONSTRAINT tf_mcp_tool_policies_connection_id_not_null TO tf_mcp_tool_policies_integration_id_not_null;
ALTER TABLE {{schema}}.tf_mcp_tool_revisions RENAME CONSTRAINT tf_mcp_tool_revisions_connection_id_fkey TO tf_mcp_tool_revisions_integration_id_fkey;
ALTER TABLE {{schema}}.tf_mcp_tool_revisions RENAME CONSTRAINT tf_mcp_tool_revisions_connection_id_not_null TO tf_mcp_tool_revisions_integration_id_not_null;
ALTER TABLE {{schema}}.tf_provider_integrations RENAME CONSTRAINT tf_provider_connections_creation_digest_not_null TO tf_provider_integrations_creation_digest_not_null;
ALTER TABLE {{schema}}.tf_provider_integrations RENAME CONSTRAINT tf_provider_connections_credential_not_null TO tf_provider_integrations_credential_not_null;
ALTER TABLE {{schema}}.tf_provider_integrations RENAME CONSTRAINT tf_provider_connections_enabled_not_null TO tf_provider_integrations_enabled_not_null;
ALTER TABLE {{schema}}.tf_provider_integrations RENAME CONSTRAINT tf_provider_connections_generation_check TO tf_provider_integrations_generation_check;
ALTER TABLE {{schema}}.tf_provider_integrations RENAME CONSTRAINT tf_provider_connections_generation_not_null TO tf_provider_integrations_generation_not_null;
ALTER TABLE {{schema}}.tf_provider_integrations RENAME CONSTRAINT tf_provider_connections_id_not_null TO tf_provider_integrations_id_not_null;
ALTER TABLE {{schema}}.tf_provider_integrations RENAME CONSTRAINT tf_provider_connections_membership_id_fkey TO tf_provider_integrations_membership_id_fkey;
ALTER TABLE {{schema}}.tf_provider_integrations RENAME CONSTRAINT tf_provider_connections_membership_id_not_null TO tf_provider_integrations_membership_id_not_null;
ALTER TABLE {{schema}}.tf_provider_integrations RENAME CONSTRAINT tf_provider_connections_name_not_null TO tf_provider_integrations_name_not_null;
ALTER TABLE {{schema}}.tf_provider_integrations RENAME CONSTRAINT tf_provider_connections_pkey TO tf_provider_integrations_pkey;
ALTER TABLE {{schema}}.tf_provider_integrations RENAME CONSTRAINT tf_provider_connections_source_not_null TO tf_provider_integrations_source_not_null;
ALTER TABLE {{schema}}.tf_provider_polls RENAME CONSTRAINT tf_provider_polls_connection_id_fkey TO tf_provider_polls_integration_id_fkey;
ALTER TABLE {{schema}}.tf_provider_polls RENAME CONSTRAINT tf_provider_polls_connection_id_not_null TO tf_provider_polls_integration_id_not_null;
ALTER TABLE {{schema}}.tf_workflow_provider_grants RENAME CONSTRAINT tf_workflow_provider_grants_connection_id_fkey TO tf_workflow_provider_grants_integration_id_fkey;
ALTER TABLE {{schema}}.tf_workflow_provider_grants RENAME CONSTRAINT tf_workflow_provider_grants_connection_id_not_null TO tf_workflow_provider_grants_integration_id_not_null;

ALTER INDEX {{schema}}.tf_connection_grants_team RENAME TO tf_integration_grants_team;
ALTER INDEX {{schema}}.tf_connection_repository RENAME TO tf_integration_repository;
ALTER INDEX {{schema}}.tf_connection_source_grants_team RENAME TO tf_integration_source_grants_team;

CREATE OR REPLACE FUNCTION {{schema}}.tf_mcp_invalidate_team_access()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE affected uuid;
BEGIN
  PERFORM id FROM {{schema}}.tf_authorization_lock WHERE id=1 FOR UPDATE;
  FOR affected IN SELECT integration_id FROM {{schema}}.tf_mcp_team_grants WHERE team_id=OLD.team_id ORDER BY integration_id LOOP
    UPDATE {{schema}}.tf_mcp_integrations SET authorization_epoch=authorization_epoch+1,version=version+1,grants_version=grants_version+1,refresh_claim=NULL,refresh_started_at=NULL WHERE id=affected;
    UPDATE {{schema}}.tf_mcp_tool_policies SET enabled_revision=NULL,standing_exception=false,policy_version=policy_version+1 WHERE integration_id=affected;
    UPDATE {{schema}}.tf_mcp_oauth_attempts SET state='consumed',material=NULL WHERE integration_id=affected;
  END LOOP;
  RETURN OLD;
END $function$;

CREATE OR REPLACE FUNCTION {{schema}}.tf_mcp_invalidate_team_grant()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN
  PERFORM id FROM {{schema}}.tf_authorization_lock WHERE id=1 FOR UPDATE;
  UPDATE {{schema}}.tf_mcp_integrations SET authorization_epoch=authorization_epoch+1,version=version+1,grants_version=grants_version+1,refresh_claim=NULL,refresh_started_at=NULL WHERE id=OLD.integration_id;
  UPDATE {{schema}}.tf_mcp_tool_policies SET enabled_revision=NULL,standing_exception=false,policy_version=policy_version+1 WHERE integration_id=OLD.integration_id;
  UPDATE {{schema}}.tf_mcp_oauth_attempts SET state='consumed',material=NULL WHERE integration_id=OLD.integration_id;
  RETURN OLD;
END $function$;

CREATE OR REPLACE FUNCTION {{schema}}.tf_mcp_validate_claim()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN
  PERFORM 1 FROM {{schema}}.tf_mcp_integrations WHERE id=NEW.integration_id FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM {{schema}}.tf_mcp_actions WHERE id=NEW.action_id AND integration_id=NEW.integration_id AND expires_at>clock_timestamp()) THEN
    RAISE EXCEPTION 'Invalid MCP claim';
  END IF;
  IF EXISTS (SELECT 1 FROM {{schema}}.tf_mcp_claims c LEFT JOIN {{schema}}.tf_mcp_receipts r ON r.action_id=c.action_id
    WHERE c.integration_id=NEW.integration_id AND (r.action_id IS NULL OR (r.status='outcome-unknown' AND NOT EXISTS
      (SELECT 1 FROM {{schema}}.tf_mcp_reconciliations h WHERE h.action_id=c.action_id AND h.observation<>'still-unknown')))) THEN
    RAISE EXCEPTION 'MCP integration blocked';
  END IF;
  IF EXISTS (SELECT 1 FROM {{schema}}.tf_mcp_cancellations WHERE action_id=NEW.action_id) OR
     EXISTS (SELECT 1 FROM {{schema}}.tf_mcp_decisions WHERE action_id=NEW.action_id AND decision='reject') THEN
    RAISE EXCEPTION 'MCP action cancelled';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM {{schema}}.tf_mcp_actions a JOIN {{schema}}.tf_mcp_decisions d ON d.action_id=a.id
    WHERE a.id=NEW.action_id AND d.decision='approve' AND d.digest=a.digest AND d.membership_id=(a.requester->>'membershipId')::uuid)
    AND NOT EXISTS (SELECT 1 FROM {{schema}}.tf_mcp_actions a JOIN {{schema}}.tf_mcp_policy_evaluations e ON e.action_id=a.id
      JOIN {{schema}}.tf_mcp_tool_policies p ON p.integration_id=a.integration_id AND p.name=a.tool_name
      WHERE a.id=NEW.action_id AND NOT a.requires_consent AND e.digest=a.digest AND e.policy_version=a.policy_version
      AND p.policy_version=a.policy_version AND p.standing_exception AND p.enabled_revision=a.tool_revision) THEN
    RAISE EXCEPTION 'MCP approval required';
  END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION {{schema}}.tf_table_source_allowed(member_id uuid, actor_user text, source jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE integration_row record; source_row record;
BEGIN
  PERFORM id FROM {{schema}}.tf_authorization_lock WHERE id=1 FOR SHARE;
  IF NOT EXISTS(SELECT 1 FROM {{schema}}.tf_memberships WHERE id=member_id AND user_id=actor_user AND removed_at IS NULL) THEN RETURN false; END IF;
  CASE source->>'kind'
  WHEN 'private-conversation' THEN
    RETURN EXISTS(SELECT 1 FROM {{schema}}.tf_conversations WHERE id=(source->>'conversationId')::uuid AND kind='private' AND owner_user_id=actor_user AND owner_membership_id=member_id);
  WHEN 'github-source','integration-source' THEN
    SELECT * INTO integration_row FROM {{schema}}.tf_integrations WHERE id=(source->>'integrationId')::uuid FOR SHARE;
    IF NOT FOUND OR NOT integration_row.enabled OR integration_row.deleted_at IS NOT NULL THEN RETURN false; END IF;
    IF source->>'kind'='github-source' AND (integration_row.generation<>(source->>'generation')::integer OR integration_row.grants_version<>(source->>'grantsVersion')::integer) THEN RETURN false; END IF;
    RETURN EXISTS(SELECT 1 FROM {{schema}}.tf_integration_sources WHERE id=(source->>'sourceId')::uuid AND integration_id=integration_row.id)
      AND NOT EXISTS(SELECT permission FROM (VALUES ('read'),('use')) p(permission) WHERE NOT (
        EXISTS(SELECT 1 FROM {{schema}}.tf_integration_person_grants g WHERE g.integration_id=integration_row.id AND g.membership_id=member_id AND g.permission=p.permission)
        OR EXISTS(SELECT 1 FROM {{schema}}.tf_integration_grants g JOIN {{schema}}.tf_member_teams mt ON mt.team_id=g.team_id WHERE mt.membership_id=member_id AND g.integration_id=integration_row.id AND g.permission=p.permission)))
      AND (EXISTS(SELECT 1 FROM {{schema}}.tf_integration_source_person_grants g WHERE g.source_id=(source->>'sourceId')::uuid AND g.membership_id=member_id)
        OR EXISTS(SELECT 1 FROM {{schema}}.tf_integration_source_grants g JOIN {{schema}}.tf_member_teams mt ON mt.team_id=g.team_id WHERE mt.membership_id=member_id AND g.source_id=(source->>'sourceId')::uuid AND g.permission='github.issue.read'));
  WHEN 'google-integration' THEN
    IF source->>'membershipId'<>member_id::text THEN RETURN false; END IF;
    SELECT * INTO integration_row FROM {{schema}}.tf_google_integrations WHERE id=(source->>'integrationId')::uuid FOR SHARE;
    IF NOT FOUND THEN RETURN false; END IF;
    RETURN integration_row.account_id=source->>'accountId' AND integration_row.membership_id=member_id AND integration_row.user_id=actor_user AND integration_row.generation=(source->>'generation')::integer AND integration_row.status='connected'
      AND to_jsonb(integration_row.scopes) @> (source->'scopes') AND (source->'scopes') @> to_jsonb(integration_row.scopes) AND to_jsonb(integration_row.scopes) @> (source->'requiredScopes');
  WHEN 'atlassian-source' THEN
    IF source->>'membershipId'<>member_id::text THEN RETURN false; END IF;
    SELECT * INTO integration_row FROM {{schema}}.tf_atlassian_accounts WHERE id=(source->>'accountId')::uuid FOR SHARE;
    IF NOT FOUND THEN RETURN false; END IF;
    SELECT * INTO source_row FROM {{schema}}.tf_atlassian_sources WHERE id=(source->>'sourceId')::uuid FOR SHARE;
    IF NOT FOUND THEN RETURN false; END IF;
    RETURN source_row.account_id=integration_row.id AND source_row.membership_id=member_id AND source_row.enabled AND source_row.binding=(source->>'binding')::jsonb AND integration_row.state='active'
      AND integration_row.generation=(source->>'generation')::integer AND integration_row.grants_version=(source->>'grantsVersion')::integer AND integration_row.expires_at>clock_timestamp()
      AND ((integration_row.ownership='personal' AND integration_row.owner_membership_id=member_id) OR (integration_row.ownership='business' AND (
        EXISTS(SELECT 1 FROM {{schema}}.tf_atlassian_account_member_grants g WHERE g.account_id=integration_row.id AND g.membership_id=member_id)
        OR EXISTS(SELECT 1 FROM {{schema}}.tf_atlassian_account_team_grants g JOIN {{schema}}.tf_member_teams mt ON mt.team_id=g.team_id WHERE g.account_id=integration_row.id AND mt.membership_id=member_id))));
  ELSE RETURN false;
  END CASE;
END $function$;

CREATE OR REPLACE VIEW {{schema}}.tf_knowledge_google_eligible WITH (security_invoker=true) AS
SELECT d.id AS document_id,
    a.membership_id,
    a.user_id,
    p.expires_at
   FROM ((((({{schema}}.tf_knowledge_documents d
     JOIN {{schema}}.tf_knowledge_sources s ON ((s.id = d.source_id)))
     JOIN {{schema}}.tf_knowledge_revisions r ON ((r.id = d.observed_revision_id)))
     JOIN {{schema}}.tf_knowledge_google_readers a ON ((a.source_id = s.id)))
     JOIN {{schema}}.tf_knowledge_access_proofs p ON (((p.document_id = d.id) AND (p.membership_id = a.membership_id) AND (p.access_epoch = s.access_epoch))))
     JOIN {{schema}}.tf_knowledge_google_proof_bindings b ON (((b.document_id = d.id) AND (b.membership_id = a.membership_id))))
  WHERE ((d.tombstoned_at IS NULL) AND (p.expires_at > clock_timestamp()) AND (p.acl_version = r.source_revision) AND (p.acl_checked_at <= clock_timestamp()) AND (p.membership_checked_at <= clock_timestamp()) AND ((a.integration_id)::text = (b.binding ->> 'integrationId'::text)) AND (a.account_id = (b.binding ->> 'accountId'::text)) AND (a.generation = ((b.binding ->> 'generation'::text))::integer) AND (a.scopes @> ARRAY( SELECT jsonb_array_elements_text((b.binding -> 'requiredScopes'::text)) AS jsonb_array_elements_text)));

CREATE OR REPLACE VIEW {{schema}}.tf_knowledge_google_readers WITH (security_invoker=true) AS
SELECT s.id AS source_id,
    m.id AS membership_id,
    m.user_id,
    g.binding AS manager_binding,
    g.selection,
    c.id AS integration_id,
    c.account_id,
    c.generation,
    c.scopes
   FROM (((((({{schema}}.tf_knowledge_sources s
     JOIN {{schema}}.tf_knowledge_google_sources g ON ((g.source_id = s.id)))
     JOIN {{schema}}.tf_knowledge_google_members a ON ((a.source_id = s.id)))
     JOIN {{schema}}.tf_memberships m ON (((m.id = a.membership_id) AND (m.removed_at IS NULL))))
     JOIN {{schema}}.tf_memberships owner ON (((owner.id = s.owner_membership_id) AND (owner.removed_at IS NULL))))
     JOIN {{schema}}.tf_google_integrations manager ON (((manager.membership_id = owner.id) AND (manager.user_id = owner.user_id))))
     JOIN {{schema}}.tf_google_integrations c ON (((c.membership_id = m.id) AND (c.user_id = m.user_id))))
  WHERE ((s.provider = 'google'::text) AND (s.state = ANY (ARRAY['active'::text, 'paused'::text])) AND (s.account_namespace = (g.binding ->> 'accountId'::text)) AND (s.selection = (g.selection)::text) AND (((g.selection ->> 'kind'::text) <> 'gmail'::text) OR (m.id = owner.id)) AND (manager.status = 'connected'::text) AND ((manager.id)::text = (g.binding ->> 'integrationId'::text)) AND (manager.account_id = (g.binding ->> 'accountId'::text)) AND (manager.generation = ((g.binding ->> 'generation'::text))::integer) AND (manager.scopes @> ARRAY( SELECT jsonb_array_elements_text((g.binding -> 'requiredScopes'::text)) AS jsonb_array_elements_text)) AND (c.status = 'connected'::text) AND
        CASE
            WHEN ((g.selection ->> 'kind'::text) = 'gmail'::text) THEN (c.scopes && ARRAY['https://www.googleapis.com/auth/gmail.readonly'::text, 'https://www.googleapis.com/auth/gmail.modify'::text, 'https://mail.google.com/'::text])
            ELSE (c.scopes && ARRAY['https://www.googleapis.com/auth/drive.readonly'::text, 'https://www.googleapis.com/auth/drive'::text])
        END);

-- Stored codes follow the rename. The closed set is every code the connection-era release wrote, plus connection.*
-- permissions and audit operations. Strings must match it exactly, so user and provider text that merely mentions a
-- connection is left alone. Keys move only for the three fields the product writes. Credentials keep their envelopes (key ID connection-v1 included), and columns that hold provider
-- payloads or table cell values are historical input, not product codes.
-- Text `failure` columns hold provider error codes such as stale-connection, which the web matches by name.
CREATE FUNCTION {{schema}}.tf_integration_rename_code(value text, parent text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT CASE
    WHEN value ~ '^connection\.[a-z-]+$' OR value = ANY (ARRAY[
      'atlassian-stale-connection', 'connection-authority', 'connection-blocked', 'connection-create', 'connection-not-found',
      'connection-operation-failed', 'connection-or-membership-unavailable', 'connection-owner', 'connection-required',
      'connection-service-unavailable', 'connection-source', 'connection-token', 'connection-unavailable',
      'connections-unavailable', 'github-connections', 'github-stale-connection', 'google-connection',
      'google-connection-changed', 'google-connection-required', 'google-stale-connection', 'mcp-connection',
      'slack-stale-connection', 'stale-connection', 'team-owns-connections'])
      OR parent = ANY (ARRAY['kind', 'destination']) AND value = ANY (ARRAY['connection', 'connections'])
    THEN replace(value, 'connection', 'integration')
    ELSE value
  END
$$;
REVOKE ALL ON FUNCTION {{schema}}.tf_integration_rename_code(text, text) FROM PUBLIC;
CREATE FUNCTION {{schema}}.tf_integration_rename_json(value jsonb, parent text) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
BEGIN
  RETURN CASE jsonb_typeof(value)
    WHEN 'object' THEN (
      SELECT coalesce(jsonb_object_agg(
        CASE WHEN key = ANY (ARRAY['connectionId', 'connectionIds', 'connectionGeneration']) THEN replace(key, 'connection', 'integration') ELSE key END,
        {{schema}}.tf_integration_rename_json(item, key)), '{}'::jsonb)
      FROM jsonb_each(value) AS entry(key, item))
    WHEN 'array' THEN (
      SELECT coalesce(jsonb_agg({{schema}}.tf_integration_rename_json(item, parent) ORDER BY position), '[]'::jsonb)
      FROM jsonb_array_elements(value) WITH ORDINALITY AS element(item, position))
    WHEN 'string' THEN to_jsonb({{schema}}.tf_integration_rename_code(value #>> '{}', parent))
    ELSE value
  END;
END
$$;
REVOKE ALL ON FUNCTION {{schema}}.tf_integration_rename_json(jsonb, text) FROM PUBLIC;

DO $rename_codes$
DECLARE
  target record;
BEGIN
  FOR target IN
    SELECT c.oid::regclass AS relation, a.attname AS name, format_type(a.atttypid, NULL) AS type
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    WHERE c.relnamespace = '{{schema}}'::regnamespace AND c.relkind IN ('r', 'p') AND c.relname LIKE 'tf\_%'
      AND a.attnum > 0 AND NOT a.attisdropped
      AND (a.atttypid = 'jsonb'::regtype AND a.attname !~ '(credential|secret)' AND (c.relname, a.attname) NOT IN (
          ('tf_conversation_responses', 'answer'), ('tf_google_heartbeat_items', 'message'), ('tf_knowledge_embedding_vectors', 'vector'),
          ('tf_mcp_actions', 'arguments'), ('tf_mcp_tool_revisions', 'tool'), ('tf_provider_events', 'payload'),
          ('tf_slack_events', 'payload'), ('tf_slack_message_changes', 'message'), ('tf_table_proposal_changes', 'key_value'),
          ('tf_table_proposal_matches', 'key_value'), ('tf_table_proposal_matches', 'mapped'), ('tf_table_row_history', 'values'),
          ('tf_table_row_history', 'before_values'), ('tf_table_row_history_data', 'values'), ('tf_table_row_history_data', 'before_values'),
          ('tf_table_row_requests', 'input'), ('tf_table_row_requests', 'result'), ('tf_table_unique_values', 'value'),
          ('tf_workflow_automation_events', 'input'), ('tf_workflow_row_events', 'snapshot'), ('tf_workflow_runs', 'input'),
          ('tf_workflow_steps', 'output'))
        OR a.atttypid = 'text'::regtype AND a.attname = 'failure'
        OR (c.relname, a.attname) IN (('tf_audit_events', 'operation'), ('tf_integration_creation_grants', 'permission'),
          ('tf_recommendation_events', 'kind'), ('tf_table_import_objects', 'kind')))
    ORDER BY 1, 2
  LOOP
    EXECUTE format('ALTER TABLE %s DISABLE TRIGGER USER', target.relation);
    IF target.type = 'jsonb' THEN
      EXECUTE format('UPDATE %1$s SET %2$I = {{schema}}.tf_integration_rename_json(%2$I, NULL) WHERE %2$I::text LIKE ''%%connection%%'' AND %2$I IS DISTINCT FROM {{schema}}.tf_integration_rename_json(%2$I, NULL)', target.relation, target.name);
    ELSE
      EXECUTE format('UPDATE %1$s SET %2$I = {{schema}}.tf_integration_rename_code(%2$I, %3$L) WHERE %2$I LIKE ''%%connection%%'' AND %2$I IS DISTINCT FROM {{schema}}.tf_integration_rename_code(%2$I, %3$L)', target.relation, target.name, target.name);
    END IF;
    EXECUTE format('ALTER TABLE %s ENABLE TRIGGER USER', target.relation);
  END LOOP;
END
$rename_codes$;
DROP FUNCTION {{schema}}.tf_integration_rename_json(jsonb, text);
DROP FUNCTION {{schema}}.tf_integration_rename_code(text, text);

ALTER TABLE {{schema}}.tf_integration_creation_grants ALTER COLUMN permission SET DEFAULT 'integration.create'::text;
ALTER TABLE {{schema}}.tf_integration_creation_grants ADD CONSTRAINT tf_integration_creation_grants_permission_check CHECK ((permission = 'integration.create'::text));
ALTER TABLE {{schema}}.tf_conversation_parts ADD CONSTRAINT tf_conversation_parts_kind_check CHECK ((((kind = 'text'::text) AND (text IS NOT NULL) AND (attachment_id IS NULL) AND (request_id IS NULL) AND (response_id IS NULL) AND (approval_id IS NULL) AND (file_id IS NULL) AND (google_file IS NULL) AND (skill_id IS NULL) AND (compaction_id IS NULL)) OR ((kind = 'attachment'::text) AND (text IS NULL) AND (attachment_id IS NOT NULL) AND (request_id IS NULL) AND (response_id IS NULL) AND (approval_id IS NULL) AND (file_id IS NULL) AND (google_file IS NULL) AND (skill_id IS NULL) AND (compaction_id IS NULL)) OR ((kind = 'request'::text) AND (text IS NULL) AND (attachment_id IS NULL) AND (request_id IS NOT NULL) AND (response_id IS NULL) AND (approval_id IS NULL) AND (file_id IS NULL) AND (google_file IS NULL) AND (skill_id IS NULL) AND (compaction_id IS NULL)) OR ((kind = 'response'::text) AND (text IS NULL) AND (attachment_id IS NULL) AND (request_id IS NULL) AND (response_id IS NOT NULL) AND (approval_id IS NULL) AND (file_id IS NULL) AND (google_file IS NULL) AND (skill_id IS NULL) AND (compaction_id IS NULL)) OR ((kind = ANY (ARRAY['approval'::text, 'approval-resolution'::text])) AND (text IS NULL) AND (attachment_id IS NULL) AND (request_id IS NULL) AND (response_id IS NULL) AND (approval_id IS NOT NULL) AND (file_id IS NULL) AND (google_file IS NULL) AND (skill_id IS NULL) AND (compaction_id IS NULL)) OR ((kind = 'file'::text) AND (text IS NULL) AND (attachment_id IS NULL) AND (request_id IS NULL) AND (response_id IS NULL) AND (approval_id IS NULL) AND (file_id IS NOT NULL) AND (google_file IS NULL) AND (skill_id IS NULL) AND (compaction_id IS NULL)) OR ((kind = 'google-file'::text) AND (text IS NULL) AND (attachment_id IS NULL) AND (request_id IS NULL) AND (response_id IS NULL) AND (approval_id IS NULL) AND (file_id IS NULL) AND (skill_id IS NULL) AND (compaction_id IS NULL) AND (jsonb_typeof(google_file) = 'object'::text) AND (google_file ?& ARRAY['fileId'::text, 'integrationId'::text, 'accountId'::text, 'generation'::text, 'name'::text, 'mimeType'::text]) AND (octet_length((google_file)::text) <= 4096)) OR ((kind = ANY (ARRAY['skill'::text, 'skill-use'::text])) AND (text IS NULL) AND (attachment_id IS NULL) AND (request_id IS NULL) AND (response_id IS NULL) AND (approval_id IS NULL) AND (file_id IS NULL) AND (google_file IS NULL) AND (skill_id IS NOT NULL) AND (compaction_id IS NULL)) OR ((kind = 'compact'::text) AND (attachment_id IS NULL) AND (request_id IS NULL) AND (response_id IS NULL) AND (approval_id IS NULL) AND (file_id IS NULL) AND (google_file IS NULL) AND (skill_id IS NULL) AND ((text IS NULL) OR (compaction_id IS NULL)) AND (char_length(COALESCE(text, 'x'::text)) <= 2000)) OR ((kind = 'compaction'::text) AND (text IS NULL) AND (attachment_id IS NULL) AND (request_id IS NULL) AND (response_id IS NULL) AND (approval_id IS NULL) AND (file_id IS NULL) AND (google_file IS NULL) AND (skill_id IS NULL) AND (compaction_id IS NOT NULL))));
ALTER TABLE {{schema}}.tf_recommendation_events ADD CONSTRAINT tf_recommendation_events_kind_check CHECK ((kind = ANY (ARRAY['definition'::text, 'integration'::text, 'memory'::text, 'knowledge'::text, 'file'::text, 'rows'::text, 'membership'::text, 'project'::text, 'settings'::text, 'seed'::text, 'repair'::text])));
ALTER TABLE {{schema}}.tf_table_import_objects ADD CONSTRAINT tf_table_import_objects_kind_check CHECK ((kind = ANY (ARRAY['file'::text, 'integration'::text])));
