import { z } from 'zod';
import { modelCatalogSchema, type ModelCatalog } from '@tulipfarm/config/model-catalog';
import type { WorkspaceScope } from './scope';

export const catalogMaxAge = 24 * 60 * 60_000;
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
    snapshot.updatedAt <= now &&
    now - snapshot.updatedAt < catalogMaxAge
    ? snapshot
    : null;
}

/** IDB transactions serialize writes and deletion; current() also fences delayed opens. */
export function createCatalogPersistence(factory: IDBFactory | undefined = globalThis.indexedDB) {
  let opening: Promise<IDBDatabase> | undefined;
  const open = () => {
    if (!opening)
      opening = new Promise<IDBDatabase>((resolve, reject) => {
        if (!factory) {
          reject(new Error('IndexedDB unavailable'));
          return;
        }
        const request = factory.open('tulipfarm-model-catalog', 1);
        request.onupgradeneeded = () => {
          request.result.createObjectStore('catalogs');
        };
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('IndexedDB blocked'));
        request.onsuccess = () => {
          request.result.onversionchange = () => request.result.close();
          resolve(request.result);
        };
      });
    return opening;
  };
  const prune = (store: IDBObjectStore, remove: (value: z.infer<typeof snapshotSchema>) => boolean) => {
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const parsed = snapshotSchema.safeParse(cursor.value);
      if (
        !parsed.success ||
        parsed.data.updatedAt > Date.now() ||
        Date.now() - parsed.data.updatedAt >= catalogMaxAge ||
        remove(parsed.data)
      )
        cursor.delete();
      cursor.continue();
    };
  };
  return {
    async restore(scope: WorkspaceScope, current: () => boolean) {
      try {
        const db = await open();
        if (!current()) return null;
        const value = await new Promise<unknown>((resolve, reject) => {
          const transaction = db.transaction('catalogs', 'readwrite');
          const store = transaction.objectStore('catalogs');
          const request = store.get(snapshotKey(scope));
          let result: unknown;
          request.onsuccess = () => {
            result = request.result;
          };
          prune(store, () => false);
          transaction.oncomplete = () => resolve(result);
          transaction.onabort = () => reject(transaction.error);
          transaction.onerror = () => reject(transaction.error);
        });
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
        await new Promise<void>((resolve, reject) => {
          const transaction = db.transaction('catalogs', 'readwrite');
          transaction.objectStore('catalogs').put(value, snapshotKey(scope));
          transaction.oncomplete = () => resolve();
          transaction.onabort = () => reject(transaction.error);
          transaction.onerror = () => reject(transaction.error);
        });
      } catch {
        /* Persistence must not prevent memory-only reads. */
      }
    },
    async clear(userId: string, workspaceId?: string) {
      try {
        const db = await open();
        await new Promise<void>((resolve, reject) => {
          const transaction = db.transaction('catalogs', 'readwrite');
          prune(
            transaction.objectStore('catalogs'),
            value => value.userId === userId && (workspaceId === undefined || value.workspaceId === workspaceId),
          );
          transaction.oncomplete = () => resolve();
          transaction.onabort = () => reject(transaction.error);
          transaction.onerror = () => reject(transaction.error);
        });
      } catch {
        /* Storage can be blocked or unavailable. */
      }
    },
  };
}
