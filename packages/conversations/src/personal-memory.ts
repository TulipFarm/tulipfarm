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
  type PersonalMemory,
} from './personal-memory-contracts.ts';
import {
  forgetKeepMemory,
  keepMemoryContext,
  personalMemoryMode,
  PersonalMemoryUnavailable,
  PersonalMemoryUnsupported,
  readKeepMemory,
  readKeepMemoryState,
  replaceKeepMemory,
  undoKeepMemory,
  type PersonalMemoryTransaction,
} from './keep-personal-memory.ts';
export * from './personal-memory-contracts.ts';
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
  return result;
}

async function keepOnly(tx: PersonalMemoryTransaction, actor: HumanActor) {
  const mode = await keepMode(tx, actor);
  if (mode.kind !== 'keep') throw new PersonalMemoryUnsupported();
  return mode;
}

/** Undoes the member's last memory change in Keep: a deleted memory comes back, an edit is reverted as a new revision. */
export async function undoOwnPersonalMemory(
  tx: PersonalMemoryTransaction,
  actor: HumanActor,
  expectedRevision: number,
) {
  const result = await changed(tx, actor, await undoKeepMemory(await keepOnly(tx, actor), expectedRevision));
  await clearBudPreferences(tx, actor);
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
  const result = await changed(tx, actor, await forgetKeepMemory(await keepOnly(tx, actor), expectedRevision, text));
  await clearBudPreferences(tx, actor);
  return result;
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
    /** Keep only: permanently erases the whole memory, including its history and trash. */
    forget: (workspaceId: string, userId: string, value: unknown) => {
      const input = deletePersonalMemorySchema.parse(value);
      return change(workspaceId, userId, (tx, actor) => forgetOwnPersonalMemory(tx, actor, input.expectedRevision));
    },
  };
}
