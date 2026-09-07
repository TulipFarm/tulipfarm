import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { transactionPort } from "../pg/test-support";
import { INTEGRATION_STORAGE_STATEMENTS, IntegrationStore } from "./integration-store";
import {
  PROVIDER_OBJECT_OWNERSHIP_STORAGE_STATEMENTS,
  ProviderObjectOwnershipStore,
} from "./provider-object-ownership-store";

describe("ProviderObjectOwnershipStore", () => {
  let database: PGlite;
  let store: ProviderObjectOwnershipStore;

  beforeAll(async () => {
    database = new PGlite();
    for (const statement of [
      ...INTEGRATION_STORAGE_STATEMENTS,
      ...PROVIDER_OBJECT_OWNERSHIP_STORAGE_STATEMENTS,
    ]) {
      await database.exec(statement);
    }
    const transactions = transactionPort(database);
    const integrations = new IntegrationStore(transactions);
    await integrations.putApp({
      id: "app-1",
      businessId: "business-1",
      provider: "slack",
      externalAppId: "A1",
      credentialRefs: [],
      status: "active",
    });
    await integrations.putIntegration({
      id: "integration-1",
      businessId: "business-1",
      appId: "app-1",
      externalTenantId: "T1",
      status: "active",
    });
    store = new ProviderObjectOwnershipStore(transactions, () => "2026-09-07T00:00:00.000Z");
  });

  afterAll(async () => {
    await database.close();
  });

  it("records, scopes, removes, and restores provider ownership", async () => {
    const key = {
      businessId: "business-1",
      integrationId: "integration-1",
      provider: "slack",
      objectType: "bookmark" as const,
      providerObjectId: "Bk1",
      channelId: "C1",
    };
    await store.record({ ...key, creationRunId: "run-1", creationIntentId: "intent-1" });
    await expect(store.owns(key)).resolves.toBe(true);
    await expect(
      store.findByCreationIntent({
        businessId: "business-1",
        integrationId: "integration-1",
        provider: "slack",
        creationIntentId: "intent-1",
      })
    ).resolves.toMatchObject({
      ...key,
      creationRunId: "run-1",
      creationIntentId: "intent-1",
    });
    await expect(store.owns({ ...key, integrationId: "other" })).resolves.toBe(false);
    await expect(store.owns({ ...key, channelId: "C2" })).resolves.toBe(false);

    await store.remove(key);
    await expect(store.owns(key)).resolves.toBe(false);
    await expect(
      store.findByCreationIntent({
        businessId: "business-1",
        integrationId: "integration-1",
        provider: "slack",
        creationIntentId: "intent-1",
      })
    ).resolves.toBeUndefined();

    await store.record({ ...key, creationRunId: "run-2", creationIntentId: "intent-2" });
    await expect(store.owns(key)).resolves.toBe(true);
  });

  it("allows only one active provider object per creation intent", async () => {
    const base = {
      businessId: "business-1",
      integrationId: "integration-1",
      provider: "slack",
      objectType: "file" as const,
      channelId: "C1",
      creationRunId: "run-3",
      creationIntentId: "intent-unique",
    };
    await store.record({ ...base, providerObjectId: "F1" });

    await expect(store.record({ ...base, providerObjectId: "F2" })).rejects.toThrow();
  });
});
