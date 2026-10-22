import { escapeIdentifier } from 'pg';
import { z } from 'zod';
import {
  AccessDenied,
  currentMember,
  lockAuthorization,
  type AuthorizationTransaction,
  type HumanActor,
} from './index.ts';
import { mcpSourceDependencySchema } from './source-dependencies.ts';

const table = (tx: AuthorizationTransaction, name: string) =>
  `${escapeIdentifier(tx.schema)}.${escapeIdentifier(name)}`;

export async function requireMcpSource(
  tx: AuthorizationTransaction,
  actor: HumanActor,
  input: z.infer<typeof mcpSourceDependencySchema>,
) {
  const source = mcpSourceDependencySchema.parse(input);
  await lockAuthorization(tx);
  await currentMember(tx, actor);
  const installed = z
    .object({ installed: z.boolean() })
    .parse(
      (await tx.client.query('SELECT to_regclass($1) IS NOT NULL AS installed', [table(tx, 'tf_mcp_integrations')]))
        .rows[0],
    ).installed;
  if (!installed) throw new AccessDenied();
  const allowed = await tx.client.query(
    `SELECT c.id FROM ${table(tx, 'tf_mcp_integrations')} c
    WHERE c.id=$1 AND c.authorization_epoch=$2 AND c.lifecycle='active' AND c.credential IS NOT NULL
      AND ((c.ownership='personal' AND c.owner_membership_id=$3)
        OR (c.ownership='shared' AND (
          EXISTS (SELECT 1 FROM ${table(tx, 'tf_mcp_member_grants')} g WHERE g.integration_id=c.id AND g.membership_id=$3)
          OR EXISTS (SELECT 1 FROM ${table(tx, 'tf_mcp_team_grants')} g JOIN ${table(tx, 'tf_member_teams')} m ON m.team_id=g.team_id WHERE g.integration_id=c.id AND m.membership_id=$3))))
    FOR SHARE OF c`,
    [source.integrationId, source.authorizationEpoch, actor.membershipId],
  );
  if (!allowed.rowCount) throw new AccessDenied();
}

export async function requireMcpTaskRun(tx: AuthorizationTransaction, actor: HumanActor, runId: string) {
  const allowed = await tx.client.query(
    `SELECT r.id FROM ${table(tx, 'tf_agent_runs')} r
    JOIN ${table(tx, 'tf_agent_task_runs')} b ON b.run_id=r.id
    JOIN ${table(tx, 'tf_agent_tasks')} t ON t.id=b.task_id
    WHERE r.id=$1 AND r.kind='delegated' AND r.schedule_id IS NULL
      AND r.user_id=$2 AND r.membership_id=$3 AND t.owner_user_id=$2 AND t.owner_membership_id=$3
      AND b.generation=t.generation`,
    [runId, actor.userId, actor.membershipId],
  );
  if (!allowed.rowCount) throw new AccessDenied();
}

export async function requirePrivateTaskSource(tx: AuthorizationTransaction, actor: HumanActor, taskId: string) {
  await currentMember(tx, actor);
  if (
    !(
      await tx.client.query(
        `SELECT id FROM ${table(tx, 'tf_agent_tasks')} WHERE id=$1 AND owner_user_id=$2 AND owner_membership_id=$3`,
        [taskId, actor.userId, actor.membershipId],
      )
    ).rowCount
  )
    throw new AccessDenied();
}

export async function requireSharedMcpSlots(tx: AuthorizationTransaction, definition: unknown) {
  const { mcp } = z
    .object({ mcp: z.array(z.object({ integrationId: z.uuid().optional(), serverIdentity: z.string() })).optional() })
    .parse(definition);
  for (const slot of mcp ?? [])
    if (slot.integrationId) {
      if (
        !(
          await tx.client.query(
            `SELECT id FROM ${table(tx, 'tf_mcp_integrations')} WHERE id=$1 AND ownership='shared' AND server_identity=$2`,
            [slot.integrationId, slot.serverIdentity],
          )
        ).rowCount
      )
        throw new AccessDenied();
    }
}

export async function requireMcpPrivateConversation(
  tx: AuthorizationTransaction,
  actor: HumanActor,
  conversationId: string,
) {
  const allowed = await tx.client.query(
    `SELECT id FROM ${table(tx, 'tf_conversations')} WHERE id=$1 AND kind='private' AND owner_user_id=$2 AND owner_membership_id=$3`,
    [conversationId, actor.userId, actor.membershipId],
  );
  if (!allowed.rowCount) throw new AccessDenied();
  for (const name of ['tf_slack_dm_roots', 'tf_slack_default_turns']) {
    const installed = z
      .object({ installed: z.boolean() })
      .parse(
        (await tx.client.query('SELECT to_regclass($1) IS NOT NULL AS installed', [table(tx, name)])).rows[0],
      ).installed;
    if (
      installed &&
      (await tx.client.query(`SELECT 1 FROM ${table(tx, name)} WHERE conversation_id=$1`, [conversationId])).rowCount
    )
      throw new AccessDenied();
  }
}
