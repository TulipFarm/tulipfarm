import { describe, expect, it, vi } from "vitest";
import {
  ProductTelemetryReporter,
  type ProductTelemetryState,
  type ProductTelemetryStateStore,
  productTelemetryPolicy,
} from "./product-telemetry-reporter";

function fixture(production = true) {
  let state: ProductTelemetryState | undefined;
  const store: ProductTelemetryStateStore = {
    async initialize(initial) {
      state ??= structuredClone(initial);
    },
    async locked(fn) {
      if (!state) throw Error("uninitialized");
      return fn(state);
    },
  };
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }));
  let now = new Date("2026-09-14T00:00:00.000Z");
  const reporter = new ProductTelemetryReporter({
    store,
    production,
    maxLevel: 2,
    fetchImpl,
    now: () => now,
    bootstrap: async () => ({
      version: "1.0",
      os: "linux",
      architecture: "x64",
      deployment_method: "docker",
    }),
    snapshot: async () => ({
      users: 1,
      resource_types: 1,
      integrations: 0,
      skills: 1,
      bundled_skills: 2,
      agents: 1,
      routines: 0,
      resource_type_names: ["Customer"],
      skill_names: ["Support"],
      agent_names: ["Support"],
    }),
  });
  return {
    reporter,
    fetchImpl,
    advance: () => {
      now = new Date(now.getTime() + 86400000);
    },
    get: () => state,
  };
}

describe("product telemetry reporter", () => {
  it("waits for completed setup and explicitly configured optional sharing", async () => {
    const f = fixture();
    await f.reporter.initialize();
    await f.reporter.dispatch();
    expect(f.fetchImpl).not.toHaveBeenCalled();
    await f.reporter.completeSetup();
    await f.reporter.dispatch();
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(f.fetchImpl.mock.calls[0]?.[1]?.body)).event_type).toBe(
      "instance_bootstrapped"
    );
    f.advance();
    await f.reporter.dispatch();
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    await f.reporter.save(1);
    await f.reporter.dispatch();
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
    expect(
      JSON.parse(String(f.fetchImpl.mock.calls[1]?.[1]?.body)).data.skill_names
    ).toBeUndefined();
  });
  it("retains event identity across retries and purges queued inventory on downgrade", async () => {
    const f = fixture();
    await f.reporter.initialize();
    await f.reporter.completeSetup(2);
    f.fetchImpl.mockRejectedValueOnce(Error("secret URL must not escape"));
    await f.reporter.dispatch();
    const pending = f.get()?.pending;
    expect(pending?.event_type).toBe("instance_bootstrapped");
    f.advance();
    await f.reporter.dispatch();
    expect(JSON.parse(String(f.fetchImpl.mock.calls[1]?.[1]?.body)).event_id).toBe(
      pending?.event_id
    );
    f.fetchImpl.mockRejectedValueOnce(Error("offline"));
    await f.reporter.dispatch();
    expect(f.get()?.pending?.telemetry_level).toBe(2);
    await f.reporter.save(0);
    expect(f.get()?.pending).toBeNull();
    f.advance();
    await f.reporter.dispatch();
    expect(f.fetchImpl).toHaveBeenCalledTimes(3);
  });
  it("never sends in development and keeps preview identity stable", async () => {
    const f = fixture(false);
    await f.reporter.initialize();
    await f.reporter.completeSetup(2);
    const one = await f.reporter.status();
    const two = await f.reporter.status();
    expect(one.installationId).toBe(two.installationId);
    expect(one.preview.bootstrap).toEqual(two.preview.bootstrap);
    await f.reporter.dispatch();
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });
});

it("defaults empty deployment variables and refuses invalid levels", () => {
  expect(productTelemetryPolicy({ NODE_ENV: "production", TULIPFARM_TELEMETRY_LEVEL: "" })).toEqual(
    { enabled: true, maxLevel: 2 }
  );
  expect(productTelemetryPolicy({ TULIPFARM_TELEMETRY_LEVEL: "invalid" })).toEqual({
    enabled: false,
    maxLevel: 0,
  });
  expect(productTelemetryPolicy({ NODE_ENV: "test", TULIPFARM_TELEMETRY_LEVEL: "1" })).toEqual({
    enabled: false,
    maxLevel: 1,
  });
});

it("bounds combined inventories while preserving complete counts", async () => {
  let state: ProductTelemetryState;
  const reporter = new ProductTelemetryReporter({
    production: false,
    maxLevel: 2,
    store: {
      async initialize(value) {
        state = value;
      },
      async locked(fn) {
        return fn(state);
      },
    },
    bootstrap: async () => ({
      version: "1",
      os: "linux",
      architecture: "x64",
      deployment_method: "unknown",
    }),
    snapshot: async () => ({
      users: 1,
      resource_types: 400,
      integrations: 400,
      skills: 400,
      bundled_skills: 1,
      agents: 400,
      routines: 1,
      ...Object.fromEntries(
        ["resource_type_names", "integration_providers", "skill_names", "agent_names"].map(
          (key) => [
            key,
            Array.from(
              { length: 400 },
              (_, i) => `${String(i).padStart(4, "0")}${"多".repeat(100)}`
            ),
          ]
        )
      ),
    }),
  });
  await reporter.initialize();
  const status = await reporter.status();
  const event = status.preview.snapshot;
  expect(event?.data).toMatchObject({
    resource_types: 400,
    skills: 400,
    inventory_truncated: true,
  });
  expect(JSON.stringify(event).length * 2).toBeLessThan(24576);
  expect(new TextEncoder().encode(JSON.stringify(event)).length).toBeLessThan(24576);
});

it("retains the exact sent mandatory report for later inspection", async () => {
  const f = fixture();
  await f.reporter.initialize();
  await f.reporter.completeSetup();
  await f.reporter.dispatch();
  expect((await f.reporter.status()).preview.bootstrap).toEqual(
    JSON.parse(String(f.fetchImpl.mock.calls[0]?.[1]?.body))
  );
});

it("collects outside the state transaction and rechecks a downgrade before queueing", async () => {
  let state: ProductTelemetryState;
  let locked = false;
  let downgrade = false;
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }));
  const reporter = new ProductTelemetryReporter({
    production: true,
    maxLevel: 2,
    fetchImpl,
    store: {
      async initialize(initial) {
        state = initial;
      },
      async locked(fn) {
        expect(locked).toBe(false);
        locked = true;
        try {
          return await fn(state);
        } finally {
          locked = false;
        }
      },
    },
    bootstrap: async () => {
      expect(locked).toBe(false);
      return { version: "1", os: "linux", architecture: "x64", deployment_method: "unknown" };
    },
    snapshot: async () => {
      expect(locked).toBe(false);
      if (downgrade) await reporter.configure(0);
      return {
        users: 1,
        resource_types: 0,
        integrations: 0,
        skills: 0,
        bundled_skills: 0,
        agents: 0,
        routines: 0,
      };
    },
  });
  await reporter.initialize();
  await reporter.completeSetup(2);
  await reporter.dispatch();
  await reporter.status();
  downgrade = true;
  await reporter.dispatch();
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect((await reporter.status()).preview.snapshot).toBeNull();
});

it("recovery after failed setup preference persistence never resurrects an earlier optional choice", async () => {
  const f = fixture();
  await f.reporter.initialize();
  await f.reporter.configure(2);
  expect((await f.reporter.status()).configured).toBe(true);
  await f.reporter.completeSetup();
  expect((await f.reporter.status()).configured).toBe(false);
  await f.reporter.dispatch();
  f.advance();
  await f.reporter.dispatch();
  expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  await f.reporter.completeSetup(0);
  expect((await f.reporter.status()).level).toBe(0);
  await f.reporter.save(1);
  await f.reporter.completeSetup();
  expect((await f.reporter.status()).configured).toBe(true);
  expect((await f.reporter.status()).level).toBe(1);
});
