import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { transactionPort } from "../pg/test-support";
import {
  CHANNEL_SURFACE_STORAGE_STATEMENTS,
  type ChannelSurfaceInstanceKey,
  ChannelSurfaceStore,
  SlackCapabilityObservationStore,
} from "./channel-surface-store";
import {
  INTEGRATION_STORAGE_STATEMENTS,
  IntegrationStore,
  type PersistedIntegrationApp,
} from "./integration-store";

const BUSINESS_ID = "business-1";
const APP_ID = "app-1";
const INTEGRATION_ID = "integration-1";
const NOW = "2026-09-07T04:30:00.000Z";

const app: PersistedIntegrationApp = {
  id: APP_ID,
  businessId: BUSINESS_ID,
  provider: "slack",
  externalAppId: "A-PRIMARY",
  credentialRefs: ["secret://slack/bot"],
  status: "active",
};

const instanceKey: ChannelSurfaceInstanceKey = {
  businessId: BUSINESS_ID,
  provider: "slack",
  integrationId: INTEGRATION_ID,
  externalTenantId: "T-ACME",
  externalSubject: "U-MUSKAN",
  surface: "home",
  externalId: "home",
};

describe("ChannelSurfaceStore", () => {
  let database: PGlite;
  let store: ChannelSurfaceStore;
  let capabilities: SlackCapabilityObservationStore;
  let integrations: IntegrationStore;
  let now: string;

  beforeAll(async () => {
    database = new PGlite();
    await database.exec(`CREATE TABLE artifacts (
      business_id text NOT NULL,
      id text NOT NULL,
      PRIMARY KEY (business_id, id)
    )`);
    for (const statement of [
      ...INTEGRATION_STORAGE_STATEMENTS,
      ...CHANNEL_SURFACE_STORAGE_STATEMENTS,
    ]) {
      await database.exec(statement);
    }
    const transactions = transactionPort(database);
    store = new ChannelSurfaceStore(transactions, () => now);
    capabilities = new SlackCapabilityObservationStore(transactions, () => now);
    integrations = new IntegrationStore(transactions);
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await database.query("TRUNCATE TABLE integration_apps CASCADE");
    await database.query("TRUNCATE TABLE artifacts");
    now = NOW;
    await integrations.putApp(app);
    await integrations.putIntegration({
      id: INTEGRATION_ID,
      businessId: BUSINESS_ID,
      appId: APP_ID,
      externalTenantId: instanceKey.externalTenantId,
      credentialRef: "secret://slack/bot",
      status: "active",
    });
    await database.query("INSERT INTO artifacts (business_id, id) VALUES ($1, $2)", [
      BUSINESS_ID,
      "artifact-1",
    ]);
  });

  it("gets and upserts provider view state without storing provider payloads", async () => {
    expect(await store.getInstance(instanceKey)).toBeNull();

    await store.upsertInstance({
      ...instanceKey,
      providerViewId: "V-1",
      providerHash: "hash-1",
      artifactId: "artifact-1",
      artifactRevision: 3,
      renderDigest: "digest-1",
      status: "active",
      lastPublishedAt: NOW,
    });

    expect(await store.getInstance(instanceKey)).toMatchObject({
      ...instanceKey,
      providerViewId: "V-1",
      providerHash: "hash-1",
      artifactId: "artifact-1",
      artifactRevision: 3,
      renderDigest: "digest-1",
      status: "active",
      lastPublishedAt: NOW,
    });

    await expect(
      store.upsertInstance({
        ...instanceKey,
        artifactId: "missing",
        artifactRevision: 1,
        renderDigest: "digest-2",
        status: "active",
      })
    ).rejects.toThrow("channel_surface_artifact_reference_invalid");
  });

  it("coalesces duplicate opens and supersedes older queued work on explicit refresh", async () => {
    const [first, duplicate] = await Promise.all([
      store.enqueuePublish({
        ...instanceKey,
        coalescingKey: "slack-home:integration-1:U-MUSKAN:bucket-1",
        supersedePending: false,
      }),
      store.enqueuePublish({
        ...instanceKey,
        coalescingKey: "slack-home:integration-1:U-MUSKAN:bucket-1",
        supersedePending: false,
      }),
    ]);
    const refresh = await store.enqueuePublish({
      ...instanceKey,
      coalescingKey: "slack-home:integration-1:U-MUSKAN:refresh-1",
      supersedePending: true,
    });

    expect(first).toMatchObject({ outcome: "enqueued", job: { generation: 1 } });
    expect(duplicate).toMatchObject({ outcome: "coalesced", job: { generation: 1 } });
    expect(refresh).toMatchObject({ outcome: "enqueued", job: { generation: 2 } });
    expect(await store.getPublishJob(first.job)).toMatchObject({ status: "superseded" });
  });

  it("leases due work once and conditionally finalizes provider success", async () => {
    const { job } = await store.enqueuePublish({
      ...instanceKey,
      coalescingKey: "slack-home:integration-1:U-MUSKAN:bucket-1",
      supersedePending: false,
    });

    const [claimed] = await store.claimPublish({
      businessId: BUSINESS_ID,
      owner: "worker-1",
      limit: 1,
      leaseDurationMs: 30_000,
    });
    expect(claimed).toMatchObject({
      generation: job.generation,
      status: "leased",
      leaseOwner: "worker-1",
      attempt: 1,
    });
    expect(
      await store.claimPublish({
        businessId: BUSINESS_ID,
        owner: "worker-2",
        limit: 1,
        leaseDurationMs: 30_000,
      })
    ).toEqual([]);

    expect(
      await store.finalizePublishSuccess({
        key: instanceKey,
        generation: job.generation,
        leaseOwner: "worker-2",
        providerViewId: "V-1",
        providerHash: "hash-1",
        renderDigest: "digest-1",
      })
    ).toBe(false);
    expect(
      await store.finalizePublishSuccess({
        key: instanceKey,
        generation: job.generation,
        leaseOwner: "worker-1",
        providerViewId: "V-1",
        providerHash: "hash-1",
        renderDigest: "digest-1",
      })
    ).toBe(true);

    const completed = await store.getPublishJob(job);
    expect(completed).toMatchObject({ status: "succeeded" });
    expect(completed).not.toHaveProperty("leaseOwner");
    expect(await store.getInstance(instanceKey)).toMatchObject({
      providerViewId: "V-1",
      providerHash: "hash-1",
      renderDigest: "digest-1",
      lastPublishedAt: NOW,
    });
  });

  it("finds the latest generation and lets its lease owner supersede stale work", async () => {
    const first = await store.enqueuePublish({
      ...instanceKey,
      coalescingKey: "slack-home:integration-1:U-MUSKAN:first",
      supersedePending: false,
    });
    const [claimed] = await store.claimPublish({
      businessId: BUSINESS_ID,
      owner: "worker-1",
      limit: 1,
      leaseDurationMs: 30_000,
    });
    const second = await store.enqueuePublish({
      ...instanceKey,
      coalescingKey: "slack-home:integration-1:U-MUSKAN:second",
      supersedePending: true,
    });

    await expect(store.getLatestPublishJob(first.job)).resolves.toMatchObject({
      generation: second.job.generation,
      status: "pending",
    });
    await expect(store.supersedePublish({ job: claimed, leaseOwner: "worker-1" })).resolves.toBe(
      true
    );
    await expect(store.getPublishJob(first.job)).resolves.toMatchObject({
      status: "superseded",
    });
  });

  it("releases retryable failures until their durable retry time", async () => {
    const { job } = await store.enqueuePublish({
      ...instanceKey,
      coalescingKey: "slack-home:integration-1:U-MUSKAN:bucket-1",
      supersedePending: false,
    });
    await store.claimPublish({
      businessId: BUSINESS_ID,
      owner: "worker-1",
      limit: 1,
      leaseDurationMs: 30_000,
    });

    expect(
      await store.finalizePublishFailure({
        job,
        leaseOwner: "worker-1",
        status: "retry_wait",
        errorCode: "rate_limited",
        nextAttemptAt: "2026-09-07T04:30:10.000Z",
      })
    ).toBe(true);
    expect(
      await store.claimPublish({
        businessId: BUSINESS_ID,
        owner: "worker-2",
        limit: 1,
        leaseDurationMs: 30_000,
      })
    ).toEqual([]);

    now = "2026-09-07T04:30:10.000Z";
    expect(
      await store.claimPublish({
        businessId: BUSINESS_ID,
        owner: "worker-2",
        limit: 1,
        leaseDurationMs: 30_000,
      })
    ).toEqual([expect.objectContaining({ status: "leased", leaseOwner: "worker-2", attempt: 2 })]);
  });

  it("lets another worker take over an expired lease", async () => {
    await store.enqueuePublish({
      ...instanceKey,
      coalescingKey: "slack-home:integration-1:U-MUSKAN:bucket-1",
      supersedePending: false,
    });
    await store.claimPublish({
      businessId: BUSINESS_ID,
      owner: "worker-1",
      limit: 1,
      leaseDurationMs: 5000,
    });

    now = "2026-09-07T04:30:05.000Z";
    expect(
      await store.claimPublish({
        businessId: BUSINESS_ID,
        owner: "worker-2",
        limit: 1,
        leaseDurationMs: 5000,
      })
    ).toEqual([expect.objectContaining({ status: "leased", leaseOwner: "worker-2", attempt: 2 })]);
  });

  it("returns only unexpired capability observations and replaces prior evidence", async () => {
    const key = {
      businessId: BUSINESS_ID,
      integrationId: INTEGRATION_ID,
      capability: "data_table",
      rendererVersion: "1",
    };

    await capabilities.upsert({
      ...key,
      status: "unsupported",
      expiresAt: "2026-09-08T04:30:00.000Z",
    });
    expect(await capabilities.get(key)).toMatchObject({ ...key, status: "unsupported" });

    await capabilities.upsert({
      ...key,
      status: "supported",
      expiresAt: "2026-09-07T04:31:00.000Z",
    });
    expect(await capabilities.get(key)).toMatchObject({ status: "supported" });

    now = "2026-09-07T04:31:00.000Z";
    expect(await capabilities.get(key)).toBeNull();
  });
});
