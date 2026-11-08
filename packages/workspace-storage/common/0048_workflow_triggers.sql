-- A workflow definition holds a list of triggers instead of one. Each trigger has an ID that is its identity across
-- revisions, and the state that outlives a revision (its switch, next due time, webhook keys and fired once time)
-- moves from tf_workflows to one tf_workflow_triggers row per workflow and trigger ID. Rows are never deleted, so a
-- trigger ID keeps its kind and its webhook keys when it is removed and added back.
CREATE TABLE {{schema}}.tf_workflow_triggers (
  workflow_id uuid NOT NULL REFERENCES {{schema}}.tf_workflows(id),
  trigger_id text NOT NULL CHECK (trigger_id ~ '^[a-z][a-z0-9_]{0,47}$'),
  kind text NOT NULL CHECK (kind IN ('record','row','provider','github','webhook','event','once','interval','cron')),
  enabled boolean NOT NULL DEFAULT true,
  -- When the trigger was last switched back on. Record occurrences due before then never run.
  switched_on_at timestamptz,
  next_run_at timestamptz,
  once_fired_at timestamptz,
  webhook_digest text,
  webhook_secret jsonb,
  webhook_previous jsonb,
  webhook_previous_expires_at timestamptz,
  PRIMARY KEY (workflow_id, trigger_id),
  CONSTRAINT tf_workflow_triggers_webhook_one_current CHECK (webhook_digest IS NULL OR webhook_secret IS NULL),
  CONSTRAINT tf_workflow_triggers_webhook_previous_expiry CHECK ((webhook_previous IS NULL) = (webhook_previous_expires_at IS NULL))
);
CREATE INDEX tf_workflow_triggers_due ON {{schema}}.tf_workflow_triggers (next_run_at, workflow_id) WHERE next_run_at IS NOT NULL;
REVOKE ALL ON {{schema}}.tf_workflow_triggers FROM PUBLIC;
GRANT SELECT, INSERT ON {{schema}}.tf_workflow_triggers TO {{runtime}};
GRANT UPDATE (enabled,switched_on_at,next_run_at,once_fired_at,webhook_digest,webhook_secret,webhook_previous,webhook_previous_expires_at)
  ON {{schema}}.tf_workflow_triggers TO {{runtime}};

-- Revision IDs stay the same. A migrated trigger's ID is its kind; a manual trigger becomes an empty list.
UPDATE {{schema}}.tf_workflow_revisions
SET definition = (definition - 'trigger') || jsonb_build_object('triggers',
  CASE WHEN definition->'trigger'->>'kind' = 'manual' THEN '[]'::jsonb
  ELSE jsonb_build_array(jsonb_build_object('id', definition->'trigger'->>'kind') || (definition->'trigger')) END)
WHERE definition ? 'trigger';

-- A GitHub trigger lists its repositories and events. The one repository and event a shipped trigger named become
-- one-item lists.
UPDATE {{schema}}.tf_workflow_revisions
SET definition = jsonb_set(definition, '{triggers}', (
  SELECT jsonb_agg(CASE WHEN t->>'kind' = 'github' AND t ? 'repositoryId' THEN
    (t - 'repositoryId' - 'event' - 'actions') || jsonb_build_object(
      'repositories', jsonb_build_array(t->'repositoryId'),
      'events', jsonb_build_array(jsonb_build_object('event', t->'event')
        || CASE WHEN t ? 'actions' THEN jsonb_build_object('actions', t->'actions') ELSE '{}'::jsonb END))
    ELSE t END ORDER BY o)
  FROM jsonb_array_elements(definition->'triggers') WITH ORDINALITY x(t, o)))
WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(definition->'triggers') t
  WHERE t->>'kind' = 'github' AND t ? 'repositoryId');

INSERT INTO {{schema}}.tf_workflow_triggers
  (workflow_id,trigger_id,kind,next_run_at,webhook_digest,webhook_secret,webhook_previous,webhook_previous_expires_at)
SELECT DISTINCT ON (w.id, t->>'id') w.id, t->>'id', t->>'kind',
  CASE WHEN r.id = w.active_revision THEN w.next_run_at END,
  CASE WHEN t->>'kind' = 'webhook' THEN w.webhook_digest END,
  CASE WHEN t->>'kind' = 'webhook' THEN w.webhook_secret END,
  CASE WHEN t->>'kind' = 'webhook' THEN w.webhook_previous END,
  CASE WHEN t->>'kind' = 'webhook' THEN w.webhook_previous_expires_at END
FROM {{schema}}.tf_workflows w
JOIN {{schema}}.tf_workflow_revisions r ON r.workflow_id = w.id AND r.id IN (w.revision, w.active_revision)
CROSS JOIN LATERAL jsonb_array_elements(r.definition->'triggers') t
ORDER BY w.id, t->>'id', (r.id = w.active_revision) DESC;

-- A once trigger that already fired stays fired while its time is unchanged, whichever revision runs next.
UPDATE {{schema}}.tf_workflow_triggers t SET once_fired_at = (d.definition->'triggers'->0->>'at')::timestamptz
FROM {{schema}}.tf_workflows w
JOIN {{schema}}.tf_workflow_revisions d ON d.workflow_id = w.id AND d.id = w.active_revision
WHERE t.workflow_id = w.id AND t.trigger_id = 'once' AND d.definition->'triggers'->0->>'kind' = 'once'
  AND EXISTS (SELECT 1 FROM {{schema}}.tf_workflow_runs r
    WHERE r.workflow_id = w.id AND r.revision = w.active_revision AND r.request_key LIKE 'schedule:%');

UPDATE {{schema}}.tf_workflows SET next_run_at = NULL, webhook_digest = NULL, webhook_secret = NULL,
  webhook_previous = NULL, webhook_previous_expires_at = NULL
WHERE next_run_at IS NOT NULL OR webhook_digest IS NOT NULL OR webhook_secret IS NOT NULL OR webhook_previous IS NOT NULL;

ALTER TABLE {{schema}}.tf_workflow_runs
  ADD COLUMN trigger_id text,
  ADD COLUMN fired_trigger_ids text[] NOT NULL DEFAULT '{}';
UPDATE {{schema}}.tf_workflow_runs r
SET trigger_id = d.definition->'triggers'->0->>'id', fired_trigger_ids = ARRAY[d.definition->'triggers'->0->>'id']
FROM {{schema}}.tf_workflow_revisions d
WHERE d.workflow_id = r.workflow_id AND d.id = r.revision AND r.request_key NOT LIKE 'manual:%'
  AND jsonb_array_length(d.definition->'triggers') > 0;
-- Request keys now name the trigger, so a sender retrying a delivery made before this migration still finds its run.
UPDATE {{schema}}.tf_workflow_runs SET request_key = 'webhook:webhook:' || substr(request_key, 9)
WHERE request_key LIKE 'webhook:%';
UPDATE {{schema}}.tf_workflow_runs
SET request_key = regexp_replace(request_key, '^(provider|github):([0-9a-f-]{36}):', '\1:\2:\1:')
WHERE request_key ~ '^(provider|github):[0-9a-f-]{36}:';
CREATE INDEX tf_workflow_runs_trigger_history ON {{schema}}.tf_workflow_runs (workflow_id, trigger_id, created_at DESC, id DESC)
  WHERE trigger_id IS NOT NULL;

ALTER TABLE {{schema}}.tf_provider_polls ADD COLUMN trigger_id text;
UPDATE {{schema}}.tf_provider_polls SET trigger_id = 'provider';
ALTER TABLE {{schema}}.tf_provider_polls ALTER COLUMN trigger_id SET NOT NULL,
  DROP CONSTRAINT tf_provider_polls_pkey, ADD PRIMARY KEY (workflow_id, trigger_id);

ALTER TABLE {{schema}}.tf_provider_events ADD COLUMN trigger_id text, ADD COLUMN fired_trigger_ids text[];
UPDATE {{schema}}.tf_provider_events e SET trigger_id = d.definition->'triggers'->0->>'kind',
  fired_trigger_ids = ARRAY[d.definition->'triggers'->0->>'kind']
FROM {{schema}}.tf_workflow_revisions d WHERE d.workflow_id = e.workflow_id AND d.id = e.revision;
UPDATE {{schema}}.tf_provider_events SET trigger_id = 'provider', fired_trigger_ids = ARRAY['provider'] WHERE trigger_id IS NULL;
ALTER TABLE {{schema}}.tf_provider_events ALTER COLUMN trigger_id SET NOT NULL, ALTER COLUMN fired_trigger_ids SET NOT NULL,
  DROP CONSTRAINT tf_provider_events_pkey, ADD PRIMARY KEY (workflow_id, revision, trigger_id, event_key);
GRANT UPDATE (fired_trigger_ids) ON {{schema}}.tf_provider_events TO {{runtime}};
-- A queued GitHub event keeps the repository it came from, so admission rechecks the sponsor's access to that one.
ALTER TABLE {{schema}}.tf_provider_events ADD COLUMN github_repository_id text;
UPDATE {{schema}}.tf_provider_events e SET github_repository_id = d.definition->'triggers'->0->'repositories'->>0
FROM {{schema}}.tf_workflow_revisions d
WHERE d.workflow_id = e.workflow_id AND d.id = e.revision AND NOT e.admitted
  AND d.definition->'triggers'->0->>'kind' = 'github';

ALTER TABLE {{schema}}.tf_workflow_record_occurrences ADD COLUMN trigger_id text;
UPDATE {{schema}}.tf_workflow_record_occurrences SET trigger_id = 'record';
ALTER TABLE {{schema}}.tf_workflow_record_occurrences ALTER COLUMN trigger_id SET NOT NULL,
  DROP CONSTRAINT tf_workflow_record_occurrences_pkey, ADD PRIMARY KEY (workflow_id, revision, trigger_id, record_id, due_at);

-- One row change is one queued event for its workflow; trigger_ids lists the row triggers it matched when captured.
ALTER TABLE {{schema}}.tf_workflow_row_events ADD COLUMN trigger_ids text[];
UPDATE {{schema}}.tf_workflow_row_events SET trigger_ids = ARRAY['row'];
ALTER TABLE {{schema}}.tf_workflow_row_events ALTER COLUMN trigger_ids SET NOT NULL,
  ADD CHECK (cardinality(trigger_ids) BETWEEN 1 AND 20);
-- A row event whose triggers were all switched off settles as ignored with this reason.
ALTER TABLE {{schema}}.tf_workflow_row_events DROP CONSTRAINT tf_workflow_row_events_reason_check,
  ADD CONSTRAINT tf_workflow_row_events_reason_check CHECK (reason IN ('capacity','values-too-large',
    'values-unavailable','workflow-disabled','revision-replaced','workflow-archived','user-cancelled','trigger-disabled'));

ALTER TABLE {{schema}}.tf_workflow_webhook_signatures ADD COLUMN trigger_id text;
UPDATE {{schema}}.tf_workflow_webhook_signatures SET trigger_id = 'webhook';
ALTER TABLE {{schema}}.tf_workflow_webhook_signatures ALTER COLUMN trigger_id SET NOT NULL,
  DROP CONSTRAINT tf_workflow_webhook_signatures_pkey, ADD PRIMARY KEY (workflow_id, trigger_id, signature);

ALTER TABLE {{schema}}.tf_workflow_webhook_deliveries ADD COLUMN trigger_id text;
UPDATE {{schema}}.tf_workflow_webhook_deliveries SET trigger_id = 'webhook';
ALTER TABLE {{schema}}.tf_workflow_webhook_deliveries ALTER COLUMN trigger_id SET NOT NULL;
CREATE INDEX tf_workflow_webhook_deliveries_trigger ON {{schema}}.tf_workflow_webhook_deliveries
  (workflow_id, trigger_id, received_at DESC, id DESC);

-- Combining workflows into one archives the old ones. Each old workflow's public webhook URL keeps working by
-- forwarding to the trigger its webhook state moved to, until the old workflow is restored by hand.
CREATE TABLE {{schema}}.tf_workflow_webhook_aliases (
  old_workflow_id uuid PRIMARY KEY REFERENCES {{schema}}.tf_workflows(id),
  workflow_id uuid NOT NULL,
  trigger_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (old_workflow_id <> workflow_id),
  FOREIGN KEY (workflow_id, trigger_id) REFERENCES {{schema}}.tf_workflow_triggers(workflow_id, trigger_id)
);
CREATE INDEX tf_workflow_webhook_aliases_target ON {{schema}}.tf_workflow_webhook_aliases (workflow_id, trigger_id);
REVOKE ALL ON {{schema}}.tf_workflow_webhook_aliases FROM PUBLIC;
GRANT SELECT, INSERT, DELETE ON {{schema}}.tf_workflow_webhook_aliases TO {{runtime}};
GRANT UPDATE (workflow_id, trigger_id) ON {{schema}}.tf_workflow_webhook_aliases TO {{runtime}};
GRANT UPDATE (workflow_id, trigger_id) ON {{schema}}.tf_workflow_webhook_deliveries TO {{runtime}};

-- A GitHub trigger can cover every repository of one account, so a repository records the account that owns it.
ALTER TABLE {{schema}}.tf_knowledge_github_repositories ADD COLUMN owner_id text CHECK (owner_id ~ '^[1-9][0-9]{0,19}$');
-- Syncs record each repository's owner, so queue the next sync of every healthy, idle GitHub source now rather than
-- at its usual time. Leased, failed and rate-limited sources keep their schedule.
UPDATE {{schema}}.tf_knowledge_github_sources g SET next_attempt_at = clock_timestamp()
FROM {{schema}}.tf_knowledge_sources s
WHERE s.id = g.source_id AND s.state = 'active' AND g.sync_state <> 'failed'
  AND g.failure IS DISTINCT FROM 'rate-limited' AND g.lease_token IS NULL AND g.next_attempt_at > clock_timestamp();

-- A row change captures one event per workflow, listing every switched-on row trigger it matches in definition order.
CREATE OR REPLACE FUNCTION {{schema}}.tf_workflow_capture_row_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  workflow record;
  files jsonb;
BEGIN
  IF NEW.operation='transform' THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM {{schema}}.tf_table_generations g WHERE g.id=NEW.generation_id AND g.state='active') THEN
    RETURN NEW;
  END IF;
  SELECT COALESCE(jsonb_agg(f->>'id'),'[]'::jsonb) INTO files
    FROM {{schema}}.tf_table_generations g CROSS JOIN LATERAL jsonb_array_elements(g.definition->'fields') f
    WHERE g.id=NEW.generation_id AND f->>'kind'='file';
  FOR workflow IN
    SELECT w.id,w.active_revision,array_agg(t.value->>'id' ORDER BY t.ordinality) AS trigger_ids
    FROM {{schema}}.tf_workflows w
    JOIN {{schema}}.tf_workflow_revisions r ON r.workflow_id=w.id AND r.id=w.active_revision
    CROSS JOIN LATERAL jsonb_array_elements(r.definition->'triggers') WITH ORDINALITY t
    JOIN {{schema}}.tf_workflow_triggers s ON s.workflow_id=w.id AND s.trigger_id=t.value->>'id' AND s.enabled
    WHERE w.enabled AND w.archived_at IS NULL AND t.value->>'kind'='row' AND t.value->>'tableId'=NEW.table_id::text
      AND (
        (t.value->>'event'='created' AND (NEW.operation='create' OR NEW.operation='restore' AND NEW.before_values IS NULL))
        OR (t.value->>'event'='updated' AND (NEW.operation='update' OR NEW.operation='restore' AND NEW.before_values IS NOT NULL) AND cardinality(NEW.field_ids)>0)
        OR (t.value->>'event'='deleted' AND NEW.operation='delete')
      )
      AND (NOT t.value ? 'fieldIds' OR EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(t.value->'fieldIds') f WHERE f::uuid=ANY(NEW.field_ids)
      ))
    GROUP BY w.id,w.active_revision
    ORDER BY w.id
  LOOP
    PERFORM 1 FROM {{schema}}.tf_workflows w WHERE w.id=workflow.id AND w.enabled AND w.archived_at IS NULL
      AND w.active_revision=workflow.active_revision FOR SHARE;
    IF NOT FOUND THEN CONTINUE; END IF;
    INSERT INTO {{schema}}.tf_workflow_row_events(workflow_id,revision,history_id,table_id,changed_at,snapshot,trigger_ids)
      VALUES(workflow.id,workflow.active_revision,NEW.id,NEW.table_id,NEW.created_at,
        jsonb_build_object('row_id',NEW.row_id,'token',NEW.token,'field_ids',NEW.field_ids,
          'values',NEW.values,'before_values',NEW.before_values,'file_fields',files),
        workflow.trigger_ids)
      ON CONFLICT DO NOTHING;
  END LOOP;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION {{schema}}.tf_workflow_capture_row_event() FROM PUBLIC;
