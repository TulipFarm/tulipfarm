import { pgPoolTuning } from "@tulipfarm/constants";
import type { Queryable as StorageQueryable, TransactionPort } from "@tulipfarm/storage";
import { Pool } from "pg";

/** Local query shape; apps cannot import each other, and storage owns only neutral ports. */
export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

interface ReleasableQueryable extends Queryable {
  release(): void;
}

interface ConnectableQueryable extends Queryable {
  connect(): Promise<ReleasableQueryable>;
}

function hasConnect(q: Queryable): q is ConnectableQueryable {
  return typeof (q as { connect?: unknown }).connect === "function";
}

/** Run work on one transaction, so a claim and its evidence commit together or not at all. */
export async function withTransaction<T>(
  q: Queryable,
  callback: (tx: Queryable) => Promise<T>
): Promise<T> {
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

/** Adapts this app's `Queryable` to the `@tulipfarm/storage` transaction port. */
export function transactionPort(database: Queryable): TransactionPort {
  return {
    withTransaction: (operation) =>
      withTransaction(database, (tx) => operation(tx as unknown as StorageQueryable)),
  };
}

export async function connectPg(connectionString: string): Promise<Pool> {
  const pool = new Pool({ connectionString, ...pgPoolTuning() });
  // Force a connection now so boot fails loud if Postgres is unreachable.
  await pool.query("SELECT 1");
  return pool;
}
