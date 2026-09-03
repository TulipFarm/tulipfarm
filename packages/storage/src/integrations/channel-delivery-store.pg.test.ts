import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { transactionPort } from "../pg/test-support";
import {
  CHANNEL_DELIVERY_STORAGE_STATEMENTS,
  ChannelDeliveryStore,
} from "./channel-delivery-store";
import {
  INTEGRATION_STORAGE_STATEMENTS,
  IntegrationStore,
  type PersistedIntegrationApp,
} from "./integration-store";

const BUSINESS_ID = "business-1";
const APP_ID = "00000000-0000-4000-8000-000000000001";
const INTEGRATION_ID = "00000000-0000-4000-8000-000000000002";
const NOW = "2026-07-26T10:00:00.000Z";

const app: PersistedIntegrationApp = {
  id: APP_ID,
  businessId: BUSINESS_ID,
  provider: "slack",
  externalAppId: "A-PRIMARY",
  credentialRefs: ["secret://slack/bot"],
  status: "active",
};

const attempt = {
  businessId: BUSINESS_ID,
  integrationId: INTEGRATION_ID,
  routeId: "route-1",
  idempotencyKey: "delivery-1",
  provider: "slack",
  destination: "C-OPS",
  agentId: "agent-1",
  principalId: "user-1",
};

describe("ChannelDeliveryStore", () => {
  let database: PGlite;
  let store: ChannelDeliveryStore;
  let integrations: IntegrationStore;
  let now: string;

  beforeAll(async () => {
    database = new PGlite();
    for (const statement of [
      ...INTEGRATION_STORAGE_STATEMENTS,
      ...CHANNEL_DELIVERY_STORAGE_STATEMENTS,
    ]) {
      await database.exec(statement);
    }
    const transactions = transactionPort(database);
    store = new ChannelDeliveryStore(transactions, () => now);
    integrations = new IntegrationStore(transactions);
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await database.query("TRUNCATE TABLE integration_apps CASCADE");
    now = NOW;
    await integrations.putApp(app);
    await integrations.putIntegration({
      id: INTEGRATION_ID,
      businessId: BUSINESS_ID,
      appId: APP_ID,
      externalTenantId: "T-ACME",
      credentialRef: "secret://slack/bot",
      status: "active",
    });
  });

  it("persists the delivery identity before dispatch and collapses concurrent duplicates", async () => {
    const first = await store.begin(attempt);
    const duplicate = await store.begin(attempt);

    expect(first).toMatchObject({
      outcome: "started",
      record: { status: "pending", attempts: 1 },
    });
    expect(duplicate).toMatchObject({
      outcome: "duplicate",
      record: { status: "pending", attempts: 1 },
    });
  });

  it("returns a confirmed duplicate without creating a second attempt", async () => {
    await store.begin(attempt);
    await store.complete(attempt, "provider-message-1");

    expect(await store.begin(attempt)).toMatchObject({
      outcome: "duplicate",
      record: {
        status: "confirmed",
        attempts: 1,
        providerMessageId: "provider-message-1",
      },
    });
  });

  it("claims a rate-limited delivery only after its durable retry time", async () => {
    await store.begin(attempt);
    await store.fail(attempt, {
      status: "retry_wait",
      code: "provider_rate_limited",
      retryAfterMs: 7000,
    });

    expect(await store.begin(attempt)).toMatchObject({
      outcome: "duplicate",
      record: { status: "retry_wait", attempts: 1 },
    });

    now = "2026-07-26T10:00:07.000Z";
    expect(await store.begin(attempt)).toMatchObject({
      outcome: "started",
      record: { status: "pending", attempts: 2 },
    });
  });

  it("keeps ambiguous and revoked outcomes terminal until reconciliation or reauthorization", async () => {
    await store.begin(attempt);
    await store.fail(attempt, { status: "ambiguous", code: "provider_unavailable" });
    expect(await store.begin(attempt)).toMatchObject({
      outcome: "duplicate",
      record: { status: "ambiguous" },
    });

    const revoked = { ...attempt, idempotencyKey: "delivery-2" };
    await store.begin(revoked);
    await store.fail(revoked, { status: "revoked", code: "integration_revoked" });
    expect(await store.begin(revoked)).toMatchObject({
      outcome: "duplicate",
      record: { status: "revoked" },
    });
  });
});
