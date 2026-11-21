import { randomUUID } from 'node:crypto';
import type { AuthorizationTransaction, HumanActor } from '@tulipfarm/access';
import { keepConfiguration } from '@tulipfarm/config/keep';
import {
  createKeepClient,
  keepMemberScope,
  keepProfilePath,
  type KeepClient,
  type KeepErrorCode,
  type KeepMemoryResult,
  type KeepRevision,
  type KeepScope,
} from '@tulipfarm/memory-keep';
import { log } from '@tulipfarm/observability';
import { workspaceIdFromSchema } from '@tulipfarm/workspace-storage/runtime';
import type { PersonalMemory } from '@tulipfarm/memory-core/personal-memory-contracts';

export type PersonalMemoryTransaction = AuthorizationTransaction & { commonVersion?: number; workspaceId?: string };

/** Why personal memory cannot be read or changed right now. None of these is an empty memory. */
export type PersonalMemoryUnavailableReason =
  /** Keep did not answer, or refused the service's credentials. */
  | 'unavailable'
  /** This deployment has no Keep endpoint. */
  | 'not-configured'
  /** The workspace's storage has not been migrated far enough for this operation. */
  | 'updating';

/** The memory changed since the revision the caller read. */
export class PersonalMemoryConflict extends Error {
  constructor() {
    super('personal_memory_conflict');
    this.name = 'PersonalMemoryConflict';
  }
}

export class PersonalMemoryUnavailable extends Error {
  readonly reason: PersonalMemoryUnavailableReason;
  constructor(reason: PersonalMemoryUnavailableReason) {
    super('personal-memory-unavailable');
    this.name = 'PersonalMemoryUnavailable';
    this.reason = reason;
  }
}

/** Keep refused the change itself, such as text over its size limit. Retrying the same change will not help. */
export class PersonalMemoryRejected extends Error {
  readonly code: KeepErrorCode;
  constructor(code: KeepErrorCode) {
    super('personal-memory-rejected');
    this.name = 'PersonalMemoryRejected';
    this.code = code;
  }
}

/** The common migration that lets a decided forget card drop the text it asked to forget. */
export const keepForgetScrubVersion = 94;
const writeTimeoutMs = 5000;

type Dependencies = {
  readonly client: () => KeepClient | undefined;
};

function defaults(): Dependencies {
  let client: KeepClient | undefined | null = null;
  return {
    client() {
      if (client !== null) return client;
      const configuration = keepConfiguration();
      client =
        configuration.status === 'configured'
          ? createKeepClient({
              endpoint: configuration.endpoint,
              token: configuration.token,
              timeoutMs: writeTimeoutMs,
            })
          : undefined;
      return client;
    },
  };
}

let dependencies = defaults();

/** Replaces how Keep is reached, for tests and local tools. Returns a function that restores the default. */
export function configureKeepPersonalMemory(options: { client?: KeepClient | undefined }) {
  dependencies = { client: 'client' in options ? () => options.client : dependencies.client };
  return () => {
    dependencies = defaults();
  };
}

/** Where a member's memory lives: their own scope in Keep. */
export type PersonalMemoryMode = { readonly kind: 'keep'; readonly client: KeepClient; readonly scope: KeepScope };

/** The member's memory in Keep. Throws {@link PersonalMemoryUnavailable} when this deployment has no Keep endpoint. */
export function personalMemoryMode(tx: PersonalMemoryTransaction, actor: HumanActor): PersonalMemoryMode {
  const client = dependencies.client();
  if (!client) throw new PersonalMemoryUnavailable('not-configured');
  return {
    kind: 'keep',
    client,
    scope: keepMemberScope(tx.workspaceId ?? workspaceIdFromSchema(tx.schema), actor.membershipId),
  };
}

type Keep = PersonalMemoryMode;

/** The member's `/profile.md` in Keep: absent, current, or in the trash. */
export type KeepProfile =
  | { readonly kind: 'empty' }
  | {
      readonly kind: 'active' | 'trashed';
      readonly head: KeepRevision;
      /** The trash hides a file's text, so a trashed profile reads as empty. */
      readonly text: string;
      readonly revisions: number;
    };

const maximumRevision = 2147483646;

/**
 * Personal memory revisions are integers. A Keep profile's revision is its head's ledger sequence, doubled, plus one
 * while it is in the trash, so deleting and restoring both change it and it never repeats for different content.
 */
export function keepRevision(profile: KeepProfile) {
  if (profile.kind === 'empty') return 0;
  const revision = profile.head.seq * 2 + (profile.kind === 'trashed' ? 1 : 0);
  if (revision > maximumRevision) throw new PersonalMemoryRejected('limit_exceeded');
  return revision;
}

export function failed(result: Exclude<KeepMemoryResult<unknown>, { status: 'ok' }>, operation: string): never {
  // The log names the operation and Keep's answer only: never memory text, scope or token.
  log('warn', 'dependency', 'call_failed', {
    operation: `keep.memory.${operation}`,
    outcome: result.status,
    ...('reason' in result && result.reason ? { reason: result.reason } : {}),
    ...('code' in result && result.code ? { code: result.code } : {}),
  });
  if (result.status === 'unavailable') throw new PersonalMemoryUnavailable('unavailable');
  if (result.status === 'rejected') throw new PersonalMemoryRejected(result.code);
  throw new PersonalMemoryConflict();
}

/** Retries a keyed write once when Keep may not have seen it; the idempotency key makes it apply at most once. */
export async function once<T>(operation: () => Promise<KeepMemoryResult<T>>) {
  const result = await operation();
  return result.status === 'unavailable' && (result.reason === 'timeout' || result.reason === 'unreachable')
    ? operation()
    : result;
}

export async function readKeepProfile(keep: Keep): Promise<KeepProfile> {
  const target = { scope: keep.scope, path: keepProfilePath };
  for (let attempt = 0; attempt < 3; attempt++) {
    const history = await keep.client.history(target);
    if (history.status === 'not_found') return { kind: 'empty' };
    if (history.status !== 'ok') failed(history, 'history');
    const head = history.value.revisions.find(revision => revision.isHead);
    if (!head) failed({ status: 'unavailable', reason: 'invalid_response' }, 'history');
    const file = await keep.client.read(target);
    const revisions = history.value.revisions.length;
    if (file.status === 'not_found') return { kind: 'trashed', head, text: '', revisions };
    if (file.status !== 'ok') failed(file, 'read');
    // A change between the two reads: read both again.
    if (file.value.head.revisionId === head.revisionId)
      return { kind: 'active', head, text: file.value.text, revisions };
  }
  throw new PersonalMemoryConflict();
}

export async function readKeepMemory(keep: Keep): Promise<PersonalMemory> {
  const profile = await readKeepProfile(keep);
  return { content: profile.kind === 'active' ? profile.text : '', revision: keepRevision(profile) };
}

/** The member's memory and what Keep's history can do with it. */
export async function readKeepMemoryState(keep: Keep) {
  return keepMemoryState(await readKeepProfile(keep));
}

export function keepMemoryState(profile: KeepProfile) {
  return {
    content: profile.kind === 'active' ? profile.text : '',
    revision: keepRevision(profile),
    history: {
      trashed: profile.kind === 'trashed',
      undo: profile.kind === 'trashed' || (profile.kind === 'active' && profile.revisions > 1),
    },
  };
}

async function current(keep: Keep, expectedRevision: number) {
  const profile = await readKeepProfile(keep);
  if (keepRevision(profile) !== expectedRevision) throw new PersonalMemoryConflict();
  return profile;
}

async function restore(keep: Keep) {
  const restored = await keep.client.restore({ scope: keep.scope, path: keepProfilePath });
  if (restored.status !== 'ok') failed(restored, 'restore');
  return restored.value;
}

/**
 * Compare-and-swap replacement of the member's memory. Blank text moves the profile to Keep's trash, where it stays
 * recoverable for 7 days; it is not erased. Returns the previous content so callers can record the change.
 */
export async function replaceKeepMemory(keep: Keep, nextContent: string, expectedRevision: number) {
  const normalized = nextContent.trim() ? nextContent : '';
  const profile = await current(keep, expectedRevision);
  const previous = profile.kind === 'active' ? profile.text : '';
  if (!normalized) {
    if (profile.kind !== 'active') return { previous, memory: { content: '', revision: expectedRevision } };
    const deleted = await keep.client.delete({
      scope: keep.scope,
      path: keepProfilePath,
      expectedRevisionId: profile.head.revisionId,
    });
    if (deleted.status !== 'ok') failed(deleted, 'delete');
    return { previous, memory: { content: '', revision: keepRevision({ ...profile, kind: 'trashed' }) } };
  }
  if (profile.kind === 'active' && profile.text === normalized)
    return { previous, memory: { content: normalized, revision: expectedRevision } };
  const expectedRevisionId =
    profile.kind === 'empty'
      ? undefined
      : profile.kind === 'trashed'
        ? (await restore(keep)).head.revisionId
        : profile.head.revisionId;
  const idempotencyKey = randomUUID();
  const written = await once(() =>
    keep.client.write({
      scope: keep.scope,
      path: keepProfilePath,
      text: normalized,
      ...(expectedRevisionId === undefined ? {} : { expectedRevisionId }),
      idempotencyKey,
    }),
  );
  if (written.status !== 'ok') {
    // A deleted memory is restored only to be overwritten; if the write fails, put it back in the trash.
    if (profile.kind === 'trashed' && expectedRevisionId !== undefined)
      await keep.client.delete({ scope: keep.scope, path: keepProfilePath, expectedRevisionId });
    failed(written, 'write');
  }
  return { previous, memory: await readKeepMemory(keep) };
}

/** Undoes the last change: restores a trashed profile, or writes the previous revision's text as a new one. */
export async function undoKeepMemory(keep: Keep, expectedRevision: number) {
  const profile = await current(keep, expectedRevision);
  if (profile.kind === 'empty') throw new PersonalMemoryConflict();
  if (profile.kind === 'trashed') await restore(keep);
  else {
    const undone = await keep.client.undo({
      scope: keep.scope,
      path: keepProfilePath,
      expectedRevisionId: profile.head.revisionId,
    });
    if (undone.status !== 'ok') failed(undone, 'undo');
  }
  return { previous: profile.kind === 'active' ? profile.text : '', memory: await readKeepMemory(keep) };
}

/**
 * Permanently erases memory: the exact `text` everywhere in the profile, or the whole profile. Keep removes it from
 * every revision and the trash, so it cannot be undone.
 */
export async function forgetKeepMemory(keep: Keep, expectedRevision: number, text?: string) {
  const profile = await current(keep, expectedRevision);
  if (profile.kind === 'empty') return { previous: '', memory: { content: '', revision: 0 } };
  const forgotten = await keep.client.forget({
    scope: keep.scope,
    path: keepProfilePath,
    ...(text === undefined ? {} : { text }),
  });
  if (forgotten.status !== 'ok') failed(forgotten, 'forget');
  return { previous: profile.kind === 'active' ? profile.text : '', memory: await readKeepMemory(keep) };
}
