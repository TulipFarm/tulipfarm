import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { transactionPort } from "../pg/test-support";
import { INTEGRATION_STORAGE_STATEMENTS, IntegrationStore } from "./integration-store";
import { SOUL_REPOSITORY_STORAGE_STATEMENTS, SoulRepositoryStore } from "./soul-repository-store";

const BUSINESS_ID = "business-1";
const APP_ID = "00000000-0000-4000-8000-000000000001";
const INTEGRATION_ID = "00000000-0000-4000-8000-000000000002";

describe("SoulRepositoryStore", () => {
  let database: PGlite;
  let store: SoulRepositoryStore;
  let integrations: IntegrationStore;

  beforeAll(async () => {
    database = new PGlite();
    for (const statement of INTEGRATION_STORAGE_STATEMENTS) {
      await database.exec(statement);
    }
    for (const statement of SOUL_REPOSITORY_STORAGE_STATEMENTS) {
      await database.exec(statement);
    }
    const transactions = transactionPort(database);
    store = new SoulRepositoryStore(transactions);
    integrations = new IntegrationStore(transactions);
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await database.query("TRUNCATE TABLE integration_apps CASCADE");
  });

  async function seedIntegration() {
    await integrations.putApp({
      id: APP_ID,
      businessId: BUSINESS_ID,
      provider: "github",
      externalAppId: "A-PRIMARY",
      credentialRefs: ["secret://github/app"],
      status: "active",
    });
    await integrations.putIntegration({
      id: INTEGRATION_ID,
      businessId: BUSINESS_ID,
      appId: APP_ID,
      externalTenantId: "I-ACME",
      credentialRef: "secret://github/installation",
      status: "active",
    });
  }

  it("persists and reads a business's soul repository", async () => {
    await seedIntegration();
    await store.put({
      businessId: BUSINESS_ID,
      integrationId: INTEGRATION_ID,
      owner: "acme",
      repo: "soul",
      createdVia: "connected_existing",
    });

    expect(await store.get(BUSINESS_ID)).toEqual({
      businessId: BUSINESS_ID,
      integrationId: INTEGRATION_ID,
      owner: "acme",
      repo: "soul",
      createdVia: "connected_existing",
    });
  });

  it("returns undefined for a business with no soul repository", async () => {
    expect(await store.get("business-missing")).toBeUndefined();
  });

  it("upserts in place on repeated put for the same business", async () => {
    await seedIntegration();
    await store.put({
      businessId: BUSINESS_ID,
      integrationId: INTEGRATION_ID,
      owner: "acme",
      repo: "soul",
      createdVia: "connected_existing",
    });
    await store.put({
      businessId: BUSINESS_ID,
      integrationId: INTEGRATION_ID,
      owner: "acme",
      repo: "soul-renamed",
      createdVia: "created_via_app",
    });

    expect(await store.get(BUSINESS_ID)).toMatchObject({
      repo: "soul-renamed",
      createdVia: "created_via_app",
    });
  });

  it("rejects a soul repository referencing an integration from another business", async () => {
    await seedIntegration();

    await expect(
      store.put({
        businessId: "business-2",
        integrationId: INTEGRATION_ID,
        owner: "acme",
        repo: "soul",
        createdVia: "connected_existing",
      })
    ).rejects.toThrow();
  });
});
