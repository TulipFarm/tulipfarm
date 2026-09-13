import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import type { OimConnection } from "@tulipfarm/schema";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EVENT_STORAGE_STATEMENTS, type StoreEventInput } from "../events";
import { transactionPort } from "../pg/test-support";
import type { Queryable, TransactionPort } from "../ports";
import { CONNECTION_EXTERNAL_IDENTITY_STORAGE_STATEMENTS } from "./connection-external-identity-store";
import { CONNECTION_STORAGE_STATEMENTS, ConnectionStore } from "./connection-store";
import {
  INGRESS_TEARDOWN_STORAGE_STATEMENTS,
  IngressTeardownStore,
} from "./ingress-teardown-store";
import {
  OIM_INGRESS_EMISSION_STORAGE_STATEMENTS,
  OimIngressEmissionStore,
} from "./oim-ingress-emission-store";
import {
  type PersistedWebhookDelivery,
  WEBHOOK_INBOX_STORAGE_STATEMENTS,
  WebhookInboxStore,
} from "./webhook-inbox-store";

const BUSINESS_ID = "business-1";
const CONNECTION_ID = "connection-1";

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function connection(id = CONNECTION_ID): OimConnection {
  return {
    id,
    integration: { id: "acme", majorVersion: 2 },
    label: "Acme",
    owner: { scope: "organization" },
    status: "active",
    isDefault: false,
    configuration: {},
    agentVisibleConfiguration: [],
    secretBindings: { access: "secret://access" },
    health: { status: "healthy", checkedAt: "2026-09-13T12:00:00.000Z" },
    expiresAt: null,
  };
}

function event(deliveryId: string): StoreEventInput {
  return {
    eventId: `event-${deliveryId}`,
    type: "ticket.created",
    version: 1,
    occurredAt: "2026-09-13T12:00:00.000Z",
    receivedAt: "2026-09-13T12:00:00.000Z",
    businessId: BUSINESS_ID,
    source: {
      provider: "acme",
      integrationId: "acme",
      externalTenantId: "tenant-1",
      deliveryId,
    },
    principal: { kind: "integration", externalId: "account-1" },
    record: {},
    deduplicationKey: deliveryId,
    classification: [],
    data: { type: "ticket_created" },
    verification: { status: "verified", method: "hmac_sha256" },
  };
}

describe("OimIngressEmissionStore", () => {
  let database: PGlite;
  let transactions: TransactionPort;
  let inbox: WebhookInboxStore;
  let connections: ConnectionStore;
  let teardowns: IngressTeardownStore;

  beforeAll(async () => {
    database = new PGlite();
    for (const statement of [
      ...CONNECTION_STORAGE_STATEMENTS,
      ...CONNECTION_EXTERNAL_IDENTITY_STORAGE_STATEMENTS,
      ...WEBHOOK_INBOX_STORAGE_STATEMENTS,
      ...OIM_INGRESS_EMISSION_STORAGE_STATEMENTS,
      ...INGRESS_TEARDOWN_STORAGE_STATEMENTS,
      ...EVENT_STORAGE_STATEMENTS,
    ]) {
      await database.exec(statement);
    }
    transactions = transactionPort(database);
    inbox = new WebhookInboxStore(transactions);
    connections = new ConnectionStore(transactions);
    teardowns = new IngressTeardownStore(transactions);
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await database.query(`
      TRUNCATE TABLE
        consumer_receipts,
        quarantine_records,
        outbox_messages,
        events_inbox,
        oim_ingress_teardowns,
        webhook_deliveries,
        connection_external_identities,
        connections
    `);
    await connections.put(BUSINESS_ID, connection());
    await database.query(
      `INSERT INTO connection_external_identities (
         business_id, connection_id, integration_id, integration_major_version,
         external_tenant_id, external_account_id, proof_kind, proof_digest,
         verified_at, verified_by
       ) VALUES ($1, $2, 'acme', 2, 'tenant-1', 'account-1', 'auth', $3, now(), 'provider')`,
      [BUSINESS_ID, CONNECTION_ID, "a".repeat(64)]
    );
  });

  async function normalized(
    deliveryId: string,
    connectionId = CONNECTION_ID
  ): Promise<
    PersistedWebhookDelivery & {
      leaseExpiresAt: Date;
      connectionId: string;
      externalTenantId: string;
      externalAccountId: string;
    }
  > {
    const claimAt = new Date("2030-09-13T12:00:00.000Z");
    await inbox.recordVerified(BUSINESS_ID, {
      id: deliveryId,
      integrationId: "acme",
      integrationMajorVersion: 2,
      connectionId,
      externalTenantId: "tenant-1",
      externalAccountId: "account-1",
      deduplicationKey: deliveryId,
      bodySha256: "b".repeat(64),
      safeHeaders: {},
      encryptedBody: "encrypted",
      eventType: "ticket.created",
      verification: "verified",
      authenticatedEvidenceDigest: randomUUID().replaceAll("-", "").padEnd(64, "0"),
    });
    const claimed = (await inbox.claim(1, 120, claimAt))[0];
    if (claimed === undefined || claimed.leaseExpiresAt === null) {
      throw new Error("delivery was not claimed");
    }
    await inbox.markNormalized(
      BUSINESS_ID,
      deliveryId,
      "ticket.created",
      { id: deliveryId },
      {
        expectedState: "accepted",
        expectedAttempts: claimed.attempts,
        expectedLeaseExpiresAt: claimed.leaseExpiresAt,
        now: claimAt,
      }
    );
    const normalizedDelivery = (await inbox.claim(1, 120, claimAt))[0];
    if (
      normalizedDelivery === undefined ||
      normalizedDelivery.leaseExpiresAt === null ||
      normalizedDelivery.connectionId === null ||
      normalizedDelivery.externalTenantId === null ||
      normalizedDelivery.externalAccountId === null
    ) {
      throw new Error("normalized delivery was not claimed");
    }
    return {
      ...normalizedDelivery,
      leaseExpiresAt: normalizedDelivery.leaseExpiresAt,
      connectionId: normalizedDelivery.connectionId,
      externalTenantId: normalizedDelivery.externalTenantId,
      externalAccountId: normalizedDelivery.externalAccountId,
    };
  }

  function emissionInput(delivery: Awaited<ReturnType<typeof normalized>>) {
    return {
      businessId: BUSINESS_ID,
      deliveryId: delivery.id,
      expectedAttempts: delivery.attempts,
      expectedLeaseExpiresAt: delivery.leaseExpiresAt,
      integrationId: "acme",
      integrationMajorVersion: 2,
      connectionId: delivery.connectionId,
      externalTenantId: delivery.externalTenantId,
      externalAccountId: delivery.externalAccountId,
      event: event(delivery.id),
    };
  }

  it("atomically inserts one idempotent event and marks its delivery dispatched", async () => {
    const delivery = await normalized(randomUUID());
    const store = new OimIngressEmissionStore(transactions, randomUUID);

    await expect(store.emitIfAuthorized(emissionInput(delivery))).resolves.toMatchObject({
      kind: "inserted",
      owner: { scope: "organization" },
    });
    await expect(inbox.findById(BUSINESS_ID, delivery.id)).resolves.toMatchObject({
      state: "dispatched",
    });
    const persisted = await database.query<{ event_count: number; outbox_count: number }>(
      `SELECT
         (SELECT count(*)::int FROM events_inbox) AS event_count,
         (SELECT count(*)::int FROM outbox_messages) AS outbox_count`
    );
    expect(persisted.rows[0]).toEqual({ event_count: 1, outbox_count: 1 });
  });

  it("does not insert an event after teardown has committed", async () => {
    const delivery = await normalized(randomUUID());
    await teardowns.disable(
      {
        businessId: BUSINESS_ID,
        connectionId: CONNECTION_ID,
        integrationId: "acme",
        integrationMajorVersion: 2,
      },
      new Date("2026-09-13T12:01:00.000Z")
    );

    const store = new OimIngressEmissionStore(transactions, randomUUID);
    await expect(store.emitIfAuthorized(emissionInput(delivery))).resolves.toEqual({
      kind: "unauthorized",
    });
    const persisted = await database.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM events_inbox"
    );
    expect(persisted.rows[0]?.count).toBe(0);
    await expect(inbox.findById(BUSINESS_ID, delivery.id)).resolves.toMatchObject({
      state: "normalized",
    });
  });

  it("rechecks teardown after waiting for a teardown-first Connection lock", async () => {
    const delivery = await normalized(randomUUID());
    const inserted = deferred();
    const release = deferred();
    const hookedTeardown = new IngressTeardownStore({
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
    });
    const disabling = hookedTeardown.disable({
      businessId: BUSINESS_ID,
      connectionId: CONNECTION_ID,
      integrationId: "acme",
      integrationMajorVersion: 2,
    });
    await inserted.promise;
    const store = new OimIngressEmissionStore(transactions, randomUUID);
    const emitting = store.emitIfAuthorized(emissionInput(delivery));
    let emissionSettled = false;
    void emitting.then(() => {
      emissionSettled = true;
    });
    await Promise.resolve();
    expect(emissionSettled).toBe(false);

    release.resolve();
    await expect(disabling).resolves.toBe(true);
    await expect(emitting).resolves.toEqual({ kind: "unauthorized" });
    const persisted = await database.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM events_inbox"
    );
    expect(persisted.rows[0]?.count).toBe(0);
  });

  it("makes teardown wait for an already-authorized atomic insertion", async () => {
    const delivery = await normalized(randomUUID());
    const locked = deferred();
    const release = deferred();
    const hooked: TransactionPort = {
      withTransaction: (operation) =>
        transactions.withTransaction((transaction) =>
          operation({
            query: async <Row>(text: string, params?: readonly unknown[]) => {
              const result = await transaction.query<Row>(text, params);
              if (text.includes("SELECT connection.owner_scope")) {
                locked.resolve();
                await release.promise;
              }
              return result;
            },
          } satisfies Queryable)
        ),
    };
    const store = new OimIngressEmissionStore(hooked, randomUUID);

    const emitting = store.emitIfAuthorized(emissionInput(delivery));
    await locked.promise;
    let teardownSettled = false;
    const teardown = teardowns
      .disable({
        businessId: BUSINESS_ID,
        connectionId: CONNECTION_ID,
        integrationId: "acme",
        integrationMajorVersion: 2,
      })
      .then((result) => {
        teardownSettled = true;
        return result;
      });
    await Promise.resolve();
    expect(teardownSettled).toBe(false);

    release.resolve();
    await expect(emitting).resolves.toMatchObject({ kind: "inserted" });
    await expect(teardown).resolves.toBe(true);
  });

  it("deduplicates within one exact route but not across Connections", async () => {
    const secondConnectionId = "connection-2";
    await connections.put(BUSINESS_ID, connection(secondConnectionId));
    await database.query(
      `INSERT INTO connection_external_identities (
         business_id, connection_id, integration_id, integration_major_version,
         external_tenant_id, external_account_id, proof_kind, proof_digest,
         verified_at, verified_by
       ) VALUES ($1, $2, 'acme', 2, 'tenant-1', 'account-1', 'auth', $3, now(), 'provider')`,
      [BUSINESS_ID, secondConnectionId, "c".repeat(64)]
    );
    const first = await normalized(randomUUID());
    const duplicate = await normalized(randomUUID());
    const independent = await normalized(randomUUID(), secondConnectionId);
    const withProviderDeduplication = (delivery: Awaited<ReturnType<typeof normalized>>) => ({
      ...emissionInput(delivery),
      event: { ...event(delivery.id), deduplicationKey: "provider-event-42" },
    });
    const store = new OimIngressEmissionStore(transactions, randomUUID);

    await expect(store.emitIfAuthorized(withProviderDeduplication(first))).resolves.toMatchObject({
      kind: "inserted",
    });
    await expect(
      store.emitIfAuthorized(withProviderDeduplication(duplicate))
    ).resolves.toMatchObject({ kind: "duplicate" });
    await expect(
      store.emitIfAuthorized(withProviderDeduplication(independent))
    ).resolves.toMatchObject({ kind: "inserted" });
    const persisted = await database.query<{ event_count: number; outbox_count: number }>(
      `SELECT
         (SELECT count(*)::int FROM events_inbox) AS event_count,
         (SELECT count(*)::int FROM outbox_messages) AS outbox_count`
    );
    expect(persisted.rows[0]).toEqual({ event_count: 2, outbox_count: 2 });
    await expect(inbox.findById(BUSINESS_ID, duplicate.id)).resolves.toMatchObject({
      state: "dispatched",
    });
  });

  it("does not insert after the Connection is revoked", async () => {
    const delivery = await normalized(randomUUID());
    await database.query(
      "UPDATE connections SET status = 'revoked' WHERE business_id = $1 AND id = $2",
      [BUSINESS_ID, CONNECTION_ID]
    );

    const store = new OimIngressEmissionStore(transactions, randomUUID);
    await expect(store.emitIfAuthorized(emissionInput(delivery))).resolves.toEqual({
      kind: "unauthorized",
    });
    const persisted = await database.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM events_inbox"
    );
    expect(persisted.rows[0]?.count).toBe(0);
  });
});
