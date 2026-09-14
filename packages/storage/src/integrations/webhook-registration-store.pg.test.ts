import { PGlite } from "@electric-sql/pglite";
import type { OimConnection } from "@tulipfarm/schema";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { transactionPort } from "../pg/test-support";
import type { Queryable, TransactionPort } from "../ports";
import {
  CONNECTION_AUTH_STEP_STORAGE_STATEMENTS,
  ConnectionAuthStepStore,
} from "./connection-auth-step-store";
import { CONNECTION_EXTERNAL_IDENTITY_STORAGE_STATEMENTS } from "./connection-external-identity-store";
import { CONNECTION_STORAGE_STATEMENTS, ConnectionStore } from "./connection-store";
import {
  INGRESS_TEARDOWN_STORAGE_STATEMENTS,
  IngressTeardownStore,
} from "./ingress-teardown-store";
import { OIM_INGRESS_EMISSION_STORAGE_STATEMENTS } from "./oim-ingress-emission-store";
import {
  type VerifiedWebhookDeliveryInput,
  WEBHOOK_INBOX_STORAGE_STATEMENTS,
} from "./webhook-inbox-store";
import {
  WEBHOOK_REGISTRATION_STORAGE_STATEMENTS,
  WebhookRegistrationStore,
  type WebhookRegistrationTarget,
} from "./webhook-registration-store";

const BUSINESS_ID = "business-1";
const NOW = new Date("2026-03-01T12:00:00.000Z");

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function settledAbsenceEvidence() {
  return {
    proofDigest: "a".repeat(64),
    verifiedAt: NOW.toISOString(),
    verifiedBy: "acme-registration-status",
  };
}

function connection(id: string): OimConnection {
  return {
    id,
    integration: { id: "acme", majorVersion: 2 },
    label: id,
    owner: { scope: "organization" },
    status: "active",
    isDefault: false,
    configuration: {},
    agentVisibleConfiguration: [],
    secretBindings: { access: `secret://${id}-access` },
    health: { status: "action_required", checkedAt: NOW.toISOString() },
    expiresAt: null,
  };
}

function target(connectionId: string): WebhookRegistrationTarget {
  return {
    integrationKey: "acme-v2",
    manifestDigest: "a".repeat(64),
    stepId: "webhook",
    callbackUrl: `https://api.example.test/api/v1/hooks/oim/acme-v2/${connectionId}`,
    operationId: "register_hook",
    unregisterOperationId: "remove_hook",
    secretSlot: "webhook_secret",
    packageSnapshot: {
      integrationId: "acme",
      version: "2.0.0",
      majorVersion: 2,
      packageDigest: "a".repeat(64),
      manifestText: "{}",
      files: [],
    },
  };
}

function delivery(
  connectionId: string,
  id: string,
  evidence: string
): VerifiedWebhookDeliveryInput {
  return {
    id,
    integrationId: "acme",
    integrationMajorVersion: 2,
    connectionId,
    externalTenantId: "tenant-1",
    externalAccountId: "account-1",
    deduplicationKey: "provider-delivery-1",
    bodySha256: "b".repeat(64),
    safeHeaders: {},
    encryptedBody: "encrypted",
    eventType: "ticket.created",
    verification: "verified",
    authenticatedEvidenceDigest: evidence,
  };
}

describe("WebhookRegistrationStore", () => {
  let database: PGlite;
  let registrations: WebhookRegistrationStore;
  let connections: ConnectionStore;
  let authSteps: ConnectionAuthStepStore;
  let teardowns: IngressTeardownStore;

  beforeAll(async () => {
    database = new PGlite();
    for (const statement of [
      ...CONNECTION_STORAGE_STATEMENTS,
      ...CONNECTION_AUTH_STEP_STORAGE_STATEMENTS,
      ...CONNECTION_EXTERNAL_IDENTITY_STORAGE_STATEMENTS,
      ...INGRESS_TEARDOWN_STORAGE_STATEMENTS,
      ...WEBHOOK_INBOX_STORAGE_STATEMENTS,
      ...OIM_INGRESS_EMISSION_STORAGE_STATEMENTS,
      ...WEBHOOK_REGISTRATION_STORAGE_STATEMENTS,
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
        webhook_deliveries,
        oim_webhook_registration_attempts,
        oim_webhook_registrations,
        oim_ingress_teardowns,
        connection_external_identities,
        connection_auth_steps,
        connections
    `);
    const transactions = transactionPort(database);
    registrations = new WebhookRegistrationStore(transactions);
    connections = new ConnectionStore(transactions);
    authSteps = new ConnectionAuthStepStore(transactions);
    teardowns = new IngressTeardownStore(transactions);
    for (const id of ["connection-1", "connection-2"]) {
      await connections.put(BUSINESS_ID, connection(id));
      await authSteps.put({
        businessId: BUSINESS_ID,
        connectionId: id,
        stepId: "webhook",
        status: "pending",
        accessSlot: null,
        accessSecretRef: null,
        refreshSlot: null,
        refreshSecretRef: null,
        externalIdentity: null,
        expiresAt: null,
        healthCheckedAt: NOW.toISOString(),
      });
    }
  });

  async function activate(
    connectionId: string,
    registrationTarget = target(connectionId),
    expiresAt?: string
  ) {
    const key = {
      businessId: BUSINESS_ID,
      connectionId,
      integrationId: "acme",
      integrationMajorVersion: 2,
    };
    await registrations.requestRegistration(key, registrationTarget, NOW);
    const claim = await registrations.claim(key, `lease-${connectionId}`, 120, NOW);
    if (claim === null) throw new Error("registration was not claimed");
    const secretRef = `secret://${connectionId}-webhook` as const;
    expect(await registrations.stageSecret(key, claim.leaseToken ?? "", secretRef)).toBe(true);
    const attemptId = `attempt-${connectionId}`;
    await registrations.recordDispatchedAttempt(claim, {
      attemptId,
      idempotencyKey: attemptId,
      secretRef,
      now: NOW,
    });
    const verifiedIdentity = {
      ...key,
      externalTenantId: "tenant-1",
      externalAccountId: "account-1",
      proofKind: "auth" as const,
      proofDigest: "c".repeat(64),
      verifiedAt: NOW.toISOString(),
      verifiedBy: "acme-account-api",
    };
    await registrations.recordAttemptSuccess(attemptId, {
      subscriptionId: `subscription-${connectionId}`,
      verifiedIdentity,
      now: NOW,
    });
    const completed = await registrations.completeRegistration(claim, {
      attemptId,
      subscriptionId: `subscription-${connectionId}`,
      secretRef,
      verifiedIdentity,
      expiresAt,
      now: NOW,
    });
    expect(completed.kind).toBe("active");
    const active = await registrations.findActive(key, "acme-v2");
    if (active === null) throw new Error("registration did not activate");
    return { key, active };
  }

  it("publishes the auth step, Connection binding, and verified identity in one transaction", async () => {
    const { key, active } = await activate("connection-1");

    expect(active).toMatchObject({
      state: "active",
      desiredState: "active",
      active: {
        subscriptionId: "subscription-connection-1",
        secretRef: "secret://connection-1-webhook",
      },
    });
    expect(await connections.findById(BUSINESS_ID, "connection-1")).toMatchObject({
      secretBindings: {
        access: "secret://connection-1-access",
        webhook_secret: "secret://connection-1-webhook",
      },
      webhookRegistration: {
        ingressUrl: "https://api.example.test/api/v1/hooks/oim/acme-v2/connection-1",
      },
    });
    expect(await authSteps.find(BUSINESS_ID, "connection-1", "webhook")).toMatchObject({
      status: "active",
      accessSlot: "webhook_secret",
      accessSecretRef: "secret://connection-1-webhook",
    });
    expect(await registrations.findVerifiedIdentity(key)).toMatchObject({
      externalTenantId: "tenant-1",
      externalAccountId: "account-1",
    });
  });

  it("keeps a live registration while backing off and renewing it before expiry", async () => {
    const initialExpiry = new Date(NOW.getTime() + 3_600_000).toISOString();
    const registrationTarget = {
      ...target("connection-1"),
      renewal: {
        operationId: "renew_hook",
        subscriptionId: { in: "body" as const, pointer: "/id" },
        expiresAtPath: "/expiresAt",
        renewBeforeSeconds: 300,
      },
    };
    const { key, active } = await activate("connection-1", registrationTarget, initialExpiry);
    const due = new Date(NOW.getTime() + 3_300_000);
    expect(active.nextAttemptAt).toEqual(due);

    const firstRenewal = await registrations.claim(key, "renewal-1", 120, due);
    expect(firstRenewal).toMatchObject({ action: "renew", state: "active", renewalCycle: 1 });
    if (firstRenewal === null) throw new Error("renewal was not claimed");
    await registrations.failClaim(firstRenewal, "provider unavailable", 60, due);

    const delayed = await registrations.claim(
      key,
      "renewal-2",
      120,
      new Date(due.getTime() + 59_000)
    );
    expect(delayed).toBeNull();
    const retryAt = new Date(due.getTime() + 60_000);
    const retry = await registrations.claim(key, "renewal-2", 120, retryAt);
    if (retry === null) throw new Error("renewal retry was not claimed");
    expect(retry.renewalCycle).toBe(1);
    const renewedExpiry = new Date(NOW.getTime() + 7_200_000).toISOString();
    const renewed = await registrations.completeRenewal(retry, renewedExpiry, retryAt);

    expect(renewed).toMatchObject({
      state: "active",
      lastError: null,
      active: { subscriptionId: "subscription-connection-1", expiresAt: renewedExpiry },
    });
    expect(renewed?.nextAttemptAt).toEqual(new Date(NOW.getTime() + 6_900_000));
    const nextCycle = await registrations.claim(
      key,
      "renewal-3",
      120,
      new Date(NOW.getTime() + 6_900_000)
    );
    expect(nextCycle).toMatchObject({ action: "renew", renewalCycle: 2 });
  });

  it("skips an ineligible Connection when selecting the next due registration", async () => {
    const firstKey = {
      businessId: BUSINESS_ID,
      connectionId: "connection-1",
      integrationId: "acme",
      integrationMajorVersion: 2,
    };
    const secondKey = { ...firstKey, connectionId: "connection-2" };
    await registrations.requestRegistration(firstKey, target("connection-1"), NOW);
    await registrations.requestRegistration(secondKey, target("connection-2"), NOW);
    await connections.put(BUSINESS_ID, {
      ...connection("connection-1"),
      status: "revoked",
    });

    const claim = await registrations.claimNext("lease-eligible", 120, NOW);
    expect(claim).toMatchObject({ connectionId: "connection-2", action: "register" });
  });

  it("rejects registration after waiting for a teardown-first Connection lock", async () => {
    const locked = deferred();
    const release = deferred();
    const baseTransactions = transactionPort(database);
    const hooked: TransactionPort = {
      withTransaction: (operation) =>
        baseTransactions.withTransaction((transaction) =>
          operation({
            query: async <Row>(text: string, params?: readonly unknown[]) => {
              const result = await transaction.query<Row>(text, params);
              if (text.includes("INSERT INTO oim_ingress_teardowns")) {
                locked.resolve();
                await release.promise;
              }
              return result;
            },
          } satisfies Queryable)
        ),
    };
    const teardown = new IngressTeardownStore(hooked).disable({
      businessId: BUSINESS_ID,
      connectionId: "connection-1",
      integrationId: "acme",
      integrationMajorVersion: 2,
    });
    await locked.promise;
    const registering = registrations.requestRegistration(
      {
        businessId: BUSINESS_ID,
        connectionId: "connection-1",
        integrationId: "acme",
        integrationMajorVersion: 2,
      },
      target("connection-1"),
      NOW
    );
    let registrationSettled = false;
    void registering.then(
      () => {
        registrationSettled = true;
      },
      () => {
        registrationSettled = true;
      }
    );
    await Promise.resolve();
    expect(registrationSettled).toBe(false);

    release.resolve();
    await expect(teardown).resolves.toBe(true);
    await expect(registering).rejects.toThrow("webhook_connection_unavailable");
  });

  it("scopes provider deduplication to the exact Connection", async () => {
    const first = await activate("connection-1");
    const second = await activate("connection-2");

    const recordedFirst = await registrations.recordVerifiedIfActive(
      first.key,
      first.active.revision,
      delivery("connection-1", "delivery-1", "d".repeat(64))
    );
    const recordedSecond = await registrations.recordVerifiedIfActive(
      second.key,
      second.active.revision,
      delivery("connection-2", "delivery-2", "e".repeat(64))
    );
    const duplicate = await registrations.recordVerifiedIfActive(
      first.key,
      first.active.revision,
      delivery("connection-1", "delivery-3", "d".repeat(64))
    );

    expect(recordedFirst.accepted).toBe(true);
    expect(recordedSecond.accepted).toBe(true);
    expect(duplicate).toMatchObject({ accepted: false, delivery: { id: "delivery-1" } });
  });

  it("fences new delivery persistence before remote cleanup starts", async () => {
    const { key, active } = await activate("connection-1");
    await registrations.requestRemoval(key, NOW);

    await expect(
      registrations.recordVerifiedIfActive(
        key,
        active.revision,
        delivery("connection-1", "delivery-after-remove", "f".repeat(64))
      )
    ).rejects.toThrow("webhook_registration_inactive");
    const rows = await database.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM webhook_deliveries"
    );
    expect(rows.rows[0]?.count).toBe(0);
  });

  it("rejects delivery persistence after waiting for a teardown-first Connection lock", async () => {
    const { key, active } = await activate("connection-1");
    const inserted = deferred();
    const release = deferred();
    const baseTransactions = transactionPort(database);
    const hooked: TransactionPort = {
      withTransaction: (operation) =>
        baseTransactions.withTransaction((transaction) =>
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
    const teardown = new IngressTeardownStore(hooked).disable(key, NOW);
    await inserted.promise;
    const recording = registrations.recordVerifiedIfActive(
      key,
      active.revision,
      delivery("connection-1", "delivery-after-teardown", "f".repeat(64))
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
    await expect(recording).rejects.toThrow("webhook_registration_inactive");
    const rows = await database.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM webhook_deliveries"
    );
    expect(rows.rows[0]?.count).toBe(0);
  });

  it("turns a stale authorization publication into durable remote cleanup", async () => {
    const key = {
      businessId: BUSINESS_ID,
      connectionId: "connection-1",
      integrationId: "acme",
      integrationMajorVersion: 2,
    };
    await registrations.requestRegistration(key, target("connection-1"), NOW);
    const claim = await registrations.claim(key, "lease-1", 120, NOW);
    if (claim === null) throw new Error("registration was not claimed");
    await registrations.stageSecret(key, "lease-1", "secret://staged");
    await registrations.recordDispatchedAttempt(claim, {
      attemptId: "attempt-stale",
      idempotencyKey: "attempt-stale",
      secretRef: "secret://staged",
      now: NOW,
    });
    const step = await authSteps.find(BUSINESS_ID, "connection-1", "webhook");
    if (step === null) throw new Error("webhook step missing");
    await authSteps.updateHealth({
      businessId: BUSINESS_ID,
      connectionId: "connection-1",
      stepId: "webhook",
      expectedRevision: step.revision,
      status: "action_required",
      expiresAt: null,
      healthCheckedAt: NOW.toISOString(),
    });

    const verifiedIdentity = {
      ...key,
      externalTenantId: "tenant-1",
      externalAccountId: "account-1",
      proofKind: "auth" as const,
      proofDigest: "1".repeat(64),
      verifiedAt: NOW.toISOString(),
      verifiedBy: "acme-account-api",
    };
    await registrations.recordAttemptSuccess("attempt-stale", {
      subscriptionId: "subscription-stale",
      verifiedIdentity,
      now: NOW,
    });
    const completed = await registrations.completeRegistration(claim, {
      attemptId: "attempt-stale",
      subscriptionId: "subscription-stale",
      secretRef: "secret://staged",
      verifiedIdentity,
      now: NOW,
    });

    expect(completed).toMatchObject({
      kind: "cleanup_required",
      attempt: { state: "cleanup_pending", subscriptionId: "subscription-stale" },
    });
    const unchanged = await connections.findById(BUSINESS_ID, "connection-1");
    expect(unchanged).toMatchObject({
      secretBindings: { access: "secret://connection-1-access" },
    });
    expect(unchanged?.webhookRegistration).toBeUndefined();
  });

  it("turns registration completion after ingress teardown into durable cleanup", async () => {
    const key = {
      businessId: BUSINESS_ID,
      connectionId: "connection-1",
      integrationId: "acme",
      integrationMajorVersion: 2,
    };
    await registrations.requestRegistration(key, target("connection-1"), NOW);
    const claim = await registrations.claim(key, "lease-1", 120, NOW);
    if (claim === null) throw new Error("registration was not claimed");
    await registrations.stageSecret(key, "lease-1", "secret://staged");
    await registrations.recordDispatchedAttempt(claim, {
      attemptId: "attempt-teardown",
      idempotencyKey: "attempt-teardown",
      secretRef: "secret://staged",
      now: NOW,
    });
    await teardowns.disable(key, NOW);

    const verifiedIdentity = {
      ...key,
      externalTenantId: "tenant-1",
      externalAccountId: "account-1",
      proofKind: "auth" as const,
      proofDigest: "1".repeat(64),
      verifiedAt: NOW.toISOString(),
      verifiedBy: "acme-account-api",
    };
    await registrations.recordAttemptSuccess("attempt-teardown", {
      subscriptionId: "subscription-after-teardown",
      verifiedIdentity,
      now: NOW,
    });
    const completed = await registrations.completeRegistration(claim, {
      attemptId: "attempt-teardown",
      subscriptionId: "subscription-after-teardown",
      secretRef: "secret://staged",
      verifiedIdentity,
      now: NOW,
    });

    expect(completed).toMatchObject({
      kind: "cleanup_required",
      attempt: { state: "cleanup_pending", subscriptionId: "subscription-after-teardown" },
    });
    await expect(registrations.findActive(key)).resolves.toBeNull();
    await expect(
      registrations.recordVerifiedIfActive(key, claim.revision, delivery("connection-1", "d", "e"))
    ).rejects.toThrow("webhook_registration_inactive");
  });

  it("rechecks teardown after completion waits for a teardown-first Connection lock", async () => {
    const key = {
      businessId: BUSINESS_ID,
      connectionId: "connection-1",
      integrationId: "acme",
      integrationMajorVersion: 2,
    };
    await registrations.requestRegistration(key, target("connection-1"), NOW);
    const claim = await registrations.claim(key, "lease-1", 120, NOW);
    if (claim === null) throw new Error("registration was not claimed");
    await registrations.stageSecret(key, "lease-1", "secret://staged");
    await registrations.recordDispatchedAttempt(claim, {
      attemptId: "attempt-teardown-first",
      idempotencyKey: "attempt-teardown-first",
      secretRef: "secret://staged",
      now: NOW,
    });
    const identity = {
      ...key,
      externalTenantId: "tenant-1",
      externalAccountId: "account-1",
      proofKind: "auth" as const,
      proofDigest: "1".repeat(64),
      verifiedAt: NOW.toISOString(),
      verifiedBy: "acme-account-api",
    };
    await registrations.recordAttemptSuccess("attempt-teardown-first", {
      subscriptionId: "subscription-after-teardown",
      verifiedIdentity: identity,
      now: NOW,
    });
    const inserted = deferred();
    const release = deferred();
    const baseTransactions = transactionPort(database);
    const hooked: TransactionPort = {
      withTransaction: (operation) =>
        baseTransactions.withTransaction((transaction) =>
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
    const teardown = new IngressTeardownStore(hooked).disable(key, NOW);
    await inserted.promise;
    const completion = registrations.completeRegistration(claim, {
      attemptId: "attempt-teardown-first",
      subscriptionId: "subscription-after-teardown",
      secretRef: "secret://staged",
      verifiedIdentity: identity,
      now: NOW,
    });
    let completionSettled = false;
    void completion.then(
      () => {
        completionSettled = true;
      },
      () => {
        completionSettled = true;
      }
    );
    await Promise.resolve();
    expect(completionSettled).toBe(false);

    release.resolve();
    await expect(teardown).resolves.toBe(true);
    await expect(completion).resolves.toMatchObject({
      kind: "cleanup_required",
      attempt: {
        state: "cleanup_pending",
        subscriptionId: "subscription-after-teardown",
      },
    });
    await expect(connections.findById(BUSINESS_ID, "connection-1")).resolves.toMatchObject({
      secretBindings: { access: "secret://connection-1-access" },
    });
  });

  it("reconciles an unresolved attempt instead of blindly registering again after a crash", async () => {
    const key = {
      businessId: BUSINESS_ID,
      connectionId: "connection-1",
      integrationId: "acme",
      integrationMajorVersion: 2,
    };
    await registrations.requestRegistration(key, target("connection-1"), NOW);
    const first = await registrations.claim(key, "lease-1", 10, NOW);
    if (first === null) throw new Error("first registration was not claimed");
    await registrations.stageSecret(key, "lease-1", "secret://staged");
    await registrations.recordDispatchedAttempt(first, {
      attemptId: "attempt-late",
      idempotencyKey: "attempt-late",
      secretRef: "secret://staged",
      now: NOW,
    });
    await expect(registrations.claimAttempt(key, "too-early", 10, NOW)).resolves.toBeNull();
    await expect(
      registrations.claim(key, "lease-2", 10, new Date(NOW.getTime() + 11_000))
    ).resolves.toBeNull();
    const reconciliation = await registrations.claimAttempt(
      key,
      "reconcile-lease",
      10,
      new Date(NOW.getTime() + 11_000)
    );
    if (reconciliation === null) throw new Error("registration attempt was not reclaimed");

    const verifiedIdentity = {
      ...key,
      externalTenantId: "tenant-1",
      externalAccountId: "account-1",
      proofKind: "auth" as const,
      proofDigest: "1".repeat(64),
      verifiedAt: NOW.toISOString(),
      verifiedBy: "acme-account-api",
    };
    await registrations.recordAttemptSuccess("attempt-late", {
      subscriptionId: "subscription-late",
      verifiedIdentity,
      now: NOW,
    });
    const completed = await registrations.completeRegistration(first, {
      attemptId: "attempt-late",
      subscriptionId: "subscription-late",
      secretRef: "secret://staged",
      verifiedIdentity,
      now: NOW,
    });

    expect(reconciliation).toMatchObject({
      attemptId: "attempt-late",
      generation: first.generation,
      action: "reconcile",
    });
    expect(completed).toMatchObject({
      kind: "cleanup_required",
      attempt: {
        state: "cleanup_pending",
        subscriptionId: "subscription-late",
        leaseToken: "reconcile-lease",
      },
    });
  });

  it("retains an undispatched staged Secret until teardown claims it for cleanup", async () => {
    const key = {
      businessId: BUSINESS_ID,
      connectionId: "connection-1",
      integrationId: "acme",
      integrationMajorVersion: 2,
    };
    await registrations.requestRegistration(key, target("connection-1"), NOW);
    const abandoned = await registrations.claim(key, "abandoned", 10, NOW);
    if (abandoned === null) throw new Error("registration was not claimed");
    await registrations.stageSecret(key, "abandoned", "secret://undispatched");
    await registrations.requestRemoval(key, NOW);

    const cleanup = await registrations.claim(key, "cleanup", 10, new Date(NOW.getTime() + 11_000));
    expect(cleanup).toMatchObject({
      action: "remove",
      active: null,
      stagedSecretRef: "secret://undispatched",
    });
    if (cleanup === null) throw new Error("staged Secret cleanup was not claimed");
    await expect(registrations.completeRemoval(cleanup, NOW)).resolves.toMatchObject({
      state: "removed",
      stagedSecretRef: null,
    });
  });

  it("keeps a lost registration response unresolved until reconciliation proves absence", async () => {
    const key = {
      businessId: BUSINESS_ID,
      connectionId: "connection-1",
      integrationId: "acme",
      integrationMajorVersion: 2,
    };
    await registrations.requestRegistration(key, target("connection-1"), NOW);
    const claim = await registrations.claim(key, "register", 10, NOW);
    if (claim === null) throw new Error("registration was not claimed");
    await registrations.stageSecret(key, "register", "secret://ambiguous");
    await registrations.recordDispatchedAttempt(claim, {
      attemptId: "attempt-ambiguous",
      idempotencyKey: "attempt-ambiguous",
      secretRef: "secret://ambiguous",
      now: NOW,
    });
    await registrations.markRegistrationUncertain(claim, "response lost", 60, NOW);

    await expect(registrations.requestRemoval(key, NOW)).resolves.toMatchObject({
      desiredState: "removed",
      state: "cleanup_failed",
      stagedSecretRef: "secret://ambiguous",
    });
    await expect(registrations.hasUnresolvedAttempts(key)).resolves.toBe(true);
    const reconciliation = await registrations.claimAttempt(
      key,
      "reconcile",
      10,
      new Date(NOW.getTime() + 61_000)
    );
    expect(reconciliation).toMatchObject({
      attemptId: "attempt-ambiguous",
      action: "reconcile",
    });
    if (reconciliation === null) throw new Error("ambiguous attempt was not claimed");
    await registrations.completeAttemptAbsent(reconciliation, settledAbsenceEvidence(), NOW);

    await expect(registrations.requestRemoval(key, NOW)).resolves.toMatchObject({
      state: "removed",
      stagedSecretRef: null,
    });
    await expect(registrations.hasUnresolvedAttempts(key)).resolves.toBe(false);
  });

  it("does not report remote cleanup complete without reconciliation evidence", async () => {
    const key = {
      businessId: BUSINESS_ID,
      connectionId: "connection-1",
      integrationId: "acme",
      integrationMajorVersion: 2,
    };
    await registrations.requestRegistration(key, target("connection-1"), NOW);
    const claim = await registrations.claim(key, "register", 10, NOW);
    if (claim === null) throw new Error("registration was not claimed");
    await registrations.stageSecret(key, "register", "secret://unknown");
    await registrations.recordDispatchedAttempt(claim, {
      attemptId: "attempt-unknown",
      idempotencyKey: "attempt-unknown",
      secretRef: "secret://unknown",
      now: NOW,
    });
    await registrations.markRegistrationUncertain(claim, "response lost", 60, NOW);
    await registrations.requestRemoval(key, NOW);
    const reconciliation = await registrations.claimAttempt(
      key,
      "reconcile",
      10,
      new Date(NOW.getTime() + 61_000)
    );
    if (reconciliation === null) throw new Error("ambiguous attempt was not claimed");
    await registrations.failAttempt(reconciliation, "provider lookup unavailable", 60, NOW);

    await expect(registrations.requestRemoval(key, NOW)).resolves.toMatchObject({
      desiredState: "removed",
      state: "cleanup_failed",
      stagedSecretRef: "secret://unknown",
    });
    await expect(registrations.hasUnresolvedAttempts(key)).resolves.toBe(true);
  });

  it("turns a late success after settled absence into durable cleanup", async () => {
    const key = {
      businessId: BUSINESS_ID,
      connectionId: "connection-1",
      integrationId: "acme",
      integrationMajorVersion: 2,
    };
    await registrations.requestRegistration(key, target("connection-1"), NOW);
    const claim = await registrations.claim(key, "register", 10, NOW);
    if (claim === null) throw new Error("registration was not claimed");
    await registrations.stageSecret(key, "register", "secret://late-after-absence");
    await registrations.recordDispatchedAttempt(claim, {
      attemptId: "attempt-late-after-absence",
      idempotencyKey: "attempt-late-after-absence",
      secretRef: "secret://late-after-absence",
      now: NOW,
    });
    await registrations.markRegistrationUncertain(claim, "response pending", 60, NOW);
    const reconciliation = await registrations.claimAttempt(
      key,
      "reconcile",
      10,
      new Date(NOW.getTime() + 61_000)
    );
    if (reconciliation === null) throw new Error("ambiguous attempt was not claimed");
    await expect(
      registrations.completeAttemptAbsent(reconciliation, settledAbsenceEvidence(), NOW)
    ).resolves.toBe(true);
    const absence = await database.query<{ settled_absence_evidence: { verifiedBy: string } }>(
      `SELECT settled_absence_evidence
         FROM oim_webhook_registration_attempts
        WHERE attempt_id = 'attempt-late-after-absence'`
    );
    expect(absence.rows[0]?.settled_absence_evidence).toMatchObject({
      verifiedBy: "acme-registration-status",
    });
    const identity = {
      ...key,
      externalTenantId: "tenant-1",
      externalAccountId: "account-1",
      proofKind: "auth" as const,
      proofDigest: "1".repeat(64),
      verifiedAt: NOW.toISOString(),
      verifiedBy: "acme-account-api",
    };

    await expect(
      registrations.recordAttemptSuccess("attempt-late-after-absence", {
        subscriptionId: "subscription-late-after-absence",
        verifiedIdentity: identity,
        now: NOW,
      })
    ).resolves.toMatchObject({
      state: "cleanup_pending",
      subscriptionId: "subscription-late-after-absence",
    });
    await expect(
      registrations.completeRegistration(claim, {
        attemptId: "attempt-late-after-absence",
        subscriptionId: "subscription-late-after-absence",
        secretRef: "secret://late-after-absence",
        verifiedIdentity: identity,
        now: NOW,
      })
    ).resolves.toMatchObject({
      kind: "cleanup_required",
      attempt: { state: "cleanup_pending" },
    });
    await expect(registrations.hasUnresolvedAttempts(key)).resolves.toBe(true);
  });

  it("does not overwrite a late success that races settled-absence publication", async () => {
    const key = {
      businessId: BUSINESS_ID,
      connectionId: "connection-1",
      integrationId: "acme",
      integrationMajorVersion: 2,
    };
    await registrations.requestRegistration(key, target("connection-1"), NOW);
    const claim = await registrations.claim(key, "register", 10, NOW);
    if (claim === null) throw new Error("registration was not claimed");
    await registrations.stageSecret(key, "register", "secret://absence-race");
    await registrations.recordDispatchedAttempt(claim, {
      attemptId: "attempt-absence-race",
      idempotencyKey: "attempt-absence-race",
      secretRef: "secret://absence-race",
      now: NOW,
    });
    await registrations.markRegistrationUncertain(claim, "response pending", 60, NOW);
    const reconciliation = await registrations.claimAttempt(
      key,
      "reconcile",
      10,
      new Date(NOW.getTime() + 61_000)
    );
    if (reconciliation === null) throw new Error("ambiguous attempt was not claimed");
    const identity = {
      ...key,
      externalTenantId: "tenant-1",
      externalAccountId: "account-1",
      proofKind: "auth" as const,
      proofDigest: "1".repeat(64),
      verifiedAt: NOW.toISOString(),
      verifiedBy: "acme-account-api",
    };
    await registrations.recordAttemptSuccess("attempt-absence-race", {
      subscriptionId: "subscription-late",
      verifiedIdentity: identity,
      now: NOW,
    });

    await expect(
      registrations.completeAttemptAbsent(reconciliation, settledAbsenceEvidence(), NOW)
    ).resolves.toBe(false);
    await expect(registrations.hasUnresolvedAttempts(key)).resolves.toBe(true);
    const cleanup = await registrations.claimAttempt(
      key,
      "cleanup",
      10,
      new Date(NOW.getTime() + 72_000)
    );
    expect(cleanup).toMatchObject({
      action: "remove",
      state: "cleanup_pending",
      subscriptionId: "subscription-late",
    });
  });

  it("rotates generation only when the desired registration target changes", async () => {
    const key = {
      businessId: BUSINESS_ID,
      connectionId: "connection-1",
      integrationId: "acme",
      integrationMajorVersion: 2,
    };
    const first = await registrations.requestRegistration(key, target("connection-1"), NOW);
    const repeated = await registrations.requestRegistration(key, target("connection-1"), NOW);
    const changedTarget = {
      ...target("connection-1"),
      manifestDigest: "b".repeat(64),
      operationId: "register_hook_v2",
    };
    const [changed, repeatedChanged] = await Promise.all([
      registrations.requestRegistration(key, changedTarget, NOW),
      registrations.requestRegistration(key, changedTarget, NOW),
    ]);

    expect(repeated.generation).toBe(first.generation);
    expect(changed.generation).toBe(first.generation + 1);
    expect(repeatedChanged.generation).toBe(changed.generation);
  });

  it("queues a known late success without overwriting a newer target generation", async () => {
    const key = {
      businessId: BUSINESS_ID,
      connectionId: "connection-1",
      integrationId: "acme",
      integrationMajorVersion: 2,
    };
    await registrations.requestRegistration(key, target("connection-1"), NOW);
    const first = await registrations.claim(key, "lease-a", 120, NOW);
    if (first === null) throw new Error("first target was not claimed");
    await registrations.stageSecret(key, "lease-a", "secret://target-a");
    await registrations.recordDispatchedAttempt(first, {
      attemptId: "attempt-a",
      idempotencyKey: "attempt-a",
      secretRef: "secret://target-a",
      now: NOW,
    });
    const targetB = {
      ...target("connection-1"),
      manifestDigest: "b".repeat(64),
      operationId: "register_hook_v2",
    };
    const newer = await registrations.requestRegistration(key, targetB, NOW);
    const identity = {
      ...key,
      externalTenantId: "tenant-1",
      externalAccountId: "account-1",
      proofKind: "auth" as const,
      proofDigest: "1".repeat(64),
      verifiedAt: NOW.toISOString(),
      verifiedBy: "acme-account-api",
    };
    await registrations.recordAttemptSuccess("attempt-a", {
      subscriptionId: "subscription-a",
      verifiedIdentity: identity,
      now: NOW,
    });

    await expect(
      registrations.completeRegistration(first, {
        attemptId: "attempt-a",
        subscriptionId: "subscription-a",
        secretRef: "secret://target-a",
        verifiedIdentity: identity,
        now: NOW,
      })
    ).resolves.toMatchObject({
      kind: "cleanup_required",
      attempt: { state: "cleanup_pending", subscriptionId: "subscription-a" },
    });
    const current = await registrations.requestRegistration(key, targetB, NOW);
    expect(current).toMatchObject({
      generation: newer.generation,
      desiredState: "active",
      target: { manifestDigest: "b".repeat(64), operationId: "register_hook_v2" },
    });
  });
});
