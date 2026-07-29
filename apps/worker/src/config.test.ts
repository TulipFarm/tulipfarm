import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import { describe, expect, it } from "vitest";
import { loadConfig, WorkerConfigError } from "./config";

const MINIMAL = { DATABASE_URL: "postgres://localhost:5432/tulipfarm" };

describe("loadConfig", () => {
  it("applies documented defaults when only DATABASE_URL is set", () => {
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
      drainTimeoutMs: 15_000,
    });
    expect(config.owner).not.toEqual("");
  });

  it("refuses to start without a database url", () => {
    expect(() => loadConfig({})).toThrow(WorkerConfigError);
    expect(() => loadConfig({ DATABASE_URL: "   " })).toThrow("DATABASE_URL is required");
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

  it("honours an explicit owner so two processes on one host stay distinguishable", () => {
    expect(loadConfig({ ...MINIMAL, WORKER_OWNER: "worker-a" }).owner).toBe("worker-a");
    expect(() => loadConfig({ ...MINIMAL, WORKER_OWNER: "  " })).toThrow(
      "WORKER_OWNER must not be blank"
    );
  });
});
