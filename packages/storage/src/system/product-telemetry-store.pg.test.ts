import { PGlite } from "@electric-sql/pglite";
import { ProductTelemetryReporter } from "@tulipfarm/observability";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  PRODUCT_TELEMETRY_STORAGE_STATEMENTS,
  ProductTelemetryStore,
} from "./product-telemetry-store";

let db: PGlite;
let store: ProductTelemetryStore;
beforeAll(async () => {
  db = new PGlite();
  for (const sql of PRODUCT_TELEMETRY_STORAGE_STATEMENTS) await db.exec(sql);
  store = new ProductTelemetryStore(db, {
    withTransaction: (fn) => db.transaction((tx) => fn(tx)),
  });
});
afterAll(async () => {
  await db.close();
});
it("persists identity across initialization and atomically rolls back interrupted mutations", async () => {
  const initial = {
    installationId: "91a46579-bf7b-437c-b777-cb345b88ffab",
    firstBootAt: "2026-09-14T00:00:00.000Z",
    level: 2 as const,
    configured: false,
    setupComplete: false,
    bootstrapSentAt: null,
    lastSnapshotAt: null,
    pending: null,
    attempts: 0,
    retryAt: null,
  };
  await store.initialize(initial);
  await store.initialize({ ...initial, installationId: "8e09c22f-b93c-4125-9b43-4c5e50600a8f" });
  expect(await store.locked(async (state) => state.installationId)).toBe(initial.installationId);
  await expect(
    store.locked(async (state) => {
      state.level = 0;
      throw Error("crash");
    })
  ).rejects.toThrow("crash");
  expect(await store.locked(async (state) => state.level)).toBe(2);
  await store.locked(async (state) => {
    state.level = 0;
    state.configured = true;
  });
  const restarted = new ProductTelemetryStore(db, {
    withTransaction: (fn) => db.transaction((tx) => fn(tx)),
  });
  expect(await restarted.locked(async (state) => state.configured)).toBe(true);
});

it("serializes concurrent reporters so a replica cannot deliver an already acknowledged bootstrap", async () => {
  await db.exec("DELETE FROM deployment_product_telemetry");
  const sent: string[] = [];
  const options = {
    production: true,
    maxLevel: 0 as const,
    store,
    fetchImpl: async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      sent.push(String(init?.body));
      return new Response(null, { status: 202 });
    },
    bootstrap: async () => ({
      version: "1",
      os: "linux",
      architecture: "x64",
      deployment_method: "unknown",
    }),
    snapshot: async () => ({
      users: 1,
      resource_types: 0,
      integrations: 0,
      skills: 0,
      bundled_skills: 0,
      agents: 0,
      routines: 0,
    }),
  };
  const first = new ProductTelemetryReporter(options);
  const second = new ProductTelemetryReporter({
    ...options,
    store: new ProductTelemetryStore(db, {
      withTransaction: (fn) => db.transaction((tx) => fn(tx)),
    }),
  });
  await first.initialize();
  await second.initialize();
  await first.completeSetup();
  await Promise.all([first.dispatch(), second.dispatch()]);
  expect(sent).toHaveLength(1);
  expect((await second.status()).bootstrapSentAt).not.toBeNull();
});
