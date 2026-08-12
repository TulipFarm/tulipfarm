/**
 * One pool configuration for every process that talks to Postgres.
 *
 * All three services previously built `new Pool({ connectionString })` and took node-postgres'
 * defaults. Two of those defaults are actively dangerous away from a local Docker container:
 *
 * - `connectionTimeoutMillis` defaults to **0 — wait forever**. If Postgres is unreachable or the
 *   connection limit is exhausted, requests queue indefinitely instead of failing, so the service
 *   stops responding without ever reporting an error.
 * - There is no `statement_timeout` or `idle_in_transaction_session_timeout`, so one runaway query
 *   or one leaked transaction holds a connection — and any locks it took — until the process dies.
 *
 * SSL is deliberately *not* configured here. `pg` already parses `sslmode` out of the connection
 * string, so pointing `DATABASE_URL` at a managed host works unchanged. Note that the current
 * `pg-connection-string` treats `sslmode=require` as `verify-full` (full certificate
 * verification); a host with a private CA needs `sslmode=no-verify` or a `ca` in the URL. Setting
 * `ssl` here would silently override that choice for every deployment.
 */

export interface PgPoolTuning {
  max: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
  statement_timeout?: number;
  idle_in_transaction_session_timeout?: number;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

/** Default ceiling per process. Three services plus pg-boss share the server's `max_connections`,
 *  so this is per-process headroom, not a target. */
export const DEFAULT_PG_POOL_MAX = 10;

/** Long enough for a heavy analytical query, short enough that a runaway one cannot outlive a
 *  deployment. `PG_STATEMENT_TIMEOUT_MS=0` disables it. */
export const DEFAULT_STATEMENT_TIMEOUT_MS = 60_000;

/** An open transaction holds its locks. A minute is far longer than any legitimate one here. */
export const DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS = 60_000;

/** Fail fast instead of queueing forever when the database is unreachable or saturated. */
export const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;

/**
 * Pool tuning shared by the API, worker, and integration worker.
 *
 * `overrides` exists for the migration pool, which needs a small `max` and no statement timeout —
 * a `CREATE INDEX` on a large table legitimately runs for minutes and must not be killed halfway.
 */
export function pgPoolTuning(overrides: Partial<PgPoolTuning> = {}): PgPoolTuning {
  const statementTimeout = envInt("PG_STATEMENT_TIMEOUT_MS", DEFAULT_STATEMENT_TIMEOUT_MS);
  const idleInTransaction = envInt(
    "PG_IDLE_IN_TRANSACTION_TIMEOUT_MS",
    DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS
  );
  return {
    max: envInt("PG_POOL_MAX", DEFAULT_PG_POOL_MAX),
    idleTimeoutMillis: envInt("PG_IDLE_TIMEOUT_MS", 30_000),
    connectionTimeoutMillis: envInt("PG_CONNECTION_TIMEOUT_MS", DEFAULT_CONNECTION_TIMEOUT_MS),
    // 0 means "no timeout" in Postgres, so omit the key entirely rather than sending 0 — that
    // keeps the server default in play instead of overriding it with a disabled timeout.
    ...(statementTimeout > 0 ? { statement_timeout: statementTimeout } : {}),
    ...(idleInTransaction > 0 ? { idle_in_transaction_session_timeout: idleInTransaction } : {}),
    ...overrides,
  };
}
