-- Workspace evals: saved test cases for a saved agent, and the runs that grade the agent against them. An agent has at
-- most one eval set. A run never writes outside these tables: every effect the agent asks for is simulated and recorded
-- in its results. Deleting an agent deletes its set, cases, runs and results.
CREATE TABLE {{schema}}.tf_agent_eval_sets (
  agent_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_agents(id),
  -- The catalog model family that grades judge checks; null uses the agent's own model.
  judge_model text CHECK (char_length(judge_model) BETWEEN 1 AND 200),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- One case: a message, optional earlier turns, checks, pinned reads and effect overrides, as validated JSON.
CREATE TABLE {{schema}}.tf_agent_eval_cases (
  id uuid PRIMARY KEY,
  agent_id uuid NOT NULL REFERENCES {{schema}}.tf_agent_eval_sets(agent_id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  body jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object'),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX tf_agent_eval_cases_agent ON {{schema}}.tf_agent_eval_cases (agent_id, created_at, id);

-- One run: who started it, the agent definition revision it tested, its models and repeats, and its totals. Usage
-- columns are picodollars at list price; credits are recorded in tf_credit_usage under flow id agent-eval:<run id>.
CREATE TABLE {{schema}}.tf_agent_eval_runs (
  id uuid PRIMARY KEY,
  agent_id uuid NOT NULL REFERENCES {{schema}}.tf_agent_eval_sets(agent_id) ON DELETE CASCADE,
  membership_id uuid NOT NULL,
  user_id text NOT NULL,
  definition_revision text NOT NULL CHECK (definition_revision ~ '^[a-f0-9]{64}$'),
  models text[] NOT NULL CHECK (cardinality(models) BETWEEN 1 AND 3),
  judge_model text NOT NULL,
  repeats integer NOT NULL CHECK (repeats IN (1, 3)),
  case_ids uuid[] NOT NULL CHECK (cardinality(case_ids) BETWEEN 1 AND 100),
  status text NOT NULL CHECK (status IN ('queued','running','completed','failed','stopped')),
  -- Why a run stopped or failed: credits, cap, agent-changed, cancelled, unavailable.
  stop_reason text CHECK (char_length(stop_reason) BETWEEN 1 AND 200),
  estimate_pico_usd bigint NOT NULL CHECK (estimate_pico_usd >= 0),
  agent_usage jsonb NOT NULL DEFAULT '{}',
  judge_usage jsonb NOT NULL DEFAULT '{}',
  summary jsonb,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz,
  finished_at timestamptz,
  CHECK ((status IN ('completed','failed','stopped')) = (finished_at IS NOT NULL))
);
CREATE INDEX tf_agent_eval_runs_agent ON {{schema}}.tf_agent_eval_runs (agent_id, created_at DESC);
-- An agent has at most one active run.
CREATE UNIQUE INDEX tf_agent_eval_runs_active ON {{schema}}.tf_agent_eval_runs (agent_id)
  WHERE status IN ('queued','running');

-- One case, model and repeat of a run: pass or fail, check verdicts, the transcript with each tool call marked live,
-- pinned or simulated, usage and duration.
CREATE TABLE {{schema}}.tf_agent_eval_results (
  run_id uuid NOT NULL REFERENCES {{schema}}.tf_agent_eval_runs(id) ON DELETE CASCADE,
  case_id uuid NOT NULL,
  model text NOT NULL,
  repeat integer NOT NULL CHECK (repeat BETWEEN 0 AND 2),
  case_name text NOT NULL,
  pass boolean NOT NULL,
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (run_id, case_id, model, repeat)
);

REVOKE ALL ON {{schema}}.tf_agent_eval_sets, {{schema}}.tf_agent_eval_cases, {{schema}}.tf_agent_eval_runs,
  {{schema}}.tf_agent_eval_results FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON {{schema}}.tf_agent_eval_sets, {{schema}}.tf_agent_eval_cases,
  {{schema}}.tf_agent_eval_runs, {{schema}}.tf_agent_eval_results TO {{runtime}};
