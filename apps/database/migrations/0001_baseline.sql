-- Squashed platform baseline (0001-0011 concatenated in order). Production started empty, so history was rewritten.

-- 0001_baseline.sql
CREATE SCHEMA IF NOT EXISTS app;

CREATE TABLE users (
  id uuid DEFAULT pg_catalog.gen_random_uuid() PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  email_verified boolean NOT NULL,
  image text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE sessions (
  id uuid DEFAULT pg_catalog.gen_random_uuid() PRIMARY KEY,
  expires_at timestamptz NOT NULL,
  token text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL,
  ip_address text,
  user_agent text,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE accounts (
  id uuid DEFAULT pg_catalog.gen_random_uuid() PRIMARY KEY,
  account_id text NOT NULL,
  provider_id text NOT NULL,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  access_token text,
  refresh_token text,
  id_token text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  scope text,
  password text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL
);

CREATE TABLE verifications (
  id uuid DEFAULT pg_catalog.gen_random_uuid() PRIMARY KEY,
  identifier text NOT NULL,
  value text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX sessions_user_id_idx ON sessions (user_id);
CREATE INDEX accounts_user_id_idx ON accounts (user_id);
CREATE INDEX verifications_identifier_idx ON verifications (identifier);

CREATE TABLE workspaces (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  request_id uuid NOT NULL,
  created_by uuid NOT NULL REFERENCES users (id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  slug text NOT NULL UNIQUE CHECK (length(slug) BETWEEN 3 AND 48 AND slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  soul_commit text CHECK (soul_commit ~ '^[a-f0-9]{40}$'),
  soul_bucket text,
  soul_key text,
  ready_at timestamptz,
  UNIQUE (created_by, request_id),
  CHECK ((ready_at IS NULL AND soul_commit IS NULL AND soul_bucket IS NULL AND soul_key IS NULL)
    OR (ready_at IS NOT NULL AND soul_commit IS NOT NULL AND soul_bucket IS NOT NULL AND soul_key IS NOT NULL))
);

CREATE TABLE workspace_memberships (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id),
  role text NOT NULL CHECK (role IN ('owner')),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX workspace_memberships_user_id_idx ON workspace_memberships (user_id);
CREATE INDEX workspaces_pending_idx ON workspaces (created_at) WHERE ready_at IS NULL;

CREATE TABLE app.workspace_storage (
  workspace_id uuid PRIMARY KEY REFERENCES app.workspaces (id),
  initial_membership_id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  generation integer NOT NULL DEFAULT 1 CHECK (generation > 0),
  stage text NOT NULL DEFAULT 'reserved' CHECK (stage IN ('reserved', 'database', 'ready')),
  runtime_credential jsonb,
  migration_credential jsonb,
  confirmation_credential jsonb,
  error_code text CHECK (error_code IN ('setup_failed', 'incompatible_version')),
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((runtime_credential IS NULL AND migration_credential IS NULL AND confirmation_credential IS NULL)
    OR (runtime_credential IS NOT NULL AND migration_credential IS NOT NULL AND confirmation_credential IS NOT NULL)),
  CHECK (stage = 'reserved' OR runtime_credential IS NOT NULL)
);

REVOKE ALL ON app.workspace_storage FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'tulipfarm')
    AND CURRENT_USER <> 'tulipfarm' THEN
    REVOKE ALL ON app.workspace_storage FROM tulipfarm;
    GRANT SELECT (workspace_id, generation, stage, runtime_credential, error_code, updated_at),
      INSERT (workspace_id) ON app.workspace_storage TO tulipfarm;
  END IF;
END
$$;

ALTER TABLE app.workspace_storage
  DROP CONSTRAINT workspace_storage_check1,
  ADD CONSTRAINT workspace_storage_credentials_check CHECK (stage IN ('reserved', 'unavailable') OR runtime_credential IS NOT NULL),
  DROP CONSTRAINT workspace_storage_stage_check,
  ADD COLUMN disabled_at timestamptz,
  ADD COLUMN disabled_operation_id uuid,
  ADD CONSTRAINT workspace_storage_stage_check CHECK (stage IN ('reserved', 'database', 'ready', 'unavailable')),
  ADD CONSTRAINT workspace_storage_tombstone_check CHECK (
    (stage = 'unavailable' AND disabled_at IS NOT NULL AND disabled_operation_id IS NOT NULL)
    OR (stage <> 'unavailable' AND disabled_at IS NULL AND disabled_operation_id IS NULL)
  );

CREATE TABLE app.workspace_storage_operations (
  workspace_id uuid NOT NULL REFERENCES app.workspace_storage (workspace_id),
  operation_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('rotate-passwords', 'rotate-keys', 'disable')),
  operator text NOT NULL,
  expected_generation integer NOT NULL,
  generation integer NOT NULL,
  key_ids jsonb NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, operation_id)
);
REVOKE ALL ON app.workspace_storage_operations FROM PUBLIC;

CREATE FUNCTION app.preserve_workspace_tombstone() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF OLD.disabled_at IS NOT NULL THEN
    RAISE EXCEPTION 'Workspace tombstones are permanent' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.preserve_workspace_tombstone() FROM PUBLIC;
CREATE TRIGGER preserve_workspace_tombstone BEFORE UPDATE OR DELETE ON app.workspace_storage
FOR EACH ROW EXECUTE FUNCTION app.preserve_workspace_tombstone();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'tulipfarm') AND CURRENT_USER <> 'tulipfarm' THEN
    REVOKE ALL ON app.workspace_storage_operations FROM tulipfarm;
  END IF;
END
$$;

CREATE TABLE app.email_deliveries (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('invitation', 'magic-link')),
  workspace_id uuid,
  invitation_id uuid,
  payload jsonb,
  expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'failed', 'sent', 'cancelled')),
  attempts integer NOT NULL DEFAULT 0,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  sent_at timestamptz,
  CHECK ((kind = 'invitation' AND workspace_id IS NOT NULL AND invitation_id IS NOT NULL) OR
         (kind = 'magic-link' AND workspace_id IS NULL AND invitation_id IS NULL)),
  CHECK ((status IN ('sent', 'cancelled') AND payload IS NULL) OR
         (status IN ('pending', 'sending', 'failed') AND payload IS NOT NULL))
);
CREATE INDEX email_deliveries_pending ON app.email_deliveries (created_at, id) WHERE payload IS NOT NULL;
REVOKE ALL ON app.email_deliveries FROM PUBLIC;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

CREATE FUNCTION app.invitation_delivery(workspace uuid, invitation uuid, action text, envelope jsonb DEFAULT NULL, expiry timestamptz DEFAULT NULL)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE result text;
BEGIN
  IF session_user <> 'ws_' || replace(workspace::text, '-', '') || '_runtime' THEN
    RAISE EXCEPTION 'Delivery access denied' USING ERRCODE = '42501';
  END IF;
  IF action = 'enqueue' THEN
    INSERT INTO app.email_deliveries (id, kind, workspace_id, invitation_id, payload, expires_at)
      VALUES (invitation, 'invitation', workspace, invitation, envelope, expiry);
  ELSIF action = 'cancel' THEN
    UPDATE app.email_deliveries SET status = 'cancelled', payload = NULL, lease_until = NULL
      WHERE workspace_id = workspace AND invitation_id = invitation AND status <> 'sent';
  ELSIF action <> 'status' THEN
    RAISE EXCEPTION 'Unknown delivery action';
  END IF;
  SELECT CASE WHEN expires_at <= clock_timestamp() AND status NOT IN ('sent', 'cancelled') THEN 'cancelled' ELSE status END
    INTO result FROM app.email_deliveries WHERE workspace_id = workspace AND invitation_id = invitation;
  RETURN result;
END
$$;
REVOKE ALL ON FUNCTION app.invitation_delivery(uuid, uuid, text, jsonb, timestamptz) FROM PUBLIC;

CREATE TABLE app.api_rate_limits (
  key text PRIMARY KEY CHECK (key ~ '^[a-f0-9]{64}$'),
  hits integer NOT NULL CHECK (hits > 0),
  expires_at timestamptz NOT NULL
);
CREATE INDEX api_rate_limits_expiry_idx ON app.api_rate_limits (expires_at);
REVOKE ALL ON app.api_rate_limits FROM PUBLIC;

CREATE SCHEMA model_lifecycle;
REVOKE ALL ON SCHEMA model_lifecycle FROM PUBLIC;

CREATE TABLE model_lifecycle.identities (
  kind text NOT NULL CHECK (kind IN ('bundle', 'model', 'route', 'mapping', 'pricing', 'cohort')),
  id text NOT NULL,
  value jsonb NOT NULL,
  PRIMARY KEY (kind, id)
);
CREATE TABLE model_lifecycle.bundles (
  id text PRIMARY KEY,
  payload jsonb NOT NULL,
  registered_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE model_lifecycle.evidence (
  id text PRIMARY KEY,
  bundle_id text NOT NULL REFERENCES model_lifecycle.bundles(id),
  payload jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE model_lifecycle.notices (
  id text PRIMARY KEY,
  payload jsonb NOT NULL,
  prepared_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE model_lifecycle.activations (
  revision integer PRIMARY KEY CHECK (revision > 0),
  environment text NOT NULL CHECK (environment IN ('local', 'production')),
  payload jsonb NOT NULL,
  activated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE model_lifecycle.head (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  revision integer NOT NULL CHECK (revision >= 0),
  activation_revision integer REFERENCES model_lifecycle.activations(revision)
);
INSERT INTO model_lifecycle.head (revision) VALUES (0);
CREATE TABLE model_lifecycle.commands (
  id text PRIMARY KEY,
  payload jsonb NOT NULL,
  receipt jsonb NOT NULL,
  applied_by text NOT NULL DEFAULT current_user,
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE model_lifecycle.cutoffs (
  command_id text PRIMARY KEY REFERENCES model_lifecycle.commands(id) DEFERRABLE INITIALLY DEFERRED,
  kind text NOT NULL CHECK (kind IN ('route', 'family')),
  target_id text NOT NULL,
  effective_at timestamptz NOT NULL
);
CREATE TABLE model_lifecycle.notice_deliveries (
  id text PRIMARY KEY,
  notice_id text NOT NULL REFERENCES model_lifecycle.notices(id),
  command_id text NOT NULL REFERENCES model_lifecycle.commands(id) DEFERRABLE INITIALLY DEFERRED,
  environment text NOT NULL CHECK (environment IN ('local', 'production')),
  payload jsonb NOT NULL,
  acknowledged_by text NOT NULL DEFAULT current_user,
  acknowledged_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX model_lifecycle_cutoff_target ON model_lifecycle.cutoffs (kind, target_id, effective_at);

CREATE FUNCTION model_lifecycle.preserve_history() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'Model lifecycle history is immutable';
END;
$$;
REVOKE ALL ON FUNCTION model_lifecycle.preserve_history() FROM PUBLIC;
DO $$
DECLARE relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['identities', 'bundles', 'evidence', 'notices', 'notice_deliveries', 'activations', 'commands', 'cutoffs'] LOOP
    EXECUTE format('CREATE TRIGGER preserve_history BEFORE UPDATE OR DELETE OR TRUNCATE ON model_lifecycle.%I FOR EACH STATEMENT EXECUTE FUNCTION model_lifecycle.preserve_history()', relation);
  END LOOP;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'tulipfarm') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA model_lifecycle FROM tulipfarm;
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA model_lifecycle FROM tulipfarm;
    GRANT USAGE ON SCHEMA model_lifecycle TO tulipfarm;
    GRANT SELECT ON model_lifecycle.bundles, model_lifecycle.identities,
      model_lifecycle.activations, model_lifecycle.head, model_lifecycle.cutoffs TO tulipfarm;
  END IF;
END;
$$;
REVOKE ALL ON ALL TABLES IN SCHEMA model_lifecycle FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA model_lifecycle FROM PUBLIC;

CREATE TABLE app.model_route_health (
  key text PRIMARY KEY CHECK (key ~ '^[a-f0-9]{64}$'),
  until_at timestamptz,
  probe_id uuid,
  probe_until timestamptz
);
CREATE TABLE app.model_route_health_claims (
  attempt_id uuid PRIMARY KEY,
  key text NOT NULL REFERENCES app.model_route_health (key),
  epoch bigint NOT NULL,
  expires_at timestamptz NOT NULL
);
ALTER TABLE app.model_route_health ADD COLUMN epoch bigint NOT NULL DEFAULT 0;
REVOKE ALL ON app.model_route_health FROM PUBLIC;
REVOKE ALL ON app.model_route_health_claims FROM PUBLIC;

CREATE VIEW model_lifecycle.notice_events WITH (security_barrier = true) AS
SELECT (c.receipt->>'revision')::integer AS revision,
  c.receipt->>'kind' AS kind,
  c.applied_at AS recorded_at,
  COALESCE(a.activated_at, cutoff.effective_at) AS effective_at,
  cutoff.kind AS target_kind,
  cutoff.target_id,
  n.payload->'target'->>'successorFamilyId' AS successor_family_id
FROM model_lifecycle.commands c
LEFT JOIN model_lifecycle.activations a
  ON a.revision = (c.receipt->>'revision')::integer
  AND c.receipt->>'kind' IN ('activate', 'rollback')
LEFT JOIN model_lifecycle.cutoffs cutoff ON cutoff.command_id = c.id
LEFT JOIN model_lifecycle.notices n
  ON n.id = c.payload->'command'->>'noticeId' AND cutoff.command_id IS NOT NULL
WHERE a.revision IS NOT NULL OR cutoff.command_id IS NOT NULL;

REVOKE ALL ON model_lifecycle.notice_events FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'tulipfarm') THEN
    GRANT SELECT ON model_lifecycle.notice_events TO tulipfarm;
  END IF;
END;
$$;

ALTER TABLE app.workspaces ADD COLUMN creation_name text;
UPDATE app.workspaces SET creation_name = name;
ALTER TABLE app.workspaces ALTER COLUMN creation_name SET NOT NULL;
ALTER TABLE app.workspaces ADD COLUMN settings_revision integer NOT NULL DEFAULT 0 CHECK (settings_revision >= 0);

CREATE FUNCTION app.workspace_creation_name() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN NEW.creation_name := NEW.name;
  ELSIF NEW.creation_name IS DISTINCT FROM OLD.creation_name THEN
    RAISE EXCEPTION 'Workspace creation input is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.workspace_creation_name() FROM PUBLIC;
CREATE TRIGGER workspace_creation_name BEFORE INSERT OR UPDATE ON app.workspaces
FOR EACH ROW EXECUTE FUNCTION app.workspace_creation_name();

CREATE TABLE app.workspace_settings_commands (
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  request_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES app.users(id),
  membership_id uuid NOT NULL,
  command jsonb NOT NULL,
  receipt jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, request_id)
);
REVOKE ALL ON app.workspace_settings_commands FROM PUBLIC;

CREATE FUNCTION app.workspace_access(workspace uuid, exclusive_access boolean DEFAULT false) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE token text := replace(workspace::text, '-', '');
BEGIN
  IF session_user NOT IN ('ws_' || token || '_runtime', 'ws_' || token || '_migration', 'ws_' || token || '_confirmation') THEN
    RAISE EXCEPTION 'Workspace identity mismatch' USING ERRCODE = '42501';
  END IF;
  IF exclusive_access THEN PERFORM pg_advisory_xact_lock(hashtextextended(workspace::text, 740));
  ELSE PERFORM pg_advisory_xact_lock_shared(hashtextextended(workspace::text, 740)); END IF;
  RETURN EXISTS (SELECT 1 FROM app.workspace_storage WHERE workspace_id = workspace AND stage <> 'unavailable');
END
$$;
REVOKE ALL ON FUNCTION app.workspace_access(uuid, boolean) FROM PUBLIC;

CREATE FUNCTION app.workspace_settings(workspace uuid, actor uuid, membership uuid, command jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  token text := replace(workspace::text, '-', '');
  settings record;
  previous app.workspace_settings_commands%ROWTYPE;
  result jsonb;
  request uuid;
  action text;
  member_role text;
  lock_id integer;
BEGIN
  IF session_user <> 'ws_' || token || '_runtime' THEN
    RAISE EXCEPTION 'Workspace identity mismatch' USING ERRCODE = '42501';
  END IF;
  action := command->>'kind';
  IF NOT app.workspace_access(workspace, action = 'delete') THEN
    RAISE EXCEPTION 'workspace-settings-not-found' USING ERRCODE = 'P0002';
  END IF;
  EXECUTE format('SELECT id FROM %I.tf_authorization_lock WHERE id = 1 FOR %s', 'ws_' || token,
    CASE WHEN command IS NULL THEN 'SHARE' ELSE 'UPDATE' END) INTO lock_id;
  IF lock_id IS NULL THEN RAISE EXCEPTION 'workspace-settings-not-found' USING ERRCODE = 'P0002'; END IF;
  EXECUTE format('SELECT role FROM %I.tf_memberships WHERE id = $1 AND user_id = $2 AND removed_at IS NULL', 'ws_' || token)
    INTO member_role USING membership, actor::text;
  IF member_role IS NULL OR (command IS NOT NULL AND member_role <> 'admin') THEN
    RAISE EXCEPTION 'workspace-settings-not-found' USING ERRCODE = 'P0002';
  END IF;
  SELECT w.name, w.slug, w.settings_revision INTO settings FROM app.workspaces w
    JOIN app.workspace_storage s ON s.workspace_id = w.id WHERE w.id = workspace AND s.stage = 'ready' FOR UPDATE OF w;
  IF NOT FOUND THEN RAISE EXCEPTION 'workspace-settings-not-found' USING ERRCODE = 'P0002'; END IF;
  IF command IS NULL THEN
    RETURN jsonb_build_object('workspaceId', workspace, 'name', settings.name, 'slug', settings.slug, 'revision', settings.settings_revision);
  END IF;
  request := (command->>'requestId')::uuid;
  SELECT * INTO previous FROM app.workspace_settings_commands WHERE workspace_id = workspace AND request_id = request;
  IF FOUND THEN
    IF previous.user_id <> actor OR previous.command <> command THEN
      RAISE EXCEPTION 'workspace-settings-request-conflict' USING ERRCODE = 'P0001';
    END IF;
    RETURN previous.receipt;
  END IF;
  IF (command->>'expectedRevision')::integer IS DISTINCT FROM settings.settings_revision THEN
    RAISE EXCEPTION 'workspace-settings-revision-conflict' USING ERRCODE = 'P0001';
  END IF;
  IF action = 'rename' THEN
    IF command->>'name' IS NULL OR length(btrim(command->>'name')) NOT BETWEEN 1 AND 80 THEN
      RAISE EXCEPTION 'invalid-request' USING ERRCODE = '22023';
    END IF;
    UPDATE app.workspaces SET name = command->>'name', settings_revision = settings_revision + 1 WHERE id = workspace;
    result := jsonb_build_object('kind', 'rename', 'requestId', request, 'name', command->>'name', 'revision', settings.settings_revision + 1);
  ELSIF action = 'delete' THEN
    IF command->>'confirmationName' IS DISTINCT FROM settings.name OR command->'acknowledgeRetainedData' IS DISTINCT FROM 'true'::jsonb THEN
      RAISE EXCEPTION 'workspace-settings-confirmation-mismatch' USING ERRCODE = 'P0001';
    END IF;
    UPDATE app.workspace_storage SET stage = 'unavailable', disabled_at = clock_timestamp(), disabled_operation_id = request,
      error_code = NULL, updated_at = clock_timestamp() WHERE workspace_id = workspace;
    UPDATE app.workspaces SET settings_revision = settings_revision + 1 WHERE id = workspace;
    IF to_regclass('app.email_deliveries') IS NOT NULL THEN
      UPDATE app.email_deliveries SET status = 'cancelled', payload = NULL, lease_until = NULL
        WHERE workspace_id = workspace AND status IN ('pending', 'failed', 'sending');
    END IF;
    result := jsonb_build_object('kind', 'delete', 'requestId', request, 'workspaceId', workspace, 'status', 'deleted', 'dataDisposition', 'retained');
  ELSE RAISE EXCEPTION 'invalid-request' USING ERRCODE = '22023';
  END IF;
  INSERT INTO app.workspace_settings_commands(workspace_id, request_id, user_id, membership_id, command, receipt)
    VALUES (workspace, request, actor, membership, command, result);
  RETURN result;
END
$$;
REVOKE ALL ON FUNCTION app.workspace_settings(uuid, uuid, uuid, jsonb) FROM PUBLIC;

CREATE FUNCTION app.model_availability_receipt() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  workspace uuid;
  actor uuid;
  result jsonb;
BEGIN
  IF TG_TABLE_SCHEMA !~ '^ws_[a-f0-9]{32}$' OR TG_TABLE_NAME <> 'tf_model_availability_commands'
    OR TG_OP <> 'INSERT' OR session_user <> TG_TABLE_SCHEMA || '_runtime' THEN
    RAISE EXCEPTION 'Workspace identity mismatch' USING ERRCODE = '42501';
  END IF;
  workspace := substring(TG_TABLE_SCHEMA FROM 4)::uuid;
  IF NOT app.workspace_access(workspace) THEN
    RAISE EXCEPTION 'Workspace unavailable' USING ERRCODE = '42501';
  END IF;
  EXECUTE format('SELECT id FROM %I.tf_authorization_lock WHERE id = 1 FOR SHARE', TG_TABLE_SCHEMA);
  EXECUTE format('SELECT user_id::uuid FROM %I.tf_memberships WHERE id = $1 AND role = ''admin'' AND removed_at IS NULL', TG_TABLE_SCHEMA)
    INTO actor USING NEW.membership_id;
  IF actor IS NULL THEN RAISE EXCEPTION 'Current administrator required' USING ERRCODE = '42501'; END IF;
  EXECUTE format('SELECT jsonb_build_object(''requestId'', $1, ''familyId'', family_id, ''enabled'', enabled, ''revision'', revision)
    FROM %I.tf_model_availability WHERE family_id = $2 AND editor_membership_id = $3', TG_TABLE_SCHEMA)
    INTO result USING NEW.request_id, NEW.input->>'familyId', NEW.membership_id;
  IF result IS NULL OR NEW.receipt IS DISTINCT FROM result OR NEW.input IS DISTINCT FROM
    jsonb_build_object('requestId', NEW.request_id, 'familyId', result->'familyId', 'enabled', result->'enabled', 'expectedRevision', (result->>'revision')::integer - 1) THEN
    RAISE EXCEPTION 'Availability receipt mismatch' USING ERRCODE = '22023';
  END IF;
  INSERT INTO app.workspace_settings_commands(workspace_id, request_id, user_id, membership_id, command, receipt)
    VALUES (workspace, NEW.request_id, actor, NEW.membership_id, NEW.input || '{"kind":"model-availability"}'::jsonb, result);
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.model_availability_receipt() FROM PUBLIC;

DO $$
DECLARE item record; principal record; token text; schema_grantable boolean;
BEGIN
  FOR principal IN SELECT DISTINCT pg_get_userbyid(n.nspowner) AS rolname FROM pg_namespace n
    WHERE n.nspname ~ '^ws_[a-f0-9]{32}$'
    UNION SELECT pg_get_userbyid(a.grantee) FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
      WHERE p.oid = to_regprocedure('app.invitation_delivery(uuid,uuid,text,jsonb,timestamptz)') AND a.is_grantable AND a.grantee <> 0 LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION app.workspace_access(uuid, boolean), app.workspace_settings(uuid, uuid, uuid, jsonb), app.model_availability_receipt() TO %I WITH GRANT OPTION', principal.rolname);
  END LOOP;
  FOR item IN SELECT workspace_id FROM app.workspace_storage LOOP
    token := replace(item.workspace_id::text, '-', '');
    -- Production workspace schemas belong to the provisioner; its common migration 0026 grants this access instead.
    schema_grantable := EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'ws_' || token AND pg_has_role(current_user, nspowner, 'MEMBER'));
    IF schema_grantable AND to_regclass(format('%I.tf_memberships', 'ws_' || token)) IS NOT NULL THEN
      EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', 'ws_' || token, current_user);
      EXECUTE format('GRANT SELECT ON %I.tf_memberships, %I.tf_authorization_lock TO %I', 'ws_' || token, 'ws_' || token, current_user);
      EXECUTE format('GRANT UPDATE(lock_version) ON %I.tf_authorization_lock TO %I', 'ws_' || token, current_user);
    END IF;
    IF schema_grantable AND to_regclass(format('%I.tf_model_availability_commands', 'ws_' || token)) IS NOT NULL THEN
      EXECUTE format('GRANT SELECT ON %I.tf_model_availability TO %I', 'ws_' || token, current_user);
      EXECUTE format('CREATE TRIGGER model_availability_receipt AFTER INSERT ON %I.tf_model_availability_commands FOR EACH ROW EXECUTE FUNCTION app.model_availability_receipt()', 'ws_' || token);
    END IF;
    FOR principal IN SELECT rolname FROM pg_roles WHERE rolname IN ('ws_' || token || '_runtime', 'ws_' || token || '_migration', 'ws_' || token || '_confirmation') LOOP
      EXECUTE format('GRANT USAGE ON SCHEMA app TO %I', principal.rolname);
      EXECUTE format('GRANT EXECUTE ON FUNCTION app.workspace_access(uuid, boolean) TO %I', principal.rolname);
      IF principal.rolname = 'ws_' || token || '_runtime' THEN
        EXECUTE format('GRANT EXECUTE ON FUNCTION app.workspace_settings(uuid, uuid, uuid, jsonb) TO %I', principal.rolname);
      END IF;
    END LOOP;
  END LOOP;
END
$$;

CREATE TABLE app.slack_workspace_links (
  workspace_id uuid PRIMARY KEY,
  installation_id uuid NOT NULL UNIQUE,
  app_id text NOT NULL,
  team_id text UNIQUE,
  generation integer NOT NULL DEFAULT 1 CHECK (generation > 0),
  state text NOT NULL CHECK (state IN ('reserved', 'authorizing', 'active', 'failed', 'revoked')),
  state_hash text NOT NULL UNIQUE,
  session_id text NOT NULL,
  user_id text NOT NULL,
  membership_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  CHECK (state <> 'active' OR team_id IS NOT NULL)
);
REVOKE ALL ON app.slack_workspace_links FROM PUBLIC;

ALTER TABLE users ADD COLUMN last_model_family_id text;

CREATE TABLE app.knowledge_embedding_capacity_gate (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  observed_at timestamptz NOT NULL
);
INSERT INTO app.knowledge_embedding_capacity_gate VALUES (true, clock_timestamp());

CREATE TABLE app.knowledge_embedding_capacity_claims (
  attempt_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('query', 'ingestion')),
  tokens integer NOT NULL CHECK (tokens > 0 AND tokens <= 100000),
  claimed_at timestamptz NOT NULL
);
CREATE INDEX knowledge_embedding_capacity_claims_recent
  ON app.knowledge_embedding_capacity_claims (claimed_at);
REVOKE ALL ON app.knowledge_embedding_capacity_gate, app.knowledge_embedding_capacity_claims FROM PUBLIC;

CREATE FUNCTION app.acquire_knowledge_embedding_capacity(
  p_workspace_id uuid, p_purpose text, p_tokens integer, p_attempt_id uuid
) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  observed timestamptz;
  previous app.knowledge_embedding_capacity_claims%ROWTYPE;
  usage record;
BEGIN
  IF p_workspace_id IS NULL OR p_attempt_id IS NULL OR p_purpose IS NULL
    OR p_purpose NOT IN ('query', 'ingestion') OR p_tokens IS NULL OR p_tokens <= 0 THEN
    RAISE EXCEPTION 'Invalid embedding capacity claim' USING ERRCODE = '22023';
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Embedding capacity requires read committed isolation' USING ERRCODE = '25000';
  END IF;

  UPDATE app.knowledge_embedding_capacity_gate
    SET observed_at = greatest(clock_timestamp(), observed_at)
    WHERE singleton RETURNING observed_at INTO STRICT observed;

  DELETE FROM app.knowledge_embedding_capacity_claims
    WHERE claimed_at <= observed - interval '60 seconds';
  SELECT * INTO previous FROM app.knowledge_embedding_capacity_claims WHERE attempt_id = p_attempt_id;
  IF FOUND THEN
    IF previous.workspace_id <> p_workspace_id OR previous.purpose <> p_purpose OR previous.tokens <> p_tokens THEN
      RAISE EXCEPTION 'Embedding capacity attempt payload changed' USING ERRCODE = '22023';
    END IF;
    RETURN true;
  END IF;

  SELECT coalesce(sum(tokens), 0) AS global_tokens,
    count(*) FILTER (WHERE claimed_at > observed - interval '10 seconds') AS global_requests,
    coalesce(sum(tokens) FILTER (WHERE purpose = 'ingestion'), 0) AS background_tokens,
    count(*) FILTER (WHERE purpose = 'ingestion' AND claimed_at > observed - interval '10 seconds') AS background_requests,
    coalesce(sum(tokens) FILTER (WHERE workspace_id = p_workspace_id), 0) AS workspace_tokens,
    count(*) FILTER (WHERE workspace_id = p_workspace_id AND claimed_at > observed - interval '10 seconds') AS workspace_requests,
    coalesce(sum(tokens) FILTER (WHERE workspace_id = p_workspace_id AND purpose = 'ingestion'), 0) AS workspace_background_tokens,
    count(*) FILTER (WHERE workspace_id = p_workspace_id AND purpose = 'ingestion' AND claimed_at > observed - interval '10 seconds') AS workspace_background_requests
    INTO usage FROM app.knowledge_embedding_capacity_claims
    WHERE claimed_at > observed - interval '60 seconds';

  IF usage.global_tokens + p_tokens > 400000 OR usage.global_requests >= 400
    OR usage.workspace_tokens + p_tokens > 100000 OR usage.workspace_requests >= 100
    OR (p_purpose = 'ingestion' AND (usage.background_tokens + p_tokens > 300000 OR usage.background_requests >= 300
      OR usage.workspace_background_tokens + p_tokens > 75000 OR usage.workspace_background_requests >= 75)) THEN
    RETURN false;
  END IF;
  INSERT INTO app.knowledge_embedding_capacity_claims (attempt_id, workspace_id, purpose, tokens, claimed_at)
    VALUES (p_attempt_id, p_workspace_id, p_purpose, p_tokens, observed);
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION app.acquire_knowledge_embedding_capacity(uuid, text, integer, uuid) FROM PUBLIC;

CREATE TABLE user_visits (
  user_id uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  first_session_id text,
  first_seen_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO user_visits (user_id) SELECT id FROM users;

-- 0002_canonical_email.sql
-- Dedupe key for sign-up. The CASE expression mirrors canonicalEmail() in packages/workspaces/src/canonical-email.ts.
-- When existing users already share a key, the oldest keeps it and the others stay NULL.
-- They are reported here and are not merged. Find them later with: SELECT id FROM app.users WHERE canonical_email IS NULL.
ALTER TABLE users ADD COLUMN canonical_email text;

UPDATE users SET canonical_email = ranked.canonical
FROM (
  SELECT id, canonical, row_number() OVER (PARTITION BY canonical ORDER BY created_at, id) AS position
  FROM users CROSS JOIN LATERAL (SELECT lower(email) AS email) address
  CROSS JOIN LATERAL (SELECT CASE WHEN split_part(address.email, '@', 2) IN ('gmail.com', 'googlemail.com') AND replace(split_part(split_part(address.email, '@', 1), '+', 1), '.', '') <> '' THEN replace(split_part(split_part(address.email, '@', 1), '+', 1), '.', '') || '@gmail.com' ELSE address.email END AS canonical) key
) ranked
WHERE users.id = ranked.id AND ranked.position = 1;

CREATE UNIQUE INDEX users_canonical_email_key ON users (canonical_email);

DO $$
DECLARE
  collision record;
BEGIN
  FOR collision IN
    SELECT duplicate.id, holder.id AS holder_id
    FROM users duplicate CROSS JOIN LATERAL (SELECT lower(duplicate.email) AS email) address
    JOIN users holder ON holder.canonical_email = CASE WHEN split_part(address.email, '@', 2) IN ('gmail.com', 'googlemail.com') AND replace(split_part(split_part(address.email, '@', 1), '+', 1), '.', '') <> '' THEN replace(split_part(split_part(address.email, '@', 1), '+', 1), '.', '') || '@gmail.com' ELSE address.email END
    WHERE duplicate.canonical_email IS NULL
    ORDER BY holder.id, duplicate.created_at
  LOOP
    RAISE NOTICE 'Canonical email collision: user % shares an address with user %; not merged.', collision.id, collision.holder_id;
  END LOOP;
END $$;

-- 0003_workspace_icon.sql
-- Workspace icon is a small image data URL. The browser shrinks it to 128px WebP before upload.
-- 45000 characters is the base64 form of about 32 KB. Users keep using users.image, which already exists.
ALTER TABLE app.workspaces ADD COLUMN icon text
  CHECK (icon IS NULL OR (length(icon) <= 45000 AND icon ~ '^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$'));
ALTER TABLE app.users ADD CONSTRAINT users_image_size CHECK (image IS NULL OR image ~ '^https://' OR (length(image) <= 45000 AND image ~ '^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$')) NOT VALID;

CREATE OR REPLACE FUNCTION app.workspace_settings(workspace uuid, actor uuid, membership uuid, command jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  token text := replace(workspace::text, '-', '');
  settings record;
  previous app.workspace_settings_commands%ROWTYPE;
  result jsonb;
  request uuid;
  action text;
  member_role text;
  lock_id integer;
BEGIN
  IF session_user <> 'ws_' || token || '_runtime' THEN
    RAISE EXCEPTION 'Workspace identity mismatch' USING ERRCODE = '42501';
  END IF;
  action := command->>'kind';
  IF NOT app.workspace_access(workspace, action = 'delete') THEN
    RAISE EXCEPTION 'workspace-settings-not-found' USING ERRCODE = 'P0002';
  END IF;
  EXECUTE format('SELECT id FROM %I.tf_authorization_lock WHERE id = 1 FOR %s', 'ws_' || token,
    CASE WHEN command IS NULL THEN 'SHARE' ELSE 'UPDATE' END) INTO lock_id;
  IF lock_id IS NULL THEN RAISE EXCEPTION 'workspace-settings-not-found' USING ERRCODE = 'P0002'; END IF;
  EXECUTE format('SELECT role FROM %I.tf_memberships WHERE id = $1 AND user_id = $2 AND removed_at IS NULL', 'ws_' || token)
    INTO member_role USING membership, actor::text;
  IF member_role IS NULL OR (command IS NOT NULL AND member_role <> 'admin') THEN
    RAISE EXCEPTION 'workspace-settings-not-found' USING ERRCODE = 'P0002';
  END IF;
  SELECT w.name, w.slug, w.icon, w.settings_revision INTO settings FROM app.workspaces w
    JOIN app.workspace_storage s ON s.workspace_id = w.id WHERE w.id = workspace AND s.stage = 'ready' FOR UPDATE OF w;
  IF NOT FOUND THEN RAISE EXCEPTION 'workspace-settings-not-found' USING ERRCODE = 'P0002'; END IF;
  IF command IS NULL THEN
    RETURN jsonb_build_object('workspaceId', workspace, 'name', settings.name, 'slug', settings.slug, 'icon', settings.icon, 'revision', settings.settings_revision);
  END IF;
  request := (command->>'requestId')::uuid;
  SELECT * INTO previous FROM app.workspace_settings_commands WHERE workspace_id = workspace AND request_id = request;
  IF FOUND THEN
    IF previous.user_id <> actor OR previous.command <> command THEN
      RAISE EXCEPTION 'workspace-settings-request-conflict' USING ERRCODE = 'P0001';
    END IF;
    RETURN previous.receipt;
  END IF;
  IF (command->>'expectedRevision')::integer IS DISTINCT FROM settings.settings_revision THEN
    RAISE EXCEPTION 'workspace-settings-revision-conflict' USING ERRCODE = 'P0001';
  END IF;
  IF action = 'rename' THEN
    IF command->>'name' IS NULL OR length(btrim(command->>'name')) NOT BETWEEN 1 AND 80 THEN
      RAISE EXCEPTION 'invalid-request' USING ERRCODE = '22023';
    END IF;
    UPDATE app.workspaces SET name = command->>'name', settings_revision = settings_revision + 1 WHERE id = workspace;
    result := jsonb_build_object('kind', 'rename', 'requestId', request, 'name', command->>'name', 'revision', settings.settings_revision + 1);
  ELSIF action = 'icon' THEN
    IF NOT command ? 'icon' THEN RAISE EXCEPTION 'invalid-request' USING ERRCODE = '22023'; END IF;
    UPDATE app.workspaces SET icon = command->>'icon', settings_revision = settings_revision + 1 WHERE id = workspace;
    result := jsonb_build_object('kind', 'icon', 'requestId', request, 'icon', command->'icon', 'revision', settings.settings_revision + 1);
  ELSIF action = 'delete' THEN
    IF command->>'confirmationName' IS DISTINCT FROM settings.name OR command->'acknowledgeRetainedData' IS DISTINCT FROM 'true'::jsonb THEN
      RAISE EXCEPTION 'workspace-settings-confirmation-mismatch' USING ERRCODE = 'P0001';
    END IF;
    UPDATE app.workspace_storage SET stage = 'unavailable', disabled_at = clock_timestamp(), disabled_operation_id = request,
      error_code = NULL, updated_at = clock_timestamp() WHERE workspace_id = workspace;
    UPDATE app.workspaces SET settings_revision = settings_revision + 1 WHERE id = workspace;
    IF to_regclass('app.email_deliveries') IS NOT NULL THEN
      UPDATE app.email_deliveries SET status = 'cancelled', payload = NULL, lease_until = NULL
        WHERE workspace_id = workspace AND status IN ('pending', 'failed', 'sending');
    END IF;
    result := jsonb_build_object('kind', 'delete', 'requestId', request, 'workspaceId', workspace, 'status', 'deleted', 'dataDisposition', 'retained');
  ELSE RAISE EXCEPTION 'invalid-request' USING ERRCODE = '22023';
  END IF;
  INSERT INTO app.workspace_settings_commands(workspace_id, request_id, user_id, membership_id, command, receipt)
    VALUES (workspace, request, actor, membership, command, result);
  RETURN result;
END
$$;
REVOKE ALL ON FUNCTION app.workspace_settings(uuid, uuid, uuid, jsonb) FROM PUBLIC;

-- 0004_workspace_icon_grant.sql
-- The API role reads and writes app.workspaces by column list. 0003 added icon without granting it,
-- so every SELECT w.* failed with permission denied.
GRANT SELECT (icon), INSERT (icon) ON app.workspaces TO tulipfarm;

-- 0005_platform_recommendation_budget.sql
CREATE TABLE app.platform_recommendation_budget_policy (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  workspace_pico_usd numeric(30,0) NOT NULL CHECK (workspace_pico_usd > 0),
  platform_pico_usd numeric(30,0) NOT NULL CHECK (platform_pico_usd > 0),
  period_seconds integer NOT NULL CHECK (period_seconds BETWEEN 1 AND 31536000)
);

CREATE TABLE app.platform_recommendation_budget_counters (
  period_started_at timestamptz NOT NULL,
  scope text NOT NULL CHECK (scope = 'platform' OR scope ~ '^workspace:[0-9a-f-]{36}$'),
  reserved_pico_usd numeric(40,0) NOT NULL DEFAULT 0 CHECK (reserved_pico_usd >= 0),
  spent_pico_usd numeric(40,0) NOT NULL DEFAULT 0 CHECK (spent_pico_usd >= 0),
  PRIMARY KEY (period_started_at, scope)
);

CREATE TABLE app.platform_recommendation_attempts (
  id text PRIMARY KEY CHECK (id ~ '^[a-zA-Z0-9:_-]{1,200}$'),
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  membership_id uuid NOT NULL,
  model_id text NOT NULL CHECK (model_id ~ '^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]{0,255}$'),
  maximum_pico_usd numeric(30,0) NOT NULL CHECK (maximum_pico_usd > 0),
  period_started_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved', 'dispatched', 'unknown', 'settled')),
  provider_pico_usd numeric(30,0) CHECK (provider_pico_usd >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  dispatched_at timestamptz,
  settled_at timestamptz,
  projected_at timestamptz,
  next_projection_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((state = 'settled') = (provider_pico_usd IS NOT NULL)),
  CHECK ((state IN ('unknown', 'settled')) = (settled_at IS NOT NULL)),
  CHECK (state <> 'dispatched' OR dispatched_at IS NOT NULL),
  CHECK (state <> 'reserved' OR dispatched_at IS NULL),
  CHECK (projected_at IS NULL OR state = 'settled')
);
CREATE INDEX platform_recommendation_attempts_pending_projection
  ON app.platform_recommendation_attempts (next_projection_at, settled_at, id)
  WHERE state = 'settled' AND projected_at IS NULL;

REVOKE ALL ON TABLE app.platform_recommendation_budget_policy,
  app.platform_recommendation_budget_counters, app.platform_recommendation_attempts FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'tulipfarm')
    AND CURRENT_USER <> 'tulipfarm' THEN
    REVOKE ALL ON TABLE app.platform_recommendation_budget_policy,
      app.platform_recommendation_budget_counters, app.platform_recommendation_attempts FROM tulipfarm;
    GRANT SELECT, INSERT, UPDATE ON TABLE app.platform_recommendation_budget_policy,
      app.platform_recommendation_budget_counters, app.platform_recommendation_attempts TO tulipfarm;
  END IF;
END
$$;

-- 0006_onboarding_drafts.sql
CREATE TABLE app.onboarding_drafts (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  details jsonb NOT NULL,
  claimed_by uuid REFERENCES app.users (id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL DEFAULT (CURRENT_TIMESTAMP + interval '24 hours')
);
CREATE INDEX onboarding_drafts_expiry_idx ON app.onboarding_drafts (expires_at);
REVOKE ALL ON app.onboarding_drafts FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE (claimed_by), DELETE ON app.onboarding_drafts TO tulipfarm;

-- 0007_last_workspace.sql
ALTER TABLE app.users ADD COLUMN last_workspace_id uuid REFERENCES app.workspaces (id) ON DELETE SET NULL;
CREATE INDEX users_last_workspace_id_idx ON app.users (last_workspace_id) WHERE last_workspace_id IS NOT NULL;

-- 0009_github_event_inbox.sql
CREATE TABLE app.github_event_policy (
  app_id text PRIMARY KEY CHECK (app_id ~ '^[1-9][0-9]{0,15}$'),
  maximum_pending integer NOT NULL CHECK (maximum_pending > 0)
);

CREATE TABLE app.github_event_routes (
  app_id text NOT NULL CHECK (app_id ~ '^[1-9][0-9]{0,15}$'),
  installation_id text NOT NULL CHECK (installation_id ~ '^[1-9][0-9]{0,15}$'),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  source_id uuid NOT NULL,
  generation integer NOT NULL CHECK (generation > 0),
  active boolean NOT NULL,
  PRIMARY KEY (app_id,installation_id,workspace_id,source_id)
);

CREATE TABLE app.github_event_deliveries (
  app_id text NOT NULL REFERENCES app.github_event_policy(app_id),
  delivery_id uuid NOT NULL,
  body_digest text NOT NULL CHECK (body_digest ~ '^[a-f0-9]{64}$'),
  event_name text NOT NULL CHECK (event_name ~ '^[a-z_]{1,64}$'),
  status text NOT NULL CHECK (status IN ('pending','routed','ignored','rejected','expired')),
  reason text CHECK (reason ~ '^[a-z][a-z0-9-]{0,99}$'),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (app_id,delivery_id),
  CHECK (expires_at > received_at AND expires_at <= received_at + interval '720 hours'),
  CHECK ((status IN ('ignored','rejected')) = (reason IS NOT NULL))
);
CREATE INDEX github_event_delivery_pending ON app.github_event_deliveries(app_id,expires_at,delivery_id)
  WHERE status = 'pending';

CREATE TABLE app.github_event_payloads (
  app_id text NOT NULL,
  delivery_id uuid NOT NULL,
  envelope jsonb NOT NULL CHECK (jsonb_typeof(envelope) = 'object' AND octet_length(envelope::text) <= 65536),
  PRIMARY KEY (app_id,delivery_id),
  FOREIGN KEY (app_id,delivery_id) REFERENCES app.github_event_deliveries(app_id,delivery_id)
);

CREATE TABLE app.github_event_dispatches (
  app_id text NOT NULL,
  delivery_id uuid NOT NULL,
  installation_id text NOT NULL,
  workspace_id uuid NOT NULL,
  source_id uuid NOT NULL,
  generation integer NOT NULL CHECK (generation > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','blocked','expired')),
  reason text CHECK (reason ~ '^[a-z][a-z0-9-]{0,99}$'),
  lease_id uuid,
  lease_until timestamptz,
  completed_lease_id uuid,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (app_id,delivery_id,workspace_id,source_id),
  FOREIGN KEY (app_id,delivery_id) REFERENCES app.github_event_deliveries(app_id,delivery_id),
  FOREIGN KEY (app_id,installation_id,workspace_id,source_id)
    REFERENCES app.github_event_routes(app_id,installation_id,workspace_id,source_id),
  CHECK ((lease_id IS NULL) = (lease_until IS NULL)),
  CHECK (status = 'pending' OR lease_id IS NULL),
  CHECK ((status IN ('delivered','blocked')) = (completed_lease_id IS NOT NULL)),
  CHECK (status <> 'blocked' OR reason IS NOT NULL)
);
CREATE INDEX github_event_dispatch_pending ON app.github_event_dispatches(app_id,next_attempt_at,delivery_id)
  WHERE status = 'pending';

REVOKE ALL ON TABLE app.github_event_policy, app.github_event_routes,
  app.github_event_deliveries, app.github_event_payloads, app.github_event_dispatches FROM PUBLIC;

-- 0010_member_profiles.sql
ALTER TABLE app.users ADD COLUMN profile_revision bigint NOT NULL DEFAULT 1 CHECK(profile_revision>0);

CREATE TABLE app.member_profile_outbox (
  user_id uuid PRIMARY KEY REFERENCES app.users(id) ON DELETE CASCADE,
  revision bigint NOT NULL CHECK(revision>0),
  workspace_cursor uuid,
  attempted_at timestamptz NOT NULL DEFAULT '-infinity'
);
REVOKE ALL ON app.member_profile_outbox FROM PUBLIC;

CREATE FUNCTION app.version_member_profile() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='INSERT' THEN NEW.profile_revision:=1;
  ELSIF ROW(NEW.name,NEW.email,NEW.image) IS DISTINCT FROM ROW(OLD.name,OLD.email,OLD.image) THEN
    NEW.profile_revision:=OLD.profile_revision+1;
  ELSE NEW.profile_revision:=OLD.profile_revision;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.version_member_profile() FROM PUBLIC;
CREATE TRIGGER version_member_profile BEFORE INSERT OR UPDATE ON app.users
  FOR EACH ROW EXECUTE FUNCTION app.version_member_profile();

CREATE FUNCTION app.capture_member_profile() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='INSERT' OR NEW.profile_revision<>OLD.profile_revision THEN
    INSERT INTO app.member_profile_outbox(user_id,revision) VALUES(NEW.id,NEW.profile_revision)
      ON CONFLICT(user_id) DO UPDATE SET revision=EXCLUDED.revision,workspace_cursor=NULL;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.capture_member_profile() FROM PUBLIC;
CREATE TRIGGER capture_member_profile AFTER INSERT OR UPDATE ON app.users
  FOR EACH ROW EXECUTE FUNCTION app.capture_member_profile();
INSERT INTO app.member_profile_outbox(user_id,revision) SELECT id,profile_revision FROM app.users;

CREATE FUNCTION app.workspace_member_profiles(workspace uuid, users uuid[])
RETURNS TABLE(id uuid,name text,email text,image text,revision text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE workspace_schema text:='ws_'||replace(workspace::text,'-','');
BEGIN
  IF workspace IS NULL OR users IS NULL OR cardinality(users) NOT BETWEEN 1 AND 100 OR array_position(users,NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'Invalid member profile batch' USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM app.workspace_storage WHERE workspace_id=workspace AND stage='ready')
    OR to_regclass(format('%I.tf_workspace_member_accounts',workspace_schema)) IS NULL THEN
    RAISE EXCEPTION 'member-profiles-unavailable';
  END IF;
  EXECUTE format('SELECT id FROM %I.tf_authorization_lock WHERE id=1 FOR SHARE',workspace_schema);
  RETURN QUERY EXECUTE format('SELECT u.id,u.name,u.email,u.image,u.profile_revision::text
    FROM app.users u JOIN %I.tf_workspace_member_accounts a ON a.user_id=u.id::text
    JOIN %I.tf_memberships m ON m.id=a.membership_id AND m.user_id=a.user_id AND m.removed_at IS NULL
    WHERE u.id=ANY($1) ORDER BY u.id',workspace_schema,workspace_schema) USING users;
END
$$;
REVOKE ALL ON FUNCTION app.workspace_member_profiles(uuid,uuid[]) FROM PUBLIC;

CREATE FUNCTION app.pending_member_profile_events()
RETURNS TABLE(user_id uuid,revision text,workspace_cursor uuid)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  WITH candidates AS (
    SELECT user_id FROM app.member_profile_outbox ORDER BY attempted_at,user_id LIMIT 10 FOR UPDATE SKIP LOCKED
  )
  UPDATE app.member_profile_outbox o SET attempted_at=clock_timestamp()
    FROM candidates c WHERE o.user_id=c.user_id
    RETURNING o.user_id,o.revision::text,o.workspace_cursor
$$;
REVOKE ALL ON FUNCTION app.pending_member_profile_events() FROM PUBLIC;

CREATE FUNCTION app.advance_member_profile_event(account uuid,version bigint,expected_cursor uuid,next_cursor uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE affected integer;
BEGIN
  IF next_cursor IS NULL THEN
    DELETE FROM app.member_profile_outbox WHERE user_id=account AND revision=version
      AND workspace_cursor IS NOT DISTINCT FROM expected_cursor;
  ELSE
    IF expected_cursor IS NOT NULL AND next_cursor<=expected_cursor THEN
      RAISE EXCEPTION 'Invalid member profile cursor' USING ERRCODE='22023';
    END IF;
    UPDATE app.member_profile_outbox SET workspace_cursor=next_cursor
      WHERE user_id=account AND revision=version AND workspace_cursor IS NOT DISTINCT FROM expected_cursor;
  END IF;
  GET DIAGNOSTICS affected=ROW_COUNT;
  RETURN affected=1;
END
$$;
REVOKE ALL ON FUNCTION app.advance_member_profile_event(uuid,bigint,uuid,uuid) FROM PUBLIC;
