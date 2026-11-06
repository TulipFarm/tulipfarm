import { hashKey, type QueryKey } from '@tanstack/react-query';
import { z, type ZodType } from 'zod';
import { indexedDatabase, persistedAgeValid, transactionDone } from './persistence';
import type { SessionIdentity, WorkspaceScope } from './scope';

/** A first-page read a feature lets the next page load show from disk while the network answers. */
export type PersistedRead = { name: string; limit: number; match: (key: QueryKey) => boolean; schema: ZodType };
export type RestoredRead = { key: QueryKey; data: unknown; updatedAt: number };
export type AdmissionSnapshot<T> = { sessionId: string; expiresAt: number; updatedAt: number; read: T };

// Sizes count JSON characters. Larger reads are not worth the disk or the parse on the next load.
const maxReadSize = 1_000_000;
const maxUserSize = 3_000_000;
// Rewrite an unchanged admission this often, so a daily visitor keeps one younger than the maximum age.
const admissionRefresh = 60 * 60_000;

const timestamp = z.number().finite().nonnegative();
const scopeShape = {
  version: z.literal(1),
  userId: z.string().min(1),
  workspaceId: z.string().min(1),
  membershipId: z.string().min(1),
  name: z.string(),
  key: z.array(z.unknown()),
  updatedAt: timestamp,
};
const readSchema = z.strictObject({ ...scopeShape, data: z.unknown() });
const indexSchema = z.strictObject({ ...scopeShape, savedAt: timestamp, size: z.number().int().nonnegative() });
const admissionSchema = z.strictObject({
  version: z.literal(1),
  userId: z.string().min(1),
  sessionId: z.string().min(1),
  slug: z.string().min(1),
  workspaceId: z.string().min(1),
  expiresAt: timestamp,
  updatedAt: timestamp,
  read: z.unknown(),
});

const readId = (scope: WorkspaceScope, key: QueryKey) =>
  JSON.stringify([scope.userId, scope.workspaceId, scope.membershipId, hashKey(key)]);
const admissionId = (userId: string, slug: string) => JSON.stringify([userId, slug]);
// Ids are JSON arrays of strings, so every id under a scope shares this prefix.
const under = (parts: string[]) => {
  const prefix = `${JSON.stringify(parts).slice(0, -1)},`;
  return IDBKeyRange.bound(prefix, `${prefix}\uffff`);
};
const startsWith = (key: readonly unknown[], prefix: QueryKey) =>
  prefix.length <= key.length && hashKey(key.slice(0, prefix.length)) === hashKey(prefix);
const sameScope = (a: WorkspaceScope, b: WorkspaceScope) =>
  a.userId === b.userId && a.workspaceId === b.workspaceId && a.membershipId === b.membershipId;

/**
 * Chat, project and workspace-shell reads kept on disk for 24 hours, so a return visit can show them
 * before the session and membership checks finish. Everything is keyed by user, workspace and
 * membership, validated with the feature's response schema on the way in and out, and cleared on
 * sign-out, 401 and workspace denial. IndexedDB failures leave normal network reads available.
 */
export function createReadPersistence(factory: () => IDBFactory | undefined = () => globalThis.indexedDB) {
  const open = indexedDatabase(factory, 'tulipfarm-query-cache', 1, db => {
    db.createObjectStore('reads');
    db.createObjectStore('index');
    db.createObjectStore('admissions');
  });
  let definitions: readonly PersistedRead[] = [];
  let configured = false;
  let markConfigured!: () => void;
  const configuration = new Promise<void>(resolve => (markConfigured = resolve));
  const savedAdmissions = new Map<string, { value: string; at: number }>();
  let provisional: {
    identity: SessionIdentity;
    scope: WorkspaceScope;
    reads: RestoredRead[];
    confirmed: boolean;
  } | null = null;

  function prune(transaction: IDBTransaction, userId: string) {
    const index = transaction.objectStore('index');
    const values = index.getAll(under([userId]));
    const ids = index.getAllKeys(under([userId]));
    ids.onsuccess = () => {
      const remove = (id: IDBValidKey) => {
        index.delete(id);
        transaction.objectStore('reads').delete(id);
      };
      const kept: { id: IDBValidKey; value: z.infer<typeof indexSchema> }[] = [];
      ids.result.forEach((id, position) => {
        const parsed = indexSchema.safeParse(values.result[position]);
        if (parsed.success && persistedAgeValid(parsed.data.updatedAt)) kept.push({ id, value: parsed.data });
        else remove(id);
      });
      kept.sort((a, b) => b.value.savedAt - a.value.savedAt);
      const counts = new Map<string, number>();
      let size = 0;
      for (const { id, value } of kept) {
        const group = JSON.stringify([value.workspaceId, value.membershipId, value.name]);
        const count = (counts.get(group) ?? 0) + 1;
        counts.set(group, count);
        size += value.size;
        const limit = definitions.find(definition => definition.name === value.name)?.limit ?? 0;
        if (count > limit || size > maxUserSize) remove(id);
      }
    };
  }

  return {
    /** Features name the reads that may persist; nothing persists before this is called. */
    configure(next: readonly PersistedRead[]) {
      definitions = next;
      configured = true;
      markConfigured();
    },
    /** Pending until `configure` runs, which can be after the first reads succeed; null once it has. */
    untilConfigured: () => (configured ? null : configuration),
    persists: (key: QueryKey) => definitions.some(definition => definition.match(key)),
    async restore(scope: WorkspaceScope, known: readonly PersistedRead[] = definitions): Promise<RestoredRead[]> {
      try {
        const db = await open();
        const transaction = db.transaction('reads', 'readonly');
        const request = transaction
          .objectStore('reads')
          .getAll(under([scope.userId, scope.workspaceId, scope.membershipId]));
        await transactionDone(transaction);
        const restored: RestoredRead[] = [];
        for (const value of request.result) {
          const parsed = readSchema.safeParse(value);
          if (
            !parsed.success ||
            !sameScope({ kind: 'workspace', ...parsed.data }, scope) ||
            !persistedAgeValid(parsed.data.updatedAt)
          )
            continue;
          const definition = known.find(item => item.name === parsed.data.name);
          if (!definition?.match(parsed.data.key)) continue;
          const data = definition.schema.safeParse(parsed.data.data);
          if (data.success) restored.push({ key: parsed.data.key, data: data.data, updatedAt: parsed.data.updatedAt });
        }
        return restored;
      } catch {
        return [];
      }
    },
    async save(scope: WorkspaceScope, key: QueryKey, data: unknown, updatedAt: number, current: () => boolean) {
      try {
        const definition = definitions.find(item => item.match(key));
        const parsed = definition?.schema.safeParse(data);
        if (!definition || !parsed?.success || !persistedAgeValid(updatedAt)) return;
        const size = JSON.stringify(parsed.data).length;
        if (size > maxReadSize) return;
        const db = await open();
        if (!current()) return;
        const transaction = db.transaction(['reads', 'index'], 'readwrite');
        const id = readId(scope, key);
        const envelope = {
          version: 1 as const,
          userId: scope.userId,
          workspaceId: scope.workspaceId,
          membershipId: scope.membershipId,
          name: definition.name,
          key: [...key],
          updatedAt,
        };
        transaction.objectStore('reads').put({ ...envelope, data: parsed.data }, id);
        transaction.objectStore('index').put({ ...envelope, savedAt: Date.now(), size }, id);
        prune(transaction, scope.userId);
        await transactionDone(transaction);
      } catch {
        /* Persistence must not prevent memory-only reads. */
      }
    },
    /** Drops persisted reads under these feature-key prefixes, such as after a concealing change or a denied read. */
    async remove(scope: WorkspaceScope, prefixes: readonly QueryKey[]) {
      try {
        const db = await open();
        const transaction = db.transaction(['reads', 'index'], 'readwrite');
        const request = transaction.objectStore('index').openCursor(under([scope.userId, scope.workspaceId]));
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          const parsed = indexSchema.safeParse(cursor.value);
          if (
            !parsed.success ||
            (parsed.data.membershipId === scope.membershipId &&
              prefixes.some(prefix => startsWith(parsed.data.key, prefix)))
          ) {
            cursor.delete();
            transaction.objectStore('reads').delete(cursor.primaryKey);
          }
          cursor.continue();
        };
        await transactionDone(transaction);
      } catch {
        /* Storage can be blocked or unavailable. */
      }
    },
    /** Without a user, clears every user's data, as sign-out does. */
    async clear(userId?: string, workspaceId?: string) {
      savedAdmissions.clear();
      if (provisional && (userId === undefined || provisional.scope.userId === userId)) provisional.reads = [];
      try {
        const db = await open();
        const transaction = db.transaction(['reads', 'index', 'admissions'], 'readwrite');
        if (userId === undefined) {
          for (const name of ['reads', 'index', 'admissions']) transaction.objectStore(name).clear();
        } else {
          const range = under(workspaceId === undefined ? [userId] : [userId, workspaceId]);
          transaction.objectStore('reads').delete(range);
          transaction.objectStore('index').delete(range);
          const request = transaction.objectStore('admissions').openCursor(under([userId]));
          request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) return;
            const parsed = admissionSchema.safeParse(cursor.value);
            if (!parsed.success || workspaceId === undefined || parsed.data.workspaceId === workspaceId)
              cursor.delete();
            cursor.continue();
          };
        }
        await transactionDone(transaction);
      } catch {
        /* Storage can be blocked or unavailable. */
      }
    },
    /** The last confirmed workspace admission for this person and slug, read for a provisional render. */
    async saveAdmission(
      identity: SessionIdentity,
      slug: string,
      workspaceId: string,
      expiresAt: number,
      read: unknown,
    ) {
      try {
        const id = admissionId(identity.userId, slug);
        const value = JSON.stringify([identity.sessionId, workspaceId, expiresAt, read]);
        const previous = savedAdmissions.get(id);
        if (previous?.value === value && Date.now() - previous.at < admissionRefresh) return;
        savedAdmissions.set(id, { value, at: Date.now() });
        const db = await open();
        const transaction = db.transaction('admissions', 'readwrite');
        transaction.objectStore('admissions').put(
          {
            version: 1,
            userId: identity.userId,
            sessionId: identity.sessionId,
            slug,
            workspaceId,
            expiresAt,
            updatedAt: Date.now(),
            read,
          },
          id,
        );
        await transactionDone(transaction);
      } catch {
        /* Storage can be blocked or unavailable. */
      }
    },
    async restoreAdmission<T>(userId: string, slug: string, schema: ZodType<T>): Promise<AdmissionSnapshot<T> | null> {
      try {
        const db = await open();
        const transaction = db.transaction('admissions', 'readonly');
        const request = transaction.objectStore('admissions').get(admissionId(userId, slug));
        await transactionDone(transaction);
        const parsed = admissionSchema.safeParse(request.result);
        if (
          !parsed.success ||
          parsed.data.userId !== userId ||
          parsed.data.slug !== slug ||
          !persistedAgeValid(parsed.data.updatedAt) ||
          parsed.data.expiresAt <= Date.now()
        )
          return null;
        const read = schema.safeParse(parsed.data.read);
        return read.success
          ? {
              sessionId: parsed.data.sessionId,
              expiresAt: parsed.data.expiresAt,
              updatedAt: parsed.data.updatedAt,
              read: read.data,
            }
          : null;
      } catch {
        return null;
      }
    },
    async forgetAdmission(userId: string, slug: string) {
      savedAdmissions.delete(admissionId(userId, slug));
      try {
        const db = await open();
        const transaction = db.transaction('admissions', 'readwrite');
        transaction.objectStore('admissions').delete(admissionId(userId, slug));
        await transactionDone(transaction);
      } catch {
        /* Storage can be blocked or unavailable. */
      }
    },
    /** A workspace shown from disk before its admission is confirmed. Its reads seed the session client once. */
    beginProvisional(identity: SessionIdentity, scope: WorkspaceScope, reads: RestoredRead[]) {
      provisional = { identity, scope, reads, confirmed: false };
    },
    confirmProvisional(scope: WorkspaceScope) {
      if (provisional && sameScope(provisional.scope, scope)) provisional.confirmed = true;
    },
    endProvisional() {
      provisional = null;
    },
    /** True while a scope is shown from disk and unconfirmed; nothing read in it is saved until confirmed. */
    unconfirmed: (scope: WorkspaceScope) =>
      !!provisional && !provisional.confirmed && sameScope(provisional.scope, scope),
    provisionalReads(identity: SessionIdentity, scope: WorkspaceScope) {
      return provisional &&
        provisional.identity.userId === identity.userId &&
        provisional.identity.sessionId === identity.sessionId &&
        sameScope(provisional.scope, scope)
        ? provisional.reads
        : [];
    },
  };
}

export const persistedReads = createReadPersistence();
