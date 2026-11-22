import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AuthorizationTransaction, HumanActor } from '@tulipfarm/access';
import { transcriptChunks } from '@tulipfarm/memory-core/memory/transcript';
import {
  createPostgresMemoryReconciliationRepository,
  createPostgresTranscriptSource,
} from '@tulipfarm/memory-postgres';
import { recordRecommendationChange } from '@tulipfarm/workspace-storage/recommendations';
import type { MaintenanceFence } from './maintenance-contracts.ts';
import type { ConversationCompactor, EffectiveCompactionPolicy } from './compaction.ts';
import { personalMemoryMode, PersonalMemoryUnavailable } from './keep-personal-memory.ts';
import { lastDirectMemoryChange, lockMemoryLearning, memoryLearningInstalled } from './memory-learning.ts';
import {
  applyFileEdits,
  listMemoryFiles,
  memoryEditFormat,
  memoryFingerprint,
  memoryForModel,
  parseFileEdits,
} from './memory-files.ts';

/** The most edits one transcript chunk may make. */
const learningEdits = 5;

export const learningSystemPrompt = [
  "Update the current user's personal memory from what they said in this chat, so Bud knows them better next time.",
  'The edits apply at once, without review. Save only durable facts the user stated about themselves, including their personal interests, likes and hobbies, how they want Bud to respond, their work, recurring subjects, ongoing responsibilities and the people they work with.',
  'Do not save one-off requests, task details, completed work, chat summaries, quoted or pasted third-party text, or anything only the assistant said.',
  memoryEditFormat,
  'Every edit must also have "messageId" (UUID of the requester message) and "quote" (exact wording from that message). Never cite assistant or tool output.',
  'A newer statement that conflicts with saved memory is a change. A request to forget something is a remove. Avoid duplicates of what is already saved.',
  `Make at most ${learningEdits} edits. If nothing should change, return {"edits":[]}.`,
].join('\n');

type MemoryTransaction = <T>(
  operation: (
    tx: AuthorizationTransaction,
    current: {
      actor: HumanActor;
      coveredThrough: number | null;
      policy: EffectiveCompactionPolicy | null;
    },
  ) => Promise<T>,
) => Promise<T>;

const repository = (tx: AuthorizationTransaction) =>
  createPostgresMemoryReconciliationRepository(tx.client, { schema: tx.schema, tablePrefix: 'tf_' });
const transcriptSource = (tx: AuthorizationTransaction) =>
  createPostgresTranscriptSource(tx.client, { schema: tx.schema, tablePrefix: 'tf_' });
const progressSchema = z.object({
  memory_complete: z.boolean(),
  memory_chunk: z.number().int(),
  memory_step: z.number().int(),
  memory_base_revision: z.number().int().nullable(),
  memory_manual_at: z.string().nullable(),
});
const messagesSchema = z.array(
  z.object({ id: z.uuid(), text: z.string(), createdAt: z.string(), acceptedSequence: z.number().int() }),
);

async function keepFor(tx: AuthorizationTransaction, actor: HumanActor) {
  let mode;
  try {
    mode = personalMemoryMode(tx, actor);
  } catch (error) {
    if (error instanceof PersonalMemoryUnavailable) return undefined;
    throw error;
  }
  return (await memoryLearningInstalled(tx)) ? mode : undefined;
}

/**
 * Background learning for a member's private chat: it applies edits that cite the member's own words straight to their
 * memory files. It restarts when memory changes while the model is asked. Without a Keep endpoint nothing is learned.
 */
export async function reconcileMaintenanceMemory(
  transaction: MemoryTransaction,
  fence: MaintenanceFence,
  compactor: ConversationCompactor,
): Promise<boolean> {
  const input = await transaction(async (tx, current) => {
    const keep = await keepFor(tx, current.actor);
    const progress = progressSchema.parse((await repository(tx).progress([fence.jobId])).rows[0]);
    if (progress.memory_complete) return { kind: 'done' } as const;
    const owner = (await repository(tx).owner([fence.conversationId])).rows[0]!;
    if (!keep || owner.project_id !== null || owner.owner_membership_id !== current.actor.membershipId) {
      await repository(tx).complete([fence.jobId]);
      return { kind: 'done' } as const;
    }
    const revision = memoryFingerprint(await listMemoryFiles(keep));
    const manualAt = await lastDirectMemoryChange(tx, current.actor);
    let chunk = progress.memory_chunk,
      step = progress.memory_step;
    if (manualAt !== progress.memory_manual_at) {
      chunk = 0;
      step++;
    }
    if (progress.memory_base_revision !== null && progress.memory_base_revision !== revision) step++;
    const messages = messagesSchema.parse(
      (
        await transcriptSource(tx).requesterMessages([
          fence.conversationId,
          current.actor.membershipId,
          current.coveredThrough,
          manualAt,
          fence.generation,
        ])
      ).rows,
    );
    const chunks = transcriptChunks(
      messages.map(message => ({ ...message, role: 'user' as const })),
      12000,
    );
    const transcript = chunks[chunk];
    if (transcript === undefined) {
      await repository(tx).completeEmpty([fence.jobId]);
      return { kind: 'done' } as const;
    }
    await repository(tx).saveProgress([fence.jobId, chunk, step, revision, manualAt, null]);
    const policy = current.policy ?? (await compactor.policy(tx));
    return {
      kind: 'generate',
      memory: await memoryForModel(keep),
      revision,
      manualAt,
      transcript,
      messages: messages.filter(message => transcript.includes(`id="${message.id}"`)),
      chunk,
      step,
      last: chunk + 1 === chunks.length,
      families: policy.families,
    } as const;
  });
  if (input.kind === 'done') return true;
  const response = await compactor.summarize({
    fence,
    purpose: 'memory',
    step: input.step,
    families: input.families,
    system: learningSystemPrompt,
    messages: [
      { role: 'user', text: JSON.stringify({ currentMemory: input.memory, requesterTranscript: input.transcript }) },
    ],
  });
  const edits = parseFileEdits(response.text, {
    kind: 'learning',
    maximum: learningEdits,
    transcript: input.transcript,
    messages: input.messages,
  });
  return transaction(async (tx, { actor }) => {
    const keep = await keepFor(tx, actor);
    if (!keep) {
      await repository(tx).clearStep([fence.jobId]);
      await repository(tx).complete([fence.jobId]);
      return true;
    }
    // Under the lock a concurrent change or forget has either committed, and is seen below, or waits for this one.
    await lockMemoryLearning(tx, actor);
    // Memory changed meanwhile: learn again against what the member has now.
    if (
      memoryFingerprint(await listMemoryFiles(keep)) !== input.revision ||
      (await lastDirectMemoryChange(tx, actor)) !== input.manualAt
    ) {
      await repository(tx).clearStep([fence.jobId]);
      await repository(tx).restart([fence.jobId]);
      return false;
    }
    const changes = await applyFileEdits(keep, edits);
    if (changes.length > 0)
      await recordRecommendationChange(tx, {
        id: randomUUID(),
        kind: 'memory',
        sourceId: actor.membershipId,
        membershipIds: [actor.membershipId],
        invalidate: true,
      });
    await repository(tx).finish([fence.jobId, input.chunk + 1, input.step + 1, input.last]);
    await repository(tx).clearStep([fence.jobId]);
    return input.last;
  });
}
