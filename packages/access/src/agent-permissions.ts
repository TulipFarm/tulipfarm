import { escapeIdentifier } from 'pg';
import { z } from 'zod';
import { AccessDenied, currentMember, type AuthorizationTransaction, type HumanActor } from './index.ts';

const table = (tx: AuthorizationTransaction, name: string) =>
  `${escapeIdentifier(tx.schema)}.${escapeIdentifier(name)}`;
export type AgentPermission = 'read' | 'edit' | 'delete' | 'invoke' | 'manage';
export type SkillPermission = 'read' | 'use' | 'manage';
// Each permission is independent. Management also reveals the definition being managed.
// Expressions are internal SQL. Request values must use query parameters.
export function definitionGrantPredicate(
  tx: AuthorizationTransaction,
  kind: 'agent' | 'skill',
  id: string,
  membership: string,
  permission: string,
) {
  const column = kind === 'agent' ? 'agent_id' : 'skill_id';
  const teams = kind === 'agent' ? 'tf_agent_grants' : 'tf_skill_team_grants';
  const people = kind === 'agent' ? 'tf_agent_person_grants' : 'tf_skill_person_grants';
  return `(EXISTS (SELECT 1 FROM ${table(tx, people)} grant_person WHERE grant_person.${column}=${id} AND grant_person.membership_id=${membership} AND (grant_person.permission=${permission} OR (${permission}='read' AND grant_person.permission='manage'))) OR EXISTS (SELECT 1 FROM ${table(tx, teams)} grant_team JOIN ${table(tx, 'tf_member_teams')} grant_member ON grant_member.team_id=grant_team.team_id WHERE grant_team.${column}=${id} AND grant_member.membership_id=${membership} AND (grant_team.permission=${permission} OR (${permission}='read' AND grant_team.permission='manage'))))`;
}

export async function requireAgentGrant(
  tx: AuthorizationTransaction,
  actor: HumanActor,
  agentId: string,
  permission: AgentPermission,
) {
  await currentMember(tx, actor);
  const predicate = definitionGrantPredicate(tx, 'agent', 'a.id', '$2', '$3');
  if (
    !(
      await tx.client.query(
        `SELECT 1 FROM ${table(tx, 'tf_agents')} a WHERE a.id=$1 AND a.saved_revision IS NOT NULL AND a.deleted_at IS NULL AND ${predicate}`,
        [agentId, actor.membershipId, permission],
      )
    ).rowCount
  )
    throw new AccessDenied();
}

export async function requireAgentRunInvocation(
  tx: AuthorizationTransaction,
  actor: HumanActor,
  agentId: string,
  runId: string,
) {
  try {
    await requireAgentGrant(tx, actor, agentId, 'invoke');
    return;
  } catch (error) {
    if (!(error instanceof AccessDenied)) throw error;
  }
  await currentMember(tx, actor);
  const allowed = await tx.client.query(
    `SELECT 1 FROM ${table(tx, 'tf_agent_runs')} a
    JOIN ${table(tx, 'tf_slack_agent_turns')} t ON t.run_id=a.id AND t.event_id=a.id
    JOIN ${table(tx, 'tf_slack_agent_branches')} b ON b.id=t.branch_id
    JOIN ${table(tx, 'tf_slack_channel_roots')} r ON r.id=b.root_id AND r.agent_id=a.agent_id
    JOIN ${table(tx, 'tf_slack_channel_invocations')} v ON v.root_id=r.id AND v.event_id=t.event_id
    JOIN ${table(tx, 'tf_slack_events')} e ON e.id=t.event_id AND e.installation_id=r.installation_id AND e.generation=r.generation
    JOIN ${table(tx, 'tf_slack_channel_attachments')} c ON c.installation_id=r.installation_id AND c.generation=r.generation AND c.channel=r.channel AND c.agent_id=r.agent_id
    JOIN ${table(tx, 'tf_slack_identities')} p ON p.id=b.identity_id AND p.installation_id=r.installation_id AND p.generation=r.generation
    JOIN ${table(tx, 'tf_slack_installations')} i ON i.id=p.installation_id AND i.generation=p.generation
    JOIN ${table(tx, 'tf_agents')} g ON g.id=a.agent_id
    JOIN ${table(tx, 'tf_agent_activations')} x ON x.id=a.activation_id AND x.agent_id=a.agent_id AND x.definition_revision=a.definition_revision
    WHERE a.id=$1 AND a.agent_id=$2 AND a.user_id=$3 AND a.membership_id=$4 AND a.kind='delegated' AND a.schedule_id IS NULL AND a.task_id IS NULL
      AND a.status IN ('ready','running','waiting') AND g.enabled AND g.saved_revision IS NOT NULL AND g.deleted_at IS NULL AND x.revoked_at IS NULL
      AND r.channel ~ '^[CG]' AND t.request_snapshot->>'channel'=r.channel AND e.payload->>'channel'=r.channel
      AND t.request_snapshot->>'user'=p.slack_user_id AND e.payload->>'user'=p.slack_user_id AND e.disposition='held'
      AND p.user_id=a.user_id AND p.membership_id=a.membership_id AND p.state='authorized' AND p.credential IS NOT NULL
      AND i.state='active' AND i.bot_credential IS NOT NULL AND 'chat:write'=ANY(i.scopes)
      AND NOT EXISTS (SELECT 1 FROM ${table(tx, 'tf_slack_user_revocations')} revoked WHERE revoked.installation_id=i.id AND revoked.generation=i.generation AND revoked.slack_user_id=p.slack_user_id)
      AND EXISTS (SELECT 1 FROM ${table(tx, 'tf_slack_installation_grants')} grant_use WHERE grant_use.installation_id=i.id
        AND (grant_use.membership_id=$4 OR EXISTS (SELECT 1 FROM ${table(tx, 'tf_member_teams')} mt WHERE mt.team_id=grant_use.team_id AND mt.membership_id=$4)))`,
    [runId, agentId, actor.userId, actor.membershipId],
  );
  if (!allowed.rowCount) throw new AccessDenied();
}

export async function requireSkillGrant(
  tx: AuthorizationTransaction,
  actor: HumanActor,
  skillId: string,
  permission: SkillPermission,
) {
  await currentMember(tx, actor);
  const predicate = definitionGrantPredicate(tx, 'skill', 's.id', '$2', '$3');
  if (
    !(
      await tx.client.query(`SELECT 1 FROM ${table(tx, 'tf_workspace_skills')} s WHERE s.id=$1 AND ${predicate}`, [
        skillId,
        actor.membershipId,
        permission,
      ])
    ).rowCount
  )
    throw new AccessDenied();
}

export async function canManageSkill(tx: AuthorizationTransaction, actor: HumanActor, skillId: string) {
  try {
    await requireSkillGrant(tx, actor, skillId, 'manage');
    return true;
  } catch (error) {
    if (error instanceof AccessDenied) return false;
    throw error;
  }
}

const runSchema = z.object({
  kind: z.enum(['delegated', 'scheduled']),
  membership_id: z.uuid().nullable(),
  user_id: z.string().nullable(),
  agent_id: z.uuid(),
});

// A delegated run belongs to its requester. A scheduled run is visible only to its recorded audience.
export async function requireAgentRunHistory(tx: AuthorizationTransaction, actor: HumanActor, runId: string) {
  const member = await currentMember(tx, actor);
  const run = runSchema
    .optional()
    .parse(
      (
        await tx.client.query(
          `SELECT kind,membership_id,user_id,agent_id FROM ${table(tx, 'tf_agent_runs')} WHERE id=$1`,
          [runId],
        )
      ).rows[0],
    );
  if (!run) throw new AccessDenied();
  if (run.kind === 'delegated') {
    if (run.membership_id !== member.id || run.user_id !== actor.userId) throw new AccessDenied();
    return;
  }
  await requireAgentGrant(tx, actor, run.agent_id, 'invoke');
  if (
    !(
      await tx.client.query(
        `SELECT 1 FROM ${table(tx, 'tf_agent_run_audience')} WHERE run_id=$1 AND membership_id=$2`,
        [runId, actor.membershipId],
      )
    ).rowCount
  )
    throw new AccessDenied();
}
