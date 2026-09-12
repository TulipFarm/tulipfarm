import { type OimConnection, validateOimManifest } from "@tulipfarm/schema";
import type { ConnectionAuthStep, PersistedConnection } from "@tulipfarm/storage";
import { describe, expect, it } from "vitest";
import { OimOperationConnectionResolver } from "./operation";
import { ConnectionResolver } from "./resolver";

const manifest = validateOimManifest({
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
      { id: "access", label: "Access", kind: "oauth2_access_token" },
      { id: "refresh", label: "Refresh", kind: "oauth2_refresh_token" },
    ],
    steps: [
      {
        id: "consent",
        title: "Authorize",
        type: "oauth2",
        authorizationUrl: "https://acme.test/authorize",
        tokenUrl: "https://acme.test/token",
        scopes: ["read"],
        clientId: { type: "credential", slot: "access" },
        bindings: [
          { sourcePath: "/access_token", target: { type: "credential", slot: "access" } },
          { sourcePath: "/refresh_token", target: { type: "credential", slot: "refresh" } },
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
      identityMode: "shared_or_personal",
      credentialSlot: "access",
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

function connection(): PersistedConnection {
  return {
    businessId: "business-1",
    id: "connection-1",
    integration: { id: "acme", majorVersion: 2 },
    label: "Acme",
    owner: { scope: "personal", principalKind: "user", principalId: "user-1" },
    status: "active",
    isDefault: true,
    configuration: {},
    agentVisibleConfiguration: [],
    secretBindings: {
      access: "secret://00000000-0000-4000-8000-000000000001",
      refresh: "secret://00000000-0000-4000-8000-000000000002",
    },
    health: { status: "healthy", checkedAt: "2026-09-12T00:00:00.000Z" },
    expiresAt: "2026-09-12T13:00:00.000Z",
    createdAt: new Date("2026-09-12T00:00:00.000Z"),
    updatedAt: new Date("2026-09-12T00:00:00.000Z"),
  };
}

function authStep(status: ConnectionAuthStep["status"]): ConnectionAuthStep {
  return {
    businessId: "business-1",
    connectionId: "connection-1",
    stepId: "consent",
    status,
    accessSlot: "access",
    accessSecretRef: "secret://00000000-0000-4000-8000-000000000001",
    refreshSlot: "refresh",
    refreshSecretRef: "secret://00000000-0000-4000-8000-000000000002",
    externalIdentity: null,
    expiresAt: "2026-09-12T13:00:00.000Z",
    healthCheckedAt: "2026-09-12T00:00:00.000Z",
    revision: 1,
    createdAt: "2026-09-12T00:00:00.000Z",
    updatedAt: "2026-09-12T00:00:00.000Z",
  };
}

function resolver(
  stepStatus: ConnectionAuthStep["status"],
  health: PersistedConnection["health"]["status"] = "healthy"
) {
  const row = { ...connection(), health: { ...connection().health, status: health } };
  const reader = {
    findById: async () => row,
    listForOwner: async (
      _businessId: string,
      _integration: OimConnection["integration"],
      owner: OimConnection["owner"]
    ) => (owner.scope === "personal" ? [row] : []),
    listForIntegration: async () => [row],
  };
  return new OimOperationConnectionResolver(
    new ConnectionResolver(reader, { canUse: async () => true }),
    { list: async () => [authStep(stepStatus)] },
    () => new Date("2026-09-12T12:00:00.000Z")
  );
}

describe("OimOperationConnectionResolver", () => {
  it("returns the exact selected identity and currently available slots without plaintext", async () => {
    const operation = manifest.operations[0];
    if (operation === undefined) throw new Error("expected operation");
    const result = await resolver("active").resolve({
      businessId: "business-1",
      manifest,
      operation,
      principal: { kind: "user", id: "user-1" },
      personalOwnerId: "user-1",
    });

    expect(result).toMatchObject({
      kind: "ready",
      connection: {
        id: "connection-1",
        integration: { id: "acme", majorVersion: 2 },
      },
      availableCredentialSlots: ["access", "refresh"],
      credentialRef: "secret://00000000-0000-4000-8000-000000000001",
    });
    expect(JSON.stringify(result)).not.toContain("plaintext");
  });

  it("fails closed when the OAuth step for the selected slot needs reauthorization", async () => {
    const operation = manifest.operations[0];
    if (operation === undefined) throw new Error("expected operation");

    await expect(
      resolver("action_required").resolve({
        businessId: "business-1",
        manifest,
        operation,
        principal: { kind: "user", id: "user-1" },
        personalOwnerId: "user-1",
      })
    ).resolves.toEqual({
      kind: "connection_unhealthy",
      connectionId: "connection-1",
      status: "action_required",
      stepId: "consent",
    });
  });

  it("does not lease credentials while aggregate Connection health is unknown", async () => {
    const operation = manifest.operations[0];
    if (operation === undefined) throw new Error("expected operation");

    await expect(
      resolver("active", "unknown").resolve({
        businessId: "business-1",
        manifest,
        operation,
        principal: { kind: "user", id: "user-1" },
        personalOwnerId: "user-1",
      })
    ).resolves.toMatchObject({
      kind: "connection_unhealthy",
      connectionId: "connection-1",
      status: "unknown",
    });
  });

  it("rejects a captured binding after health, expiry, step, ref, or lifecycle changes", async () => {
    const operation = manifest.operations[0];
    if (operation === undefined) throw new Error("expected operation");
    let row = connection();
    let step = authStep("active");
    const reader = {
      findById: async () => row,
      listForOwner: async () => [row],
      listForIntegration: async () => [row],
    };
    const operationResolver = new OimOperationConnectionResolver(
      new ConnectionResolver(reader, { canUse: async () => true }),
      { list: async () => [step] },
      () => new Date("2026-09-12T12:00:00.000Z")
    );
    const selected = await operationResolver.resolve({
      businessId: "business-1",
      manifest,
      operation,
      principal: { kind: "user", id: "user-1" },
      personalOwnerId: "user-1",
    });
    if (selected.kind !== "ready") throw new Error("expected ready Connection");

    for (const mutate of [
      () => {
        row = { ...row, health: { ...row.health, status: "action_required" } };
      },
      () => {
        row = { ...connection(), expiresAt: "2026-09-12T11:59:59.000Z" };
      },
      () => {
        row = connection();
        step = authStep("action_required");
      },
      () => {
        row = connection();
        step = { ...authStep("active"), expiresAt: "2026-09-12T11:59:59.000Z" };
      },
      () => {
        step = authStep("active");
        row = {
          ...connection(),
          secretBindings: {
            ...connection().secretBindings,
            access: "secret://00000000-0000-4000-8000-000000000009",
          },
        };
      },
      () => {
        row = { ...connection(), status: "revoked" };
      },
    ]) {
      mutate();
      await expect(
        operationResolver.reauthorize(
          "business-1",
          manifest,
          selected.binding,
          selected.credentialRef
        )
      ).resolves.toBe(false);
    }
  });
});
