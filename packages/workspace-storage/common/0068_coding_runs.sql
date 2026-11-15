-- One row per `coding.run` call, keyed by its tool call ID. The run waits for its member's decision on the exact
-- repository, branch, agent, task and plan (`digest`), then runs once. Only the confirmation role records decisions,
-- so the runtime cannot approve its own run; it only moves the run through `status` once it is approved.
CREATE TABLE {{schema}}.tf_coding_runs (
  id uuid PRIMARY KEY,
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  user_id text NOT NULL,
  conversation_id uuid NOT NULL,
  turn_id uuid NOT NULL,
  generation integer NOT NULL CHECK (generation >= 0),
  agent text NOT NULL CHECK (agent IN ('claude-code', 'codex', 'copilot')),
  repository text NOT NULL CHECK (char_length(repository) BETWEEN 3 AND 140),
  branch text CHECK (char_length(branch) BETWEEN 1 AND 255),
  task text NOT NULL CHECK (char_length(task) BETWEEN 1 AND 16000),
  plan_owner_membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  decision text NOT NULL DEFAULT 'pending' CHECK (decision IN ('pending', 'approved', 'denied')),
  decision_command_id uuid,
  decided_at timestamptz,
  status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'expired', 'running', 'finished', 'interrupted')),
  expires_at timestamptz NOT NULL,
  started_at timestamptz,
  deadline_at timestamptz,
  finished_at timestamptz,
  result jsonb CHECK (result IS NULL OR octet_length(result::text) <= 262144),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((decision = 'pending') = (decided_at IS NULL)),
  CHECK ((decision = 'pending') = (decision_command_id IS NULL)),
  CHECK (status NOT IN ('running', 'finished', 'interrupted') OR decision = 'approved'),
  CHECK (status <> 'expired' OR decision = 'pending'),
  CHECK ((status IN ('running', 'finished', 'interrupted')) = (started_at IS NOT NULL AND deadline_at IS NOT NULL)),
  CHECK ((status = 'finished') = (result IS NOT NULL))
);
CREATE INDEX tf_coding_runs_turn ON {{schema}}.tf_coding_runs (turn_id);

REVOKE ALL ON {{schema}}.tf_coding_runs FROM PUBLIC;
GRANT SELECT, INSERT ON {{schema}}.tf_coding_runs TO {{runtime}};
GRANT UPDATE (status, started_at, deadline_at, finished_at, result) ON {{schema}}.tf_coding_runs TO {{runtime}};
GRANT SELECT ON {{schema}}.tf_coding_runs TO {{confirmation}};
GRANT UPDATE (decision, decision_command_id, decided_at) ON {{schema}}.tf_coding_runs TO {{confirmation}};
