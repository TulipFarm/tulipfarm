import { z } from 'zod';
import type { AuthorizationTransaction, HumanActor } from '@tulipfarm/access';
import {
  learnedKnowledgePrompt,
  learnedKnowledgeVersion,
  learnedParts,
  learnedRequest,
  parseLearnedEntries,
  type LearnedKnowledge,
} from '@tulipfarm/knowledge';
import { CreditsExhausted } from '@tulipfarm/workspace-storage/credits';
import { qualified } from '@tulipfarm/workspace-storage/runtime';
import type { MaintenanceFence } from './maintenance-contracts.ts';
import type { ConversationCompactor, EffectiveCompactionPolicy } from './compaction.ts';

/** Saves business facts to the member's Knowledge. Absent where the worker does not provide it. */
export type LearnedKnowledgePort = Pick<LearnedKnowledge, 'entries' | 'apply'>;

type KnowledgeTransaction = <T>(
  operation: (
    tx: AuthorizationTransaction,
    current: { actor: HumanActor; coveredThrough: number | null; policy: EffectiveCompactionPolicy | null },
  ) => Promise<T>,
) => Promise<T>;

const table = (tx: AuthorizationTransaction, name: string) => qualified(tx.schema, name);
export const knowledgeLearningInstalled = (tx: AuthorizationTransaction) =>
  Number((tx as { commonVersion?: number }).commonVersion ?? 0) >= learnedKnowledgeVersion;
const messagesSchema = z.array(z.object({ id: z.uuid(), text: z.string() }));

async function complete(tx: AuthorizationTransaction, jobId: string) {
  await tx.client.query(`UPDATE ${table(tx, 'tf_conversation_maintenance')} SET knowledge_complete=true WHERE id=$1`, [
    jobId,
  ]);
}

/** The member's own messages this job covers that no earlier learning pass read. */
async function requesterMessages(
  tx: AuthorizationTransaction,
  fence: MaintenanceFence,
  actor: HumanActor,
  through: number | null,
) {
  return messagesSchema.parse(
    (
      await tx.client.query(
        `SELECT m.id, string_agg(p.text,E'\n' ORDER BY p.ordinal) AS text
      FROM ${table(tx, 'tf_conversation_messages')} m
      JOIN ${table(tx, 'tf_conversation_parts')} p ON p.message_id=m.id AND p.kind IN ('text','layout')
      JOIN ${table(tx, 'tf_conversation_turns')} t ON t.source_message_id=m.id
      WHERE m.conversation_id=$1 AND m.author_kind='human' AND m.membership_id=$2 AND t.accepted_sequence<=$3
        AND t.accepted_sequence>COALESCE((SELECT max(covered_through) FROM ${table(tx, 'tf_conversation_maintenance')}
          WHERE conversation_id=$1 AND generation<$4 AND knowledge_complete),0)
        AND NOT EXISTS (SELECT 1 FROM ${table(tx, 'tf_internal_publications')} i WHERE i.message_id=m.id)
      GROUP BY m.id,m.sequence ORDER BY m.sequence`,
        [fence.conversationId, actor.membershipId, through, fence.generation],
      )
    ).rows,
  );
}

/**
 * Background learning of business facts from a member's private chat, after personal memory. It reads only the
 * member's own messages in a chat they own and saves facts as Learned notes in their own Knowledge, so nobody sees an
 * entry who could not see its source. One part of the chat per call; returns whether the chat is done.
 */
export async function reconcileMaintenanceKnowledge(
  transaction: KnowledgeTransaction,
  fence: MaintenanceFence,
  compactor: ConversationCompactor,
  learned: LearnedKnowledgePort | undefined,
  options: { shouldLearn?: (workspaceId: string, content: string) => Promise<boolean> } = {},
): Promise<boolean> {
  const input = await transaction(async (tx, current) => {
    if (!knowledgeLearningInstalled(tx)) return { kind: 'done' } as const;
    const progress = z
      .object({ knowledge_complete: z.boolean(), knowledge_chunk: z.number().int() })
      .parse(
        (
          await tx.client.query(
            `SELECT knowledge_complete,knowledge_chunk FROM ${table(tx, 'tf_conversation_maintenance')} WHERE id=$1`,
            [fence.jobId],
          )
        ).rows[0],
      );
    if (progress.knowledge_complete) return { kind: 'done' } as const;
    const owner = z
      .object({ owner_membership_id: z.uuid().nullable() })
      .parse(
        (
          await tx.client.query(`SELECT owner_membership_id FROM ${table(tx, 'tf_conversations')} WHERE id=$1`, [
            fence.conversationId,
          ])
        ).rows[0],
      );
    if (!learned || owner.owner_membership_id !== current.actor.membershipId) {
      await complete(tx, fence.jobId);
      return { kind: 'done' } as const;
    }
    const parts = learnedParts(await requesterMessages(tx, fence, current.actor, current.coveredThrough));
    const part = parts[progress.knowledge_chunk];
    if (part === undefined) {
      await complete(tx, fence.jobId);
      return { kind: 'done' } as const;
    }
    const policy = current.policy ?? (await compactor.policy(tx));
    return {
      kind: 'generate',
      actor: current.actor,
      part,
      chunk: progress.knowledge_chunk,
      last: progress.knowledge_chunk + 1 === parts.length,
      families: policy.families,
    } as const;
  });
  if (input.kind === 'done') return true;
  if (
    options.shouldLearn &&
    !(await options.shouldLearn(fence.workspaceId, input.part.map(message => message.text).join('\n\n')))
  ) {
    return transaction(async tx => {
      await tx.client.query(
        `UPDATE ${table(tx, 'tf_conversation_maintenance')} SET knowledge_chunk=$2,knowledge_complete=$3 WHERE id=$1`,
        [fence.jobId, input.chunk + 1, input.last],
      );
      return input.last;
    });
  }
  const port = learned!;
  try {
    const entries = await port.entries(fence.workspaceId, input.actor.userId);
    const response = await compactor.summarize({
      fence,
      purpose: 'knowledge',
      step: input.chunk,
      families: input.families,
      system: learnedKnowledgePrompt,
      messages: [{ role: 'user', text: learnedRequest(entries, input.part) }],
    });
    await port.apply(
      fence.workspaceId,
      input.actor.userId,
      { kind: 'chat', id: fence.conversationId, runId: null },
      `chat:${fence.jobId}:${input.chunk}`,
      parseLearnedEntries(response.text, input.part),
    );
  } catch (error) {
    // Without credits or a model the chat is not read for facts; maintenance carries on.
    if (
      !(error instanceof CreditsExhausted) &&
      !(error instanceof Error && error.message === 'compaction-model-unavailable')
    )
      throw error;
    return transaction(async tx => {
      await complete(tx, fence.jobId);
      return true;
    });
  }
  return transaction(async tx => {
    await tx.client.query(
      `UPDATE ${table(tx, 'tf_conversation_maintenance')} SET knowledge_chunk=$2,knowledge_complete=$3 WHERE id=$1`,
      [fence.jobId, input.chunk + 1, input.last],
    );
    await tx.client.query(
      `DELETE FROM ${table(tx, 'tf_conversation_maintenance_steps')} WHERE job_id=$1 AND purpose='knowledge' AND step=$2`,
      [fence.jobId, input.chunk],
    );
    return input.last;
  });
}
