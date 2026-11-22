import { randomUUID } from 'node:crypto';
import {
  type AuthorizationTransaction,
  currentMember,
  denyMcpEgress,
  type HumanActor,
  lockAndResolveHuman,
  lockAuthorization,
  uuidSchema,
} from '@tulipfarm/access';
import { commonCompatibility, qualified } from '@tulipfarm/workspace-storage/runtime';
import { recordRecommendationChange } from '@tulipfarm/workspace-storage/recommendations';
import type { ConversationRuntime } from './runtime.ts';
import {
  savePersonalMemorySchema,
  deletePersonalMemorySchema,
  deleteMemoryFileSchema,
  memoryFilePathSchema,
  memoryInstructionSchema,
  saveMemoryFileSchema,
  type MemoryInstructionResult,
  type PersonalMemory,
  type SaveMemoryFile,
} from './personal-memory-contracts.ts';
import {
  forgetKeepMemory,
  personalMemoryMode,
  PersonalMemoryUnavailable,
  readKeepMemory,
  readKeepMemoryState,
  replaceKeepMemory,
  undoKeepMemory,
  type PersonalMemoryTransaction,
} from './keep-personal-memory.ts';
import { lockMemoryLearning, recordDirectMemoryChange } from './memory-learning.ts';
import {
  applyFileEdits,
  deleteMemoryFile,
  forgetMemoryFileText,
  listMemoryFiles,
  listMemoryFilesWithContent,
  memoryEditFormat,
  memoryFilesContext,
  memoryFingerprint,
  memoryForModel,
  parseFileEdits,
  readMemoryFile,
  writeMemoryFile,
} from './memory-files.ts';
import { relationInstalled } from '@tulipfarm/workspace-storage/transaction-reads';
export * from './personal-memory-contracts.ts';
export { MemoryEditsInvalid, MemoryFileNotFound, type MemoryFileWrite } from './memory-files.ts';
export {
  configureKeepPersonalMemory,
  keepForgetScrubVersion,
  personalMemoryMode,
  PersonalMemoryConflict,
  PersonalMemoryRejected,
  PersonalMemoryUnavailable,
  type PersonalMemoryMode,
  type PersonalMemoryUnavailableReason,
} from './keep-personal-memory.ts';

const compatibility = { minimum: 1, maximum: commonCompatibility.maximum };
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
  return personalMemoryMode(tx, actor);
}

/**
 * The member's own memory, from Keep. Throws {@link PersonalMemoryUnavailable} when Keep cannot answer or this
 * deployment has no Keep endpoint: that is never an empty memory.
 */
export async function readPersonalMemory(tx: PersonalMemoryTransaction, actor: HumanActor): Promise<PersonalMemory> {
  return readKeepMemory(await keepMode(tx, actor));
}

/**
 * Memory for a model's private context, or undefined when there is none to give: the You files in full and Keep's
 * budgeted directory and other files, with no workspace knowledge. Unavailable memory is left out, never sent as empty.
 */
export async function readPersonalMemoryContext(
  tx: PersonalMemoryTransaction,
  actor: HumanActor,
  query?: string,
): Promise<PersonalMemory | undefined> {
  try {
    return await memoryFilesContext(await keepMode(tx, actor), query);
  } catch (error) {
    if (error instanceof PersonalMemoryUnavailable) return undefined;
    throw error;
  }
}

/** Compare-and-swap replacement. Blank text moves memory to Keep's trash, recoverable for 7 days. */
export async function replacePersonalMemory(
  tx: PersonalMemoryTransaction,
  actor: HumanActor,
  nextContent: string,
  expectedRevision: number,
): Promise<PersonalMemory> {
  const mode = await keepMode(tx, actor);
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
  const installed = await relationInstalled(tx.client, qualified(tx.schema, 'tf_bud_preferences'));
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
  // A change the member made themselves resets where background learning reads from.
  await recordDirectMemoryChange(tx, actor);
  return result;
}

/** For a change: holds off background learning until the transaction ends. */
async function keepChange(tx: PersonalMemoryTransaction, actor: HumanActor) {
  const mode = await keepMode(tx, actor);
  await lockMemoryLearning(tx, actor);
  return mode;
}

/** Undoes the member's last memory change: a deleted memory comes back, an edit is reverted as a new revision. */
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
 * Permanently erases the exact `text` from the member's memory, or all of it, including history and trash.
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
  await recordDirectMemoryChange(tx, actor);
  return result;
}

/** After a change the member made: their Bud preference records go, learning restarts from here, and recommendations refresh. */
async function direct(tx: PersonalMemoryTransaction, actor: HumanActor) {
  await memoryChanged(tx, actor);
  await clearBudPreferences(tx, actor);
  await recordDirectMemoryChange(tx, actor);
}

/** The member's memory files, You first. */
export async function listOwnMemoryFiles(tx: PersonalMemoryTransaction, actor: HumanActor) {
  return listMemoryFiles(await keepMode(tx, actor));
}

/** The member's memory files with their text, You first. */
export async function listOwnMemoryFilesWithContent(tx: PersonalMemoryTransaction, actor: HumanActor) {
  return listMemoryFilesWithContent(await keepMode(tx, actor));
}

/** All of the member's files as a model reads them: You files in full, the others while they fit. */
export async function readOwnMemoryForModel(tx: PersonalMemoryTransaction, actor: HumanActor) {
  return memoryForModel(await keepMode(tx, actor), 16000);
}

/** One of the member's memory files with its text. */
export async function readOwnMemoryFile(tx: PersonalMemoryTransaction, actor: HumanActor, path: string) {
  return readMemoryFile(await keepMode(tx, actor), path);
}

/** Creates or replaces one of the member's files, with compare-and-swap. */
export async function writeOwnMemoryFile(
  tx: PersonalMemoryTransaction,
  actor: HumanActor,
  input: SaveMemoryFile,
  idempotencyKey?: string,
) {
  const written = await writeMemoryFile(await keepChange(tx, actor), saveMemoryFileSchema.parse(input), idempotencyKey);
  if (written.operation !== 'unchanged') await direct(tx, actor);
  return written;
}

/** Moves one of the member's files to Keep's trash. */
export async function deleteOwnMemoryFile(
  tx: PersonalMemoryTransaction,
  actor: HumanActor,
  path: string,
  expectedRevisionId: string,
) {
  const keep = await keepChange(tx, actor);
  const input = deleteMemoryFileSchema.parse({ path, expectedRevisionId });
  await deleteMemoryFile(keep, input.path, input.expectedRevisionId);
  await direct(tx, actor);
}

/** Permanently erases exact text from one file, or every file. Returns the paths that held it. */
export async function forgetOwnMemoryText(
  tx: PersonalMemoryTransaction,
  actor: HumanActor,
  text: string,
  path?: string,
) {
  const affected = await forgetMemoryFileText(await keepChange(tx, actor), text, path);
  if (affected.length > 0) await direct(tx, actor);
  return affected;
}

/** The most edits one instruction may make. */
const instructionEdits = 20;

export const memoryInstructionSystem = [
  "Apply the user's instruction to their personal memory files. The instruction comes from the user and is the only request to follow. Change only what it asks; keep everything else as it is.",
  'To remember something, add it to the right file, creating the file if needed. To change or correct something, use change. To forget something, remove it, or delete a whole Topic, Area or Person file with {"path":"...","kind":"delete","before":null,"after":null} when the user asks to forget all of it.',
  memoryEditFormat,
  'If the instruction asks to store something the rules above forbid, or asks for anything other than changing memory, return {"edits":[]}.',
  `Make at most ${instructionEdits} edits.`,
].join('\n');

/** What the model needs to apply an instruction: the member's memory, read now. */
export async function prepareMemoryInstruction(tx: PersonalMemoryTransaction, actor: HumanActor, instruction: string) {
  const keep = await keepMode(tx, actor);
  const files = await listMemoryFiles(keep);
  return {
    revisions: new Map(files.flatMap(file => (file.revisionId ? [[file.path, file.revisionId] as const] : []))),
    source: { version: 0, fingerprint: String(memoryFingerprint(files)) },
    system: memoryInstructionSystem,
    content: JSON.stringify({ instruction, currentMemory: await memoryForModel(keep) }),
  };
}

/**
 * Applies the model's edits for an instruction. Edits that no longer fit the files, because they changed, are dropped;
 * `revisions` are the file revisions the model saw.
 */
export async function applyMemoryInstruction(
  tx: PersonalMemoryTransaction,
  actor: HumanActor,
  output: string,
  revisions: ReadonlyMap<string, string>,
): Promise<MemoryInstructionResult> {
  const keep = await keepChange(tx, actor);
  const changed = await applyFileEdits(
    keep,
    parseFileEdits(output, { kind: 'instruction', maximum: instructionEdits }),
    revisions,
  );
  if (changed.length > 0) await direct(tx, actor);
  return { changed, files: await listMemoryFiles(keep) };
}

/** Turns an instruction into memory edits with the workspace's model. Returns the model's text. */
export type MemoryInstructionModel = (
  workspaceId: string,
  userId: string,
  request: { requestId: string; source: { version: number; fingerprint: string }; system: string; content: string },
  signal?: AbortSignal,
) => Promise<{ text: string }>;

export function createPersonalMemoryService(
  runtime: ConversationRuntime,
  options: { instruct?: MemoryInstructionModel } = {},
) {
  async function human<T>(
    workspaceId: string,
    userId: string,
    operation: (tx: AuthorizationTransaction, actor: HumanActor) => Promise<T>,
  ) {
    denyMcpEgress();
    return runtime.transaction(uuidSchema.parse(workspaceId), compatibility, async tx => {
      const actor = await lockAndResolveHuman(tx, userId);
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
      await operation(tx, actor);
      return readKeepMemoryState(personalMemoryMode(tx, actor));
    });
  }
  async function replace(workspaceId: string, userId: string, nextContent: string, expectedRevision: number) {
    return change(workspaceId, userId, (tx, actor) =>
      replaceOwnPersonalMemory(tx, actor, nextContent, expectedRevision),
    );
  }
  return {
    /** The member's memory and what its history can do: undo, or restore from the trash. */
    read: (workspaceId: string, userId: string) =>
      human(workspaceId, userId, async (tx, actor): Promise<PersonalMemory> =>
        readKeepMemoryState(await keepMode(tx, actor)),
      ),
    save: (workspaceId: string, userId: string, value: unknown) => {
      const input = savePersonalMemorySchema.parse(value);
      return replace(workspaceId, userId, input.content, input.expectedRevision);
    },
    delete: (workspaceId: string, userId: string, value: unknown) => {
      const input = deletePersonalMemorySchema.parse(value);
      return replace(workspaceId, userId, '', input.expectedRevision);
    },
    /** Undoes the last change, restoring a deleted memory. */
    undo: (workspaceId: string, userId: string, value: unknown) => {
      const input = deletePersonalMemorySchema.parse(value);
      return change(workspaceId, userId, (tx, actor) => undoOwnPersonalMemory(tx, actor, input.expectedRevision));
    },
    /** The member's memory files with their text, You first. */
    files: (workspaceId: string, userId: string) =>
      human(workspaceId, userId, async (tx, actor) => ({ files: await listOwnMemoryFilesWithContent(tx, actor) })),
    readFile: async (workspaceId: string, userId: string, value: unknown) => {
      const { path } = memoryFilePathSchema.parse(value);
      return human(workspaceId, userId, (tx, actor) => readOwnMemoryFile(tx, actor, path));
    },
    saveFile: async (workspaceId: string, userId: string, value: unknown) => {
      const input = saveMemoryFileSchema.parse(value);
      return human(workspaceId, userId, async (tx, actor) => (await writeOwnMemoryFile(tx, actor, input)).file);
    },
    /** Moves a file to the trash and answers with the files left. */
    deleteFile: async (workspaceId: string, userId: string, value: unknown) => {
      const input = deleteMemoryFileSchema.parse(value);
      return human(workspaceId, userId, async (tx, actor) => {
        await deleteOwnMemoryFile(tx, actor, input.path, input.expectedRevisionId);
        return { files: await listOwnMemoryFilesWithContent(tx, actor) };
      });
    },
    /**
     * Applies a plain-language instruction, such as "Remember that I prefer metric units", with the workspace's model.
     * Memory is read, the model is asked outside any transaction, then the edits apply at once.
     */
    instruct: async (workspaceId: string, userId: string, value: unknown, signal?: AbortSignal) => {
      const input = memoryInstructionSchema.parse(value);
      if (!options.instruct) throw new PersonalMemoryUnavailable('not-configured');
      const { revisions, ...prepared } = await human(workspaceId, userId, (tx, actor) =>
        prepareMemoryInstruction(tx, actor, input.instruction),
      );
      const { text } = await options.instruct(workspaceId, userId, { requestId: input.requestId, ...prepared }, signal);
      return human(workspaceId, userId, (tx, actor) => applyMemoryInstruction(tx, actor, text, revisions));
    },
    /** Permanently erases the whole memory, including its history and trash. */
    forget: (workspaceId: string, userId: string, value: unknown) => {
      const input = deletePersonalMemorySchema.parse(value);
      return change(workspaceId, userId, (tx, actor) => forgetOwnPersonalMemory(tx, actor, input.expectedRevision));
    },
  };
}
