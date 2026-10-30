import { z } from 'zod';
import {
  AccessDenied,
  currentMember,
  lockAuthorization,
  protectedSourceClosure,
  requirePersonalMemorySource,
  requireProtectedSource,
  sourceDependenciesSchema,
  type HumanActor,
  type SourceDependency,
} from '@tulipfarm/access';
import { canonicalJson } from '@tulipfarm/tables/canonical';
import { relation, type AgentTransaction } from './store.ts';
import { requireAgentPermission } from './saved-policy.ts';
import { requireNoMcpDerived } from '@tulipfarm/access';

/**
 * `ownMemory` accepts the actor's own personal memory anywhere in the closure; only row drafts set it. `slackTurn`
 * checks a Slack thread in the closure against its current audience; without it a Slack thread is refused.
 */
export async function requireDraftSources(
  tx: AgentTransaction,
  actor: HumanActor,
  sources: readonly SourceDependency[],
  visited = new Set<string>(),
  runId?: string,
  publicOnly = false,
  ownMemory = false,
  slackTurn?: (eventId: string) => Promise<void>,
): Promise<void> {
  await currentMember(tx, actor);
  await lockAuthorization(tx);
  for (const source of await protectedSourceClosure(tx, sources)) {
    const key = canonicalJson(source);
    if (visited.has(key)) continue;
    visited.add(key);
    if (ownMemory && source.kind === 'personal-memory') await requirePersonalMemorySource(tx, actor, source);
    else if (slackTurn && source.kind === 'shared-slack-turn') await slackTurn(source.eventId);
    else await requireProtectedSource(tx, actor, source, runId, publicOnly);
    if (source.kind === 'agent-definition') await requireAgentPermission(tx, actor, source.agentId, 'read');
  }
}

export async function requireTaskDefinitionSources(
  tx: AgentTransaction,
  owner: HumanActor,
  taskId: string,
  runId?: string,
) {
  const task = z
    .object({
      agent_id: z.uuid(),
      definition_revision: z.string(),
      skills: z.array(z.object({ id: z.string(), revision: z.string() })),
    })
    .parse(
      (
        await tx.client.query(
          `SELECT agent_id,definition_revision,skills FROM ${relation(tx, 'tf_agent_tasks')} WHERE id=$1`,
          [taskId],
        )
      ).rows[0],
    );
  const skills: SourceDependency[] = task.skills.flatMap(skill =>
    z.uuid().safeParse(skill.id).success
      ? [{ kind: 'workspace-skill' as const, skillId: skill.id, revision: skill.revision }]
      : [],
  );
  await requireDraftSources(tx, owner, skills, new Set(), runId);
  const definitions = await tx.client.query(
    `SELECT d.sources FROM ${relation(tx, 'tf_chat_authoring_drafts')} d JOIN ${relation(tx, 'tf_chat_authoring_decisions')} c ON c.draft_id=d.id JOIN ${relation(tx, 'tf_agent_commands')} a ON a.id::text=c.outcome->'receipt'->>'commandId' JOIN ${relation(tx, 'tf_agent_saved_revisions')} s ON s.agent_id=a.agent_id AND s.soul_revision=a.accepted_revision WHERE a.agent_id=$1 AND s.definition_revision=$2 AND c.outcome->>'kind'='agent'`,
    [task.agent_id, task.definition_revision],
  );
  for (const row of definitions.rows)
    await requireDraftSources(tx, owner, sourceDependenciesSchema.parse(row.sources), new Set(), runId);
}

export async function requireCommandDraftSources(tx: AgentTransaction, actor: HumanActor, commandId: string) {
  const rows = await tx.client.query(
    `SELECT d.sources,d.conversation_id,d.membership_id,d.user_id FROM ${relation(tx, 'tf_chat_authoring_drafts')} d JOIN ${relation(tx, 'tf_chat_authoring_decisions')} c ON c.draft_id=d.id WHERE c.outcome->>'kind'='agent' AND c.outcome->'receipt'->>'commandId'=$1`,
    [commandId],
  );
  for (const row of rows.rows) {
    if (row.membership_id !== actor.membershipId || row.user_id !== actor.userId) throw new AccessDenied();
    await requireNoMcpDerived(tx, row.sources);
    await requireDraftSources(tx, actor, [
      { kind: 'private-conversation', conversationId: z.uuid().parse(row.conversation_id) },
      ...sourceDependenciesSchema.parse(row.sources),
    ]);
  }
}
