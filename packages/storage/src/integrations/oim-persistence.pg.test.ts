import { PGlite } from "@electric-sql/pglite";
import type { OimConnection } from "@tulipfarm/schema";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { transactionPort } from "../pg/test-support";
import type { Queryable, TransactionPort } from "../ports";
import {
  CONNECTION_AUTH_STEP_STORAGE_STATEMENTS,
  ConnectionAuthStepStore,
} from "./connection-auth-step-store";
import {
  CONNECTION_EXTERNAL_IDENTITY_STORAGE_STATEMENTS,
  ConnectionExternalIdentityConflictError,
  ConnectionExternalIdentityStore,
} from "./connection-external-identity-store";
import { CONNECTION_STORAGE_STATEMENTS, ConnectionStore } from "./connection-store";
import {
  OIM_KNOWLEDGE_CHECKPOINT_STORAGE_STATEMENTS,
  OimKnowledgeCheckpointStore,
} from "./oim-knowledge-checkpoint-store";
import { POLLING_INGRESS_STORAGE_STATEMENTS, PollingIngressStore } from "./polling-ingress-store";
import {
  WEBHOOK_INBOX_STORAGE_STATEMENTS,
  WebhookDeduplicationConflictError,
  WebhookInboxStore,
} from "./webhook-inbox-store";

const BUSINESS_ID = "business-1";
const CONNECTION_ID = "connection-1";
const OTHER_CONNECTION_ID = "connection-2";

function connection(id: string, overrides: Partial<OimConnection> = {}): OimConnection {
  return {
    id,
    integration: { id: "calendar", majorVersion: 2 },
    label: id,
    owner: { scope: "organization" },
    status: "active",
    isDefault: false,
    configuration: { region: "us" },
    agentVisibleConfiguration: ["region"],
    secretBindings: { access: "secret://00000000-0000-4000-8000-000000000001" },
    health: { status: "unknown", checkedAt: null },
    expiresAt: null,
    ...overrides,
  };
}

describe("OIM persistence foundations", () => {
  let database: PGlite;

  beforeAll(async () => {
    database = new PGlite();
    for (const statement of [
      ...CONNECTION_STORAGE_STATEMENTS,
      ...CONNECTION_AUTH_STEP_STORAGE_STATEMENTS,
      ...CONNECTION_EXTERNAL_IDENTITY_STORAGE_STATEMENTS,
      ...WEBHOOK_INBOX_STORAGE_STATEMENTS,
      ...POLLING_INGRESS_STORAGE_STATEMENTS,
      ...OIM_KNOWLEDGE_CHECKPOINT_STORAGE_STATEMENTS,
    ]) {
      await database.exec(statement);
    }
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await database.query(`
      TRUNCATE TABLE
        connection_auth_steps,
        connection_external_identities,
        connections,
        webhook_deliveries,
        polling_ingress_state,
        oim_knowledge_scan_checkpoints
    `);
    await new ConnectionStore(transactionPort(database)).put(
      BUSINESS_ID,
      connection(CONNECTION_ID)
    );
  });

  it("keeps one active default per exact owner and Integration major", async () => {
    const store = new ConnectionStore(transactionPort(database));
    await store.put(BUSINESS_ID, connection(CONNECTION_ID, { isDefault: true }));
    await store.put(BUSINESS_ID, connection(OTHER_CONNECTION_ID, { isDefault: true }));
    await store.put(
      BUSINESS_ID,
      connection("team-connection", {
        owner: { scope: "team", teamId: "00000000-0000-4000-8000-000000000002" },
        isDefault: true,
      })
    );

    const organization = await store.listForOwner(
      BUSINESS_ID,
      { id: "calendar", majorVersion: 2 },
      { scope: "organization" }
    );
    const team = await store.listForOwner(
      BUSINESS_ID,
      { id: "calendar", majorVersion: 2 },
      { scope: "team", teamId: "00000000-0000-4000-8000-000000000002" }
    );

    expect(organization.map(({ id, isDefault }) => [id, isDefault])).toEqual([
      [OTHER_CONNECTION_ID, true],
      [CONNECTION_ID, false],
    ]);
    expect(team).toMatchObject([{ id: "team-connection", isDefault: true }]);
  });

  it("updates one OAuth step without overwriting another step", async () => {
    const store = new ConnectionAuthStepStore(transactionPort(database));
    const base = {
      businessId: BUSINESS_ID,
      connectionId: CONNECTION_ID,
      status: "active" as const,
      accessSlot: "access_token",
      accessSecretRef: "secret://00000000-0000-4000-8000-000000000011",
      refreshSlot: "refresh_token",
      refreshSecretRef: "secret://00000000-0000-4000-8000-000000000013",
      externalIdentity: { subject: "user-1" },
      expiresAt: "2026-09-12T10:00:00.000Z",
      healthCheckedAt: "2026-09-12T09:00:00.000Z",
    };
    await store.put({ ...base, stepId: "account" });
    await store.put({
      ...base,
      stepId: "admin",
      accessSecretRef: "secret://00000000-0000-4000-8000-000000000012",
    });

    const account = await store.find(BUSINESS_ID, CONNECTION_ID, "account");
    expect(
      await store.updateHealth({
        businessId: BUSINESS_ID,
        connectionId: CONNECTION_ID,
        stepId: "account",
        expectedRevision: account?.revision ?? 0,
        status: "action_required",
        expiresAt: null,
        healthCheckedAt: "2026-09-12T09:30:00.000Z",
      })
    ).not.toBeNull();

    await expect(store.find(BUSINESS_ID, CONNECTION_ID, "admin")).resolves.toMatchObject({
      status: "active",
      accessSlot: "access_token",
      accessSecretRef: "secret://00000000-0000-4000-8000-000000000012",
      refreshSlot: "refresh_token",
      expiresAt: "2026-09-12T10:00:00.000Z",
    });
  });

  it("immutably binds verified provider identity to the selected Connection", async () => {
    const store = new ConnectionExternalIdentityStore(transactionPort(database));
    await new ConnectionStore(transactionPort(database)).put(
      BUSINESS_ID,
      connection(CONNECTION_ID, {
        configuration: {
          external_tenant_id: "untrusted-tenant",
          external_account_id: "untrusted-account",
        },
        agentVisibleConfiguration: ["external_tenant_id", "external_account_id"],
      })
    );
    const binding = {
      businessId: BUSINESS_ID,
      connectionId: CONNECTION_ID,
      integrationId: "calendar",
      integrationMajorVersion: 2,
      externalTenantId: "tenant-1",
      externalAccountId: "account-1",
      proofKind: "auth" as const,
      proofDigest: "a".repeat(64),
      verifiedAt: "2026-09-12T09:00:00.000Z",
      verifiedBy: "oim-auth-service",
    };

    await expect(store.bindVerified(binding)).resolves.toMatchObject(binding);
    await expect(store.bindVerified(binding)).resolves.toMatchObject(binding);
    await expect(
      store.bindVerified({ ...binding, externalAccountId: "account-2" })
    ).rejects.toBeInstanceOf(ConnectionExternalIdentityConflictError);
    await expect(store.find(BUSINESS_ID, CONNECTION_ID)).resolves.toMatchObject({
      externalTenantId: "tenant-1",
      externalAccountId: "account-1",
      proofKind: "auth",
      verifiedBy: "oim-auth-service",
    });
  });

  it("deduplicates only within the full webhook routing identity", async () => {
    const store = new WebhookInboxStore(transactionPort(database));
    const connections = new ConnectionStore(transactionPort(database));
    await connections.put(BUSINESS_ID, connection(OTHER_CONNECTION_ID));
    await connections.put(
      BUSINESS_ID,
      connection("connection-3", {
        integration: { id: "calendar", majorVersion: 3 },
      })
    );
    const input = {
      integrationId: "calendar",
      integrationMajorVersion: 2,
      connectionId: CONNECTION_ID,
      deduplicationKey: "provider-event-1",
      bodySha256: "body",
      safeHeaders: {},
      encryptedBody: "ciphertext",
      eventType: null,
      verification: "verified",
    };

    await expect(store.record(BUSINESS_ID, { ...input, id: "delivery-1" })).resolves.toMatchObject({
      accepted: true,
    });

    await expect(
      store.record(BUSINESS_ID, { ...input, id: "delivery-2", connectionId: OTHER_CONNECTION_ID })
    ).resolves.toMatchObject({ accepted: true });
    await expect(
      store.record(BUSINESS_ID, {
        ...input,
        id: "delivery-3",
        integrationMajorVersion: 3,
        connectionId: "connection-3",
      })
    ).resolves.toMatchObject({ accepted: true });
    await expect(store.record(BUSINESS_ID, { ...input, id: "delivery-4" })).resolves.toMatchObject({
      accepted: false,
      delivery: { id: "delivery-1" },
    });
  });

  it("deduplicates verified webhook evidence independently of unsigned delivery ids", async () => {
    const store = new WebhookInboxStore(transactionPort(database));
    const connections = new ConnectionStore(transactionPort(database));
    await connections.put(BUSINESS_ID, connection(OTHER_CONNECTION_ID));
    await connections.put(
      BUSINESS_ID,
      connection("connection-3", {
        integration: { id: "calendar", majorVersion: 3 },
      })
    );
    const input = {
      integrationId: "calendar",
      integrationMajorVersion: 2,
      connectionId: CONNECTION_ID,
      authenticatedEvidenceDigest: "b".repeat(64),
      bodySha256: "body",
      safeHeaders: {},
      encryptedBody: "ciphertext",
      eventType: null,
      verification: "verified" as const,
    };

    await expect(
      store.recordVerified(BUSINESS_ID, {
        ...input,
        id: "verified-1",
        deduplicationKey: "unsigned-id-1",
      })
    ).resolves.toMatchObject({ accepted: true });
    await expect(
      store.recordVerified(BUSINESS_ID, {
        ...input,
        id: "verified-2",
        deduplicationKey: "unsigned-id-2",
      })
    ).resolves.toMatchObject({ accepted: false, delivery: { id: "verified-1" } });
    await expect(
      store.recordVerified(BUSINESS_ID, {
        ...input,
        id: "verified-3",
        connectionId: OTHER_CONNECTION_ID,
        deduplicationKey: "unsigned-id-2",
      })
    ).resolves.toMatchObject({ accepted: true });
    await expect(
      store.recordVerified(BUSINESS_ID, {
        ...input,
        id: "verified-4",
        integrationMajorVersion: 3,
        connectionId: "connection-3",
        deduplicationKey: "unsigned-id-2",
      })
    ).resolves.toMatchObject({ accepted: true });
    await expect(
      store.recordVerified(BUSINESS_ID, {
        ...input,
        id: "verified-conflict",
        deduplicationKey: "unsigned-id-3",
        bodySha256: "different-body",
      })
    ).rejects.toBeInstanceOf(WebhookDeduplicationConflictError);
  });

  it("upgrades a matching legacy delivery without trusting a conflicting provider id", async () => {
    const store = new WebhookInboxStore(transactionPort(database));
    const legacy = {
      integrationId: "calendar",
      integrationMajorVersion: 2,
      connectionId: CONNECTION_ID,
      deduplicationKey: "provider-event-1",
      bodySha256: "same-body",
      safeHeaders: {},
      encryptedBody: "ciphertext",
      eventType: null,
      verification: "legacy",
    };
    await store.record(BUSINESS_ID, { ...legacy, id: "legacy-delivery" });

    await expect(
      store.recordVerified(BUSINESS_ID, {
        ...legacy,
        id: "verified-retry",
        verification: "verified",
        authenticatedEvidenceDigest: "c".repeat(64),
      })
    ).resolves.toMatchObject({
      accepted: false,
      delivery: {
        id: "legacy-delivery",
        verification: "verified",
        authenticatedEvidenceDigest: "c".repeat(64),
      },
    });
    await expect(
      store.recordVerified(BUSINESS_ID, {
        ...legacy,
        id: "conflicting-retry",
        bodySha256: "different-body",
        verification: "verified",
        authenticatedEvidenceDigest: "d".repeat(64),
      })
    ).rejects.toBeInstanceOf(WebhookDeduplicationConflictError);
  });

  it("reloads the verified winner when a concurrent legacy upgrade wins the CAS", async () => {
    const legacyStore = new WebhookInboxStore(transactionPort(database));
    const input = {
      integrationId: "calendar",
      integrationMajorVersion: 2,
      connectionId: CONNECTION_ID,
      deduplicationKey: "provider-event-1",
      bodySha256: "same-body",
      safeHeaders: {},
      encryptedBody: "ciphertext",
      eventType: null,
      verification: "verified" as const,
      authenticatedEvidenceDigest: "e".repeat(64),
    };
    await legacyStore.record(BUSINESS_ID, {
      ...input,
      id: "legacy-delivery",
      verification: "legacy",
    });
    let intercepted = false;
    const concurrentTransactions: TransactionPort = {
      async withTransaction<T>(operation: (transaction: Queryable) => Promise<T>): Promise<T> {
        return operation({
          async query<Row>(text: string, params: readonly unknown[] = []) {
            if (!intercepted && text.includes("SET authenticated_evidence_digest = $3")) {
              intercepted = true;
              await database.query(
                `UPDATE webhook_deliveries
                    SET authenticated_evidence_digest = $3,
                        verification = 'verified'
                  WHERE business_id = $1 AND id = $2`,
                [BUSINESS_ID, "legacy-delivery", input.authenticatedEvidenceDigest]
              );
              return { rows: [] as Row[] };
            }
            return database.query<Row>(text, [...params]);
          },
        });
      },
    };
    const concurrentStore = new WebhookInboxStore(concurrentTransactions);

    await expect(
      concurrentStore.recordVerified(BUSINESS_ID, { ...input, id: "verified-retry" })
    ).resolves.toMatchObject({
      accepted: false,
      delivery: {
        id: "legacy-delivery",
        authenticatedEvidenceDigest: input.authenticatedEvidenceDigest,
      },
    });
    expect(intercepted).toBe(true);
  });

  it("fences each webhook normalization and dispatch transition", async () => {
    const store = new WebhookInboxStore(transactionPort(database));
    const now = new Date(Date.now() + 1_000);
    await store.record(BUSINESS_ID, {
      id: "delivery-1",
      integrationId: "calendar",
      integrationMajorVersion: 2,
      connectionId: CONNECTION_ID,
      deduplicationKey: "provider-event-1",
      bodySha256: "body",
      safeHeaders: {},
      encryptedBody: "ciphertext",
      eventType: null,
      verification: "verified",
    });
    const firstClaim = (await store.claim(1, 30, now))[0];
    if (firstClaim === undefined || firstClaim.leaseExpiresAt === null) {
      throw new Error("delivery was not leased");
    }
    await expect(
      store.markNormalized(
        BUSINESS_ID,
        firstClaim.id,
        "event.created",
        { id: "event-1" },
        {
          expectedState: "accepted",
          expectedAttempts: firstClaim.attempts,
          expectedLeaseExpiresAt: firstClaim.leaseExpiresAt,
          now,
        }
      )
    ).resolves.toBe(true);
    const secondClaim = (await store.claim(1, 30, now))[0];
    if (secondClaim === undefined || secondClaim.leaseExpiresAt === null) {
      throw new Error("normalized delivery was not leased");
    }

    await expect(
      store.markDispatched(BUSINESS_ID, secondClaim.id, {
        expectedState: "normalized",
        expectedAttempts: secondClaim.attempts,
        expectedLeaseExpiresAt: secondClaim.leaseExpiresAt,
      })
    ).resolves.toBe(true);
    await expect(store.findById(BUSINESS_ID, "delivery-1")).resolves.toMatchObject({
      state: "dispatched",
      normalizedPayload: { id: "event-1" },
    });
  });

  it("fences stale polling completions", async () => {
    const store = new PollingIngressStore(transactionPort(database));
    const now = new Date(Date.now() + 1_000);
    await expect(store.claim(BUSINESS_ID, CONNECTION_ID, "lease-1", 10, now)).resolves.toEqual({
      cursor: null,
    });
    await expect(
      store.claim(BUSINESS_ID, CONNECTION_ID, "lease-2", 10, new Date(now.getTime() + 11_000))
    ).resolves.toEqual({ cursor: null });
    await expect(
      store.complete(BUSINESS_ID, CONNECTION_ID, "lease-1", "stale", 60, now)
    ).resolves.toBe(false);
  });

  it("resumes scans, fences stale writers, and advances the baseline only after completion", async () => {
    const store = new OimKnowledgeCheckpointStore(transactionPort(database));
    const key = {
      businessId: BUSINESS_ID,
      integrationId: "calendar",
      integrationMajorVersion: 2,
      connectionId: CONNECTION_ID,
      sourceKind: "events",
      scope: "team-1",
    };
    const started = await store.claim(
      key,
      "scan-1",
      "lease-1",
      10,
      new Date("2026-09-12T09:00:00Z")
    );
    const firstPage = await store.appendPage(
      key,
      "lease-1",
      started?.revision ?? 0,
      "page-2",
      ["a", "b"],
      new Date("2026-09-12T09:00:01Z")
    );
    const secondPage = await store.appendPage(
      key,
      "lease-1",
      firstPage?.revision ?? 0,
      null,
      ["b", "c"],
      new Date("2026-09-12T09:00:02Z")
    );
    const resumed = await store.claim(
      key,
      "scan-1",
      "lease-2",
      10,
      new Date("2026-09-12T09:00:11Z")
    );

    expect(resumed).toMatchObject({
      baselineItemIds: [],
      scanId: "scan-1",
      continuation: null,
      accumulatedSeenItemIds: ["a", "b", "c"],
    });
    await expect(
      store.appendPage(
        key,
        "lease-1",
        secondPage?.revision ?? 0,
        null,
        ["stale"],
        new Date("2026-09-12T09:00:12Z")
      )
    ).resolves.toBeNull();

    const staged = await store.stageCompletion(
      key,
      "lease-2",
      resumed?.revision ?? 0,
      ["removed"],
      new Date("2026-09-12T09:00:12Z")
    );
    await expect(
      store.complete(key, "lease-2", staged?.revision ?? 0, new Date("2026-09-12T09:00:13Z"))
    ).resolves.toBeNull();
    const acknowledged = await store.acknowledgeDeletions(
      key,
      "lease-2",
      staged?.revision ?? 0,
      ["removed"],
      new Date("2026-09-12T09:00:13Z")
    );
    await expect(
      store.complete(key, "lease-2", acknowledged?.revision ?? 0, new Date("2026-09-12T09:00:14Z"))
    ).resolves.toMatchObject({
      baselineItemIds: ["a", "b", "c"],
      scanId: null,
      accumulatedSeenItemIds: [],
      pendingDeletionItemIds: [],
    });
  });

  it.each(["append", "stage", "acknowledge", "complete", "release"] as const)(
    "refuses expired %s mutations without losing scan state",
    async (operation) => {
      const store = new OimKnowledgeCheckpointStore(transactionPort(database));
      const key = {
        businessId: BUSINESS_ID,
        integrationId: "calendar",
        integrationMajorVersion: 2,
        connectionId: CONNECTION_ID,
        sourceKind: "events",
        scope: operation,
      };
      const claimed = await store.claim(
        key,
        "scan-1",
        "lease-1",
        10,
        new Date("2026-09-12T09:00:00Z")
      );
      const staged =
        operation === "acknowledge"
          ? await store.stageCompletion(
              key,
              "lease-1",
              claimed?.revision ?? 0,
              ["pending"],
              new Date("2026-09-12T09:00:01Z")
            )
          : claimed;
      const before = await store.load(key);
      const revision = staged?.revision ?? 0;
      const expiredAt = new Date("2026-09-12T09:00:10Z");
      const result =
        operation === "append"
          ? await store.appendPage(key, "lease-1", revision, null, ["late"], expiredAt)
          : operation === "stage"
            ? await store.stageCompletion(key, "lease-1", revision, ["late"], expiredAt)
            : operation === "acknowledge"
              ? await store.acknowledgeDeletions(key, "lease-1", revision, ["pending"], expiredAt)
              : operation === "complete"
                ? await store.complete(key, "lease-1", revision, expiredAt)
                : await store.release(key, "lease-1", revision, expiredAt);

      expect(result).toBeNull();
      await expect(store.load(key)).resolves.toEqual(before);
    }
  );
});
