import { refreshOimConnection, revokeOimConnection } from "@tulipfarm/integrations";
import type { OimManifest } from "@tulipfarm/schema";
import {
  ConnectionSecretManager,
  SecretBroker,
  type SecretProvider,
  secretStorageKey,
} from "@tulipfarm/secrets";
import type {
  ConnectionAuthStep,
  PersistedConnection,
  UpdateConnectionAuthStep,
  UpdateConnectionAuthStepHealth,
} from "@tulipfarm/storage";
import { describe, expect, it } from "vitest";

const ACCESS_REF = "secret://00000000-0000-4000-8000-000000000001";
const REFRESH_REF = "secret://00000000-0000-4000-8000-000000000002";
const CLIENT_REF = "secret://00000000-0000-4000-8000-000000000003";
const NOW = new Date("2026-09-12T12:00:00.000Z");

describe("OIM lifecycle Secret leases", () => {
  it("invalidates leases on refresh rotation and manifestless revoke", async () => {
    const values = new Map([
      [secretStorageKey(ACCESS_REF), { value: "old-access", revision: "1" }],
      [secretStorageKey(REFRESH_REF), { value: "refresh", revision: "1" }],
      [secretStorageKey(CLIENT_REF), { value: "client", revision: "1" }],
    ]);
    const provider: SecretProvider = {
      async resolveCurrent(reference) {
        const value = values.get(secretStorageKey(reference));
        return value === undefined ? null : { value: value.value, version: value.revision };
      },
      async resolveUncached(reference) {
        const value = values.get(secretStorageKey(reference));
        return value === undefined ? null : { value: value.value, version: value.revision };
      },
      async currentVersion(reference) {
        return values.get(secretStorageKey(reference))?.revision ?? null;
      },
    };
    const broker = new SecretBroker({
      provider,
      authorizer: { authorize: () => ({ allowed: true }) },
    });
    const manager = new ConnectionSecretManager(
      {
        async set(key, plaintext) {
          const previous = values.get(key);
          values.set(key, {
            value: plaintext,
            revision: String(Number(previous?.revision ?? "0") + 1),
          });
        },
        async delete(key) {
          values.delete(key);
        },
      },
      broker
    );
    let connection: PersistedConnection = {
      businessId: "business-1",
      id: "connection-1",
      integration: { id: "acme", majorVersion: 2 },
      label: "Acme",
      owner: { scope: "organization" },
      status: "active",
      isDefault: true,
      configuration: {},
      agentVisibleConfiguration: [],
      secretBindings: { access: ACCESS_REF, refresh: REFRESH_REF, client: CLIENT_REF },
      health: { status: "expiring", checkedAt: NOW.toISOString() },
      expiresAt: "2026-09-12T12:01:00.000Z",
      createdAt: NOW,
      updatedAt: NOW,
    };
    let nextSecret = 10;
    let authStep: ConnectionAuthStep = {
      businessId: connection.businessId,
      connectionId: connection.id,
      stepId: "oauth",
      status: "active",
      accessSlot: "access",
      accessSecretRef: ACCESS_REF,
      refreshSlot: "refresh",
      refreshSecretRef: REFRESH_REF,
      externalIdentity: null,
      expiresAt: connection.expiresAt,
      healthCheckedAt: NOW.toISOString(),
      revision: 1,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    };
    const authSteps = {
      async put() {
        return authStep;
      },
      async list() {
        return [authStep];
      },
      async updateHealth(input: UpdateConnectionAuthStepHealth) {
        if (input.expectedRevision !== authStep.revision) return null;
        authStep = { ...authStep, ...input, revision: authStep.revision + 1 };
        return authStep;
      },
      async update(input: UpdateConnectionAuthStep) {
        if (input.expectedRevision !== authStep.revision) return null;
        authStep = {
          ...authStep,
          ...input,
          revision: authStep.revision + 1,
          updatedAt: input.healthCheckedAt ?? NOW.toISOString(),
        };
        return authStep;
      },
    };
    const credentials = {
      async create(_integrationId: string, _slot: string, plaintext: string) {
        const reference =
          `secret://00000000-0000-4000-8000-${String(nextSecret++).padStart(12, "0")}` as const;
        await manager.rotate(reference, plaintext);
        return reference;
      },
      async read(reference: string) {
        const value = values.get(secretStorageKey(reference));
        if (value === undefined) throw new Error("missing");
        return value.value;
      },
      rotate: manager.rotate.bind(manager),
      revokeReferences: manager.revokeReferences.bind(manager),
      revokeConnection: manager.revokeConnection.bind(manager),
    };
    const connections = {
      async claimAuthStep(input: { expectedRevision: number; healthCheckedAt: string }) {
        if (connection.status !== "active" || input.expectedRevision !== authStep.revision) {
          return false;
        }
        authStep = {
          ...authStep,
          status: "pending",
          healthCheckedAt: input.healthCheckedAt,
          revision: authStep.revision + 1,
        };
        return true;
      },
      async publishAuthStep(
        input: UpdateConnectionAuthStep & {
          secretBindings: Readonly<Record<string, `secret://${string}`>>;
        }
      ) {
        if (connection.status !== "active") return false;
        const updated = await authSteps.update(input);
        if (updated === null) return false;
        connection = {
          ...connection,
          secretBindings: { ...connection.secretBindings, ...input.secretBindings },
          health: { status: "healthy", checkedAt: input.healthCheckedAt },
          expiresAt: input.expiresAt,
        };
        return true;
      },
      async markActionRequired() {
        return true;
      },
      async findById() {
        return connection;
      },
      async fenceRevocation() {
        connection = { ...connection, status: "revoked", isDefault: false };
        authStep = { ...authStep, status: "revoked", revision: authStep.revision + 1 };
        return connection;
      },
    };
    const scope = {
      secretRef: ACCESS_REF,
      connectionId: connection.id,
      credentialSlot: "access",
      toolId: "oim.acme.v2.read",
      integrationId: "acme",
      runId: "run-1",
      purpose: "read",
    } as const;
    const beforeRefresh = await broker.leaseConnection({ scope, maxUses: 2 });
    const manifest = {
      metadata: { id: "acme" },
      auth: {
        steps: [
          {
            id: "oauth",
            type: "oauth2",
            clientId: { type: "credential", slot: "client" },
            bindings: [
              { sourcePath: "/access_token", target: { type: "credential", slot: "access" } },
              { sourcePath: "/refresh_token", target: { type: "credential", slot: "refresh" } },
            ],
          },
        ],
      },
    } as unknown as OimManifest;

    await refreshOimConnection(
      {
        authSteps,
        connections,
        credentials,
        refreshOAuth: async () => ({
          credentialValues: { access: "new-access" },
          expiresAt: "2026-09-12T13:00:00.000Z",
          verifiedIdentity: {
            externalTenantId: "tenant-1",
            externalAccountId: "account-1",
            proofDigest: "a".repeat(64),
            verifiedAt: NOW.toISOString(),
            verifiedBy: "provider-profile",
          },
        }),
        now: () => NOW,
      },
      manifest,
      connection
    );
    await expect(beforeRefresh.use(() => "used")).rejects.toMatchObject({ reason: "revoked" });

    const beforeRevoke = await broker.leaseConnection({
      scope: { ...scope, secretRef: connection.secretBindings.access as `secret://${string}` },
    });
    await revokeOimConnection({ connections, credentials }, connection);
    await expect(beforeRevoke.use(() => "used")).rejects.toMatchObject({ reason: "revoked" });
    expect(connection.status).toBe("revoked");
  });
});
