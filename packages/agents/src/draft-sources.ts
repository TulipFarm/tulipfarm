import { z } from 'zod';
import {
  AccessDenied,
  canAccessTable,
  chatReviewClosure,
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
 * `ownMemory` accepts the actor's own personal memory anywhere in the closure; chat drafts set it. `slackTurn`
 * checks a Slack thread in the closure against its current audience; without it a Slack thread is refused.
 * `chatReview` checks the closure a chat review card depends on (see `chatReviewClosure`); chat drafts set it.
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
  privateConversation?: (source: SourceDependency) => Promise<void>,
  chatReview = false,
  readOnly = false,
): Promise<void> {
  await currentMember(tx, actor);
  await lockAuthorization(tx);
  for (const source of chatReview
    ? await chatReviewClosure(tx, actor, sources)
    : await protectedSourceClosure(tx, sources)) {
    const key = canonicalJson(source);
    if (visited.has(key)) continue;
    visited.add(key);
    if (ownMemory && source.kind === 'personal-memory') await requirePersonalMemorySource(tx, actor, source);
    else if (slackTurn && source.kind === 'shared-slack-turn') await slackTurn(source.eventId);
    else if (privateConversation && source.kind === 'private-conversation') await privateConversation(source);
    else await requireProtectedSource(tx, actor, source, runId, publicOnly, readOnly);
    if (source.kind === 'agent-definition') await requireAgentPermission(tx, actor, source.agentId, 'read');
  }
}

/** A saved workflow or skill. One saved from a chat that read personal memory keeps that memory as a source. */
const savedDefinitionSource = (source: SourceDependency) =>
  source.kind === 'workflow-definition' || source.kind === 'workspace-skill';

/**
 * Checks sources like requireDraftSources, but a saved workflow or skill may also carry the actor's own personal memory:
 * only the member whose memory a definition was saved with may read it. Another member's memory is refused with
 * PersonalMemoryDenied. `ownMemory` still governs memory reached through any other source, and a public-only check
 * never accepts personal memory.
 */
export async function requireOwnDefinitionSources(
  tx: AgentTransaction,
  actor: HumanActor,
  sources: readonly SourceDependency[],
  ownMemory = false,
  publicOnly = false,
) {
  const visited = new Set<string>();
  const definitions = sources.filter(savedDefinitionSource);
  await requireDraftSources(
    tx,
    actor,
    sources.filter(source => !savedDefinitionSource(source)),
    visited,
    undefined,
    publicOnly,
    ownMemory,
  );
  if (definitions.length)
    await requireDraftSources(tx, actor, definitions, visited, undefined, publicOnly, !publicOnly);
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
  for (const row of definitions.rows) {
    const sources = sourceDependenciesSchema.parse(row.sources);
    // A chat draft retains the schema of every table in the requester's workspace inventory. The reviewed definition
    // keeps a table's schema only while the task owner can still see that table; it neither pins the table's
    // revision nor requires the agent's run to read its rows.
    const schemas = (await protectedSourceClosure(tx, sources)).filter(source => source.kind === 'table-schema');
    await requireDraftSources(tx, owner, sources, new Set(schemas.map(source => canonicalJson(source))), runId);
    for (const tableId of new Set(schemas.map(source => source.tableId)))
      if (
        !(
          (await tx.client.query(`SELECT 1 FROM ${relation(tx, 'tf_table_catalog')} WHERE id=$1`, [tableId]))
            .rowCount &&
          ((await canAccessTable(tx, owner, tableId, 'table.row.read')) ||
            (await canAccessTable(tx, owner, tableId, 'table.schema.manage')))
        )
      )
        throw new AccessDenied();
  }
}

export async function requireCommandDraftSources(tx: AgentTransaction, actor: HumanActor, commandId: string) {
  const rows = await tx.client.query(
    `SELECT d.sources,d.conversation_id,d.membership_id,d.user_id FROM ${relation(tx, 'tf_chat_authoring_drafts')} d JOIN ${relation(tx, 'tf_chat_authoring_decisions')} c ON c.draft_id=d.id WHERE c.outcome->>'kind'='agent' AND c.outcome->'receipt'->>'commandId'=$1`,
    [commandId],
  );
  for (const row of rows.rows) {
    if (row.membership_id !== actor.membershipId || row.user_id !== actor.userId) throw new AccessDenied();
    await requireNoMcpDerived(tx, row.sources);
    // A chat draft records the memory its turn read; the draft's own author may still save from it.
    await requireDraftSources(
      tx,
      actor,
      [
        { kind: 'private-conversation', conversationId: z.uuid().parse(row.conversation_id) },
        ...sourceDependenciesSchema.parse(row.sources),
      ],
      new Set(),
      undefined,
      false,
      true,
    );
  }
}
