import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import { describe, expect, it } from "vitest";
import { loadConfig, WorkerConfigError } from "./config";

const MINIMAL = {
  DATABASE_URL: "postgres://localhost:5432/tulipfarm",
  INTERNAL_API_URL: "http://api:4010",
  WORKER_API_CREDENTIAL: "tfc_client.secret",
};

describe("loadConfig", () => {
  it("applies documented defaults when only the required variables are set", () => {
    const config = loadConfig(MINIMAL);

    expect(config).toMatchObject({
      databaseUrl: MINIMAL.DATABASE_URL,
      businessId: DEPLOYMENT_BUSINESS_ID,
      port: 4020,
      runPollMs: 1_000,
      waitSweepMs: 5_000,
      outboxPollMs: 1_000,
      batchSize: 25,
      leaseDurationMs: 60_000,
      runMaxLifetimeMs: 900_000,
      drainTimeoutMs: 15_000,
      maintenance: false,
    });
    expect(config.owner).not.toEqual("");
  });

  it("refuses to start without a database url", () => {
    expect(() => loadConfig({})).toThrow(WorkerConfigError);
    expect(() => loadConfig({ DATABASE_URL: "   " })).toThrow("DATABASE_URL is required");
  });

  it("refuses to start without a reachable turn host", () => {
    // Discovering this after a Chat Run is claimed would cost a participant a turn to learn
    // something the deployment already knew.
    const { INTERNAL_API_URL, ...withoutUrl } = MINIMAL;
    expect(() => loadConfig(withoutUrl)).toThrow("INTERNAL_API_URL is required");

    const { WORKER_API_CREDENTIAL, ...withoutCredential } = MINIMAL;
    expect(() => loadConfig(withoutCredential)).toThrow("WORKER_API_CREDENTIAL is required");
  });

  it("normalises a trailing slash on the turn host, so paths do not double up", () => {
    expect(loadConfig({ ...MINIMAL, INTERNAL_API_URL: "http://api:4010/" }).internalApiUrl).toBe(
      "http://api:4010"
    );
  });

  it("rejects a non-integer interval instead of coercing it", () => {
    expect(() => loadConfig({ ...MINIMAL, WORKER_RUN_POLL_MS: "1.5" })).toThrow(
      'WORKER_RUN_POLL_MS must be a positive integer, got "1.5"'
    );
    expect(() => loadConfig({ ...MINIMAL, WORKER_BATCH_SIZE: "many" })).toThrow(WorkerConfigError);
  });

  it("rejects a zero or negative interval", () => {
    expect(() => loadConfig({ ...MINIMAL, WORKER_BATCH_SIZE: "0" })).toThrow(WorkerConfigError);
    expect(() => loadConfig({ ...MINIMAL, WORKER_PORT: "-1" })).toThrow(WorkerConfigError);
  });

  it("rejects a lease that expires within one poll interval", () => {
    expect(() =>
      loadConfig({ ...MINIMAL, WORKER_LEASE_MS: "1000", WORKER_RUN_POLL_MS: "1000" })
    ).toThrow("WORKER_LEASE_MS (1000) must exceed WORKER_RUN_POLL_MS (1000)");
  });

  it("rejects a lifetime ceiling that a lease could outlast", () => {
    // A ceiling at or below the lease would let the lease expire before the heartbeat ever
    // yields, so a reclaim could race a still-heartbeating executor — the duplicate the ceiling
    // exists to bound.
    expect(() =>
      loadConfig({ ...MINIMAL, WORKER_RUN_MAX_LIFETIME_MS: "60000", WORKER_LEASE_MS: "60000" })
    ).toThrow("WORKER_RUN_MAX_LIFETIME_MS (60000) must exceed WORKER_LEASE_MS (60000)");
  });

  it("honours an explicit owner so two processes on one host stay distinguishable", () => {
    expect(loadConfig({ ...MINIMAL, WORKER_OWNER: "worker-a" }).owner).toBe("worker-a");
    expect(() => loadConfig({ ...MINIMAL, WORKER_OWNER: "  " })).toThrow(
      "WORKER_OWNER must not be blank"
    );
  });

  it("enables maintenance only on an explicitly selected replica", () => {
    expect(loadConfig({ ...MINIMAL, WORKER_MAINTENANCE: "true" }).maintenance).toBe(true);
    expect(() => loadConfig({ ...MINIMAL, WORKER_MAINTENANCE: "yes" })).toThrow(
      'WORKER_MAINTENANCE must be "true" or "false", got "yes"'
    );
  });
});
