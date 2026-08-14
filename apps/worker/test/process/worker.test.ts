import { randomUUID } from "node:crypto";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import { PgBoss } from "pg-boss";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { REQUIRED_SCHEMA_VERSION } from "../../src/config";
import { OBS_PRUNE_QUEUE } from "../../src/job-consumers";
import {
  abandonRunWithExpiredLease,
  insertQueuedRun,
  type ScratchDatabase,
  startScratchDatabase,
} from "./scratch-database";
import { buildWorkerBundle, startWorker, type WorkerHandle, waitFor } from "./worker-process";

/** Process acceptance over a real child process, socket, and database. */
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
      // Insert before exit so a worker ignoring the schema floor could claim it.
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

      // Unknown source parks with a named cause, never silent success.
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
    "attaches maintenance consumers without migrating and prunes expired observability events",
    async () => {
      const handle = await bootWorker({ env: { WORKER_MAINTENANCE: "true" } });
      await handle.waitForReady();
      const scratchDb = scratch as ScratchDatabase;
      const expiredId = randomUUID();
      const currentId = randomUUID();
      await scratchDb.query(
        `INSERT INTO obs_event (id, ts)
         VALUES ($1, now() - interval '2 days'), ($2, now())`,
        [expiredId, currentId]
      );

      const producer = new PgBoss({
        connectionString: scratchDb.url,
        migrate: false,
        schedule: false,
        supervise: false,
      });
      await producer.start();
      try {
        await producer.send(OBS_PRUNE_QUEUE, { retentionMs: 24 * 60 * 60 * 1000 });
        const remaining = await waitFor(
          () => scratchDb.query("SELECT id FROM obs_event ORDER BY id"),
          (result) => result.rows.length === 1,
          { describe: "the observability prune consumer to delete the expired event" }
        );
        expect(remaining.rows).toEqual([{ id: currentId }]);
      } finally {
        await producer.stop({ graceful: true });
      }

      handle.signal("SIGTERM");
      await expect(handle.exited).resolves.toBe(0);
      expect(handle.output()).toContain("maintenance=true");
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
      // Unknown source isolates this test to lease recovery.
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

      // SIGKILL gives no drain, lease release, or final write.
      handle.signal("SIGKILL");
      await expect(handle.exited).resolves.toBeNull();

      // Write the crash row directly; timing a real mid-batch kill is nondeterministic.
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
