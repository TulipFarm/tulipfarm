/** Persisted query data older than this, by its original read time, is never shown. */
export const persistedMaxAge = 24 * 60 * 60_000;

export const persistedAgeValid = (updatedAt: number, now = Date.now()) =>
  updatedAt <= now && now - updatedAt < persistedMaxAge;

/** Opens one IndexedDB database lazily and shares the connection. */
export function indexedDatabase(
  factory: IDBFactory | undefined | (() => IDBFactory | undefined),
  name: string,
  version: number,
  upgrade: (db: IDBDatabase) => void,
) {
  let opening: Promise<IDBDatabase> | undefined;
  return () => {
    if (!opening)
      opening = new Promise<IDBDatabase>((resolve, reject) => {
        const resolved = typeof factory === 'function' ? factory() : factory;
        if (!resolved) {
          reject(new Error('IndexedDB unavailable'));
          return;
        }
        const request = resolved.open(name, version);
        request.onupgradeneeded = () => upgrade(request.result);
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('IndexedDB blocked'));
        request.onsuccess = () => {
          request.result.onversionchange = () => request.result.close();
          resolve(request.result);
        };
      });
    return opening;
  };
}

export function transactionDone(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
  });
}
