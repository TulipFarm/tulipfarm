/** Shared Postgres pool timeouts fail fast; SSL stays in `DATABASE_URL`, not code. */

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

/** Shared app pool tuning; migration pools override limits and statement timeout. */
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
