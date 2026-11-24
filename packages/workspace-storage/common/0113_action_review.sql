CREATE TABLE {{schema}}.tf_action_review (
  id integer PRIMARY KEY CHECK (id = 1),
  mode text NOT NULL CHECK (mode IN ('legacy', 'auto', 'ask')),
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  rule text,
  interpretation text,
  actions text[] NOT NULL DEFAULT '{}',
  preview_key uuid NOT NULL DEFAULT gen_random_uuid(),
  CHECK ((mode = 'ask' AND rule IS NOT NULL AND interpretation IS NOT NULL AND cardinality(actions) > 0)
      OR (mode <> 'ask' AND rule IS NULL AND interpretation IS NULL AND cardinality(actions) = 0)),
  CHECK (actions <@ ARRAY['create-table','create-agent','create-skill','create-workflow','create-row','update-row','delete-row'])
);
-- Fresh provisioning applies migrations before inserting its provisioning marker.
INSERT INTO {{schema}}.tf_action_review(id, mode)
  SELECT 1, CASE WHEN EXISTS (SELECT 1 FROM {{schema}}.tf_provisioning) THEN 'legacy' ELSE 'auto' END;
-- UPDATE(id) allows FOR SHARE; the singleton constraint makes id immutable.
GRANT SELECT, UPDATE(id) ON {{schema}}.tf_action_review TO {{runtime}};
CREATE FUNCTION {{schema}}.tf_set_action_review(actor text, member uuid, expected integer, choice text,
  rule_text text, reviewed_actions text[], summary text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF choice NOT IN ('auto', 'ask') OR NOT EXISTS (
    SELECT 1 FROM {{schema}}.tf_memberships WHERE user_id=actor AND id=member AND role='admin' AND removed_at IS NULL
    FOR SHARE) THEN
    RAISE insufficient_privilege;
  END IF;
  UPDATE {{schema}}.tf_action_review SET mode=choice, rule=rule_text, actions=reviewed_actions,
    interpretation=summary, revision=revision+1 WHERE id=1 AND revision=expected;
  RETURN FOUND;
END
$$;
REVOKE ALL ON FUNCTION {{schema}}.tf_set_action_review(text,uuid,integer,text,text,text[],text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION {{schema}}.tf_set_action_review(text,uuid,integer,text,text,text[],text) TO {{runtime}};

CREATE TABLE {{schema}}.tf_action_review_receipts (
  call_id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL,
  turn_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('create-table','create-agent','create-skill','create-workflow','create-row','update-row','delete-row')),
  revision integer NOT NULL CHECK (revision >= 0),
  result jsonb NOT NULL,
  input_digest text NOT NULL CHECK (input_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (conversation_id, turn_id) REFERENCES {{schema}}.tf_conversation_turns(conversation_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX tf_action_review_authoring_turn ON {{schema}}.tf_action_review_receipts(turn_id, action)
  WHERE action IN ('create-table','create-agent','create-skill','create-workflow');
GRANT SELECT, INSERT ON {{schema}}.tf_action_review_receipts TO {{runtime}};
-- The publication role may inspect evidence and the current rule, never change either.
GRANT SELECT ON {{schema}}.tf_action_review_receipts TO {{customOwner}}, {{migration}};
GRANT SELECT (id, mode, revision, rule, interpretation, actions), UPDATE(id)
  ON {{schema}}.tf_action_review TO {{customOwner}}, {{migration}};

CREATE OR REPLACE FUNCTION {{schema}}.tf_table_creation_access(execution_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  creation record;
  permissions text[] := ARRAY[
    'table.row.read', 'table.row.create', 'table.row.update', 'table.row.delete', 'table.schema.manage'
  ];
BEGIN
  SELECT e.table_id, c.owning_team_id, p.membership_id, e.creation_access_granted_at,
    d.proposal_id IS NULL AS policy_save,
    plan->'after'->>'owningTeamId'=c.owning_team_id::text AS owner_current,
    plan->'after'=g.definition AND c.applied_definition=g.definition AS definition_current,
    g.state='active' AND g.revision=e.revision AND g.activated_at IS NOT NULL
      AND c.physical_table=g.physical_table AND c.applied_revision=g.revision
      AND NOT EXISTS (SELECT 1 FROM {{schema}}.tf_table_generations prior
        WHERE prior.table_id=e.table_id AND prior.id<>g.id AND prior.activated_at IS NOT NULL) AS generation_current,
    g.xmin=pg_current_xact_id()::xid AND c.xmin=pg_current_xact_id()::xid AS transaction_current
  INTO creation
  FROM {{schema}}.tf_table_executions e
  JOIN {{schema}}.tf_table_proposals p ON p.id=e.proposal_id
  LEFT JOIN {{schema}}.tf_table_proposal_decisions d
    ON d.proposal_id=p.id AND d.digest=p.digest AND d.membership_id=p.membership_id AND d.decision='approve'
  JOIN {{schema}}.tf_memberships m
    ON m.id=p.membership_id AND m.user_id=p.user_id AND m.removed_at IS NULL
  JOIN {{schema}}.tf_table_generations g ON g.id=e.target_generation AND g.table_id=e.table_id
  JOIN {{schema}}.tf_table_catalog c ON c.id=e.table_id
  CROSS JOIN LATERAL jsonb_array_elements(p.manifest->'plans') plan
  WHERE e.id=execution_id AND e.phase='reconciling' AND e.source_generation IS NULL
    AND (d.proposal_id IS NOT NULL OR (
      jsonb_array_length(p.manifest->'plans')=1
      AND NOT EXISTS (SELECT 1 FROM {{schema}}.tf_table_proposal_decisions decision WHERE decision.proposal_id=p.id)
      AND EXISTS (
        SELECT 1 FROM {{schema}}.tf_action_review_receipts receipt
        JOIN {{schema}}.tf_action_review policy ON policy.id=1 AND policy.revision=receipt.revision
        JOIN {{schema}}.tf_conversations chat ON chat.id=receipt.conversation_id
        WHERE receipt.call_id=p.id AND receipt.action='create-table' AND receipt.result->>'digest'=p.digest
          AND receipt.conversation_id=p.conversation_id AND receipt.turn_id=p.turn_id
          AND chat.kind='private' AND chat.project_id IS NULL AND chat.app_id IS NULL
          AND chat.owner_membership_id=m.id AND chat.owner_user_id=m.user_id AND chat.deleted_at IS NULL
          AND (policy.mode='auto' OR (policy.mode='ask' AND NOT ('create-table'=ANY(policy.actions))))
        FOR SHARE OF policy)
      AND (m.role='admin' OR EXISTS (
        SELECT 1 FROM {{schema}}.tf_member_teams mt JOIN {{schema}}.tf_grants gr ON gr.team_id=mt.team_id
        WHERE mt.membership_id=m.id AND gr.asset_id=c.owning_team_id AND gr.permission='table.create')
        OR EXISTS (SELECT 1 FROM {{schema}}.tf_table_person_grants gr WHERE gr.membership_id=m.id
          AND gr.asset_id=c.owning_team_id AND gr.permission='table.create'))))
    AND NOT EXISTS (SELECT 1 FROM {{schema}}.tf_teams team WHERE team.id=e.table_id)
    AND NOT EXISTS (SELECT 1 FROM {{schema}}.tf_slack_destinations destination WHERE destination.id=e.table_id)
    AND NOT EXISTS (SELECT 1 FROM {{schema}}.tf_grants grant_row
      WHERE grant_row.asset_id=e.table_id AND grant_row.permission NOT LIKE 'table.%')
    AND plan->'before'='null'::jsonb AND plan->'input'->>'kind'='schema'
    AND plan->'input'->'expectedRevision'='null'::jsonb
    AND plan->'input'->>'tableId'=e.table_id::text
    AND p.manifest->'requester'->>'membershipId'=p.membership_id::text
    AND p.manifest->'requester'->>'userId'=p.user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Table creation access is unavailable'
      USING ERRCODE='42501', DETAIL='generation-superseded';
  END IF;
  IF creation.owner_current IS NOT TRUE THEN
    RAISE EXCEPTION 'Table creation access is unavailable'
      USING ERRCODE='42501', DETAIL='owner-changed';
  END IF;
  IF creation.definition_current IS NOT TRUE THEN
    RAISE EXCEPTION 'Table creation access is unavailable'
      USING ERRCODE='42501', DETAIL='definition-changed';
  END IF;
  IF creation.generation_current IS NOT TRUE THEN
    RAISE EXCEPTION 'Table creation access is unavailable'
      USING ERRCODE='42501', DETAIL='generation-superseded';
  END IF;
  IF creation.transaction_current IS NOT TRUE THEN
    RAISE EXCEPTION 'Table creation access is unavailable'
      USING ERRCODE='42501', DETAIL='xmin-mismatch';
  END IF;

  IF EXISTS (SELECT 1 FROM {{schema}}.tf_teams WHERE id=creation.owning_team_id AND name='_everyone') THEN
    permissions := ARRAY['table.row.read', 'table.row.create', 'table.row.update', 'table.row.delete'];
  END IF;
  INSERT INTO {{schema}}.tf_table_creation_access_receipts(table_id)
    VALUES(creation.table_id) ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN
    IF creation.creation_access_granted_at IS NOT NULL THEN RETURN; END IF;
    RAISE EXCEPTION 'Table creation access is unavailable'
      USING ERRCODE='42501', DETAIL='receipt-unattributed';
  END IF;
  IF NOT creation.policy_save THEN
    INSERT INTO {{schema}}.tf_grants(team_id,asset_id,permission)
      SELECT creation.owning_team_id,creation.table_id,unnest(permissions) ON CONFLICT DO NOTHING;
  END IF;
  INSERT INTO {{schema}}.tf_table_person_grants(membership_id,asset_id,permission)
    SELECT creation.membership_id,creation.table_id,unnest(permissions) ON CONFLICT DO NOTHING;
  UPDATE {{schema}}.tf_table_executions SET creation_access_granted_at=clock_timestamp() WHERE id=execution_id;
  UPDATE {{schema}}.tf_authorization_lock SET lock_version=lock_version+1 WHERE id=1;
END
$$;
