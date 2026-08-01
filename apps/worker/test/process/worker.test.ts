import { randomUUID } from "node:crypto";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { REQUIRED_SCHEMA_VERSION } from "../../src/config";
import {
  abandonRunWithExpiredLease,
  insertQueuedRun,
  type ScratchDatabase,
  startScratchDatabase,
} from "./scratch-database";
import { buildWorkerBundle, startWorker, type WorkerHandle, waitFor } from "./worker-process";

/**
 * Process-level acceptance for the bootable worker: a real child process, a real socket, a real
 * database. Every claim this PR makes — boots, refuses an old schema, claims Runs, drains on
 * SIGTERM, recovers what a killed worker abandoned — is behavioral, so none of it can be proven
 * by a unit test over the same code.
 */
const TIMEOUT = 60_000;

let scratch: ScratchDatabase | undefined;
let worker: WorkerHandle | undefined;

beforeAll(async () => {
  await buildWorkerBundle();
}, TIMEOUT);

afterEach(async () => {
  await worker?.stop();
  worker = undefined;
  await scratch?.stop();
  scratch = undefined;
});

async function bootWorker(options: {
  schemaVersion?: number;
  owner?: string;
  env?: Record<string, string>;
}): Promise<WorkerHandle> {
  scratch = await startScratchDatabase(options.schemaVersion ?? REQUIRED_SCHEMA_VERSION);
  const handle = await startWorker({
    databaseUrl: scratch.url,
    owner: options.owner ?? "worker-under-test",
    env: options.env,
  });
  worker = handle;
  return handle;
}

describe("worker process", () => {
  it(
    "boots against a migrated database and serves both probes",
    async () => {
      const handle = await bootWorker({});
      await handle.waitForReady();

      await expect(handle.probe("/readyz")).resolves.toEqual({
        status: 200,
        body: JSON.stringify({ status: "ok" }),
      });
      await expect(handle.probe("/livez")).resolves.toEqual({
        status: 200,
        body: JSON.stringify({ status: "ok" }),
      });
      expect(handle.output()).toContain(`schema=${REQUIRED_SCHEMA_VERSION}`);
    },
    TIMEOUT
  );

  it(
    "refuses to start one migration behind, and claims nothing on the way out",
    async () => {
      const handle = await bootWorker({ schemaVersion: REQUIRED_SCHEMA_VERSION - 1 });
      const runId = randomUUID();
      // Inserted before the exit is awaited so a worker that ignored the floor would have had a
      // Run to claim. A clean exit with the Run still queued is the assertion.
      const scratchDb = scratch as ScratchDatabase;
      await insertQueuedRun(scratchDb, { businessId: DEPLOYMENT_BUSINESS_ID, runId });

      await expect(handle.exited).resolves.toBe(1);
      expect(handle.output()).toContain(
        `schema_version is ${REQUIRED_SCHEMA_VERSION - 1}, but this worker requires ` +
          `${REQUIRED_SCHEMA_VERSION}`
      );

      const run = await scratchDb.findRun(DEPLOYMENT_BUSINESS_ID, runId);
      expect(run?.status).toBe("queued");
      expect(run?.leaseOwner).toBeNull();
    },
    TIMEOUT
  );

  it(
    "claims a queued Run and parks it for an operator when no executor owns its source",
    async () => {
      const handle = await bootWorker({});
      await handle.waitForReady();
      const scratchDb = scratch as ScratchDatabase;

      const runId = randomUUID();
      await insertQueuedRun(scratchDb, {
        businessId: DEPLOYMENT_BUSINESS_ID,
        runId,
        source: "no-such-source",
      });

      const run = await waitFor(
        () => scratchDb.findRun(DEPLOYMENT_BUSINESS_ID, runId),
        (value) => value?.status === "needs_reconciliation",
        { describe: `Run ${runId} to reach needs_reconciliation` }
      );

      // No executor owns this source, so the honest terminal status is "parked with a named
      // cause" — never a silent success, and never a failure nobody can explain.
      expect(run?.status).toBe("needs_reconciliation");
      expect(run?.leaseOwner).toBeNull();
      expect(run?.leaseExpiresAt).toBeNull();
    },
    TIMEOUT
  );

  it(
    "drains on SIGTERM and exits 0",
    async () => {
      const handle = await bootWorker({});
      await handle.waitForReady();

      handle.signal("SIGTERM");

      await expect(handle.exited).resolves.toBe(0);
      expect(handle.output()).toContain("worker draining (SIGTERM)");
      expect(handle.output()).toContain("worker drained cleanly");
    },
    TIMEOUT
  );

  it(
    "recovers a Run abandoned by a killed worker, without a second worker holding its lease",
    async () => {
      const handle = await bootWorker({ owner: "worker-a" });
      await handle.waitForReady();
      const scratchDb = scratch as ScratchDatabase;

      const runId = randomUUID();
      // A source no executor owns, so the Run's fate depends only on lease recovery — the subject
      // of this test — and not on whether a turn host happened to answer.
      await insertQueuedRun(scratchDb, {
        businessId: DEPLOYMENT_BUSINESS_ID,
        runId,
        source: "no-such-source",
      });
      await waitFor(
        () => scratchDb.findRun(DEPLOYMENT_BUSINESS_ID, runId),
        (value) => value?.status === "needs_reconciliation",
        { describe: "the first worker to finish the Run" }
      );

      // SIGKILL: no drain, no lease release, no chance to write anything.
      handle.signal("SIGKILL");
      await expect(handle.exited).resolves.toBeNull();

      // The row a crash mid-batch leaves behind. Written directly because with no executor
      // registered the batch cannot be held open long enough to time a real kill inside it.
      await abandonRunWithExpiredLease(scratchDb, {
        businessId: DEPLOYMENT_BUSINESS_ID,
        runId,
        owner: "worker-a",
      });

      const restarted = await startWorker({ databaseUrl: scratchDb.url, owner: "worker-b" });
      worker = restarted;
      await restarted.waitForReady();

      const recovered = await waitFor(
        () => scratchDb.findRun(DEPLOYMENT_BUSINESS_ID, runId),
        (value) => value?.status === "needs_reconciliation",
        { describe: "the replacement worker to reclaim and finish the abandoned Run" }
      );
      expect(recovered?.leaseOwner).toBeNull();
    },
    TIMEOUT
  );
});
