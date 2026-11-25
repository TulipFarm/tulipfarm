-- Every task gets a key such as TUL-001. Numbers count up per Tasks table and are never reused, even after a delete.
-- TUL-000 is the welcome task; the worker creates it once while welcome_pending is set.
CREATE TABLE {{schema}}.tf_task_key_counters (
  table_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_table_catalog(id),
  next_number integer NOT NULL CHECK (next_number >= 1),
  welcome_pending boolean NOT NULL DEFAULT true
);
REVOKE ALL ON {{schema}}.tf_task_key_counters FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON {{schema}}.tf_task_key_counters TO {{runtime}};

CREATE TABLE {{schema}}.tf_task_keys (
  table_id uuid NOT NULL,
  row_id uuid NOT NULL,
  number integer NOT NULL CHECK (number >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (table_id, row_id),
  UNIQUE (table_id, number),
  FOREIGN KEY (table_id, row_id) REFERENCES {{schema}}.tf_table_identities(table_id, row_id)
);
REVOKE ALL ON {{schema}}.tf_task_keys FROM PUBLIC;
GRANT SELECT, INSERT ON {{schema}}.tf_task_keys TO {{runtime}};

-- Existing tasks are numbered from 1 in the order they were created.
INSERT INTO {{schema}}.tf_task_keys(table_id, row_id, number)
SELECT i.table_id, i.row_id,
  row_number() OVER (PARTITION BY i.table_id ORDER BY COALESCE(h.first_at, i.updated_at), i.row_id)
FROM {{schema}}.tf_table_identities i
JOIN {{schema}}.tf_system_tables s ON s.table_id = i.table_id AND s.kind = 'tasks'
LEFT JOIN LATERAL (
  SELECT min(created_at) AS first_at FROM {{schema}}.tf_table_row_history_data d
  WHERE d.table_id = i.table_id AND d.row_id = i.row_id
) h ON true
WHERE i.live;
INSERT INTO {{schema}}.tf_task_key_counters(table_id, next_number)
SELECT s.table_id, COALESCE((SELECT max(number) FROM {{schema}}.tf_task_keys k WHERE k.table_id = s.table_id), 0) + 1
FROM {{schema}}.tf_system_tables s WHERE s.kind = 'tasks';

-- Reminders nudge one member about one task until they act on it.
CREATE TABLE {{schema}}.tf_task_reminders (
  id uuid PRIMARY KEY,
  table_id uuid NOT NULL REFERENCES {{schema}}.tf_table_catalog(id),
  row_id uuid NOT NULL,
  membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  created_by_membership_id uuid NOT NULL REFERENCES {{schema}}.tf_memberships(id),
  schedule text NOT NULL CHECK (schedule IN ('once', 'daily', 'weekdays', 'weekly')),
  -- Local wall-clock time in time_zone for repeating reminders; a one-off reminder fires at next_fire_at.
  time_of_day time,
  -- 0 is Sunday, as in extract(dow ...).
  weekday smallint CHECK (weekday BETWEEN 0 AND 6),
  time_zone text NOT NULL CHECK (char_length(time_zone) BETWEEN 1 AND 64),
  -- When a one-off reminder fires.
  once_at timestamptz,
  next_fire_at timestamptz,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stopped')),
  stop_reason text CHECK (stop_reason IN ('cancelled', 'commented', 'done', 'access-lost', 'deleted', 'finished')),
  stopped_by_membership_id uuid REFERENCES {{schema}}.tf_memberships(id),
  fired_count integer NOT NULL DEFAULT 0 CHECK (fired_count >= 0),
  last_fired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  stopped_at timestamptz,
  CHECK ((status = 'active') = (stop_reason IS NULL)),
  CHECK ((status = 'active') = (stopped_at IS NULL)),
  CHECK (status <> 'active' OR next_fire_at IS NOT NULL),
  CHECK ((schedule = 'once') = (time_of_day IS NULL)),
  CHECK ((schedule = 'once') = (once_at IS NOT NULL)),
  CHECK ((schedule = 'weekly') = (weekday IS NOT NULL))
);
CREATE INDEX tf_task_reminders_due ON {{schema}}.tf_task_reminders(next_fire_at) WHERE status = 'active';
CREATE INDEX tf_task_reminders_row ON {{schema}}.tf_task_reminders(table_id, row_id, created_at);
REVOKE ALL ON {{schema}}.tf_task_reminders FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON {{schema}}.tf_task_reminders TO {{runtime}};

ALTER TABLE {{schema}}.tf_inbox_items DROP CONSTRAINT tf_inbox_items_kind_check;
ALTER TABLE {{schema}}.tf_inbox_items ADD CONSTRAINT tf_inbox_items_kind_check
  CHECK (kind IN ('assigned', 'waiting', 'finished', 'mention', 'reminder'));
ALTER TABLE {{schema}}.tf_inbox_slack_muted DROP CONSTRAINT tf_inbox_slack_muted_kind_check;
ALTER TABLE {{schema}}.tf_inbox_slack_muted ADD CONSTRAINT tf_inbox_slack_muted_kind_check
  CHECK (kind IN ('assigned', 'waiting', 'finished', 'mention', 'reminder'));
