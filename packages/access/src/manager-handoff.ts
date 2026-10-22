import { escapeIdentifier } from 'pg';
import { z } from 'zod';
import type { AuthorizationTransaction } from './index.ts';

// A departure removes manager authority held directly by a person, through one team, or through
// every member of a deleted team. Forced removal by an admin is not a departure and locks items instead.
export type ManagerDeparture =
  | { kind: 'member'; membershipId: string }
  | { kind: 'enrollment'; membershipId: string; teamId: string }
  | { kind: 'team'; teamId: string };

type ManagerSource = {
  kind: string;
  table: string;
  item: string;
  // Internal SQL over the grant row `g`, selecting rows that confer management.
  manages: string;
  principals: 'person' | 'team' | 'both';
  // Internal SQL over the item row `i`, selecting items that can still be managed.
  live?: { table: string; condition: string };
};

const sources: readonly ManagerSource[] = [
  {
    kind: 'project',
    table: 'tf_project_members',
    item: 'project_id',
    manages: "g.role='manager' AND g.removed_at IS NULL",
    principals: 'person',
  },
  {
    kind: 'agent',
    table: 'tf_agent_person_grants',
    item: 'agent_id',
    manages: "g.permission='manage'",
    principals: 'person',
    live: { table: 'tf_agents', condition: 'i.deleted_at IS NULL' },
  },
  {
    kind: 'agent',
    table: 'tf_agent_grants',
    item: 'agent_id',
    manages: "g.permission='manage'",
    principals: 'team',
    live: { table: 'tf_agents', condition: 'i.deleted_at IS NULL' },
  },
  {
    kind: 'skill',
    table: 'tf_skill_person_grants',
    item: 'skill_id',
    manages: "g.permission='manage'",
    principals: 'person',
  },
  {
    kind: 'skill',
    table: 'tf_skill_team_grants',
    item: 'skill_id',
    manages: "g.permission='manage'",
    principals: 'team',
  },
  // Workspaces below common version 4 have no archived_at column; the JSON read treats it as absent there.
  {
    kind: 'workflow',
    table: 'tf_workflow_grants',
    item: 'workflow_id',
    manages: "g.permission='manage'",
    principals: 'both',
    live: { table: 'tf_workflows', condition: "to_jsonb(i)->>'archived_at' IS NULL" },
  },
  {
    kind: 'workflow-provider',
    table: 'tf_workflow_provider_grants',
    item: 'integration_id',
    manages: "g.permission='manage'",
    principals: 'both',
  },
  {
    kind: 'integration',
    table: 'tf_integration_person_grants',
    item: 'integration_id',
    manages: "g.permission='manage'",
    principals: 'person',
    live: { table: 'tf_integrations', condition: 'i.deleted_at IS NULL' },
  },
  {
    kind: 'integration',
    table: 'tf_integration_grants',
    item: 'integration_id',
    manages: "g.permission='manage'",
    principals: 'team',
    live: { table: 'tf_integrations', condition: 'i.deleted_at IS NULL' },
  },
  {
    kind: 'mcp-integration',
    table: 'tf_mcp_managers',
    item: 'integration_id',
    manages: 'true',
    principals: 'both',
    live: { table: 'tf_mcp_integrations', condition: "i.ownership='shared' AND i.lifecycle<>'deleted'" },
  },
  {
    kind: 'atlassian-account',
    table: 'tf_atlassian_account_managers',
    item: 'account_id',
    manages: 'true',
    principals: 'both',
    live: { table: 'tf_atlassian_accounts', condition: "i.ownership='business'" },
  },
  {
    kind: 'slack-installation',
    table: 'tf_slack_installation_managers',
    item: 'installation_id',
    manages: 'true',
    principals: 'both',
    live: { table: 'tf_slack_installations', condition: "i.state<>'revoked'" },
  },
];

function managerRows(tx: AuthorizationTransaction, source: ManagerSource) {
  const table = (name: string) => `${escapeIdentifier(tx.schema)}.${escapeIdentifier(name)}`;
  const live = source.live
    ? ` AND EXISTS (SELECT 1 FROM ${table(source.live.table)} i WHERE i.id=g.${source.item} AND ${source.live.condition})`
    : '';
  const kind = `'${source.kind}'::text`;
  const rows: string[] = [];
  if (source.principals !== 'team')
    rows.push(
      `SELECT ${kind} AS kind,g.${source.item} AS item_id,g.membership_id,NULL::uuid AS team_id FROM ${table(source.table)} g WHERE g.membership_id IS NOT NULL AND ${source.manages}${live}`,
    );
  if (source.principals !== 'person')
    rows.push(
      `SELECT ${kind} AS kind,g.${source.item} AS item_id,mt.membership_id,g.team_id FROM ${table(source.table)} g JOIN ${table('tf_member_teams')} mt ON mt.team_id=g.team_id WHERE ${source.manages}${live}`,
    );
  return rows;
}

// True when the departure would leave a currently managed item without any current manager.
// Items that are already managerless stay locked and do not block the departure.
export async function departureNeedsManagerHandoff(tx: AuthorizationTransaction, departure: ManagerDeparture) {
  const rows = sources.flatMap(source => managerRows(tx, source));
  if (!rows.length) return false;
  const membershipId = departure.kind === 'team' ? null : z.uuid().parse(departure.membershipId);
  const teamId = departure.kind === 'member' ? null : z.uuid().parse(departure.teamId);
  const result = await tx.client.query(
    `WITH managers AS (
      SELECT r.kind,r.item_id,r.membership_id,r.team_id,
        (($1::uuid IS NULL OR r.membership_id=$1) AND ($2::uuid IS NULL OR r.team_id IS NOT DISTINCT FROM $2)) AS departing
      FROM (${rows.join(' UNION ALL ')}) r
      JOIN ${escapeIdentifier(tx.schema)}.tf_memberships m ON m.id=r.membership_id AND m.removed_at IS NULL)
    SELECT 1 FROM managers WHERE (kind,item_id) IN (SELECT kind,item_id FROM managers WHERE departing)
    GROUP BY kind,item_id HAVING bool_and(departing) LIMIT 1`,
    [membershipId, teamId],
  );
  return Boolean(result.rowCount);
}
