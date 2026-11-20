import { z } from 'zod';
import type { AuthorizationTransaction, HumanActor } from '@tulipfarm/access';
import { createMemoryReconciliation } from '@tulipfarm/memory-core/memory/reconciliation';
import { transcriptChunks } from '@tulipfarm/memory-core/memory/transcript';
import {
  createPostgresMemoryReconciliationRepository,
  createPostgresTranscriptSource,
} from '@tulipfarm/memory-postgres';
import type { MaintenanceFence } from './maintenance-contracts.ts';
import type { ConversationCompactor, EffectiveCompactionPolicy } from './compaction.ts';
import { legacyPersonalMemory, personalMemoryMode } from './personal-memory.ts';
import { keepRevision, readKeepProfile } from './keep-personal-memory.ts';
import {
  lastDirectMemoryChange,
  memoryProposalsInstalled,
  parseMemoryEdits,
  proposalSystemPrompt,
  saveMemoryProposals,
} from './memory-proposals.ts';
export { preferenceSystemPrompt, parsePreferenceReconciliation } from '@tulipfarm/memory-core/memory/reconciliation';
export { parseMemoryEdits, proposalSystemPrompt } from './memory-proposals.ts';

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
const reconcile = createMemoryReconciliation<AuthorizationTransaction>({
  memory: legacyPersonalMemory,
  repository,
  transcript: tx => transcriptSource(tx),
});
/**
 * Background learning for a member's private chat. With Keep, it never writes memory: it saves suggested edits, bound
 * to the profile revision they were made against, for the member to confirm. Hidden memory is not learned from at all.
 */
export async function reconcileMaintenanceMemory(
  transaction: MemoryTransaction,
  fence: MaintenanceFence,
  compactor: ConversationCompactor,
): Promise<boolean> {
  const mode = await transaction(async (tx, current) => (await personalMemoryMode(tx, current.actor)).kind);
  if (mode === 'legacy') return reconcile<MaintenanceFence>(transaction, fence, compactor);
  return proposeMaintenanceMemory(transaction, fence, compactor);
}

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
  const mode = await personalMemoryMode(tx, actor);
  return mode.kind === 'keep' && (await memoryProposalsInstalled(tx)) ? mode : undefined;
}

async function proposeMaintenanceMemory(
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
    const profile = await readKeepProfile(keep);
    const revision = keepRevision(profile);
    const text = profile.kind === 'active' ? profile.text : '';
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
      text,
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
    system: proposalSystemPrompt,
    messages: [
      { role: 'user', text: JSON.stringify({ currentMemory: input.text, requesterTranscript: input.transcript }) },
    ],
  });
  const edits = parseMemoryEdits(response.text, input.text, input.transcript, input.messages);
  return transaction(async (tx, { actor }) => {
    const keep = await keepFor(tx, actor);
    if (!keep) {
      await repository(tx).clearStep([fence.jobId]);
      await repository(tx).complete([fence.jobId]);
      return true;
    }
    const profile = await readKeepProfile(keep);
    // The member changed their memory meanwhile: suggest again against what they have now.
    if (keepRevision(profile) !== input.revision || (await lastDirectMemoryChange(tx, actor)) !== input.manualAt) {
      await repository(tx).clearStep([fence.jobId]);
      await repository(tx).restart([fence.jobId]);
      return false;
    }
    await saveMemoryProposals(
      tx,
      actor,
      fence.conversationId,
      { revision: input.revision, revisionId: profile.kind === 'empty' ? null : profile.head.revisionId },
      edits,
    );
    await repository(tx).finish([fence.jobId, input.chunk + 1, input.step + 1, input.last]);
    await repository(tx).clearStep([fence.jobId]);
    return input.last;
  });
}
