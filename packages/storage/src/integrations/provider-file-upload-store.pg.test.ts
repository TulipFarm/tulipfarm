import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { transactionPort } from "../pg/test-support";
import { INTEGRATION_STORAGE_STATEMENTS, IntegrationStore } from "./integration-store";
import {
  PROVIDER_FILE_UPLOAD_STORAGE_STATEMENTS,
  ProviderFileUploadStore,
} from "./provider-file-upload-store";

describe("ProviderFileUploadStore", () => {
  let database: PGlite;
  let store: ProviderFileUploadStore;

  beforeAll(async () => {
    database = new PGlite();
    for (const statement of [
      ...INTEGRATION_STORAGE_STATEMENTS,
      ...PROVIDER_FILE_UPLOAD_STORAGE_STATEMENTS,
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
    store = new ProviderFileUploadStore(transactions, () => "2026-09-07T00:00:00.000Z");
  });

  afterAll(async () => {
    await database.close();
  });

  it("persists and advances one upload by exact Integration and creation intent", async () => {
    const input = {
      businessId: "business-1",
      integrationId: "integration-1",
      provider: "slack",
      creationIntentId: "intent-1",
      creationRunId: "run-1",
      channelId: "C1",
      sourceFileId: "file-1",
      sourceSha256: "digest",
      filename: "report.pdf",
      mediaType: "application/pdf",
      sizeBytes: 3,
      providerFileId: "F1",
    };
    await store.urlRequested(input);
    await expect(
      store.find({
        businessId: "business-1",
        integrationId: "integration-1",
        provider: "slack",
        creationIntentId: "intent-1",
      })
    ).resolves.toMatchObject({ ...input, phase: "url_requested" });

    await store.advance({
      businessId: "business-1",
      integrationId: "integration-1",
      provider: "slack",
      creationIntentId: "intent-1",
      providerFileId: "F1",
      from: "url_requested",
      to: "bytes_uploaded",
    });
    await store.advance({
      businessId: "business-1",
      integrationId: "integration-1",
      provider: "slack",
      creationIntentId: "intent-1",
      providerFileId: "F1",
      from: "bytes_uploaded",
      to: "completed",
    });

    await expect(
      store.find({
        businessId: "business-1",
        integrationId: "integration-1",
        provider: "slack",
        creationIntentId: "intent-1",
      })
    ).resolves.toMatchObject({ providerFileId: "F1", phase: "completed" });
  });

  it("renews only url_requested and never replaces a progressed File ID", async () => {
    const base = {
      businessId: "business-1",
      integrationId: "integration-1",
      provider: "slack",
      creationIntentId: "intent-2",
      creationRunId: "run-2",
      channelId: "C1",
      sourceFileId: "file-1",
      sourceSha256: "digest",
      filename: "report.pdf",
      mediaType: "application/pdf",
      sizeBytes: 3,
    };
    await store.urlRequested({ ...base, providerFileId: "F-old" });
    await store.urlRequested({ ...base, providerFileId: "F-new" });
    await store.advance({
      businessId: "business-1",
      integrationId: "integration-1",
      provider: "slack",
      creationIntentId: "intent-2",
      providerFileId: "F-new",
      from: "url_requested",
      to: "bytes_uploaded",
    });

    await expect(store.urlRequested({ ...base, providerFileId: "F-too-late" })).rejects.toThrow(
      "provider_file_upload_phase_conflict"
    );
  });
});
