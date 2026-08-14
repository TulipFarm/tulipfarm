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
}): Promise<IntegrationWorkerHandle> {
  scratch = await startScratchDatabase(options.schemaVersion ?? REQUIRED_SCHEMA_VERSION);
  const handle = await startIntegrationWorker({ databaseUrl: scratch.url });
  worker = handle;
  return handle;
}

describe("integration worker process", () => {
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
