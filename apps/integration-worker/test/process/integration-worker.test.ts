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
  internalApiMode?: "ready" | "missing-native-contract";
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
    "fails closed for hosted configuration before probes or Integration loops",
    async () => {
      scratch = await startScratchDatabase(REQUIRED_SCHEMA_VERSION);
      for (const [env, error] of [
        [
          { RUNTIME_HOSTING_AUTHORITY: "malformed-private-sentinel" },
          "RUNTIME_HOSTING_AUTHORITY must",
        ],
        [{ RUNTIME_HOSTING_AUTHORITY: "tulipfarm" }, "RUNTIME_INSTALLATION_ID is required"],
        [
          { RUNTIME_HOSTING_AUTHORITY: "tulipfarm", RUNTIME_INSTALLATION_ID: "private-sentinel" },
          "must be a UUID",
        ],
        [
          { RUNTIME_HOSTING_AUTHORITY: "tulipfarm", RUNTIME_INSTALLATION_ID: randomUUID() },
          "no production hosted identity protocol",
        ],
      ] as const) {
        worker = await startIntegrationWorker({ databaseUrl: scratch.url, env });
        expect(await worker.exited).toBe(1);
        expect(worker.output()).toContain(error);
        expect(worker.output()).not.toContain("private-sentinel");
        await expect(worker.probe("/readyz")).rejects.toThrow();
        await worker.stop();
      }
      expect((await scratch.query("SELECT * FROM deployment_runtime_identity")).rows).toHaveLength(
        0
      );
      await scratch.query(
        `INSERT INTO deployment_runtime_identity (installation_id, business_id, hosting_authority)
       VALUES ($1, $2, 'tulipfarm')`,
        [randomUUID(), "legacy-business"]
      );
      worker = await startIntegrationWorker({
        databaseUrl: scratch.url,
        env: { BUSINESS_ID: "legacy-business" },
      });
      expect(await worker.exited).toBe(1);
      expect(worker.output()).toContain("RUNTIME_HOSTING_AUTHORITY conflicts");
    },
    TIMEOUT
  );

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
    "stays unready when native event dispatch is unavailable",
    async () => {
      const handle = await bootIntegrationWorker({ internalApiMode: "missing-native-contract" });
      await expect
        .poll(() => handle.output(), { timeout: 20_000 })
        .toContain("integration-worker ready:");
      expect((await handle.probe("/livez")).status).toBe(200);
      expect((await handle.probe("/readyz")).status).toBe(503);
      expect(handle.output()).toContain("Native channel event dispatch unavailable");
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
