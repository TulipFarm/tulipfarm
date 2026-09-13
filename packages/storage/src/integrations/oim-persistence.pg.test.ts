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
  INGRESS_TEARDOWN_STORAGE_STATEMENTS,
  IngressTeardownStore,
} from "./ingress-teardown-store";
import { OIM_INGRESS_EMISSION_STORAGE_STATEMENTS } from "./oim-ingress-emission-store";
import {
  OIM_KNOWLEDGE_CHECKPOINT_STORAGE_STATEMENTS,
  OIM_KNOWLEDGE_CHECKPOINT_WATERMARK_STORAGE_STATEMENTS,
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

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

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
      ...INGRESS_TEARDOWN_STORAGE_STATEMENTS,
      ...WEBHOOK_INBOX_STORAGE_STATEMENTS,
      ...OIM_INGRESS_EMISSION_STORAGE_STATEMENTS,
      ...POLLING_INGRESS_STORAGE_STATEMENTS,
      ...OIM_KNOWLEDGE_CHECKPOINT_STORAGE_STATEMENTS,
      ...OIM_KNOWLEDGE_CHECKPOINT_WATERMARK_STORAGE_STATEMENTS,
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
        oim_ingress_teardowns,
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
    const claimed = await store.update({
      businessId: BUSINESS_ID,
      connectionId: CONNECTION_ID,
      stepId: "account",
      expectedRevision: account?.revision ?? 0,
      status: "pending",
      accessSlot: "access_token",
      accessSecretRef: "secret://00000000-0000-4000-8000-000000000011",
      refreshSlot: "refresh_token",
      refreshSecretRef: "secret://00000000-0000-4000-8000-000000000013",
      externalIdentity: { subject: "user-1" },
      expiresAt: "2026-09-12T10:00:00.000Z",
      healthCheckedAt: "2026-09-12T09:15:00.000Z",
    });
    expect(claimed).toMatchObject({ status: "pending", revision: 2 });
    await expect(
      store.update({
        businessId: BUSINESS_ID,
        connectionId: CONNECTION_ID,
        stepId: "account",
        expectedRevision: account?.revision ?? 0,
        status: "action_required",
        accessSlot: "access_token",
        accessSecretRef: "secret://00000000-0000-4000-8000-000000000011",
        refreshSlot: "refresh_token",
        refreshSecretRef: "secret://00000000-0000-4000-8000-000000000013",
        externalIdentity: { subject: "user-1" },
        expiresAt: null,
        healthCheckedAt: "2026-09-12T09:30:00.000Z",
      })
    ).resolves.toBeNull();

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

  it("atomically publishes step patches, preserves concurrent bindings, and fences revoke", async () => {
    const connections = new ConnectionStore(transactionPort(database));
    const authSteps = new ConnectionAuthStepStore(transactionPort(database));
    for (const stepId of ["account", "admin"]) {
      await authSteps.put({
        businessId: BUSINESS_ID,
        connectionId: CONNECTION_ID,
        stepId,
        status: "pending",
        accessSlot: null,
        accessSecretRef: null,
        refreshSlot: null,
        refreshSecretRef: null,
        externalIdentity: null,
        expiresAt: null,
        healthCheckedAt: "2026-09-12T09:00:00.000Z",
      });
    }
    const identity = {
      businessId: BUSINESS_ID,
      connectionId: CONNECTION_ID,
      integrationId: "calendar",
      integrationMajorVersion: 2,
      externalTenantId: "tenant-1",
      externalAccountId: "account-1",
      proofKind: "auth" as const,
      proofDigest: "b".repeat(64),
      verifiedAt: "2026-09-12T09:00:00.000Z",
      verifiedBy: "provider-profile",
    };
    const publish = async (stepId: string, expectedRevision: number, ref: `secret://${string}`) =>
      connections.publishAuthStep({
        businessId: BUSINESS_ID,
        connectionId: CONNECTION_ID,
        integration: { id: "calendar", majorVersion: 2 },
        owner: { scope: "organization" },
        stepId,
        expectedRevision,
        status: "active",
        accessSlot: `${stepId}_access`,
        accessSecretRef: ref,
        refreshSlot: null,
        refreshSecretRef: null,
        externalIdentity: {
          externalTenantId: "tenant-1",
          externalAccountId: "account-1",
        },
        expiresAt: "2026-09-12T10:00:00.000Z",
        healthCheckedAt: "2026-09-12T09:00:00.000Z",
        configuration: { [`${stepId}_site`]: `${stepId}.example.test` },
        secretBindings: { [`${stepId}_access`]: ref },
        verifiedIdentity: identity,
      });

    await expect(
      Promise.all([
        publish("account", 1, "secret://00000000-0000-4000-8000-000000000021"),
        publish("admin", 1, "secret://00000000-0000-4000-8000-000000000022"),
      ])
    ).resolves.toEqual([true, true]);
    await expect(
      publish("account", 1, "secret://00000000-0000-4000-8000-000000000023")
    ).resolves.toBe(false);

    await expect(connections.findById(BUSINESS_ID, CONNECTION_ID)).resolves.toMatchObject({
      configuration: {
        region: "us",
        account_site: "account.example.test",
        admin_site: "admin.example.test",
      },
      secretBindings: {
        access: "secret://00000000-0000-4000-8000-000000000001",
        account_access: "secret://00000000-0000-4000-8000-000000000021",
        admin_access: "secret://00000000-0000-4000-8000-000000000022",
      },
      health: { status: "healthy" },
    });

    await connections.claimAuthStep({
      businessId: BUSINESS_ID,
      connectionId: CONNECTION_ID,
      integration: { id: "calendar", majorVersion: 2 },
      owner: { scope: "organization" },
      stepId: "account",
      expectedRevision: 2,
      healthCheckedAt: "2026-09-12T09:30:00.000Z",
    });
    await expect(
      connections.publishAuthStep({
        businessId: BUSINESS_ID,
        connectionId: CONNECTION_ID,
        integration: { id: "calendar", majorVersion: 2 },
        owner: { scope: "organization" },
        stepId: "account",
        expectedRevision: 3,
        status: "active",
        accessSlot: "account_access",
        accessSecretRef: "secret://00000000-0000-4000-8000-000000000024",
        refreshSlot: null,
        refreshSecretRef: null,
        externalIdentity: null,
        expiresAt: null,
        healthCheckedAt: "2026-09-12T09:30:00.000Z",
        configuration: {},
        secretBindings: {
          account_access: "secret://00000000-0000-4000-8000-000000000024",
        },
        verifiedIdentity: { ...identity, externalAccountId: "account-2" },
      })
    ).rejects.toBeInstanceOf(ConnectionExternalIdentityConflictError);
    await expect(connections.findById(BUSINESS_ID, CONNECTION_ID)).resolves.toMatchObject({
      secretBindings: {
        account_access: "secret://00000000-0000-4000-8000-000000000021",
      },
    });
    await expect(authSteps.find(BUSINESS_ID, CONNECTION_ID, "account")).resolves.toMatchObject({
      status: "pending",
      revision: 3,
    });

    const revoked = await connections.fenceRevocation(BUSINESS_ID, CONNECTION_ID);
    expect(revoked).toMatchObject({
      status: "revoked",
      isDefault: false,
      health: { status: "action_required" },
    });
    expect(revoked?.secretBindings.admin_access).toBe(
      "secret://00000000-0000-4000-8000-000000000022"
    );
    await expect(
      publish("admin", 2, "secret://00000000-0000-4000-8000-000000000025")
    ).resolves.toBe(false);
    await expect(
      connections.claimAuthStep({
        businessId: BUSINESS_ID,
        connectionId: CONNECTION_ID,
        integration: { id: "calendar", majorVersion: 2 },
        owner: { scope: "organization" },
        stepId: "admin",
        expectedRevision: 3,
        healthCheckedAt: "2026-09-12T10:00:00.000Z",
      })
    ).resolves.toBe(false);
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
      externalTenantId: "tenant-1",
      externalAccountId: "account-1",
      deduplicationKey: "provider-event-1",
      bodySha256: "body",
      safeHeaders: {},
      encryptedBody: "ciphertext",
      eventType: null,
      verification: "verified" as const,
      authenticatedEvidenceDigest: "a".repeat(64),
    };

    await expect(
      store.recordVerified(BUSINESS_ID, { ...input, id: "delivery-1" })
    ).resolves.toMatchObject({ accepted: true });

    await expect(
      store.recordVerified(BUSINESS_ID, {
        ...input,
        id: "delivery-2",
        connectionId: OTHER_CONNECTION_ID,
        authenticatedEvidenceDigest: "b".repeat(64),
      })
    ).resolves.toMatchObject({ accepted: true });
    await expect(
      store.recordVerified(BUSINESS_ID, {
        ...input,
        id: "delivery-3",
        integrationMajorVersion: 3,
        connectionId: "connection-3",
        authenticatedEvidenceDigest: "c".repeat(64),
      })
    ).resolves.toMatchObject({ accepted: true });
    await expect(
      store.recordVerified(BUSINESS_ID, { ...input, id: "delivery-4" })
    ).resolves.toMatchObject({ accepted: false, delivery: { id: "delivery-1" } });
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
      externalTenantId: "tenant-1",
      externalAccountId: "account-1",
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
      externalTenantId: "tenant-1",
      externalAccountId: "account-1",
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
      externalTenantId: "tenant-1",
      externalAccountId: "account-1",
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

  it("removes polling state and rejects new claims after Connection revoke", async () => {
    const transactions = transactionPort(database);
    const polling = new PollingIngressStore(transactions);
    const connections = new ConnectionStore(transactions);
    const now = new Date(Date.now() + 1_000);

    await expect(polling.claim(BUSINESS_ID, CONNECTION_ID, "lease-1", 10, now)).resolves.toEqual({
      cursor: null,
    });
    await expect(polling.remove(BUSINESS_ID, CONNECTION_ID)).resolves.toBe(true);
    await connections.markRevoked(BUSINESS_ID, CONNECTION_ID);

    await expect(polling.claim(BUSINESS_ID, CONNECTION_ID, "lease-2", 10, now)).resolves.toBeNull();
    await expect(polling.remove(BUSINESS_ID, CONNECTION_ID)).resolves.toBe(false);
  });

  it("durably disables polling before Connection revoke", async () => {
    const transactions = transactionPort(database);
    const polling = new PollingIngressStore(transactions);
    const teardowns = new IngressTeardownStore(transactions);
    const now = new Date(Date.now() + 1_000);

    await expect(
      teardowns.disable(
        {
          businessId: BUSINESS_ID,
          connectionId: CONNECTION_ID,
          integrationId: "calendar",
          integrationMajorVersion: 3,
        },
        now
      )
    ).resolves.toBe(false);
    await expect(teardowns.isDisabled(BUSINESS_ID, CONNECTION_ID)).resolves.toBe(false);
    await expect(
      teardowns.disable(
        {
          businessId: BUSINESS_ID,
          connectionId: CONNECTION_ID,
          integrationId: "calendar",
          integrationMajorVersion: 2,
        },
        now
      )
    ).resolves.toBe(true);
    await expect(teardowns.isDisabled(BUSINESS_ID, CONNECTION_ID)).resolves.toBe(true);
    await expect(polling.claim(BUSINESS_ID, CONNECTION_ID, "lease-1", 10, now)).resolves.toBeNull();
  });

  it("rechecks polling admission after waiting for a teardown-first Connection lock", async () => {
    const transactions = transactionPort(database);
    const polling = new PollingIngressStore(transactions);
    const now = new Date("2026-09-13T12:00:00.000Z");
    const inserted = deferred();
    const release = deferred();
    const hooked: TransactionPort = {
      withTransaction: (operation) =>
        transactions.withTransaction((transaction) =>
          operation({
            query: async <Row>(text: string, params?: readonly unknown[]) => {
              const result = await transaction.query<Row>(text, params);
              if (text.includes("INSERT INTO oim_ingress_teardowns")) {
                inserted.resolve();
                await release.promise;
              }
              return result;
            },
          } satisfies Queryable)
        ),
    };
    const teardown = new IngressTeardownStore(hooked).disable({
      businessId: BUSINESS_ID,
      connectionId: CONNECTION_ID,
      integrationId: "calendar",
      integrationMajorVersion: 2,
    });
    await inserted.promise;
    const claiming = polling.claim(BUSINESS_ID, CONNECTION_ID, "lease-1", 10, now);
    let claimSettled = false;
    void claiming.then(() => {
      claimSettled = true;
    });
    await Promise.resolve();
    expect(claimSettled).toBe(false);

    release.resolve();
    await expect(teardown).resolves.toBe(true);
    await expect(claiming).resolves.toBeNull();
  });

  it("rejects polling delivery persistence after a teardown-first Connection lock", async () => {
    const transactions = transactionPort(database);
    const connections = new ConnectionStore(transactions);
    await connections.put(
      BUSINESS_ID,
      connection(CONNECTION_ID, {
        health: { status: "healthy", checkedAt: "2026-09-13T12:00:00.000Z" },
      })
    );
    await new ConnectionExternalIdentityStore(transactions).bindVerified({
      businessId: BUSINESS_ID,
      connectionId: CONNECTION_ID,
      integrationId: "calendar",
      integrationMajorVersion: 2,
      externalTenantId: "tenant-1",
      externalAccountId: "account-1",
      proofKind: "auth",
      proofDigest: "a".repeat(64),
      verifiedAt: "2026-09-13T12:00:00.000Z",
      verifiedBy: "calendar-account-api",
    });
    const inserted = deferred();
    const release = deferred();
    const hooked: TransactionPort = {
      withTransaction: (operation) =>
        transactions.withTransaction((transaction) =>
          operation({
            query: async <Row>(text: string, params?: readonly unknown[]) => {
              const result = await transaction.query<Row>(text, params);
              if (text.includes("INSERT INTO oim_ingress_teardowns")) {
                inserted.resolve();
                await release.promise;
              }
              return result;
            },
          } satisfies Queryable)
        ),
    };
    const teardown = new IngressTeardownStore(hooked).disable({
      businessId: BUSINESS_ID,
      connectionId: CONNECTION_ID,
      integrationId: "calendar",
      integrationMajorVersion: 2,
    });
    await inserted.promise;
    const recording = new PollingIngressStore(transactions).recordVerifiedIfActive(
      {
        businessId: BUSINESS_ID,
        connectionId: CONNECTION_ID,
        integrationId: "calendar",
        integrationMajorVersion: 2,
        externalTenantId: "tenant-1",
        externalAccountId: "account-1",
      },
      {
        id: "poll-after-teardown",
        integrationId: "calendar",
        integrationMajorVersion: 2,
        connectionId: CONNECTION_ID,
        externalTenantId: "tenant-1",
        externalAccountId: "account-1",
        deduplicationKey: "provider-event-1",
        bodySha256: "b".repeat(64),
        safeHeaders: {},
        encryptedBody: "ciphertext",
        eventType: "calendar.changed",
        verification: "verified_polling",
        authenticatedEvidenceDigest: "c".repeat(64),
      }
    );
    let recordingSettled = false;
    void recording.then(
      () => {
        recordingSettled = true;
      },
      () => {
        recordingSettled = true;
      }
    );
    await Promise.resolve();
    expect(recordingSettled).toBe(false);

    release.resolve();
    await expect(teardown).resolves.toBe(true);
    await expect(recording).rejects.toThrow("polling_ingress_inactive");
    const deliveries = await database.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM webhook_deliveries"
    );
    expect(deliveries.rows[0]?.count).toBe(0);
  });

  it("rejects direct inbox persistence after a teardown-first Connection lock", async () => {
    const transactions = transactionPort(database);
    const connections = new ConnectionStore(transactions);
    await connections.put(
      BUSINESS_ID,
      connection(CONNECTION_ID, {
        health: { status: "healthy", checkedAt: "2026-09-13T12:00:00.000Z" },
      })
    );
    const inserted = deferred();
    const release = deferred();
    const teardownCommitted = deferred();
    const hookedTeardown: TransactionPort = {
      withTransaction: (operation) =>
        transactions.withTransaction((transaction) =>
          operation({
            query: async <Row>(text: string, params?: readonly unknown[]) => {
              const result = await transaction.query<Row>(text, params);
              if (text.includes("INSERT INTO oim_ingress_teardowns")) {
                inserted.resolve();
                await release.promise;
              }
              return result;
            },
          } satisfies Queryable)
        ),
    };
    const hookedInbox: TransactionPort = {
      withTransaction: (operation) =>
        transactions.withTransaction((transaction) =>
          operation({
            query: async <Row>(text: string, params?: readonly unknown[]) => {
              if (text.includes("NOT EXISTS") && text.includes("FOR SHARE")) {
                await teardownCommitted.promise;
                return { rows: [{ id: CONNECTION_ID } as Row] };
              }
              return transaction.query<Row>(text, params);
            },
          } satisfies Queryable)
        ),
    };
    const teardown = new IngressTeardownStore(hookedTeardown).disable({
      businessId: BUSINESS_ID,
      connectionId: CONNECTION_ID,
      integrationId: "calendar",
      integrationMajorVersion: 2,
    });
    await inserted.promise;
    const recording = new WebhookInboxStore(hookedInbox).recordVerifiedForActiveConnection(
      BUSINESS_ID,
      {
        id: "direct-poll-after-teardown",
        integrationId: "calendar",
        integrationMajorVersion: 2,
        connectionId: CONNECTION_ID,
        externalTenantId: "tenant-1",
        externalAccountId: "account-1",
        deduplicationKey: "provider-event-direct",
        bodySha256: "d".repeat(64),
        safeHeaders: {},
        encryptedBody: "ciphertext",
        eventType: "calendar.changed",
        verification: "verified_polling",
        authenticatedEvidenceDigest: "e".repeat(64),
      }
    );
    let recordingSettled = false;
    void recording.then(
      () => {
        recordingSettled = true;
      },
      () => {
        recordingSettled = true;
      }
    );
    await Promise.resolve();
    expect(recordingSettled).toBe(false);

    release.resolve();
    await expect(teardown).resolves.toBe(true);
    teardownCommitted.resolve();
    await expect(recording).rejects.toThrow("polling_connection_inactive");
    const deliveries = await database.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM webhook_deliveries"
    );
    expect(deliveries.rows[0]?.count).toBe(0);
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

  it("durably resets Connection checkpoints without removing their stale-writer fence", async () => {
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
      300,
      new Date("2026-09-12T09:00:00Z")
    );
    const page = await store.appendPage(
      key,
      "lease-1",
      started?.revision ?? 0,
      "page-2",
      ["event-1"],
      new Date("2026-09-12T09:00:01Z"),
      "watermark-1"
    );

    await expect(
      store.clearConnection({
        businessId: BUSINESS_ID,
        integrationId: "calendar",
        integrationMajorVersion: 2,
        connectionId: CONNECTION_ID,
      })
    ).resolves.toBe(1);
    await expect(store.load(key)).resolves.toMatchObject({
      baselineItemIds: [],
      scanId: null,
      continuation: null,
      accumulatedSeenItemIds: [],
      pendingDeletionItemIds: [],
      cursorWatermark: null,
      pendingCursorWatermark: null,
      leaseToken: null,
      revision: (page?.revision ?? 0) + 1,
    });
    await expect(
      store.appendPage(
        key,
        "lease-1",
        page?.revision ?? 0,
        null,
        ["stale"],
        new Date("2026-09-12T09:00:02Z")
      )
    ).resolves.toBeNull();
  });

  it("promotes an incremental watermark only after pending deletions are acknowledged", async () => {
    const store = new OimKnowledgeCheckpointStore(transactionPort(database));
    const key = {
      businessId: BUSINESS_ID,
      integrationId: "calendar",
      integrationMajorVersion: 2,
      connectionId: CONNECTION_ID,
      sourceKind: "events",
      scope: "incremental",
    };
    const bootstrap = await store.claim(
      key,
      "bootstrap",
      "lease-0",
      10,
      new Date("2026-09-12T08:59:57Z")
    );
    const bootstrapPage = await store.appendPage(
      key,
      "lease-0",
      bootstrap?.revision ?? 0,
      null,
      [],
      new Date("2026-09-12T08:59:58Z"),
      "watermark-0"
    );
    await expect(
      store.complete(
        key,
        "lease-0",
        bootstrapPage?.revision ?? 0,
        new Date("2026-09-12T08:59:59Z"),
        "incremental"
      )
    ).resolves.toMatchObject({
      cursorWatermark: "watermark-0",
      pendingCursorWatermark: null,
    });

    const started = await store.claim(
      key,
      "scan-1",
      "lease-1",
      10,
      new Date("2026-09-12T09:00:00Z")
    );
    await expect(
      store.complete(
        key,
        "lease-1",
        started?.revision ?? 0,
        new Date("2026-09-12T09:00:00.500Z"),
        "incremental"
      )
    ).resolves.toBeNull();
    const firstPage = await store.appendPage(
      key,
      "lease-1",
      started?.revision ?? 0,
      "page-2",
      ["changed-a"],
      new Date("2026-09-12T09:00:01Z"),
      "watermark-1"
    );
    await expect(
      store.release(key, "lease-1", firstPage?.revision ?? 0, new Date("2026-09-12T09:00:10Z"))
    ).resolves.toBeNull();
    await expect(store.load(key)).resolves.toMatchObject({
      cursorWatermark: "watermark-0",
      pendingCursorWatermark: "watermark-1",
      continuation: "page-2",
      accumulatedSeenItemIds: ["changed-a"],
    });

    const resumed = await store.claim(
      key,
      "scan-1",
      "lease-2",
      10,
      new Date("2026-09-12T09:00:11Z")
    );
    const finalPage = await store.appendPage(
      key,
      "lease-2",
      resumed?.revision ?? 0,
      null,
      ["changed-b"],
      new Date("2026-09-12T09:00:12Z"),
      "watermark-2"
    );
    const staged = await store.stageCompletion(
      key,
      "lease-2",
      finalPage?.revision ?? 0,
      ["removed"],
      new Date("2026-09-12T09:00:13Z")
    );
    const failedDeletion = await store.release(
      key,
      "lease-2",
      staged?.revision ?? 0,
      new Date("2026-09-12T09:00:14Z")
    );
    expect(failedDeletion).toMatchObject({
      baselineItemIds: [],
      cursorWatermark: "watermark-0",
      pendingCursorWatermark: "watermark-2",
      pendingDeletionItemIds: ["removed"],
    });

    const retry = await store.claim(key, "scan-1", "lease-3", 10, new Date("2026-09-12T09:00:15Z"));
    const acknowledged = await store.acknowledgeDeletions(
      key,
      "lease-3",
      retry?.revision ?? 0,
      ["removed"],
      new Date("2026-09-12T09:00:16Z")
    );
    const completed = await store.complete(
      key,
      "lease-3",
      acknowledged?.revision ?? 0,
      new Date("2026-09-12T09:00:17Z"),
      "incremental"
    );
    expect(completed).toMatchObject({
      baselineItemIds: [],
      cursorWatermark: "watermark-2",
      pendingCursorWatermark: null,
      scanId: null,
      continuation: null,
      accumulatedSeenItemIds: [],
      pendingDeletionItemIds: [],
    });

    const fullScan = await store.claim(
      key,
      "scan-2",
      "lease-4",
      10,
      new Date("2026-09-12T09:00:18Z")
    );
    const fullPage = await store.appendPage(
      key,
      "lease-4",
      fullScan?.revision ?? 0,
      null,
      ["full-a"],
      new Date("2026-09-12T09:00:19Z")
    );
    await expect(
      store.complete(key, "lease-4", fullPage?.revision ?? 0, new Date("2026-09-12T09:00:20Z"))
    ).resolves.toMatchObject({
      baselineItemIds: ["full-a"],
      cursorWatermark: "watermark-2",
      pendingCursorWatermark: null,
      scanId: null,
      continuation: null,
      accumulatedSeenItemIds: [],
      pendingDeletionItemIds: [],
    });
  });

  it("keeps a full rebuild durable across a page-boundary restart", async () => {
    const store = new OimKnowledgeCheckpointStore(transactionPort(database));
    const key = {
      businessId: BUSINESS_ID,
      integrationId: "calendar",
      integrationMajorVersion: 2,
      connectionId: CONNECTION_ID,
      sourceKind: "events",
      scope: "rebuild-team",
    };
    const started = await store.claim(
      key,
      "rebuild-scan",
      "lease-1",
      300,
      new Date("2026-09-12T09:00:00Z")
    );
    await database.query(
      `UPDATE oim_knowledge_scan_checkpoints
          SET requires_full_rebuild = true
        WHERE business_id = $1
          AND integration_id = $2
          AND integration_major_version = $3
          AND connection_id = $4
          AND source_kind = $5
          AND scope_key = $6`,
      [
        key.businessId,
        key.integrationId,
        key.integrationMajorVersion,
        key.connectionId,
        key.sourceKind,
        key.scope,
      ]
    );
    const firstPage = await store.appendPage(
      key,
      "lease-1",
      started?.revision ?? 0,
      "page-2",
      ["a"],
      new Date("2026-09-12T09:00:01Z"),
      "watermark-1"
    );
    await store.release(key, "lease-1", firstPage?.revision ?? 0, new Date("2026-09-12T09:00:02Z"));
    const resumed = await store.claim(
      key,
      "rebuild-scan",
      "lease-2",
      300,
      new Date("2026-09-12T09:00:03Z")
    );
    expect(resumed).toMatchObject({
      requiresFullRebuild: true,
      continuation: "page-2",
      accumulatedSeenItemIds: ["a"],
      pendingCursorWatermark: "watermark-1",
    });
    const finalPage = await store.appendPage(
      key,
      "lease-2",
      resumed?.revision ?? 0,
      null,
      ["b"],
      new Date("2026-09-12T09:00:04Z"),
      "watermark-2"
    );
    await expect(
      store.complete(
        key,
        "lease-2",
        finalPage?.revision ?? 0,
        new Date("2026-09-12T09:00:05Z"),
        "incremental",
        true
      )
    ).resolves.toMatchObject({
      baselineItemIds: ["a", "b"],
      cursorWatermark: "watermark-2",
      pendingCursorWatermark: null,
      requiresFullRebuild: false,
      scanId: null,
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
          ? await store.appendPage(
              key,
              "lease-1",
              revision,
              null,
              ["late"],
              expiredAt,
              "late-watermark"
            )
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
