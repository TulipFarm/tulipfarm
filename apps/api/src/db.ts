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

export interface ReleasableQueryable extends Queryable {
  release(): void;
}

export interface ConnectableQueryable extends Queryable {
  connect(): Promise<ReleasableQueryable>;
}

function hasTransaction(q: Queryable): q is TransactionalQueryable {
  return typeof (q as { transaction?: unknown }).transaction === "function";
}

/**
 * True for a `pg.Pool`, false for the PGlite test client. Callers that need a *session* — an
 * advisory lock, `SET LOCAL`, anything whose scope is the connection rather than the statement —
 * must check this and take a dedicated client, because `Pool.query` picks an arbitrary connection
 * per call. PGlite needs no such check: it is a single connection already.
 */
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

/**
 * Runs storage repositories on an already-open transaction instead of opening a new one, so an
 * app-owned write and a storage-owned write can share a single commit. `transactionPort` cannot do
 * this: a transaction handle has neither `.transaction` nor `.connect`, so it would be rejected.
 */
export function ambientTransactionPort(transaction: Queryable): TransactionPort {
  return {
    withTransaction: (operation) => operation(transaction as unknown as StorageQueryable),
  };
}

/**
 * The pool that runs migrations: the *owner* connection, which may be a different role from the
 * one serving traffic. Kept small and short-lived — `startRuntimePool` closes it once the schema
 * is current.
 */
export async function connectPg(): Promise<Pool> {
  pool = new Pool({
    connectionString: migrationConnectionString(),
    // No statement timeout: a `CREATE INDEX` on a large table legitimately runs for minutes and
    // must not be killed halfway. Small `max` because migrations use one dedicated connection.
    //
    // The idle timeout is off for a sharper reason: the migration lock is a *session* advisory
    // lock. If the server killed an idle-in-transaction migration session, it would release that
    // lock as well, and a peer replica would start migrating on top of a half-applied one. Safe
    // today because no migration does JS work between statements — but that is a property of the
    // current migration list, not something this pool should depend on.
    ...pgPoolTuning({ max: 2, statement_timeout: 0, idle_in_transaction_session_timeout: 0 }),
  });
  // Force a connection now so boot fails loud if Postgres is unreachable.
  await pool.query("SELECT 1");
  return pool;
}

/**
 * Swaps the owner connection for the runtime one, once migrations are done.
 *
 * A separate pool rather than a role switch on the existing one, because connections opened before
 * the switch would keep the owner's privileges and be indistinguishable afterwards. Closing the
 * migration pool guarantees no such connection outlives this call.
 */
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
    // Reads a table the application genuinely needs, not `SELECT 1`. `SELECT 1` requires no object
    // privilege at all, so a role that was created but never successfully granted anything would
    // sail through it and then fail every real request. This proves two things at once: the role
    // is assumable (with `options` set, one that is not fails the connection outright) and it can
    // actually read application data.
    await pool.query("SELECT 1 FROM schema_version LIMIT 1");
  } catch (error) {
    if (options === undefined) throw error;
    // The role exists but cannot be used. Running as the owner is strictly better than not running
    // at all, and the audit trigger — which binds even a superuser — remains the real backstop.
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

/**
 * The libpq `options` string that pins the runtime role, or `undefined` when no separation is in
 * effect. Exposed so a *separate* pool — one that cannot share this module's — still connects with
 * the same privileges. Returning `undefined` rather than a role name matters: passing a role that
 * does not exist fails the connection outright, so callers must not guess.
 */
export function runtimePoolOptions(): string | undefined {
  return runtimeOptions;
}
