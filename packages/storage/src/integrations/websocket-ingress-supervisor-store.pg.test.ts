import { PGlite } from "@electric-sql/pglite";
import type { OimConnection } from "@tulipfarm/schema";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { transactionPort } from "../pg/test-support";
import {
  CONNECTION_EXTERNAL_IDENTITY_STORAGE_STATEMENTS,
  ConnectionExternalIdentityStore,
} from "./connection-external-identity-store";
import { CONNECTION_STORAGE_STATEMENTS, ConnectionStore } from "./connection-store";
import {
  INGRESS_TEARDOWN_STORAGE_STATEMENTS,
  IngressTeardownStore,
} from "./ingress-teardown-store";
import { OIM_INGRESS_EMISSION_STORAGE_STATEMENTS } from "./oim-ingress-emission-store";
import { WEBHOOK_INBOX_STORAGE_STATEMENTS } from "./webhook-inbox-store";
import {
  WEBSOCKET_INGRESS_SUPERVISOR_STORAGE_STATEMENTS,
  WebsocketIngressSupervisorStore,
} from "./websocket-ingress-supervisor-store";

const BUSINESS_ID = "business-1";
const CONNECTION_ID = "connection-1";

function connection(overrides: Partial<OimConnection> = {}): OimConnection {
  return {
    id: CONNECTION_ID,
    integration: { id: "realtime", majorVersion: 1 },
    label: CONNECTION_ID,
    owner: { scope: "organization" },
    status: "active",
    isDefault: false,
    configuration: {},
    agentVisibleConfiguration: [],
    secretBindings: {},
    health: { status: "healthy", checkedAt: "2026-09-13T12:00:00.000Z" },
    expiresAt: null,
    ...overrides,
  };
}

function frame(id: string, bodySha256 = "b".repeat(64)) {
  return {
    id,
    integrationId: "realtime",
    integrationMajorVersion: 1,
    connectionId: CONNECTION_ID,
    externalTenantId: "tenant-1",
    externalAccountId: "account-1",
    deduplicationKey: "envelope-1",
    bodySha256,
    safeHeaders: {},
    encryptedBody: "ciphertext",
    eventType: "message.created",
    verification: "verified_websocket" as const,
    authenticatedEvidenceDigest: "c".repeat(64),
  };
}

const KEY = {
  businessId: BUSINESS_ID,
  connectionId: CONNECTION_ID,
  integrationId: "realtime",
  integrationMajorVersion: 1,
  externalTenantId: "tenant-1",
  externalAccountId: "account-1",
};

describe("WebsocketIngressSupervisorStore", () => {
  let database: PGlite;

  beforeAll(async () => {
    database = new PGlite();
    for (const statement of [
      ...CONNECTION_STORAGE_STATEMENTS,
      ...CONNECTION_EXTERNAL_IDENTITY_STORAGE_STATEMENTS,
      ...INGRESS_TEARDOWN_STORAGE_STATEMENTS,
      ...WEBHOOK_INBOX_STORAGE_STATEMENTS,
      ...OIM_INGRESS_EMISSION_STORAGE_STATEMENTS,
      ...WEBSOCKET_INGRESS_SUPERVISOR_STORAGE_STATEMENTS,
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
        connection_external_identities,
        connections,
        oim_ingress_teardowns,
        webhook_deliveries,
        websocket_ingress_supervisor
    `);
    const transactions = transactionPort(database);
    await new ConnectionStore(transactions).put(BUSINESS_ID, connection());
    await new ConnectionExternalIdentityStore(transactions).bindVerified({
      businessId: BUSINESS_ID,
      connectionId: CONNECTION_ID,
      integrationId: "realtime",
      integrationMajorVersion: 1,
      externalTenantId: "tenant-1",
      externalAccountId: "account-1",
      proofKind: "auth",
      proofDigest: "a".repeat(64),
      verifiedAt: "2026-09-13T12:00:00.000Z",
      verifiedBy: "realtime-account-api",
    });
  });

  it("lets only one worker hold a Connection socket lease at a time", async () => {
    const store = new WebsocketIngressSupervisorStore(transactionPort(database));
    const now = new Date("2026-09-13T12:00:00.000Z");

    await expect(store.acquire(BUSINESS_ID, CONNECTION_ID, "worker-a", 30, now)).resolves.toBe(
      true
    );
    await expect(store.acquire(BUSINESS_ID, CONNECTION_ID, "worker-b", 30, now)).resolves.toBe(
      false
    );

    const afterExpiry = new Date(now.getTime() + 31_000);
    await expect(
      store.acquire(BUSINESS_ID, CONNECTION_ID, "worker-b", 30, afterExpiry)
    ).resolves.toBe(true);
  });

  it("renews only for the current holder and releases the lease", async () => {
    const store = new WebsocketIngressSupervisorStore(transactionPort(database));
    const now = new Date("2026-09-13T12:00:00.000Z");
    await store.acquire(BUSINESS_ID, CONNECTION_ID, "worker-a", 30, now);

    await expect(store.renew(BUSINESS_ID, CONNECTION_ID, "worker-b", 30, now)).resolves.toBe(false);
    await expect(store.renew(BUSINESS_ID, CONNECTION_ID, "worker-a", 30, now)).resolves.toBe(true);

    await expect(store.release(BUSINESS_ID, CONNECTION_ID, "worker-a")).resolves.toBe(true);
    await expect(store.acquire(BUSINESS_ID, CONNECTION_ID, "worker-b", 30, now)).resolves.toBe(
      true
    );
  });

  it("persists an accepted frame to the durable inbox and deduplicates a replay", async () => {
    const store = new WebsocketIngressSupervisorStore(transactionPort(database));
    const now = new Date("2026-09-13T12:00:00.000Z");
    await store.acquire(BUSINESS_ID, CONNECTION_ID, "worker-a", 120, now);
    const fence = { holderToken: "worker-a", now };

    const first = await store.recordFrameIfActive(KEY, frame("frame-1"), fence);
    expect(first.accepted).toBe(true);

    const replay = await store.recordFrameIfActive(KEY, frame("frame-2"), fence);
    expect(replay.accepted).toBe(false);

    const deliveries = await database.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM webhook_deliveries"
    );
    expect(deliveries.rows[0]?.count).toBe(1);
  });

  it("rejects a frame from a stale holder whose lease was taken over", async () => {
    const store = new WebsocketIngressSupervisorStore(transactionPort(database));
    const now = new Date("2026-09-13T12:00:00.000Z");
    await store.acquire(BUSINESS_ID, CONNECTION_ID, "worker-a", 30, now);
    const afterExpiry = new Date(now.getTime() + 31_000);
    await store.acquire(BUSINESS_ID, CONNECTION_ID, "worker-b", 30, afterExpiry);

    await expect(
      store.recordFrameIfActive(KEY, frame("frame-1"), {
        holderToken: "worker-a",
        now: afterExpiry,
      })
    ).rejects.toThrow("websocket_ingress_lease_lost");
    const deliveries = await database.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM webhook_deliveries"
    );
    expect(deliveries.rows[0]?.count).toBe(0);
  });

  it("refuses to record a frame once the Connection is torn down", async () => {
    const transactions = transactionPort(database);
    const store = new WebsocketIngressSupervisorStore(transactions);
    const now = new Date("2026-09-13T12:00:00.000Z");
    await store.acquire(BUSINESS_ID, CONNECTION_ID, "worker-a", 120, now);
    await new IngressTeardownStore(transactions).disable({
      businessId: BUSINESS_ID,
      connectionId: CONNECTION_ID,
      integrationId: "realtime",
      integrationMajorVersion: 1,
    });

    await expect(
      store.recordFrameIfActive(KEY, frame("frame-1"), { holderToken: "worker-a", now })
    ).rejects.toThrow("websocket_ingress_inactive");
    const deliveries = await database.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM webhook_deliveries"
    );
    expect(deliveries.rows[0]?.count).toBe(0);
  });
});
