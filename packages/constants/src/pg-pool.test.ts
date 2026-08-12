import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_CONNECTION_TIMEOUT_MS,
  DEFAULT_PG_POOL_MAX,
  DEFAULT_STATEMENT_TIMEOUT_MS,
  pgPoolTuning,
} from "./pg-pool";

const TUNING_VARS = [
  "PG_POOL_MAX",
  "PG_IDLE_TIMEOUT_MS",
  "PG_CONNECTION_TIMEOUT_MS",
  "PG_STATEMENT_TIMEOUT_MS",
  "PG_IDLE_IN_TRANSACTION_TIMEOUT_MS",
];

afterEach(() => {
  for (const name of TUNING_VARS) delete process.env[name];
});

describe("pgPoolTuning", () => {
  it("never leaves the connection timeout at node-postgres' wait-forever default", () => {
    // The single most important value here: 0 means requests queue silently instead of failing.
    const tuning = pgPoolTuning();

    expect(tuning.connectionTimeoutMillis).toBe(DEFAULT_CONNECTION_TIMEOUT_MS);
    expect(tuning.connectionTimeoutMillis).toBeGreaterThan(0);
  });

  it("bounds statements and idle transactions by default", () => {
    const tuning = pgPoolTuning();

    expect(tuning.statement_timeout).toBe(DEFAULT_STATEMENT_TIMEOUT_MS);
    expect(tuning.idle_in_transaction_session_timeout).toBeGreaterThan(0);
    expect(tuning.max).toBe(DEFAULT_PG_POOL_MAX);
  });

  it("reads overrides from the environment", () => {
    process.env.PG_POOL_MAX = "42";
    process.env.PG_CONNECTION_TIMEOUT_MS = "1500";

    const tuning = pgPoolTuning();

    expect(tuning.max).toBe(42);
    expect(tuning.connectionTimeoutMillis).toBe(1500);
  });

  it("omits a timeout set to 0 rather than sending it to Postgres", () => {
    // Postgres reads 0 as "no timeout"; omitting the key keeps the server's own default instead.
    process.env.PG_STATEMENT_TIMEOUT_MS = "0";

    const tuning = pgPoolTuning();

    expect("statement_timeout" in tuning).toBe(false);
  });

  it("ignores a malformed value instead of producing NaN", () => {
    process.env.PG_POOL_MAX = "not-a-number";

    expect(pgPoolTuning().max).toBe(DEFAULT_PG_POOL_MAX);
  });

  it("lets the migration pool opt out of the statement timeout", () => {
    // A `CREATE INDEX` on a large table runs for minutes and must not be killed halfway.
    const tuning = pgPoolTuning({ max: 2, statement_timeout: 0 });

    expect(tuning.max).toBe(2);
    expect(tuning.statement_timeout).toBe(0);
  });

  it("does not configure SSL, leaving sslmode in the connection string authoritative", () => {
    // Overriding `ssl` here would silently weaken or break every managed-host deployment.
    expect("ssl" in pgPoolTuning()).toBe(false);
  });
});
