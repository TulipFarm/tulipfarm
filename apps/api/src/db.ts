import { pgPoolTuning } from "@tulipfarm/constants";
import { Pool } from "pg";
import {
  describeSeparation,
  migrationConnectionString,
  provisionRuntimeRole,
  runtimeConnectionOptions,
} from "./db-roles";

let pool: Pool;
let runtimeOptions: string | undefined;

export type {
  ConnectableQueryable,
  Queryable,
  ReleasableQueryable,
} from "@tulipfarm/storage";
export {
  ambientTransactionPort,
  hasConnect,
  transactionPort,
  withTransaction,
} from "@tulipfarm/storage";

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
