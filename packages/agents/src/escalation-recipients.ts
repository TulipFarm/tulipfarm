import { z } from 'zod';
import type { HumanActor } from '@tulipfarm/access';
import { uuidSchema } from '@tulipfarm/access/contracts';
import { relationInstalled } from '@tulipfarm/workspace-storage/transaction-reads';
import { agentDefinitionSchema, type AgentEscalationPolicy } from './contracts.ts';
import { relation, type AgentTransaction } from './store.ts';

/**
 * Resolves active workspace membership IDs that should receive an escalation or clarification.
 * Falls back to `[sponsorMembershipId]` when no targets are configured or none are active.
 */
export async function resolveEscalationRecipients(
  tx: AgentTransaction,
  sponsorMembershipId: string,
  escalationPolicy?: AgentEscalationPolicy,
): Promise<string[]> {
  const recipients: string[] = [];
  const seen = new Set<string>();
  const add = (id: string) => {
    if (!seen.has(id)) {
      seen.add(id);
      recipients.push(id);
    }
  };

  if (escalationPolicy?.targetMembershipIds?.length) {
    const active = z.array(z.object({ id: uuidSchema })).parse(
      (
        await tx.client.query(
          `SELECT id FROM ${relation(tx, 'tf_memberships')}
           WHERE id = ANY($1::uuid[]) AND removed_at IS NULL`,
          [escalationPolicy.targetMembershipIds],
        )
      ).rows,
    );
    const activeSet = new Set(active.map(row => row.id));
    for (const id of escalationPolicy.targetMembershipIds) {
      if (activeSet.has(id)) add(id);
    }
  }

  if (escalationPolicy?.targetTeamId) {
    const teamMembers = z.array(z.object({ id: uuidSchema })).parse(
      (
        await tx.client.query(
          `SELECT m.id
           FROM ${relation(tx, 'tf_member_teams')} mt
           JOIN ${relation(tx, 'tf_memberships')} m ON m.id = mt.membership_id
           WHERE mt.team_id = $1 AND m.removed_at IS NULL
           ORDER BY m.id ASC`,
          [escalationPolicy.targetTeamId],
        )
      ).rows,
    );
    for (const member of teamMembers) add(member.id);
  }

  return recipients.length > 0 ? recipients : [sponsorMembershipId];
}

export async function loadAgentEscalationPolicy(
  tx: AgentTransaction,
  agentId: string,
  revision?: string,
): Promise<AgentEscalationPolicy | undefined> {
  if (!(await relationInstalled(tx.client, relation(tx, 'tf_agent_definitions')))) return undefined;
  let definitionRow: { definition?: unknown } | undefined;
  if (revision) {
    definitionRow = (
      await tx.client.query(
        `SELECT definition FROM ${relation(tx, 'tf_agent_definitions')}
         WHERE agent_id = $1 AND revision = $2`,
        [agentId, revision],
      )
    ).rows[0] as { definition?: unknown } | undefined;
  } else {
    definitionRow = (
      await tx.client.query(
        `SELECT d.definition
         FROM ${relation(tx, 'tf_agent_activations')} a
         JOIN ${relation(tx, 'tf_agent_definitions')} d
           ON d.agent_id = a.agent_id AND d.revision = a.definition_revision
         WHERE a.agent_id = $1 AND a.revoked_at IS NULL AND a.superseded_at IS NULL
         ORDER BY a.activated_at DESC
         LIMIT 1`,
        [agentId],
      )
    ).rows[0] as { definition?: unknown } | undefined;
    if (!definitionRow) {
      definitionRow = (
        await tx.client.query(
          `SELECT definition FROM ${relation(tx, 'tf_agent_definitions')}
           WHERE agent_id = $1
           ORDER BY created_at DESC
           LIMIT 1`,
          [agentId],
        )
      ).rows[0] as { definition?: unknown } | undefined;
    }
  }
  const parsed = agentDefinitionSchema.safeParse(definitionRow?.definition);
  return parsed.success ? parsed.data.escalationPolicy : undefined;
}

export function hasExplicitEscalationTargets(policy?: AgentEscalationPolicy): boolean {
  return Boolean(policy?.targetMembershipIds?.length || policy?.targetTeamId);
}

export async function isAuthorizedEscalationResponder(
  tx: AgentTransaction,
  actor: HumanActor,
  input: {
    sponsorMembershipId: string;
    agentId: string;
    definitionRevision?: string;
    tableId?: string;
    rowId?: string;
    sourceId?: string;
  },
): Promise<{ authorized: boolean; hasExplicitTargets: boolean }> {
  const policy = await loadAgentEscalationPolicy(tx, input.agentId, input.definitionRevision);
  const explicit = hasExplicitEscalationTargets(policy);
  if (actor.membershipId === input.sponsorMembershipId) {
    return { authorized: true, hasExplicitTargets: explicit };
  }
  if (await relationInstalled(tx.client, relation(tx, 'tf_inbox_items'))) {
    const openInbox = (
      await tx.client.query(
        `SELECT 1 FROM ${relation(tx, 'tf_inbox_items')}
         WHERE membership_id = $1
           AND kind = 'waiting'
           AND resolved_at IS NULL
           AND (
             ($2::uuid IS NOT NULL AND $3::uuid IS NOT NULL AND table_id = $2 AND row_id = $3)
             OR ($4::uuid IS NOT NULL AND source_id = $4)
           )
         LIMIT 1`,
        [actor.membershipId, input.tableId ?? null, input.rowId ?? null, input.sourceId ?? null],
      )
    ).rowCount;
    if (openInbox) return { authorized: true, hasExplicitTargets: explicit };
  }
  if (explicit && policy) {
    const recipients = await resolveEscalationRecipients(tx, input.sponsorMembershipId, policy);
    if (recipients.includes(actor.membershipId)) {
      return { authorized: true, hasExplicitTargets: true };
    }
  }
  return { authorized: false, hasExplicitTargets: explicit };
}
