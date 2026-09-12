import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { transactionPort } from "../pg/test-support";
import {
  OIM_RATE_LIMIT_STORAGE_STATEMENTS,
  OimRateLimitStore,
  type OimRateLimitStoreScope,
} from "./oim-rate-limit-store";

const CONNECTION_SCOPE: OimRateLimitStoreScope = {
  businessId: "business-1",
  integrationId: "weather",
  integrationMajorVersion: 1,
  connectionId: "connection-1",
  scope: "connection",
};

describe("OimRateLimitStore", () => {
  let database: PGlite;
  let store: OimRateLimitStore;

  beforeAll(async () => {
    database = new PGlite();
    for (const statement of OIM_RATE_LIMIT_STORAGE_STATEMENTS) {
      await database.exec(statement);
    }
    store = new OimRateLimitStore(transactionPort(database));
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await database.query("TRUNCATE TABLE oim_rate_limits");
  });

  it("admits only the declared quota across concurrent callers", async () => {
    const replicaA = store;
    const replicaB = new OimRateLimitStore(transactionPort(database));
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        (index % 2 === 0 ? replicaA : replicaB).admit({
          scope: CONNECTION_SCOPE,
          quota: { requests: 5, perSeconds: 60 },
          now: new Date("2026-09-07T06:30:00.000Z"),
        })
      )
    );

    expect(results.filter((result) => result.outcome === "admitted")).toHaveLength(5);
    expect(results.filter((result) => result.outcome === "limited")).toHaveLength(7);
    expect(results.find((result) => result.outcome === "limited")).toEqual({
      outcome: "limited",
      retryAt: "2026-09-07T06:31:00.000Z",
    });
    expect(
      await replicaB.admit({
        scope: CONNECTION_SCOPE,
        quota: { requests: 5, perSeconds: 60 },
        now: new Date("2026-09-07T06:31:00.000Z"),
      })
    ).toMatchObject({ outcome: "admitted" });
  });

  it("keeps counters across store restarts and isolates Connections and operations", async () => {
    const quota = { requests: 1, perSeconds: 60 };
    const now = new Date("2026-09-07T06:30:00.000Z");

    expect(await store.admit({ scope: CONNECTION_SCOPE, quota, now })).toMatchObject({
      outcome: "admitted",
    });

    const restarted = new OimRateLimitStore(transactionPort(database));
    expect(await restarted.admit({ scope: CONNECTION_SCOPE, quota, now })).toMatchObject({
      outcome: "limited",
    });
    expect(
      await restarted.admit({
        scope: { ...CONNECTION_SCOPE, connectionId: "connection-2" },
        quota,
        now,
      })
    ).toMatchObject({ outcome: "admitted" });
    expect(
      await restarted.admit({
        scope: { ...CONNECTION_SCOPE, businessId: "business-2" },
        quota,
        now,
      })
    ).toMatchObject({ outcome: "admitted" });
    expect(
      await restarted.admit({
        scope: { ...CONNECTION_SCOPE, integrationMajorVersion: 2 },
        quota,
        now,
      })
    ).toMatchObject({ outcome: "admitted" });
    expect(
      await restarted.admit({
        scope: { ...CONNECTION_SCOPE, scope: "operation", operationId: "forecast" },
        quota,
        now,
      })
    ).toMatchObject({ outcome: "admitted" });
    expect(
      await restarted.admit({
        scope: { ...CONNECTION_SCOPE, scope: "operation", operationId: "current-weather" },
        quota,
        now,
      })
    ).toMatchObject({ outcome: "admitted" });
  });

  it("shares a provider cooldown and never shortens it", async () => {
    const now = new Date("2026-09-07T06:30:00.000Z");
    await store.admit({
      scope: CONNECTION_SCOPE,
      quota: { requests: 10, perSeconds: 60 },
      now,
    });
    await store.imposeCooldown({
      scope: CONNECTION_SCOPE,
      retryAt: new Date("2026-09-07T06:30:45.000Z"),
      now,
    });
    await store.imposeCooldown({
      scope: CONNECTION_SCOPE,
      retryAt: new Date("2026-09-07T06:30:15.000Z"),
      now,
    });

    expect(
      await new OimRateLimitStore(transactionPort(database)).admit({
        scope: CONNECTION_SCOPE,
        quota: { requests: 10, perSeconds: 60 },
        now: new Date("2026-09-07T06:30:30.000Z"),
      })
    ).toEqual({ outcome: "limited", retryAt: "2026-09-07T06:30:45.000Z" });
    expect(
      await store.admit({
        scope: CONNECTION_SCOPE,
        quota: { requests: 10, perSeconds: 60 },
        now: new Date("2026-09-07T06:30:45.000Z"),
      })
    ).toMatchObject({ outcome: "admitted" });
  });

  it("shares cooldown-only admission without consuming an invented quota", async () => {
    const anonymousOperation: OimRateLimitStoreScope = {
      businessId: "business-1",
      integrationId: "weather",
      integrationMajorVersion: 1,
      scope: "operation",
      operationId: "public-forecast",
    };
    const now = new Date("2026-09-07T06:30:00.000Z");

    expect(await store.admit({ scope: anonymousOperation, now })).toEqual({
      outcome: "admitted",
    });
    expect(await store.admit({ scope: anonymousOperation, now })).toEqual({
      outcome: "admitted",
    });

    await store.imposeCooldown({
      scope: anonymousOperation,
      retryAt: new Date("2026-09-07T06:30:20.000Z"),
      now,
    });

    expect(
      await new OimRateLimitStore(transactionPort(database)).admit({
        scope: anonymousOperation,
        now: new Date("2026-09-07T06:30:10.000Z"),
      })
    ).toEqual({ outcome: "limited", retryAt: "2026-09-07T06:30:20.000Z" });
    expect(
      await store.admit({
        scope: { ...anonymousOperation, operationId: "public-current" },
        now: new Date("2026-09-07T06:30:10.000Z"),
      })
    ).toEqual({ outcome: "admitted" });
    expect(
      await store.admit({
        scope: { ...anonymousOperation, businessId: "business-2" },
        now: new Date("2026-09-07T06:30:10.000Z"),
      })
    ).toEqual({ outcome: "admitted" });
    expect(
      await store.admit({
        scope: { ...anonymousOperation, integrationMajorVersion: 2 },
        now: new Date("2026-09-07T06:30:10.000Z"),
      })
    ).toEqual({ outcome: "admitted" });
  });
});
