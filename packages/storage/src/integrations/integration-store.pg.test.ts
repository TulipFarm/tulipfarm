import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { transactionPort } from "../pg/test-support";
import {
  INTEGRATION_STORAGE_STATEMENTS,
  IntegrationStore,
  type PersistedChannelRoute,
} from "./integration-store";

const BUSINESS_ID = "business-1";
const APP_ID = "00000000-0000-4000-8000-000000000001";
const INTEGRATION_ID = "00000000-0000-4000-8000-000000000002";

describe("IntegrationStore", () => {
  let database: PGlite;
  let store: IntegrationStore;

  beforeAll(async () => {
    database = new PGlite();
    for (const statement of INTEGRATION_STORAGE_STATEMENTS) {
      await database.exec(statement);
    }
    store = new IntegrationStore(transactionPort(database));
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await database.query("TRUNCATE TABLE integration_apps CASCADE");
  });

  async function seed() {
    await store.putApp({
      id: APP_ID,
      businessId: BUSINESS_ID,
      provider: "slack",
      externalAppId: "A-PRIMARY",
      credentialRefs: ["secret://slack/app", "secret://slack/bot"],
      status: "active",
    });
    await store.putIntegration({
      id: INTEGRATION_ID,
      businessId: BUSINESS_ID,
      appId: APP_ID,
      externalTenantId: "T-ACME",
      credentialRef: "secret://slack/bot",
      status: "active",
    });
    await store.putAccessGrant({
      id: "00000000-0000-4000-8000-000000000003",
      businessId: BUSINESS_ID,
      integrationId: INTEGRATION_ID,
      definition: { kind: "AccessGrant" },
      status: "active",
    });
  }

  it("persists the App → Integration → AccessGrant → Route hierarchy", async () => {
    await seed();
    const route: PersistedChannelRoute = {
      id: "route-1",
      businessId: BUSINESS_ID,
      integrationId: INTEGRATION_ID,
      agentId: "agent-1",
      channelId: "C-OPS",
      threadId: null,
      eventTypes: ["message"],
      priority: 10,
      status: "active",
    };
    await store.putRoute(route);

    const loaded = await store.loadRoutingSnapshot(BUSINESS_ID, "slack", "T-ACME");

    expect(loaded.apps).toHaveLength(1);
    expect(loaded.integrations).toHaveLength(1);
    expect(loaded.accessGrants).toHaveLength(1);
    expect(loaded.routes).toEqual([route]);
    expect(JSON.stringify(loaded)).not.toContain("xoxb-");
  });

  it("isolates businesses and external tenants when loading routing data", async () => {
    await seed();
    await store.putRoute({
      id: "route-1",
      businessId: BUSINESS_ID,
      integrationId: INTEGRATION_ID,
      agentId: "agent-1",
      channelId: "C-OPS",
      threadId: null,
      eventTypes: ["message"],
      priority: 10,
      status: "active",
    });

    expect(await store.loadRoutingSnapshot("business-2", "slack", "T-ACME")).toMatchObject({
      apps: [],
      integrations: [],
      accessGrants: [],
      routes: [],
    });
    expect(await store.loadRoutingSnapshot(BUSINESS_ID, "slack", "T-OTHER")).toMatchObject({
      apps: [],
      integrations: [],
      accessGrants: [],
      routes: [],
    });
  });

  it("rejects a Route whose Integration belongs to another business", async () => {
    await seed();

    await expect(
      store.putRoute({
        id: "route-cross-business",
        businessId: "business-2",
        integrationId: INTEGRATION_ID,
        agentId: "agent-1",
        channelId: "C-OPS",
        threadId: null,
        eventTypes: ["message"],
        priority: 10,
        status: "active",
      })
    ).rejects.toThrow();
  });

  it("updates a projection without changing its stable identity", async () => {
    await seed();
    await store.putIntegration({
      id: INTEGRATION_ID,
      businessId: BUSINESS_ID,
      appId: APP_ID,
      externalTenantId: "T-ACME",
      credentialRef: "secret://slack/bot-rotated",
      status: "active",
    });

    const loaded = await store.loadRoutingSnapshot(BUSINESS_ID, "slack", "T-ACME");
    expect(loaded.integrations[0]).toMatchObject({
      id: INTEGRATION_ID,
      credentialRef: "secret://slack/bot-rotated",
    });
  });

  describe("loadDeliveryStatus", () => {
    it("reports both statuses for an existing Integration/Route pair", async () => {
      await seed();
      await store.putRoute({
        id: "route-1",
        businessId: BUSINESS_ID,
        integrationId: INTEGRATION_ID,
        agentId: "agent-1",
        channelId: "C-OPS",
        threadId: null,
        eventTypes: ["message"],
        priority: 10,
        status: "active",
      });

      expect(await store.loadDeliveryStatus(BUSINESS_ID, INTEGRATION_ID, "route-1")).toEqual({
        integrationStatus: "active",
        routeStatus: "active",
      });
    });

    it("reflects a revoked Integration even when its Route is still active", async () => {
      await seed();
      await store.putRoute({
        id: "route-1",
        businessId: BUSINESS_ID,
        integrationId: INTEGRATION_ID,
        agentId: "agent-1",
        channelId: "C-OPS",
        threadId: null,
        eventTypes: ["message"],
        priority: 10,
        status: "active",
      });
      await store.putIntegration({
        id: INTEGRATION_ID,
        businessId: BUSINESS_ID,
        appId: APP_ID,
        externalTenantId: "T-ACME",
        credentialRef: "secret://slack/bot",
        status: "revoked",
      });

      expect(await store.loadDeliveryStatus(BUSINESS_ID, INTEGRATION_ID, "route-1")).toEqual({
        integrationStatus: "revoked",
        routeStatus: "active",
      });
    });

    it("returns undefined for an unknown pair, so callers fail closed", async () => {
      await seed();

      expect(
        await store.loadDeliveryStatus(BUSINESS_ID, INTEGRATION_ID, "route-missing")
      ).toBeUndefined();
    });
  });
});
