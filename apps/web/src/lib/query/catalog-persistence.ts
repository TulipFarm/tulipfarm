import { z } from 'zod';
import { modelCatalogSchema, type ModelCatalog } from '@tulipfarm/config/model-catalog';
import { indexedDatabase, persistedAgeValid, persistedMaxAge, transactionDone } from './persistence';
import type { WorkspaceScope } from './scope';

export const catalogMaxAge = persistedMaxAge;
const snapshotSchema = z.strictObject({
  version: z.literal(1),
  userId: z.string(),
  workspaceId: z.string(),
  membershipId: z.string(),
  updatedAt: z.number().finite().nonnegative(),
  data: modelCatalogSchema,
});
const snapshotKey = (scope: WorkspaceScope) => JSON.stringify([scope.userId, scope.workspaceId, scope.membershipId]);

export function parseCatalogSnapshot(value: unknown, scope: WorkspaceScope, now = Date.now()) {
  const parsed = snapshotSchema.safeParse(value);
  if (!parsed.success) return null;
  const snapshot = parsed.data;
  return snapshot.userId === scope.userId &&
    snapshot.workspaceId === scope.workspaceId &&
    snapshot.membershipId === scope.membershipId &&
    persistedAgeValid(snapshot.updatedAt, now)
    ? snapshot
    : null;
}

/** IDB transactions serialize writes and deletion; current() also fences delayed opens. */
export function createCatalogPersistence(factory: IDBFactory | undefined = globalThis.indexedDB) {
  const open = indexedDatabase(factory, 'tulipfarm-model-catalog', 1, db => {
    db.createObjectStore('catalogs');
  });
  const prune = (store: IDBObjectStore, remove: (value: z.infer<typeof snapshotSchema>) => boolean) => {
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const parsed = snapshotSchema.safeParse(cursor.value);
      if (!parsed.success || !persistedAgeValid(parsed.data.updatedAt) || remove(parsed.data)) cursor.delete();
      cursor.continue();
    };
  };
  return {
    async restore(scope: WorkspaceScope, current: () => boolean) {
      try {
        const db = await open();
        if (!current()) return null;
        const transaction = db.transaction('catalogs', 'readwrite');
        const store = transaction.objectStore('catalogs');
        const request = store.get(snapshotKey(scope));
        prune(store, () => false);
        await transactionDone(transaction);
        const value: unknown = request.result;
        return current() ? parseCatalogSnapshot(value, scope) : null;
      } catch {
        return null;
      }
    },
    async save(scope: WorkspaceScope, data: ModelCatalog, updatedAt: number, current: () => boolean) {
      try {
        const value = parseCatalogSnapshot(
          {
            version: 1,
            userId: scope.userId,
            workspaceId: scope.workspaceId,
            membershipId: scope.membershipId,
            updatedAt,
            data,
          },
          scope,
        );
        if (!value) return;
        const db = await open();
        if (!current()) return;
        const transaction = db.transaction('catalogs', 'readwrite');
        transaction.objectStore('catalogs').put(value, snapshotKey(scope));
        await transactionDone(transaction);
      } catch {
        /* Persistence must not prevent memory-only reads. */
      }
    },
    async clear(userId: string, workspaceId?: string) {
      try {
        const db = await open();
        const transaction = db.transaction('catalogs', 'readwrite');
        prune(
          transaction.objectStore('catalogs'),
          value => value.userId === userId && (workspaceId === undefined || value.workspaceId === workspaceId),
        );
        await transactionDone(transaction);
      } catch {
        /* Storage can be blocked or unavailable. */
      }
    },
  };
}
