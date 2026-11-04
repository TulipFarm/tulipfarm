-- One row per `api.request` call. Reads are inserted already `sending`; changes wait for the member's exact approval.
-- `sending` rows inside their deadline are the workspace's calls in flight.
CREATE TABLE {{schema}}.tf_api_calls (
  id uuid PRIMARY KEY,
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  origin_kind text NOT NULL CHECK (origin_kind IN ('chat', 'task')),
  conversation_id uuid,
  turn_id uuid,
  generation integer,
  task_id uuid,
  run_id uuid,
  method text NOT NULL CHECK (method IN ('GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE')),
  redacted_url text NOT NULL CHECK (char_length(redacted_url) <= 8192),
  host text NOT NULL CHECK (char_length(host) <= 255),
  request jsonb CHECK (request IS NULL OR octet_length(request::text) <= 2097152),
  secrets jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(secrets) = 'array'),
  purpose text CHECK (char_length(purpose) <= 500),
  digest text CHECK (digest ~ '^[a-f0-9]{64}$'),
  timeout_ms integer NOT NULL CHECK (timeout_ms BETWEEN 1000 AND 60000),
  status text NOT NULL CHECK (status IN (
    'awaiting-approval', 'sending', 'sent', 'failed', 'rejected', 'expired', 'conflict', 'outcome-unknown'
  )),
  expires_at timestamptz,
  claimed_at timestamptz,
  deadline_at timestamptz,
  completed_at timestamptz,
  response_status integer CHECK (response_status BETWEEN 100 AND 599),
  response_bytes bigint CHECK (response_bytes >= 0),
  duration_ms integer CHECK (duration_ms >= 0),
  error_code text CHECK (char_length(error_code) <= 64),
  file_object_key text,
  file_name text,
  file_media_type text,
  file_bytes bigint CHECK (file_bytes >= 0),
  file_sha256 text CHECK (file_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    (origin_kind = 'chat' AND conversation_id IS NOT NULL AND turn_id IS NOT NULL AND generation IS NOT NULL
      AND task_id IS NULL AND run_id IS NULL)
    OR (origin_kind = 'task' AND task_id IS NOT NULL AND run_id IS NOT NULL
      AND conversation_id IS NULL AND turn_id IS NULL AND generation IS NULL)
  ),
  CHECK ((method IN ('GET', 'HEAD')) = (digest IS NULL)),
  CHECK (method IN ('GET', 'HEAD') OR expires_at IS NOT NULL)
);
CREATE INDEX tf_api_calls_turn ON {{schema}}.tf_api_calls (turn_id) WHERE turn_id IS NOT NULL;
CREATE INDEX tf_api_calls_run ON {{schema}}.tf_api_calls (run_id) WHERE run_id IS NOT NULL;
CREATE INDEX tf_api_calls_task ON {{schema}}.tf_api_calls (task_id, created_at DESC) WHERE task_id IS NOT NULL;
CREATE INDEX tf_api_calls_sending ON {{schema}}.tf_api_calls (deadline_at) WHERE status = 'sending';
CREATE INDEX tf_api_calls_waiting ON {{schema}}.tf_api_calls (expires_at) WHERE status = 'awaiting-approval';

-- Only the confirmation role records decisions, so the runtime cannot approve its own change.
CREATE TABLE {{schema}}.tf_api_call_decisions (
  call_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_api_calls(id),
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  command_id uuid NOT NULL,
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  decision text NOT NULL CHECK (decision IN ('approve', 'reject')),
  reason text CHECK (char_length(reason) <= 500),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Reads start `sending` and changes start `awaiting-approval`. A change is sent only once, with an approval of the
-- same digest made before it expired; rejection needs a rejection. Final statuses never change.
CREATE FUNCTION {{schema}}.tf_api_call_transition() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE
  decided text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> (CASE WHEN NEW.method IN ('GET', 'HEAD') THEN 'sending' ELSE 'awaiting-approval' END)
      OR NEW.claimed_at IS NOT NULL OR NEW.completed_at IS NOT NULL THEN
      RAISE EXCEPTION 'API call must start sending or awaiting approval';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.membership_id <> OLD.membership_id OR NEW.method <> OLD.method
    OR NEW.digest IS DISTINCT FROM OLD.digest OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.secrets <> OLD.secrets OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'API call is immutable';
  END IF;
  IF NEW.status = OLD.status THEN
    IF OLD.status NOT IN ('awaiting-approval', 'sending') OR NEW.claimed_at IS DISTINCT FROM OLD.claimed_at THEN
      RAISE EXCEPTION 'API call is final';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status NOT IN ('awaiting-approval', 'sending') THEN
    RAISE EXCEPTION 'API call is final';
  END IF;
  SELECT decision INTO decided FROM {{schema}}.tf_api_call_decisions WHERE call_id = OLD.id AND digest = OLD.digest;
  IF NEW.status = 'sending' THEN
    IF OLD.status <> 'awaiting-approval' OR decided IS DISTINCT FROM 'approve'
      OR OLD.expires_at <= clock_timestamp() OR NEW.claimed_at IS NULL THEN
      RAISE EXCEPTION 'API call is not approved';
    END IF;
  ELSIF NEW.status = 'rejected' THEN
    IF OLD.status <> 'awaiting-approval' OR decided IS DISTINCT FROM 'reject' THEN
      RAISE EXCEPTION 'API call was not rejected';
    END IF;
  ELSIF NEW.status = 'expired' THEN
    IF OLD.status <> 'awaiting-approval' OR OLD.expires_at > clock_timestamp() THEN
      RAISE EXCEPTION 'API call has not expired';
    END IF;
  ELSIF NEW.status IN ('sent', 'failed', 'conflict', 'outcome-unknown') THEN
    IF OLD.status <> 'sending' THEN
      RAISE EXCEPTION 'API call was not sending';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER tf_api_call_transition BEFORE INSERT OR UPDATE ON {{schema}}.tf_api_calls
  FOR EACH ROW EXECUTE FUNCTION {{schema}}.tf_api_call_transition();
REVOKE ALL ON FUNCTION {{schema}}.tf_api_call_transition() FROM PUBLIC;

REVOKE ALL ON {{schema}}.tf_api_calls, {{schema}}.tf_api_call_decisions FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON {{schema}}.tf_api_calls TO {{runtime}};
GRANT SELECT ON {{schema}}.tf_api_call_decisions TO {{runtime}};
GRANT SELECT ON {{schema}}.tf_api_calls, {{schema}}.tf_api_call_decisions TO {{confirmation}};
GRANT INSERT ON {{schema}}.tf_api_call_decisions TO {{confirmation}};
