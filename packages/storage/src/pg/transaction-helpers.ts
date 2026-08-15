import type { Queryable, TransactionPort } from "../ports/transaction";

interface TransactionalQueryable extends Queryable {
  transaction<T>(callback: (tx: Queryable) => Promise<T>): Promise<T>;
}

export interface ReleasableQueryable extends Queryable {
  release(): void;
}

export interface ConnectableQueryable extends Queryable {
  connect(): Promise<ReleasableQueryable>;
}

function hasTransaction(q: Queryable): q is TransactionalQueryable {
  return typeof (q as { transaction?: unknown }).transaction === "function";
}

/** True only for clients that support session-scoped PostgreSQL features. */
export function hasConnect(q: Queryable): q is ConnectableQueryable {
  return typeof (q as { connect?: unknown }).connect === "function";
}

/** Run work on one transaction for both PGlite tests and the production pg Pool. */
export async function withTransaction<T>(
  q: Queryable,
  callback: (tx: Queryable) => Promise<T>
): Promise<T> {
  if (hasTransaction(q)) return q.transaction(callback);
  if (!hasConnect(q)) throw new Error("Queryable does not support transactions");

  const client = await q.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Adapts a plain `Queryable` to the `TransactionPort` repositories are written against. */
export function transactionPort(database: Queryable): TransactionPort {
  return {
    withTransaction: (fn) => withTransaction(database, (tx) => fn(tx)),
  };
}

/**
 * A `TransactionPort` for code already inside a transaction: it reuses the caller's handle rather
 * than opening a nested one, which PostgreSQL would reject.
 */
export function ambientTransactionPort(transaction: Queryable): TransactionPort {
  return {
    withTransaction: (fn) => fn(transaction),
  };
}
