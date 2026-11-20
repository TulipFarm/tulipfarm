import { randomUUID } from 'node:crypto';
import {
  currentMember,
  denyMcpEgress,
  lockAuthorization,
  resolveHuman,
  uuidSchema,
  type AuthorizationTransaction,
  type HumanActor,
} from '@tulipfarm/access';
import { commonCompatibility, qualified } from '@tulipfarm/workspace-storage/runtime';
import { recordRecommendationChange } from '@tulipfarm/workspace-storage/recommendations';
import { createPersonalMemory } from '@tulipfarm/memory-core/memory/personal-memory';
import { createPostgresMemoryRepository } from '@tulipfarm/memory-postgres';
import type { ConversationRuntime } from './runtime.ts';
import {
  savePersonalMemorySchema,
  deletePersonalMemorySchema,
  type MemoryProposals,
  type PersonalMemory,
} from './personal-memory-contracts.ts';
import {
  forgetKeepMemory,
  keepMemoryContext,
  keepMemoryState,
  keepRevision,
  personalMemoryMode,
  readKeepProfile,
  type KeepProfile,
  PersonalMemoryUnavailable,
  PersonalMemoryUnsupported,
  readKeepMemory,
  readKeepMemoryState,
  replaceKeepMemory,
  undoKeepMemory,
  type PersonalMemoryTransaction,
} from './keep-personal-memory.ts';
import {
  applyMemoryEdit,
  blockLearningSource,
  deleteMemoryProposal,
  lockMemoryLearning,
  lockMemoryProposal,
  memoryProposalRecords,
  memoryProposalsInstalled,
  MemoryProposalOutdated,
  rebindMemoryProposal,
  recordDirectMemoryChange,
  scrubMemoryProposals,
  type MemoryProposalRecord,
} from './memory-proposals.ts';
export * from './personal-memory-contracts.ts';
export { MemoryProposalNotFound, MemoryProposalOutdated } from './memory-proposals.ts';
export { PersonalMemoryConflict } from '@tulipfarm/memory-core/memory/personal-memory';
export {
  configureKeepPersonalMemory,
  keepForgetScrubVersion,
  personalMemoryMode,
  PersonalMemoryRejected,
  PersonalMemoryUnavailable,
  PersonalMemoryUnsupported,
  type PersonalMemoryMode,
  type PersonalMemoryUnavailableReason,
} from './keep-personal-memory.ts';

const compatibility = { minimum: 1, maximum: commonCompatibility.maximum };
/** The workspace's own memory store, used only while Keep is off and was never used. */
export const legacyPersonalMemory = createPersonalMemory<AuthorizationTransaction & { commonVersion?: number }>({
  repository: tx => createPostgresMemoryRepository(tx.client, { schema: tx.schema, tablePrefix: 'tf_' }),
  authorization: {
    async lock(tx) {
      await lockAuthorization(tx, 'read');
      return { kind: 'allowed', value: undefined };
    },
    async member(tx, actor) {
      await currentMember(tx, actor);
      return { kind: 'allowed', value: undefined };
    },
  },
  available: tx => !(tx.commonVersion !== undefined && tx.commonVersion < 1),
  egressPolicy: { deny: () => denyMcpEgress() },
  onChanged: (tx, actor) => memoryChanged(tx, actor),
});

function memoryChanged(tx: AuthorizationTransaction, actor: HumanActor) {
  return recordRecommendationChange(tx, {
    id: randomUUID(),
    kind: 'memory',
    sourceId: actor.membershipId,
    membershipIds: [actor.membershipId],
    invalidate: true,
  });
}

async function member(tx: PersonalMemoryTransaction, actor: HumanActor) {
  denyMcpEgress();
  await lockAuthorization(tx, 'read');
  await currentMember(tx, actor);
}

async function keepMode(tx: PersonalMemoryTransaction, actor: HumanActor) {
  await member(tx, actor);
  const mode = await personalMemoryMode(tx, actor);
  if (mode.kind === 'hidden') throw new PersonalMemoryUnavailable('hidden');
  return mode;
}

/**
 * The member's own memory, from Keep when the workspace uses it. Throws {@link PersonalMemoryUnavailable} when Keep
 * cannot answer or its memory is hidden: that is never an empty memory.
 */
export async function readPersonalMemory(tx: PersonalMemoryTransaction, actor: HumanActor): Promise<PersonalMemory> {
  const mode = await keepMode(tx, actor);
  return mode.kind === 'keep' ? readKeepMemory(mode) : legacyPersonalMemory.read(tx, actor);
}

/**
 * Memory for a model's private context, or undefined when there is none to give: Keep's personal context block (no
 * workspace knowledge) or the stored document. Unavailable or hidden memory is left out, never sent as empty.
 */
export async function readPersonalMemoryContext(
  tx: PersonalMemoryTransaction,
  actor: HumanActor,
): Promise<PersonalMemory | undefined> {
  try {
    const mode = await keepMode(tx, actor);
    return mode.kind === 'keep' ? await keepMemoryContext(mode) : await legacyPersonalMemory.read(tx, actor);
  } catch (error) {
    if (error instanceof PersonalMemoryUnavailable) return undefined;
    throw error;
  }
}

/** Compare-and-swap replacement. With Keep, blank text moves memory to the trash, recoverable for 7 days. */
export async function replacePersonalMemory(
  tx: PersonalMemoryTransaction,
  actor: HumanActor,
  nextContent: string,
  expectedRevision: number,
): Promise<PersonalMemory> {
  const mode = await keepMode(tx, actor);
  if (mode.kind === 'legacy') return legacyPersonalMemory.replace(tx, actor, nextContent, expectedRevision);
  savePersonalMemorySchema.parse({ content: nextContent, expectedRevision });
  await lockMemoryLearning(tx, actor);
  return changed(tx, actor, await replaceKeepMemory(mode, nextContent, expectedRevision));
}

async function changed(
  tx: PersonalMemoryTransaction,
  actor: HumanActor,
  result: { previous: string; memory: PersonalMemory },
) {
  if (result.previous !== result.memory.content) await memoryChanged(tx, actor);
  return result.memory;
}

async function clearBudPreferences(tx: PersonalMemoryTransaction, actor: HumanActor) {
  const installed = (
    await tx.client.query('SELECT to_regclass($1) IS NOT NULL AS installed', [
      qualified(tx.schema, 'tf_bud_preferences'),
    ])
  ).rows[0]?.installed;
  if (installed)
    await tx.client.query(`DELETE FROM ${qualified(tx.schema, 'tf_bud_preferences')} WHERE membership_id=$1`, [
      actor.membershipId,
    ]);
}

/** A change the member made themselves: it also drops their Bud preference records, so a later Bud Undo cannot bring back replaced content. */
export async function replaceOwnPersonalMemory(
  tx: PersonalMemoryTransaction,
  actor: HumanActor,
  nextContent: string,
  expectedRevision: number,
) {
  const result = await replacePersonalMemory(tx, actor, nextContent, expectedRevision);
  await clearBudPreferences(tx, actor);
  await directKeepChange(tx, actor);
  return result;
}

/** With Keep, a change the member made themselves resets where background learning reads from. */
async function directKeepChange(tx: PersonalMemoryTransaction, actor: HumanActor) {
  if ((await personalMemoryMode(tx, actor)).kind === 'keep') await recordDirectMemoryChange(tx, actor);
}

async function keepOnly(tx: PersonalMemoryTransaction, actor: HumanActor) {
  const mode = await keepMode(tx, actor);
  if (mode.kind !== 'keep') throw new PersonalMemoryUnsupported();
  return mode;
}

/** Keep only, for a change: holds off background learning until the transaction ends. */
async function keepChange(tx: PersonalMemoryTransaction, actor: HumanActor) {
  const mode = await keepOnly(tx, actor);
  await lockMemoryLearning(tx, actor);
  return mode;
}

/** Undoes the member's last memory change in Keep: a deleted memory comes back, an edit is reverted as a new revision. */
export async function undoOwnPersonalMemory(
  tx: PersonalMemoryTransaction,
  actor: HumanActor,
  expectedRevision: number,
) {
  const result = await changed(tx, actor, await undoKeepMemory(await keepChange(tx, actor), expectedRevision));
  await clearBudPreferences(tx, actor);
  await recordDirectMemoryChange(tx, actor);
  return result;
}

/**
 * Permanently erases the exact `text` from the member's memory in Keep, or all of it, including history and trash.
 * Nothing can undo it.
 */
export async function forgetOwnPersonalMemory(
  tx: PersonalMemoryTransaction,
  actor: HumanActor,
  expectedRevision: number,
  text?: string,
) {
  const result = await changed(tx, actor, await forgetKeepMemory(await keepChange(tx, actor), expectedRevision, text));
  await clearBudPreferences(tx, actor);
  await scrubMemoryProposals(tx, actor, text === undefined ? undefined : { text, memory: result.content });
  await recordDirectMemoryChange(tx, actor);
  return result;
}

const profileText = (profile: KeepProfile) => (profile.kind === 'active' ? profile.text : '');
const profileBase = (profile: KeepProfile) => ({
  revision: keepRevision(profile),
  revisionId: profile.kind === 'empty' ? null : profile.head.revisionId,
});

async function proposalsView(
  tx: PersonalMemoryTransaction,
  actor: HumanActor,
  profile: KeepProfile,
): Promise<MemoryProposals> {
  const revision = keepRevision(profile);
  const records = (await memoryProposalsInstalled(tx)) ? await memoryProposalRecords(tx, actor) : [];
  return {
    memory: keepMemoryState(profile),
    proposals: records.map(record => ({
      id: record.id,
      kind: record.kind,
      before: record.before,
      after: record.after,
      quote: record.quote,
      conversationId: record.conversationId,
      conversationTitle: record.conversationTitle,
      createdAt: record.createdAt,
      outdated: record.baseRevision !== revision || applyMemoryEdit(profileText(profile), record) === undefined,
    })),
  };
}

/** Keep only: the member's memory with the edits background learning suggested for it. */
export async function listMemoryProposals(tx: PersonalMemoryTransaction, actor: HumanActor) {
  return proposalsView(tx, actor, await readKeepProfile(await keepOnly(tx, actor)));
}

async function proposalMode(tx: PersonalMemoryTransaction, actor: HumanActor) {
  const mode = await keepChange(tx, actor);
  if (!(await memoryProposalsInstalled(tx))) throw new PersonalMemoryUnavailable('updating');
  return mode;
}

/**
 * Applies a suggested edit with a compare-and-swap write on the revision it was made against. Like the member's own
 * edit, it drops their Bud preference records and refreshes recommendations. Other suggestions made against the same
 * memory move to the new revision when they still fit it.
 */
export async function confirmMemoryProposal(tx: PersonalMemoryTransaction, actor: HumanActor, id: string) {
  const mode = await proposalMode(tx, actor);
  const proposal = await lockMemoryProposal(tx, actor, id);
  const profile = await readKeepProfile(mode);
  const revision = keepRevision(profile);
  const next = proposal.baseRevision === revision ? applyMemoryEdit(profileText(profile), proposal) : undefined;
  if (next === undefined) throw new MemoryProposalOutdated();
  await changed(tx, actor, await replaceKeepMemory(mode, next, revision));
  await clearBudPreferences(tx, actor);
  await deleteMemoryProposal(tx, actor, proposal.id);
  const updated = await readKeepProfile(mode);
  for (const other of await memoryProposalRecords(tx, actor))
    if (other.baseRevision === revision && applyMemoryEdit(profileText(updated), other) !== undefined)
      await rebindMemoryProposal(tx, actor, other.id, profileBase(updated));
  return proposalsView(tx, actor, updated);
}

/** Discards a suggestion. Learning does not suggest the same words from that chat again. */
export async function dismissMemoryProposal(tx: PersonalMemoryTransaction, actor: HumanActor, id: string) {
  const mode = await proposalMode(tx, actor);
  const proposal: MemoryProposalRecord = await lockMemoryProposal(tx, actor, id);
  await deleteMemoryProposal(tx, actor, proposal.id);
  await blockLearningSource(tx, actor, proposal);
  return proposalsView(tx, actor, await readKeepProfile(mode));
}

/**
 * Moves an outdated suggestion to the current memory when its edit still fits there. Throws
 * {@link MemoryProposalOutdated} when it no longer fits; the member can only dismiss it then.
 */
export async function refreshMemoryProposal(tx: PersonalMemoryTransaction, actor: HumanActor, id: string) {
  const mode = await proposalMode(tx, actor);
  const proposal = await lockMemoryProposal(tx, actor, id);
  const profile = await readKeepProfile(mode);
  if (applyMemoryEdit(profileText(profile), proposal) === undefined) throw new MemoryProposalOutdated();
  if (proposal.baseRevision !== keepRevision(profile))
    await rebindMemoryProposal(tx, actor, proposal.id, profileBase(profile));
  return proposalsView(tx, actor, profile);
}

export function createPersonalMemoryService(runtime: ConversationRuntime) {
  async function human<T>(
    workspaceId: string,
    userId: string,
    operation: (tx: AuthorizationTransaction, actor: HumanActor) => Promise<T>,
  ) {
    denyMcpEgress();
    return runtime.transaction(uuidSchema.parse(workspaceId), compatibility, async tx => {
      await lockAuthorization(tx, 'read');
      const actor = await resolveHuman(tx, userId);
      await currentMember(tx, actor);
      return operation(tx, actor);
    });
  }
  /** A change, answered with the memory's state afterwards so the editor can offer Undo or Restore. */
  function change(
    workspaceId: string,
    userId: string,
    operation: (tx: AuthorizationTransaction, actor: HumanActor) => Promise<PersonalMemory>,
  ) {
    return human(workspaceId, userId, async (tx, actor): Promise<PersonalMemory> => {
      const result = await operation(tx, actor);
      const mode = await personalMemoryMode(tx, actor);
      return mode.kind === 'keep' ? readKeepMemoryState(mode) : result;
    });
  }
  async function replace(workspaceId: string, userId: string, nextContent: string, expectedRevision: number) {
    return change(workspaceId, userId, (tx, actor) =>
      replaceOwnPersonalMemory(tx, actor, nextContent, expectedRevision),
    );
  }
  return {
    /** The member's memory and, with Keep, what its history can do: undo, or restore from the trash. */
    read: (workspaceId: string, userId: string) =>
      human(workspaceId, userId, async (tx, actor): Promise<PersonalMemory> => {
        const mode = await keepMode(tx, actor);
        return mode.kind === 'keep' ? readKeepMemoryState(mode) : legacyPersonalMemory.read(tx, actor);
      }),
    save: (workspaceId: string, userId: string, value: unknown) => {
      const input = savePersonalMemorySchema.parse(value);
      return replace(workspaceId, userId, input.content, input.expectedRevision);
    },
    delete: (workspaceId: string, userId: string, value: unknown) => {
      const input = deletePersonalMemorySchema.parse(value);
      return replace(workspaceId, userId, '', input.expectedRevision);
    },
    /** Keep only: undoes the last change, restoring a deleted memory. */
    undo: (workspaceId: string, userId: string, value: unknown) => {
      const input = deletePersonalMemorySchema.parse(value);
      return change(workspaceId, userId, (tx, actor) => undoOwnPersonalMemory(tx, actor, input.expectedRevision));
    },
    /** Keep only: the edits background learning suggested, for the member to confirm or dismiss. */
    proposals: (workspaceId: string, userId: string) =>
      human(workspaceId, userId, (tx, actor) => listMemoryProposals(tx, actor)),
    confirmProposal: (workspaceId: string, userId: string, id: string) =>
      human(workspaceId, userId, (tx, actor) => confirmMemoryProposal(tx, actor, uuidSchema.parse(id))),
    dismissProposal: (workspaceId: string, userId: string, id: string) =>
      human(workspaceId, userId, (tx, actor) => dismissMemoryProposal(tx, actor, uuidSchema.parse(id))),
    refreshProposal: (workspaceId: string, userId: string, id: string) =>
      human(workspaceId, userId, (tx, actor) => refreshMemoryProposal(tx, actor, uuidSchema.parse(id))),
    /** Keep only: permanently erases the whole memory, including its history and trash. */
    forget: (workspaceId: string, userId: string, value: unknown) => {
      const input = deletePersonalMemorySchema.parse(value);
      return change(workspaceId, userId, (tx, actor) => forgetOwnPersonalMemory(tx, actor, input.expectedRevision));
    },
  };
}
