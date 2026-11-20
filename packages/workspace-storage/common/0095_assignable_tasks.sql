-- Assignable tasks. Every workspace gets a built-in Tasks table whose six fields can't be changed or removed; people add
-- their own fields beside them. A row whose Assignee is an agent starts that agent's work. The web app shows the table
-- only while the assignable-tasks feature flag is on.
ALTER TABLE {{schema}}.tf_system_tables DROP CONSTRAINT tf_system_tables_kind_check;
ALTER TABLE {{schema}}.tf_system_tables ADD CONSTRAINT tf_system_tables_kind_check
  CHECK (kind IN ('workspace-members','tasks'));

DO $$
DECLARE
  table_id uuid := gen_random_uuid();
  generation_id uuid := gen_random_uuid();
  team_id uuid;
  physical_name text := 'g_' || replace(generation_id::text,'-','');
  revision text := '7a5c0e1000000000000000000000000000000091';
  definition jsonb;
  schema_name text := '{{schema}}'::regnamespace::text;
BEGIN
  SELECT id INTO STRICT team_id FROM {{schema}}.tf_teams WHERE name='_admin';
  definition := jsonb_build_object(
    'formatVersion',2,'id',table_id,'owningTeamId',team_id,'label','Tasks',
    'fields',jsonb_build_array(
      '{"id":"5b1d3c2e-7f40-4a8e-9c61-2d0a7e4b5101","label":"Title","kind":"text","required":true,"maxLength":500}'::jsonb,
      '{"id":"5b1d3c2e-7f40-4a8e-9c61-2d0a7e4b5102","label":"Description","kind":"text","required":false,"maxLength":100000,"markdown":true}'::jsonb,
      '{"id":"5b1d3c2e-7f40-4a8e-9c61-2d0a7e4b5103","label":"Assignee","kind":"actor","required":false,"assignee":true}'::jsonb,
      '{"id":"5b1d3c2e-7f40-4a8e-9c61-2d0a7e4b5104","label":"Reporter","kind":"actor","required":false,"assignee":false}'::jsonb,
      '{"id":"5b1d3c2e-7f40-4a8e-9c61-2d0a7e4b5105","label":"Run state","kind":"single-select","required":false,"options":[
        {"id":"6c2e4d3f-8a51-4b9f-8d72-3e1b8f5c6201","label":"Queued","retired":false},
        {"id":"6c2e4d3f-8a51-4b9f-8d72-3e1b8f5c6202","label":"Working","retired":false},
        {"id":"6c2e4d3f-8a51-4b9f-8d72-3e1b8f5c6203","label":"Waiting for a person","retired":false},
        {"id":"6c2e4d3f-8a51-4b9f-8d72-3e1b8f5c6204","label":"Done","retired":false},
        {"id":"6c2e4d3f-8a51-4b9f-8d72-3e1b8f5c6205","label":"Failed","retired":false}
      ]}'::jsonb,
      jsonb_build_object('id','5b1d3c2e-7f40-4a8e-9c61-2d0a7e4b5106','label','Parent task','kind','relationship',
        'required',false,'targetTableId',table_id,'cardinality','one','inverseCardinality','many',
        'reverse',null,'onDelete','restrict')
    ),'uniqueKeys','[]'::jsonb
  );
  INSERT INTO {{schema}}.tf_table_catalog(id,owning_team_id,physical_table,display_name,target_revision,applied_revision,applied_definition)
    VALUES(table_id,team_id,physical_name,'Tasks',revision,revision,definition);
  INSERT INTO {{schema}}.tf_system_tables(kind,table_id,core_definition) VALUES('tasks',table_id,definition);
  INSERT INTO {{schema}}.tf_table_generations(id,table_id,revision,definition,physical_table,state,activated_at)
    VALUES(generation_id,table_id,revision,definition,physical_name,'active',clock_timestamp());
  EXECUTE format('CREATE TABLE %I.%I (
    id uuid PRIMARY KEY, token uuid NOT NULL,
    f_5b1d3c2e7f404a8e9c612d0a7e4b5101 varchar(500) COLLATE "C" NOT NULL,
    f_5b1d3c2e7f404a8e9c612d0a7e4b5102 varchar(100000) COLLATE "C",
    f_5b1d3c2e7f404a8e9c612d0a7e4b5103 varchar(43) COLLATE "C" CHECK(
      f_5b1d3c2e7f404a8e9c612d0a7e4b5103 ~ ''^(member|agent):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$''),
    f_5b1d3c2e7f404a8e9c612d0a7e4b5104 varchar(43) COLLATE "C" CHECK(
      f_5b1d3c2e7f404a8e9c612d0a7e4b5104 ~ ''^(member|agent):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$''),
    f_5b1d3c2e7f404a8e9c612d0a7e4b5105 uuid CHECK(
      f_5b1d3c2e7f404a8e9c612d0a7e4b5105=ANY(ARRAY[
        ''6c2e4d3f-8a51-4b9f-8d72-3e1b8f5c6201''::uuid,
        ''6c2e4d3f-8a51-4b9f-8d72-3e1b8f5c6202''::uuid,
        ''6c2e4d3f-8a51-4b9f-8d72-3e1b8f5c6203''::uuid,
        ''6c2e4d3f-8a51-4b9f-8d72-3e1b8f5c6204''::uuid,
        ''6c2e4d3f-8a51-4b9f-8d72-3e1b8f5c6205''::uuid
      ])),
    f_5b1d3c2e7f404a8e9c612d0a7e4b5106 uuid
  )',schema_name,physical_name);
  EXECUTE format('ALTER TABLE %I.%I OWNER TO %I',schema_name,physical_name,'{{customOwner}}'::regrole::text);
  EXECUTE format('REVOKE ALL ON %I.%I FROM PUBLIC',schema_name,physical_name);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I.%I TO %I',schema_name,physical_name,'{{runtime}}'::regrole::text);
END
$$;

-- A row's conversation: people's and agents' comments, progress notes and change events. Keyed by row, not generation,
-- so it survives schema changes. Deleting is soft so a removed comment leaves a marker.
CREATE TABLE {{schema}}.tf_row_thread_items (
  id uuid PRIMARY KEY,
  table_id uuid NOT NULL REFERENCES {{schema}}.tf_table_catalog(id),
  row_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('comment','progress','event')),
  author_membership_id uuid REFERENCES {{schema}}.tf_memberships(id),
  author_agent_id uuid REFERENCES {{schema}}.tf_agents(id),
  agent_task_id uuid,
  body text CHECK (char_length(body) BETWEEN 1 AND 20000),
  event jsonb CHECK (event IS NULL OR jsonb_typeof(event) = 'object'),
  mentions uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(mentions) <= 50),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  edited_at timestamptz,
  deleted_at timestamptz,
  CHECK (num_nonnulls(author_membership_id, author_agent_id) <= 1),
  CHECK ((kind = 'event') = (event IS NOT NULL)),
  CHECK (kind = 'event' OR body IS NOT NULL OR deleted_at IS NOT NULL)
);
CREATE INDEX tf_row_thread_items_row ON {{schema}}.tf_row_thread_items(table_id,row_id,created_at,id);
REVOKE ALL ON {{schema}}.tf_row_thread_items FROM PUBLIC;
GRANT SELECT, INSERT ON {{schema}}.tf_row_thread_items TO {{runtime}};
GRANT UPDATE (body, mentions, edited_at, deleted_at) ON {{schema}}.tf_row_thread_items TO {{runtime}};
GRANT DELETE ON {{schema}}.tf_row_thread_items TO {{runtime}};

-- One row per row assigned to an agent. generation increases on every reassignment so a stale run can tell it lost the
-- row. The sponsor is the person whose access and credits the agent's runs use: whoever assigned it last.
CREATE TABLE {{schema}}.tf_row_assignments (
  table_id uuid NOT NULL REFERENCES {{schema}}.tf_table_catalog(id),
  row_id uuid NOT NULL,
  agent_id uuid NOT NULL REFERENCES {{schema}}.tf_agents(id),
  sponsor_membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  generation bigint NOT NULL CHECK (generation > 0),
  run_state text NOT NULL CHECK (run_state IN ('queued','working','waiting','done','failed','stopped')),
  reason text CHECK (char_length(reason) <= 500),
  wake_at timestamptz,
  current_task_id uuid,
  queued_at timestamptz,
  pending_wakes integer NOT NULL DEFAULT 0 CHECK (pending_wakes >= 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (table_id, row_id)
);
CREATE INDEX tf_row_assignments_queue ON {{schema}}.tf_row_assignments(agent_id, queued_at)
  WHERE run_state = 'queued';
CREATE INDEX tf_row_assignments_wake ON {{schema}}.tf_row_assignments(wake_at) WHERE wake_at IS NOT NULL;
CREATE UNIQUE INDEX tf_row_assignments_task ON {{schema}}.tf_row_assignments(current_task_id)
  WHERE current_task_id IS NOT NULL;
REVOKE ALL ON {{schema}}.tf_row_assignments FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON {{schema}}.tf_row_assignments TO {{runtime}};

-- Each agent run started for an assigned row, so the row can show its run history without reading transcripts.
CREATE TABLE {{schema}}.tf_row_assignment_runs (
  task_id uuid PRIMARY KEY,
  table_id uuid NOT NULL REFERENCES {{schema}}.tf_table_catalog(id),
  row_id uuid NOT NULL,
  agent_id uuid NOT NULL REFERENCES {{schema}}.tf_agents(id),
  generation bigint NOT NULL,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ended_at timestamptz,
  outcome text CHECK (outcome IN ('done','waiting','failed','stopped','finished'))
);
CREATE INDEX tf_row_assignment_runs_row ON {{schema}}.tf_row_assignment_runs(table_id,row_id,started_at DESC);
CREATE INDEX tf_row_assignment_runs_day ON {{schema}}.tf_row_assignment_runs(agent_id,started_at);
REVOKE ALL ON {{schema}}.tf_row_assignment_runs FROM PUBLIC;
GRANT SELECT, INSERT, DELETE ON {{schema}}.tf_row_assignment_runs TO {{runtime}};
GRANT UPDATE (ended_at, outcome) ON {{schema}}.tf_row_assignment_runs TO {{runtime}};

-- How many assigned rows run at once. Missing rows use the defaults: 3 per agent and 10 per workspace.
CREATE TABLE {{schema}}.tf_agent_assignment_limits (
  agent_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_agents(id),
  concurrent integer NOT NULL CHECK (concurrent BETWEEN 1 AND 20),
  daily_runs integer CHECK (daily_runs BETWEEN 1 AND 10000)
);
CREATE TABLE {{schema}}.tf_workspace_assignment_limits (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  concurrent integer NOT NULL CHECK (concurrent BETWEEN 1 AND 100)
);
REVOKE ALL ON {{schema}}.tf_agent_assignment_limits, {{schema}}.tf_workspace_assignment_limits FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON {{schema}}.tf_agent_assignment_limits, {{schema}}.tf_workspace_assignment_limits
  TO {{runtime}};

-- What needs a person's attention: rows assigned to them, agents waiting on them, finished work they reported, and
-- mentions. An item resolves itself when its cause goes away; done_at is the person dismissing it.
CREATE TABLE {{schema}}.tf_inbox_items (
  id uuid PRIMARY KEY,
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  kind text NOT NULL CHECK (kind IN ('assigned','waiting','finished','mention')),
  table_id uuid NOT NULL REFERENCES {{schema}}.tf_table_catalog(id),
  row_id uuid NOT NULL,
  source_id uuid NOT NULL,
  summary text CHECK (char_length(summary) <= 500),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  done_at timestamptz,
  resolved_at timestamptz,
  notified_at timestamptz,
  UNIQUE (membership_id, kind, source_id)
);
CREATE INDEX tf_inbox_items_open ON {{schema}}.tf_inbox_items(membership_id, created_at DESC)
  WHERE done_at IS NULL AND resolved_at IS NULL;
REVOKE ALL ON {{schema}}.tf_inbox_items FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON {{schema}}.tf_inbox_items TO {{runtime}};
