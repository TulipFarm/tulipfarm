import { type OimConnection, type OimManifest, validateOimManifest } from "@tulipfarm/schema";
import type {
  ConnectionAuthStep,
  ConnectionAuthStepFence,
  PersistedConnection,
  PublishConnectionAuthStep,
  UpdateConnectionAuthStep,
  UpdateConnectionAuthStepHealth,
} from "@tulipfarm/storage";
import { describe, expect, it, vi } from "vitest";
import {
  type ConnectionCredentialVault,
  createOimConnection,
  refreshOimConnection,
  revokeOimConnection,
} from "./lifecycle";

const NOW = new Date("2026-09-12T12:00:00.000Z");
const VERIFIED_IDENTITY = {
  externalTenantId: "tenant-1",
  externalAccountId: "account-1",
  proofDigest: "a".repeat(64),
  verifiedAt: NOW.toISOString(),
  verifiedBy: "provider-profile",
} as const;

function manifest(): OimManifest {
  return validateOimManifest({
    oimVersion: "1.0",
    kind: "Integration",
    metadata: {
      id: "acme",
      name: "Acme",
      version: "2.0.0",
      description: "Acme API",
      license: "Apache-2.0",
    },
    profiles: { core: "1.0", auth: "1.0" },
    auth: {
      credentialSlots: [
        { id: "client_id", label: "Client id", kind: "api_key" },
        { id: "client_secret", label: "Client secret", kind: "client_secret" },
        { id: "account_access", label: "Account access", kind: "oauth2_access_token" },
        { id: "account_refresh", label: "Account refresh", kind: "oauth2_refresh_token" },
        { id: "admin_access", label: "Admin access", kind: "oauth2_access_token" },
        { id: "admin_refresh", label: "Admin refresh", kind: "oauth2_refresh_token" },
      ],
      steps: [
        {
          id: "client",
          title: "OAuth app",
          type: "fields",
          fields: [
            {
              id: "client_id",
              label: "Client id",
              input: "text",
              target: { type: "credential", slot: "client_id" },
            },
            {
              id: "client_secret",
              label: "Client secret",
              input: "password",
              target: { type: "credential", slot: "client_secret" },
            },
          ],
        },
        {
          id: "account",
          title: "Authorize account",
          type: "oauth2",
          authorizationUrl: "https://acme.test/account/authorize",
          tokenUrl: "https://acme.test/account/token",
          scopes: ["account.read"],
          clientId: { type: "credential", slot: "client_id" },
          clientSecret: { type: "credential", slot: "client_secret" },
          bindings: [
            {
              sourcePath: "/access_token",
              target: { type: "credential", slot: "account_access" },
            },
            {
              sourcePath: "/refresh_token",
              target: { type: "credential", slot: "account_refresh" },
            },
          ],
        },
        {
          id: "admin",
          title: "Authorize admin",
          type: "oauth2",
          authorizationUrl: "https://acme.test/admin/authorize",
          tokenUrl: "https://acme.test/admin/token",
          scopes: ["admin.read"],
          clientId: { type: "credential", slot: "client_id" },
          clientSecret: { type: "credential", slot: "client_secret" },
          bindings: [
            {
              sourcePath: "/access_token",
              target: { type: "credential", slot: "admin_access" },
            },
            {
              sourcePath: "/refresh_token",
              target: { type: "credential", slot: "admin_refresh" },
            },
          ],
        },
      ],
    },
    operations: [
      {
        id: "read",
        name: "read",
        description: "Read.",
        effect: "read",
        identityMode: "shared_only",
        credentialSlot: "account_access",
        credentialInjection: { in: "header", name: "authorization", format: "Bearer {token}" },
        source: {
          type: "http",
          method: "GET",
          baseUrl: "https://api.acme.test",
          path: "/",
        },
        response: { schema: { type: "object" }, maxBytes: 1_024 },
      },
    ],
  });
}

function connection(): PersistedConnection {
  return {
    businessId: "business-1",
    id: "connection-1",
    integration: { id: "acme", majorVersion: 2 },
    label: "Acme",
    owner: { scope: "organization" },
    status: "active",
    isDefault: true,
    configuration: {},
    agentVisibleConfiguration: [],
    secretBindings: {
      client_id: "secret://00000000-0000-4000-8000-000000000001",
      client_secret: "secret://00000000-0000-4000-8000-000000000002",
      account_access: "secret://00000000-0000-4000-8000-000000000003",
      account_refresh: "secret://00000000-0000-4000-8000-000000000004",
      admin_access: "secret://00000000-0000-4000-8000-000000000005",
      admin_refresh: "secret://00000000-0000-4000-8000-000000000006",
    },
    health: { status: "expiring", checkedAt: NOW.toISOString() },
    expiresAt: "2026-09-12T12:05:00.000Z",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

class MemoryAuthSteps {
  readonly rows = new Map<string, ConnectionAuthStep>();

  constructor() {
    for (const stepId of ["account", "admin"]) {
      this.rows.set(stepId, {
        businessId: "business-1",
        connectionId: "connection-1",
        stepId,
        status: "active",
        accessSlot: `${stepId}_access`,
        accessSecretRef: `secret://00000000-0000-4000-8000-00000000000${
          stepId === "account" ? "3" : "5"
        }`,
        refreshSlot: `${stepId}_refresh`,
        refreshSecretRef: `secret://00000000-0000-4000-8000-00000000000${
          stepId === "account" ? "4" : "6"
        }`,
        externalIdentity: null,
        expiresAt: "2026-09-12T12:05:00.000Z",
        healthCheckedAt: NOW.toISOString(),
        revision: 1,
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      });
    }
  }

  async list() {
    return [...this.rows.values()];
  }

  async put(input: Omit<ConnectionAuthStep, "revision" | "createdAt" | "updatedAt">) {
    const previous = this.rows.get(input.stepId);
    const updated = {
      ...input,
      revision: (previous?.revision ?? 0) + 1,
      createdAt: previous?.createdAt ?? NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    };
    this.rows.set(input.stepId, updated);
    return updated;
  }

  async updateHealth(input: UpdateConnectionAuthStepHealth) {
    const row = this.rows.get(input.stepId);
    if (row === undefined || row.revision !== input.expectedRevision) return null;
    const updated = {
      ...row,
      status: input.status,
      expiresAt: input.expiresAt,
      healthCheckedAt: input.healthCheckedAt,
      revision: row.revision + 1,
    };
    this.rows.set(input.stepId, updated);
    return updated;
  }

  async update(input: UpdateConnectionAuthStep) {
    const row = this.rows.get(input.stepId);
    if (row === undefined || row.revision !== input.expectedRevision) return null;
    const updated = {
      ...row,
      ...input,
      revision: row.revision + 1,
      createdAt: row.createdAt,
      updatedAt: input.healthCheckedAt ?? NOW.toISOString(),
    };
    this.rows.set(input.stepId, updated);
    return updated;
  }
}

function vault(): ConnectionCredentialVault & { values: Map<string, string> } {
  const values = new Map<string, string>(
    Object.values(connection().secretBindings).map((reference) => [reference, `old:${reference}`])
  );
  let nextReference = 10;
  return {
    values,
    async create(_integrationId, _slot, plaintext) {
      const reference = `secret://00000000-0000-4000-8000-${String(nextReference++).padStart(
        12,
        "0"
      )}` as const;
      values.set(reference, plaintext);
      return reference;
    },
    async read(reference) {
      const value = values.get(reference);
      if (value === undefined) throw new Error("missing");
      return value;
    },
    async rotate(reference, plaintext) {
      values.set(reference, plaintext);
    },
    async revokeReferences(references) {
      for (const reference of references) values.delete(reference);
    },
    async revokeConnection(_connectionId, bindings, persist) {
      for (const reference of Object.values(bindings)) values.delete(reference);
      await persist();
    },
  };
}

function lifecycleConnections(
  authSteps: MemoryAuthSteps,
  initial: PersistedConnection = connection()
) {
  let stored = initial;
  const publishAuthStep = vi.fn(async (input: PublishConnectionAuthStep) => {
    if (stored.status !== "active") return false;
    const updated = await authSteps.update({
      businessId: input.businessId,
      connectionId: input.connectionId,
      stepId: input.stepId,
      expectedRevision: input.expectedRevision,
      status: input.status,
      accessSlot: input.accessSlot,
      accessSecretRef: input.accessSecretRef,
      refreshSlot: input.refreshSlot,
      refreshSecretRef: input.refreshSecretRef,
      externalIdentity: input.externalIdentity,
      expiresAt: input.expiresAt,
      healthCheckedAt: input.healthCheckedAt,
    });
    if (updated === null) return false;
    const rows = await authSteps.list();
    stored = {
      ...stored,
      configuration: { ...stored.configuration, ...input.configuration },
      secretBindings: { ...stored.secretBindings, ...input.secretBindings },
      health: {
        status: rows.every((row) => row.status === "active") ? "healthy" : "action_required",
        checkedAt: input.healthCheckedAt,
      },
      expiresAt:
        rows.flatMap((row) => (row.expiresAt === null ? [] : [row.expiresAt])).sort()[0] ?? null,
    };
    return true;
  });
  return {
    publishAuthStep,
    async claimAuthStep(input: ConnectionAuthStepFence) {
      return (
        (await authSteps.updateHealth({
          businessId: input.businessId,
          connectionId: input.connectionId,
          stepId: input.stepId,
          expectedRevision: input.expectedRevision,
          status: "pending",
          expiresAt: authSteps.rows.get(input.stepId)?.expiresAt ?? null,
          healthCheckedAt: input.healthCheckedAt,
        })) !== null
      );
    },
    async markActionRequired(
      _businessId: string,
      _connectionId: string,
      _integration: OimConnection["integration"],
      _owner: OimConnection["owner"],
      checkedAt: string
    ) {
      if (stored.status !== "active") return false;
      stored = { ...stored, health: { status: "action_required", checkedAt } };
      return true;
    },
    async findById() {
      return stored;
    },
    async fenceRevocation() {
      stored = { ...stored, status: "revoked", isDefault: false };
      return stored;
    },
  };
}

describe("OIM Connection lifecycle", () => {
  it("creates a personal Connection and durable pending rows for every browser step", async () => {
    const authSteps = new MemoryAuthSteps();
    authSteps.rows.clear();
    const credentials = vault();
    const put = vi.fn(async () => {});

    const result = await createOimConnection(
      {
        connections: { put },
        authSteps,
        credentials,
        newId: () => "connection-new",
        now: () => NOW,
      },
      {
        businessId: "business-1",
        manifest: manifest(),
        label: "My Acme",
        owner: { scope: "personal", principalKind: "user", principalId: "user-1" },
        values: { client_id: "client", client_secret: "secret" },
      }
    );

    expect(result).toEqual({ connectionId: "connection-new" });
    expect(put).toHaveBeenCalledWith(
      "business-1",
      expect.objectContaining({
        id: "connection-new",
        integration: { id: "acme", majorVersion: 2 },
        owner: { scope: "personal", principalKind: "user", principalId: "user-1" },
        health: { status: "action_required", checkedAt: NOW.toISOString() },
      })
    );
    expect([...authSteps.rows.values()]).toMatchObject([
      { stepId: "account", status: "pending" },
      { stepId: "admin", status: "pending" },
    ]);
  });

  it("refreshes every independently expiring OAuth step and aggregates healthy state", async () => {
    const authSteps = new MemoryAuthSteps();
    const credentials = vault();
    const connections = lifecycleConnections(authSteps);

    const result = await refreshOimConnection(
      {
        authSteps,
        connections,
        credentials,
        refreshOAuth: async ({ step }) => ({
          credentialValues: {
            [`${step.id}_access`]: `new:${step.id}:access`,
            [`${step.id}_refresh`]: `new:${step.id}:refresh`,
          },
          expiresAt: "2026-09-12T13:00:00.000Z",
          verifiedIdentity: VERIFIED_IDENTITY,
        }),
        now: () => NOW,
      },
      manifest(),
      connection()
    );

    expect(result.steps).toEqual([
      { stepId: "account", status: "renewed" },
      { stepId: "admin", status: "renewed" },
    ]);
    expect([...credentials.values.values()]).toContain("new:account:access");
    expect([...credentials.values.values()]).toContain("new:admin:access");
    expect((await connections.findById()).health.status).toBe("healthy");
  });

  it("keeps the failed step id durable without clearing a healthy step", async () => {
    const authSteps = new MemoryAuthSteps();
    const credentials = vault();
    const connections = lifecycleConnections(authSteps);

    const result = await refreshOimConnection(
      {
        authSteps,
        connections,
        credentials,
        refreshOAuth: async ({ step }) => {
          if (step.id === "admin") throw new Error("provider rejected refresh");
          return {
            credentialValues: {
              account_access: "new-account",
              account_refresh: "new-account-refresh",
            },
            expiresAt: "2026-09-12T13:00:00.000Z",
            verifiedIdentity: VERIFIED_IDENTITY,
          };
        },
        now: () => NOW,
      },
      manifest(),
      connection()
    );

    expect(result).toEqual({
      connectionId: "connection-1",
      health: "action_required",
      steps: [
        { stepId: "account", status: "renewed" },
        { stepId: "admin", status: "action_required", error: "refresh_failed" },
      ],
    });
    expect(authSteps.rows.get("account")?.status).toBe("active");
    expect(authSteps.rows.get("admin")?.status).toBe("action_required");
    expect([...credentials.values.values()]).toContain("new-account");
    expect(credentials.values.get(connection().secretBindings.admin_access as string)).toContain(
      "old:"
    );
  });

  it("keeps aggregate health action-required when a declared OAuth step is missing", async () => {
    const authSteps = new MemoryAuthSteps();
    authSteps.rows.delete("admin");
    const connections = lifecycleConnections(authSteps);

    const result = await refreshOimConnection(
      {
        authSteps,
        connections,
        credentials: vault(),
        refreshOAuth: async ({ step }) => ({
          credentialValues: {
            [`${step.id}_access`]: `new:${step.id}`,
            [`${step.id}_refresh`]: `refresh:${step.id}`,
          },
          expiresAt: "2026-09-12T13:00:00.000Z",
          verifiedIdentity: VERIFIED_IDENTITY,
        }),
        now: () => NOW,
      },
      manifest(),
      connection()
    );

    expect(result.health).toBe("action_required");
    expect(result.steps[1]).toEqual({
      stepId: "admin",
      status: "action_required",
      error: "missing_step",
    });
  });

  it("fences concurrent refresh with the auth-step revision", async () => {
    const authSteps = new MemoryAuthSteps();
    const credentials = vault();
    const connections = lifecycleConnections(authSteps);
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = refreshOimConnection(
      {
        authSteps,
        connections,
        credentials,
        refreshOAuth: async ({ step }) => {
          if (step.id === "account") await blocked;
          return {
            credentialValues: {
              [`${step.id}_access`]: `new:${step.id}`,
              [`${step.id}_refresh`]: `refresh:${step.id}`,
            },
            expiresAt: "2026-09-12T13:00:00.000Z",
            verifiedIdentity: VERIFIED_IDENTITY,
          };
        },
        now: () => NOW,
      },
      manifest(),
      connection()
    );
    await Promise.resolve();
    const concurrentSteps: string[] = [];
    const second = await refreshOimConnection(
      {
        authSteps,
        connections,
        credentials,
        refreshOAuth: async ({ step }) => {
          concurrentSteps.push(step.id);
          return {
            credentialValues: {
              [`${step.id}_access`]: `concurrent:${step.id}`,
              [`${step.id}_refresh`]: `concurrent-refresh:${step.id}`,
            },
            expiresAt: "2026-09-12T13:00:00.000Z",
            verifiedIdentity: VERIFIED_IDENTITY,
          };
        },
        now: () => NOW,
      },
      manifest(),
      connection()
    );
    release?.();
    await first;

    expect(second.steps[0]).toEqual({ stepId: "account", status: "in_progress" });
    expect(second.steps[1]).toEqual({ stepId: "admin", status: "renewed" });
    expect(concurrentSteps).toEqual(["admin"]);
  });

  it("keeps current credentials unchanged when publication loses its fence", async () => {
    const authSteps = new MemoryAuthSteps();
    authSteps.rows.delete("admin");
    const credentials = vault();
    const connections = lifecycleConnections(authSteps);
    connections.publishAuthStep.mockResolvedValue(false);
    const oldReference = connection().secretBindings.account_access as string;
    const source = manifest();
    if (source.auth === undefined) throw new Error("expected auth");

    const result = await refreshOimConnection(
      {
        authSteps,
        connections,
        credentials,
        refreshOAuth: async () => ({
          credentialValues: { account_access: "stale-access" },
          expiresAt: "2026-09-12T13:00:00.000Z",
          verifiedIdentity: VERIFIED_IDENTITY,
        }),
        now: () => NOW,
      },
      {
        ...source,
        auth: {
          ...source.auth,
          steps: source.auth.steps.filter((step) => step.id === "account"),
        },
      },
      connection()
    );

    expect(result.steps).toEqual([
      { stepId: "account", status: "conflict", error: "revision_conflict" },
    ]);
    expect(credentials.values.get(oldReference)).toBe(`old:${oldReference}`);
    expect([...credentials.values.values()]).not.toContain("stale-access");
  });

  it("revokes a manifestless Connection repeatedly and never masks a storage failure", async () => {
    const row = connection();
    const credentials = vault();
    const authSteps = new MemoryAuthSteps();
    const connections = lifecycleConnections(authSteps, row);

    await expect(revokeOimConnection({ connections, credentials }, row)).resolves.toEqual({
      connectionId: row.id,
      status: "revoked",
    });
    await expect(
      revokeOimConnection({ connections, credentials }, { ...row, status: "revoked" })
    ).resolves.toEqual({ connectionId: row.id, status: "revoked" });

    const failure = new Error("delete failed");
    await expect(
      revokeOimConnection(
        {
          connections,
          credentials: { ...credentials, revokeConnection: async () => Promise.reject(failure) },
        },
        row
      )
    ).rejects.toBe(failure);

    await expect(
      revokeOimConnection(
        {
          connections: { fenceRevocation: async () => null },
          credentials,
        },
        row
      )
    ).rejects.toThrow("connection_revocation_not_persisted");
  });
});
