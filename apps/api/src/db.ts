import { pgPoolTuning } from "@tulipfarm/constants";
import type { Queryable as StorageQueryable, TransactionPort } from "@tulipfarm/storage";
import { Pool } from "pg";
import {
  describeSeparation,
  migrationConnectionString,
  provisionRuntimeRole,
  runtimeConnectionOptions,
} from "./db-roles";

let pool: Pool;
let runtimeOptions: string | undefined;

/** Minimal query surface shared by pg.Pool and PGlite. */
export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

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

/** Adapts this app's Queryable so storage repos share the caller's transaction. */
export function transactionPort(database: Queryable): TransactionPort {
  return {
    withTransaction: (operation) =>
      withTransaction(database, (tx) => operation(tx as unknown as StorageQueryable)),
  };
}

/** Runs storage repositories inside an existing app-owned transaction. */
export function ambientTransactionPort(transaction: Queryable): TransactionPort {
  return {
    withTransaction: (operation) => operation(transaction as unknown as StorageQueryable),
  };
}

/** Owner pool used only for migrations. */
export async function connectPg(): Promise<Pool> {
  pool = new Pool({
    connectionString: migrationConnectionString(),
    // No statement timeout: large index builds may run for minutes.
    // Keep idle timeout off because the migration lock is session-scoped.
    ...pgPoolTuning({ max: 2, statement_timeout: 0, idle_in_transaction_session_timeout: 0 }),
  });
  // Force a connection now so boot fails loud if Postgres is unreachable.
  await pool.query("SELECT 1");
  return pool;
}

/** Switches from owner to runtime pool after migrations; the owner secret is then forgotten. */
export async function startRuntimePool(
  migrationPool: Pool,
  log: (msg: string) => void = console.log
): Promise<Pool> {
  const separation = await provisionRuntimeRole(migrationPool);
  log(describeSeparation(separation));

  runtimeOptions = runtimeConnectionOptions(separation);
  const options = runtimeOptions;
  pool = new Pool({
    connectionString: process.env.DATABASE_URL as string,
    ...pgPoolTuning(),
    ...(options === undefined ? {} : { options }),
  });
  try {
    // Verify a real table read, not `SELECT 1`, so missing role grants fail at boot.
    await pool.query("SELECT 1 FROM schema_version LIMIT 1");
  } catch (error) {
    if (options === undefined) throw error;
    // If runtime role setup fails, owner mode is safer than failing boot; audit remains enforced.
    log(
      `runtime role unusable (${error instanceof Error ? error.message : String(error)}); ` +
        "falling back to the owner connection"
    );
    await pool.end().catch(() => {});
    runtimeOptions = undefined;
    pool = new Pool({
      connectionString: process.env.DATABASE_URL as string,
      ...pgPoolTuning(),
    });
    await pool.query("SELECT 1 FROM schema_version LIMIT 1");
  }
  await migrationPool.end();
  return pool;
}

export function getPool(): Pool {
  return pool;
}

/** libpq options that pin the runtime role, for separately created workers. */
export function runtimePoolOptions(): string | undefined {
  return runtimeOptions;
}
