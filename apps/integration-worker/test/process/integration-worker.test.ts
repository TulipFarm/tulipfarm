import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { REQUIRED_SCHEMA_VERSION } from "../../src/config";
import {
  buildIntegrationWorkerBundle,
  type IntegrationWorkerHandle,
  startIntegrationWorker,
} from "./integration-worker-process";
import { type ScratchDatabase, startScratchDatabase } from "./scratch-database";

/** Process-level tests use a real child, socket, and database. */
const TIMEOUT = 60_000;

let scratch: ScratchDatabase | undefined;
let worker: IntegrationWorkerHandle | undefined;

beforeAll(async () => {
  await buildIntegrationWorkerBundle();
}, TIMEOUT);

afterEach(async () => {
  await worker?.stop();
  worker = undefined;
  await scratch?.stop();
  scratch = undefined;
});

async function bootIntegrationWorker(options: {
  schemaVersion?: number;
  internalApiMode?: "ready" | "missing-oim-contract";
}): Promise<IntegrationWorkerHandle> {
  scratch = await startScratchDatabase(options.schemaVersion ?? REQUIRED_SCHEMA_VERSION);
  const handle = await startIntegrationWorker({
    databaseUrl: scratch.url,
    internalApiMode: options.internalApiMode,
  });
  worker = handle;
  return handle;
}

describe("integration worker process", () => {
  it(
    "reuses the API installation identity across restarts and refuses a mismatch",
    async () => {
      scratch = await startScratchDatabase(REQUIRED_SCHEMA_VERSION);
      const installationId = randomUUID();
      const businessId = "legacy-business";
      await scratch.query(
        `INSERT INTO deployment_runtime_identity (installation_id, business_id) VALUES ($1, $2)`,
        [installationId, businessId]
      );
      for (let boot = 0; boot < 2; boot++) {
        worker = await startIntegrationWorker({
          databaseUrl: scratch.url,
          env: {
            BUSINESS_ID: businessId,
            ...(boot === 1 ? { RUNTIME_INSTALLATION_ID: "" } : {}),
          },
        });
        await worker.waitForReady();
        expect(worker.output()).toContain(`Runtime installation ${installationId} (independent)`);
        await worker.stop();
      }
      worker = await startIntegrationWorker({
        databaseUrl: scratch.url,
        env: { BUSINESS_ID: businessId, RUNTIME_INSTALLATION_ID: randomUUID() },
      });
      expect(await worker.exited).toBe(1);
      expect(worker.output()).toContain("RUNTIME_INSTALLATION_ID conflicts");
      expect(worker.output()).not.toContain("integration-worker ready:");
      expect(
        (
          await scratch.query(
            "SELECT installation_id, business_id FROM deployment_runtime_identity"
          )
        ).rows
      ).toEqual([{ installation_id: installationId, business_id: businessId }]);
    },
    TIMEOUT
  );

  it(
    "boots against a migrated database and serves both probes",
    async () => {
      const handle = await bootIntegrationWorker({});
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
    "refuses to start one migration behind",
    async () => {
      const handle = await bootIntegrationWorker({ schemaVersion: REQUIRED_SCHEMA_VERSION - 1 });

      await expect(handle.exited).resolves.toBe(1);
      expect(handle.output()).toContain(
        `schema_version is ${REQUIRED_SCHEMA_VERSION - 1}, but this worker requires ` +
          `${REQUIRED_SCHEMA_VERSION}`
      );
    },
    TIMEOUT
  );

  it(
    "fails startup when the required OIM worker contract is unavailable",
    async () => {
      const handle = await bootIntegrationWorker({ internalApiMode: "missing-oim-contract" });

      await expect(handle.exited).resolves.toBe(1);
      expect(handle.output()).toContain("GET /api/v1/internal/oim/worker-contract failed with 404");
    },
    TIMEOUT
  );

  it(
    "drains on SIGTERM and exits 0",
    async () => {
      const handle = await bootIntegrationWorker({});
      await handle.waitForReady();

      handle.signal("SIGTERM");

      await expect(handle.exited).resolves.toBe(0);
      expect(handle.output()).toContain("integration-worker draining (SIGTERM)");
      expect(handle.output()).toContain("integration-worker drained cleanly");
    },
    TIMEOUT
  );
});
