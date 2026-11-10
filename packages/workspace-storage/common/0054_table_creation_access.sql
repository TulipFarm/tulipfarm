ALTER TABLE {{schema}}.tf_table_executions ADD COLUMN creation_access_granted_at timestamptz;

GRANT SELECT(id) ON {{schema}}.tf_slack_destinations TO {{customOwner}};

-- Generation owners must not be able to erase the history that prevents a second grant.
CREATE TABLE {{schema}}.tf_table_creation_access_receipts (
  table_id uuid PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON {{schema}}.tf_table_creation_access_receipts
  FROM PUBLIC,{{runtime}},{{migration}},{{customOwner}},{{confirmation}};
INSERT INTO {{schema}}.tf_table_creation_access_receipts(table_id)
  SELECT c.id FROM {{schema}}.tf_table_catalog c
  WHERE EXISTS (SELECT 1 FROM {{schema}}.tf_table_generations g
    WHERE g.table_id=c.id AND g.activated_at IS NOT NULL);

CREATE FUNCTION {{schema}}.tf_table_creation_access(execution_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  creation record;
  permissions constant text[] := ARRAY[
    'table.row.read', 'table.row.create', 'table.row.update', 'table.row.delete', 'table.schema.manage'
  ];
BEGIN
  SELECT e.table_id, c.owning_team_id, p.membership_id INTO creation
  FROM {{schema}}.tf_table_executions e
  JOIN {{schema}}.tf_table_proposals p ON p.id=e.proposal_id
  JOIN {{schema}}.tf_table_proposal_decisions d
    ON d.proposal_id=p.id AND d.digest=p.digest AND d.membership_id=p.membership_id AND d.decision='approve'
  JOIN {{schema}}.tf_memberships m
    ON m.id=p.membership_id AND m.user_id=p.user_id AND m.removed_at IS NULL
  JOIN {{schema}}.tf_table_generations g ON g.id=e.target_generation AND g.table_id=e.table_id
  JOIN {{schema}}.tf_table_catalog c ON c.id=e.table_id
  CROSS JOIN LATERAL jsonb_array_elements(p.manifest->'plans') plan
  WHERE e.id=execution_id AND e.phase='reconciling' AND e.source_generation IS NULL
    AND NOT EXISTS (SELECT 1 FROM {{schema}}.tf_teams team WHERE team.id=e.table_id)
    AND NOT EXISTS (SELECT 1 FROM {{schema}}.tf_slack_destinations destination WHERE destination.id=e.table_id)
    AND NOT EXISTS (SELECT 1 FROM {{schema}}.tf_grants grant_row
      WHERE grant_row.asset_id=e.table_id AND grant_row.permission NOT LIKE 'table.%')
    AND g.state='active' AND g.revision=e.revision AND g.activated_at IS NOT NULL
    AND c.physical_table=g.physical_table AND c.applied_revision=g.revision AND c.applied_definition=g.definition
    AND g.xmin=pg_current_xact_id()::xid AND c.xmin=pg_current_xact_id()::xid
    AND plan->'before'='null'::jsonb AND plan->'input'->>'kind'='schema'
    AND plan->'input'->'expectedRevision'='null'::jsonb
    AND plan->'input'->>'tableId'=e.table_id::text AND plan->'after'=g.definition
    AND plan->'after'->>'owningTeamId'=c.owning_team_id::text
    AND p.manifest->'requester'->>'membershipId'=p.membership_id::text
    AND p.manifest->'requester'->>'userId'=p.user_id
    AND NOT EXISTS(SELECT 1 FROM {{schema}}.tf_table_generations prior
      WHERE prior.table_id=e.table_id AND prior.id<>g.id AND prior.activated_at IS NOT NULL);
  IF NOT FOUND THEN RAISE EXCEPTION 'Table creation access is unavailable' USING ERRCODE='42501'; END IF;

  INSERT INTO {{schema}}.tf_table_creation_access_receipts(table_id)
    VALUES(creation.table_id) ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN RAISE EXCEPTION 'Table creation access is unavailable' USING ERRCODE='42501'; END IF;

  INSERT INTO {{schema}}.tf_grants(team_id,asset_id,permission)
    SELECT creation.owning_team_id,creation.table_id,unnest(permissions) ON CONFLICT DO NOTHING;
  INSERT INTO {{schema}}.tf_table_person_grants(membership_id,asset_id,permission)
    SELECT creation.membership_id,creation.table_id,unnest(permissions) ON CONFLICT DO NOTHING;
  UPDATE {{schema}}.tf_table_executions SET creation_access_granted_at=clock_timestamp() WHERE id=execution_id;
  UPDATE {{schema}}.tf_authorization_lock SET lock_version=lock_version+1 WHERE id=1;
END
$$;
REVOKE ALL ON FUNCTION {{schema}}.tf_table_creation_access(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION {{schema}}.tf_table_creation_access(uuid) TO {{customOwner}};
