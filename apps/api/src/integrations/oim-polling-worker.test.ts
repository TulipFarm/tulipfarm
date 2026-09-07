import { PGlite } from "@electric-sql/pglite";
import { type OimManifest, oimToolId } from "@tulipfarm/schema";
import type { SecretScope } from "@tulipfarm/secrets";
import type { SoulIntegration } from "@tulipfarm/soul";
import {
  POLLING_INGRESS_STORAGE_STATEMENTS,
  PollingIngressStore,
  WEBHOOK_INBOX_STORAGE_STATEMENTS,
  WebhookInboxStore,
} from "@tulipfarm/storage";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { connectionUseAuthorizer } from "./connection-authorizer";
import {
  type OimPollingWorkerDeps,
  oimPollingSecretAuthorizer,
  pollOimIngress,
  startOimPollingWorker,
} from "./oim-polling-worker";

const connection = {
  businessId: "business-1",
  id: "connection-1",
  integration: { id: "acme", majorVersion: 1 },
  label: "Acme",
  owner: { scope: "organization" as const },
  status: "active" as const,
  isDefault: true,
  configuration: {},
  agentVisibleConfiguration: [],
  secretBindings: { token: "secret://token" },
  health: { status: "healthy" as const, checkedAt: null },
  expiresAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const manifest: OimManifest = {
  oimVersion: "1.0",
  kind: "Integration",
  metadata: { id: "acme", name: "Acme", version: "1.0.0", description: "Acme", license: "MIT" },
  profiles: { core: "1.0", events: "1.0", auth: "1.0" },
  auth: { credentialSlots: [{ id: "token", label: "Token", kind: "api_key" }], steps: [] },
  operations: [
    {
      id: "poll",
      name: "poll_events",
      description: "Poll events.",
      effect: "read",
      identityMode: "shared_only",
      credentialSlot: "token",
      credentialInjection: { in: "header", name: "Authorization", format: "******" },
      source: {
        type: "http",
        method: "GET",
        baseUrl: "https://api.acme.test",
        path: "/events",
        parameters: [{ name: "cursor", in: "query", schema: { type: "string" } }],
      },
      response: { schema: { type: "object" }, maxBytes: 4096 },
    },
  ],
  events: {
    path: "/acme",
    verification: { scheme: "shared_secret", secretSlot: "token", signatureHeader: "x-token" },
    deduplication: { kind: "none" },
    eventTypes: [
      {
        type: "updated",
        selector: { pointer: "/type", equals: "updated" },
        schema: { type: "object" },
      },
    ],
  },
  ingress: {
    kind: "polling",
    operationId: "poll",
    intervalSeconds: 60,
    cursor: { responsePointer: "/cursor", requestParameter: "cursor" },
  },
};

const installedIntegration = {
  slug: "acme",
  sourceIntegration: "acme",
  oimManifest: manifest,
} as SoulIntegration;

const pollingSecretScope = {
  secretRef: "secret://token" as const,
  connectionId: "connection-1",
  credentialSlot: "token",
  integrationId: "acme",
  toolId: oimToolId(manifest, "poll"),
  runId: "poll-connection-1",
  stateId: "poll-connection-1",
  purpose: "oim-polling",
  principalKind: "integration_adapter",
  principalId: "integration:acme",
  destination: "api.acme.test",
};

function maxIntegerCursorManifest(): OimManifest {
  const { events, ...pollingManifest } = manifest;
  return {
    ...pollingManifest,
    operations: manifest.operations.map((operation) => ({
      ...operation,
      source:
        operation.source.type === "http"
          ? {
              ...operation.source,
              parameters: [{ name: "offset", in: "query", schema: { type: "integer" } }],
            }
          : operation.source,
    })),
    ingress: {
      kind: "polling",
      operationId: "poll",
      intervalSeconds: 60,
      eventTypes: events?.eventTypes,
      cursor: {
        mode: "max_integer_plus_one",
        responsePointer: "/result",
        itemPointer: "/update_id",
        requestParameter: "offset",
      },
    },
  };
}

describe("pollOimIngress", () => {
  let database: PGlite;

  beforeAll(async () => {
    database = new PGlite();
    for (const statement of [
      ...POLLING_INGRESS_STORAGE_STATEMENTS,
      ...WEBHOOK_INBOX_STORAGE_STATEMENTS,
    ]) {
      await database.exec(statement);
    }
  });
  afterAll(async () => database.close());
  beforeEach(async () =>
    database.query("TRUNCATE TABLE polling_ingress_state, webhook_deliveries")
  );

  function deps(responses: unknown[]) {
    const http = vi.fn(async (_request: { url: string }) => ({
      status: 200,
      headers: {},
      body: responses.shift() ?? { type: "updated", cursor: "after-2" },
    }));
    return {
      connections: {
        listPollingFallbacks: async () => [connection],
        findById: vi.fn(async () => connection),
      },
      connectionAccess: { canUse: vi.fn(async () => true) },
      authorizeIntegration: vi.fn(async () => undefined),
      state: new PollingIngressStore({
        withTransaction: async (callback) =>
          callback({ query: database.query.bind(database) } as never),
      }),
      secrets: {
        leaseConnection: async () => ({
          use: async (callback: (secret: string) => unknown) => callback("credential"),
        }),
        leaseConnectionSet: async () => ({
          use: async (callback: (credentials: Readonly<Record<string, string>>) => unknown) =>
            callback({ token: "credential" }),
        }),
        revokeConnection: () => {},
      } as never,
      http: { send: http },
      soulLoader: { integrations: new Map([["acme", installedIntegration]]) } as never,
      inbox: new WebhookInboxStore({
        withTransaction: async (callback) =>
          callback({ query: database.query.bind(database) } as never),
      }),
      encryptPayload: async (raw: Buffer) => `enc:${raw.toString("utf8")}`,
      log: { info: vi.fn(), error: vi.fn() },
      newDeliveryId: () => crypto.randomUUID(),
      newLeaseToken: () => crypto.randomUUID(),
    };
  }

  it("resumes from the durable cursor after restart without replaying or skipping events", async () => {
    const first = deps([{ type: "updated", cursor: "after-1" }]);
    await pollOimIngress(first);
    const second = deps([{ type: "updated", cursor: "after-2" }]);
    await pollOimIngress({ ...second, now: () => new Date(Date.now() + 61_000) });

    const { rows } = await database.query<{ event_type: string }>(
      "SELECT event_type FROM webhook_deliveries ORDER BY received_at"
    );
    expect(rows).toEqual([{ event_type: "updated" }, { event_type: "updated" }]);
    expect((second.http.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].url).toContain(
      "cursor=after-1"
    );
  });

  it("leases a Connection to prevent concurrent polls from persisting it twice", async () => {
    const test = deps([{ type: "updated", cursor: "after-1" }]);
    await Promise.all([pollOimIngress(test), pollOimIngress(test)]);

    expect(test.http.send).toHaveBeenCalledTimes(1);
  });

  it("denies an inactive personal owner before claiming a polling lease", async () => {
    const personal = {
      ...connection,
      owner: {
        scope: "personal" as const,
        principalKind: "user" as const,
        principalId: "owner-1",
      },
    };
    const test = deps([{ type: "updated", cursor: "after-1" }]);
    const findById = vi.fn(async () => personal);
    const canUse = vi.fn(async () => false);
    await pollOimIngress({
      ...test,
      connections: {
        listPollingFallbacks: async () => [personal],
        findById,
      },
      connectionAccess: { canUse },
    });

    expect(canUse).toHaveBeenCalledWith({ kind: "user", id: "owner-1" }, personal);
    expect(test.authorizeIntegration).not.toHaveBeenCalled();
    expect(test.http.send).not.toHaveBeenCalled();
    expect((await database.query("SELECT connection_id FROM polling_ingress_state")).rows).toEqual(
      []
    );
  });

  it("does not substitute another Connection when the persisted source binding disappeared", async () => {
    const test = deps([{ type: "updated", cursor: "after-1" }]);
    const findById = vi.fn(async () => null);

    await pollOimIngress({
      ...test,
      connections: {
        listPollingFallbacks: async () => [connection],
        findById,
      },
    });

    expect(findById).toHaveBeenCalledWith("business-1", "connection-1");
    expect(test.connectionAccess.canUse).not.toHaveBeenCalled();
    expect(test.http.send).not.toHaveBeenCalled();
  });

  it("denies an untrusted installed release before claiming a polling lease", async () => {
    const test = deps([{ type: "updated", cursor: "after-1" }]);
    test.authorizeIntegration.mockRejectedValue(new Error("installed provenance missing"));

    await pollOimIngress(test);

    expect(test.authorizeIntegration).toHaveBeenCalledWith(installedIntegration);
    expect(test.http.send).not.toHaveBeenCalled();
    expect((await database.query("SELECT connection_id FROM polling_ingress_state")).rows).toEqual(
      []
    );
  });

  it("rechecks the exact Connection after claiming and releases when authority changed", async () => {
    const test = deps([{ type: "updated", cursor: "after-1" }]);
    test.connectionAccess.canUse.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await pollOimIngress(test);

    expect(test.connections.findById).toHaveBeenCalledTimes(2);
    expect(test.connections.findById).toHaveBeenCalledWith("business-1", "connection-1");
    expect(test.connectionAccess.canUse).toHaveBeenCalledTimes(2);
    expect(test.http.send).not.toHaveBeenCalled();
    const { rows } = await database.query<{ lease_token: string | null }>(
      "SELECT lease_token FROM polling_ingress_state"
    );
    expect(rows).toEqual([{ lease_token: null }]);
  });

  it("rechecks installed release provenance after claiming and before provider access", async () => {
    const test = deps([{ type: "updated", cursor: "after-1" }]);
    test.authorizeIntegration
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("installed provenance revoked"));

    await pollOimIngress(test);

    expect(test.authorizeIntegration).toHaveBeenCalledTimes(2);
    expect(test.http.send).not.toHaveBeenCalled();
    const { rows } = await database.query<{ lease_token: string | null }>(
      "SELECT lease_token FROM polling_ingress_state"
    );
    expect(rows).toEqual([{ lease_token: null }]);
  });

  it("binds the credential lease to the exact Connection and polling principal", async () => {
    const test = deps([{ type: "updated", cursor: "after-1" }]);
    const leaseConnection = vi.fn(async () => ({
      use: async (callback: (secret: string) => unknown) => callback("credential"),
    }));
    test.secrets = {
      leaseConnection,
      leaseConnectionSet: vi.fn(),
    } as never;

    await pollOimIngress(test);

    expect(leaseConnection).toHaveBeenCalledWith({
      scope: expect.objectContaining({
        connectionId: "connection-1",
        integrationId: "acme",
        principalKind: "integration_adapter",
        principalId: "integration:acme",
        purpose: "oim-polling",
      }),
    });
  });

  describe("oimPollingSecretAuthorizer", () => {
    it("admits only the exact live polling Connection, principal, operation, and release", async () => {
      const canUse = vi.fn(async () => true);
      const authorizeIntegration = vi.fn(async () => undefined);
      const authorizer = oimPollingSecretAuthorizer({
        businessId: "business-1",
        connections: { findById: async () => connection },
        connectionAccess: { canUse },
        authorizeIntegration,
        soulLoader: { integrations: new Map([["acme", installedIntegration]]) } as never,
      });

      await expect(authorizer.authorize(pollingSecretScope)).resolves.toEqual({
        allowed: true,
        maxTtlMs: 30_000,
        maxUses: 1,
      });
      expect(canUse).toHaveBeenCalledWith(
        { kind: "integration_adapter", id: "integration:acme" },
        connection
      );
      expect(authorizeIntegration).toHaveBeenCalledWith(installedIntegration);
    });

    it.each([
      { scope: "organization" as const },
      { scope: "team" as const, teamId: "00000000-0000-4000-8000-000000000004" },
    ])("admits a $scope Connection through the real live authority layers", async (owner) => {
      const sharedConnection = { ...connection, owner };
      const connectionAccess = connectionUseAuthorizer({
        businessId: "business-1",
        resolvePrincipalLayer: async (name) => ({ name, grants: [] }),
        hasTeamMembership: async () => false,
        isTeamActive: async () => true,
      });
      const authorizer = oimPollingSecretAuthorizer({
        businessId: "business-1",
        connections: { findById: async () => sharedConnection },
        connectionAccess,
        authorizeIntegration: async () => undefined,
        soulLoader: { integrations: new Map([["acme", installedIntegration]]) } as never,
      });

      await expect(authorizer.authorize(pollingSecretScope)).resolves.toEqual({
        allowed: true,
        maxTtlMs: 30_000,
        maxUses: 1,
      });
    });

    it.each([
      { secretRef: "secret://other" },
      { connectionId: "connection-other" },
      { credentialSlot: "other" },
      { integrationId: "other" },
      { toolId: "integration.other.v1.poll" },
      { principalId: "integration:other" },
      { destination: "evil.example" },
      { purpose: "other" },
    ] satisfies readonly Partial<SecretScope>[])(
      "denies a lease whose exact polling scope differs: %j",
      async (change) => {
        const authorizer = oimPollingSecretAuthorizer({
          businessId: "business-1",
          connections: { findById: async () => connection },
          connectionAccess: { canUse: async () => true },
          authorizeIntegration: async () => undefined,
          soulLoader: { integrations: new Map([["acme", installedIntegration]]) } as never,
        });

        await expect(authorizer.authorize({ ...pollingSecretScope, ...change })).resolves.toEqual({
          allowed: false,
          reason: "not_authorized",
        });
      }
    );

    it("denies when live Connection use or installed release trust is revoked", async () => {
      const canUse = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
      const authorizeIntegration = vi.fn(async () => {
        throw new Error("installed provenance revoked");
      });
      const authorizer = oimPollingSecretAuthorizer({
        businessId: "business-1",
        connections: { findById: async () => connection },
        connectionAccess: { canUse },
        authorizeIntegration,
        soulLoader: { integrations: new Map([["acme", installedIntegration]]) } as never,
      });

      await expect(authorizer.authorize(pollingSecretScope)).resolves.toMatchObject({
        allowed: false,
      });
      await expect(authorizer.authorize(pollingSecretScope)).resolves.toMatchObject({
        allowed: false,
      });
    });
  });

  describe("startOimPollingWorker", () => {
    it("tracks its long-lived Connection broker until the worker stops", () => {
      vi.useFakeTimers();
      try {
        const release = vi.fn();
        const secrets = { revokeConnection: vi.fn() };
        const worker = startOimPollingWorker({
          secrets,
          trackConnectionBroker: vi.fn((broker) => {
            expect(broker).toBe(secrets);
            return release;
          }),
        } as unknown as OimPollingWorkerDeps);

        worker.stop();
        worker.stop();

        expect(release).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("fences a late checkpoint from the worker whose lease expired", async () => {
    const state = deps([]).state;
    const firstNow = new Date(Date.now() + 1_000);
    const first = await state.claim("business-1", "connection-1", "lease-1", 30, firstNow);
    expect(first).not.toBeNull();
    const secondNow = new Date(firstNow.getTime() + 31_000);
    const second = await state.claim("business-1", "connection-1", "lease-2", 30, secondNow);
    expect(second).not.toBeNull();

    expect(
      await state.complete("business-1", "connection-1", "lease-2", "103", 60, secondNow)
    ).toBe(true);
    expect(await state.complete("business-1", "connection-1", "lease-1", "101", 60, firstNow)).toBe(
      false
    );

    const { rows } = await database.query<{ cursor: string | null }>(
      "SELECT cursor FROM polling_ingress_state"
    );
    expect(rows[0]?.cursor).toBe("103");
  });

  it("persists a Telegram-style batch before advancing its cursor and deduplicates crash retry", async () => {
    const firstResponse = {
      result: [
        { update_id: 100, type: "updated" },
        { update_id: 101, type: "updated" },
      ],
    };
    const retryResponse = {
      result: [
        { update_id: 100, type: "updated" },
        { update_id: 101, type: "updated" },
        { update_id: 102, type: "updated" },
      ],
    };
    const firstBase = deps([firstResponse]);
    const pollingState = firstBase.state;
    const complete = vi
      .fn(pollingState.complete.bind(pollingState))
      .mockRejectedValueOnce(new Error("checkpoint write crashed"));
    const first = {
      ...firstBase,
      state: {
        claim: pollingState.claim.bind(pollingState),
        complete,
        release: pollingState.release.bind(pollingState),
      } as unknown as PollingIngressStore,
      soulLoader: {
        integrations: new Map([["telegram", { oimManifest: maxIntegerCursorManifest() }]]),
      } as never,
    };
    const firstNow = new Date(Date.now() + 1_000);

    await pollOimIngress({ ...first, now: () => firstNow });
    const afterCrash = await database.query<{ cursor: string | null }>(
      "SELECT cursor FROM polling_ingress_state"
    );
    expect(afterCrash.rows[0]?.cursor).toBeNull();
    expect((await database.query("SELECT id FROM webhook_deliveries")).rows).toHaveLength(2);

    const retry = {
      ...deps([retryResponse, { result: [] }]),
      soulLoader: {
        integrations: new Map([["telegram", { oimManifest: maxIntegerCursorManifest() }]]),
      } as never,
    };
    const retryNow = new Date(firstNow.getTime() + 61_000);
    await pollOimIngress({ ...retry, now: () => retryNow });

    const afterRetry = await database.query<{ cursor: string | null }>(
      "SELECT cursor FROM polling_ingress_state"
    );
    expect(afterRetry.rows[0]?.cursor).toBe("103");
    const deliveries = await database.query<{
      id: string;
      connection_id: string;
      integration_major_version: number;
    }>("SELECT id, connection_id, integration_major_version FROM webhook_deliveries");
    expect(deliveries.rows).toHaveLength(3);
    expect(deliveries.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          connection_id: "connection-1",
          integration_major_version: 1,
        }),
      ])
    );
    expect(firstBase.http.send).toHaveBeenCalledOnce();
    expect(retry.http.send).toHaveBeenCalledOnce();
    expect((retry.http.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].url).not.toContain(
      "offset="
    );

    const emptyNow = new Date(retryNow.getTime() + 61_000);
    await pollOimIngress({ ...retry, now: () => emptyNow });
    const afterEmpty = await database.query<{ cursor: string | null }>(
      "SELECT cursor FROM polling_ingress_state"
    );
    expect(afterEmpty.rows[0]?.cursor).toBe("103");
    expect((retry.http.send as ReturnType<typeof vi.fn>).mock.calls[1]?.[0].url).toContain(
      "offset=103"
    );
    expect((await database.query("SELECT id FROM webhook_deliveries")).rows).toHaveLength(3);
  });

  it("does not persist or checkpoint a batch with an unsafe update id", async () => {
    const test = deps([{ result: [{ update_id: Number.MAX_SAFE_INTEGER, type: "updated" }] }]);
    test.soulLoader = {
      integrations: new Map([["telegram", { oimManifest: maxIntegerCursorManifest() }]]),
    } as never;

    await pollOimIngress(test);

    expect((await database.query("SELECT id FROM webhook_deliveries")).rows).toHaveLength(0);
    const { rows } = await database.query<{ cursor: string | null }>(
      "SELECT cursor FROM polling_ingress_state"
    );
    expect(rows[0]?.cursor).toBeNull();
    expect(test.log.error).toHaveBeenCalledWith(expect.stringContaining("safe integer range"));
  });
});
