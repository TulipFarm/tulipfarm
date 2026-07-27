import type { Queryable as StorageQueryable, TransactionPort } from "@tulipfarm/storage";
import { Pool } from "pg";

let pool: Pool;

/**
 * Minimal query surface shared by `pg.Pool` (prod) and the PGlite test client,
 * so the migration runner and repos run identical SQL in both environments.
 */
export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

interface TransactionalQueryable extends Queryable {
  transaction<T>(callback: (tx: Queryable) => Promise<T>): Promise<T>;
}

interface ReleasableQueryable extends Queryable {
  release(): void;
}

interface ConnectableQueryable extends Queryable {
  connect(): Promise<ReleasableQueryable>;
}

function hasTransaction(q: Queryable): q is TransactionalQueryable {
  return typeof (q as { transaction?: unknown }).transaction === "function";
}

function hasConnect(q: Queryable): q is ConnectableQueryable {
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

/**
 * Adapts this app's `Queryable` to the `@tulipfarm/storage` transaction port, so storage-owned
 * repositories run on the same pool and the same transaction semantics as the app's own repos.
 */
export function transactionPort(database: Queryable): TransactionPort {
  return {
    withTransaction: (operation) =>
      withTransaction(database, (tx) => operation(tx as unknown as StorageQueryable)),
  };
}

export async function connectPg(): Promise<Pool> {
  pool = new Pool({ connectionString: process.env.DATABASE_URL as string });
  // Force a connection now so boot fails loud if Postgres is unreachable.
  await pool.query("SELECT 1");
  return pool;
}

export function getPool(): Pool {
  return pool;
}
