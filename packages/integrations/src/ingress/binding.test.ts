import type { OimManifest } from "@tulipfarm/schema";
import type {
  PersistedConnection,
  PersistedWebhookRegistration,
  VerifiedConnectionExternalIdentity,
} from "@tulipfarm/storage";
import { describe, expect, it } from "vitest";
import { resolveWebhookIngressBinding, type WebhookIngressBindingDeps } from "./binding";
import { planWebhookRegistration } from "./registration";

const manifest = {
  metadata: { id: "acme", version: "2.0.0" },
  auth: {
    credentialSlots: [{ id: "webhook_secret" }],
    steps: [
      {
        id: "webhook",
        type: "webhook",
        operationId: "register_hook",
        unregisterOperationId: "remove_hook",
        subscriptionIdPath: "/id",
        secretSlot: "webhook_secret",
        registration: { callbackUrl: { in: "body", pointer: "/callback" } },
        unregistration: { subscriptionId: { in: "body", pointer: "/id" } },
      },
    ],
  },
  operations: [],
  events: {
    path: "/events",
    verification: { scheme: "hmac_sha256", secretSlot: "webhook_secret" },
    deduplication: { kind: "none" },
    eventTypes: [],
  },
} as unknown as OimManifest;

const { key, target } = planWebhookRegistration({
  businessId: "business-1",
  integrationKey: "acme-v2",
  connectionId: "connection-1",
  manifest,
  publicApiUrl: "https://api.example.test",
});

function connection(overrides: Partial<PersistedConnection> = {}): PersistedConnection {
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
    secretBindings: { webhook_secret: "secret://webhook-1" },
    health: { status: "healthy", checkedAt: null },
    expiresAt: null,
    webhookRegistration: {
      ingressUrl: target.callbackUrl,
      subscriptionId: "sub-1",
      operationId: target.operationId,
      unregisterOperationId: target.unregisterOperationId,
      secretSlot: target.secretSlot,
    },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function registration(
  overrides: Partial<PersistedWebhookRegistration> = {}
): PersistedWebhookRegistration {
  return {
    ...key,
    desiredState: "active",
    state: "active",
    target,
    active: {
      ...target,
      subscriptionId: "sub-1",
      secretRef: "secret://webhook-1",
    },
    stagedSecretRef: null,
    attempts: 1,
    nextAttemptAt: new Date(),
    leaseToken: null,
    leaseExpiresAt: null,
    lastError: null,
    generation: 1,
    revision: 4,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function identity(): VerifiedConnectionExternalIdentity {
  return {
    ...key,
    externalTenantId: "tenant-1",
    externalAccountId: "account-1",
    proofKind: "auth",
    proofDigest: "a".repeat(64),
    verifiedAt: new Date().toISOString(),
    verifiedBy: "provider",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function deps(
  connectionRow: PersistedConnection | null = connection(),
  registrationRow: PersistedWebhookRegistration | null = registration(),
  identityRow: VerifiedConnectionExternalIdentity | null = identity()
): WebhookIngressBindingDeps {
  return {
    businessId: "business-1",
    packageFor: async (integrationKey) => (integrationKey === "acme-v2" ? { manifest } : null),
    connections: { findById: async () => connectionRow },
    registrations: { findActive: async () => registrationRow },
    identities: { find: async () => identityRow },
  };
}

describe("resolveWebhookIngressBinding", () => {
  it("resolves only the exact catalog key, major, Connection, Secret, and identity", async () => {
    await expect(
      resolveWebhookIngressBinding(
        { integrationKey: "acme-v2", connectionId: "connection-1" },
        deps()
      )
    ).resolves.toMatchObject({
      businessId: "business-1",
      integrationKey: "acme-v2",
      integrationId: "acme",
      integrationMajorVersion: 2,
      connectionId: "connection-1",
      registrationRevision: 4,
      secretRef: "secret://webhook-1",
      verifiedIdentity: {
        externalTenantId: "tenant-1",
        externalAccountId: "account-1",
      },
    });
  });

  it.each([
    [connection({ status: "revoked" }), registration(), identity()],
    [
      connection({ health: { status: "action_required", checkedAt: null } }),
      registration(),
      identity(),
    ],
    [connection({ expiresAt: "2020-01-01T00:00:00.000Z" }), registration(), identity()],
    [
      connection({
        secretBindings: { webhook_secret: "secret://rotated" },
      }),
      registration(),
      identity(),
    ],
    [connection(), registration({ desiredState: "removed", state: "pending_removal" }), identity()],
    [connection(), registration(), null],
  ])(
    "fails closed when lifecycle, health, Secret, or identity no longer matches",
    async (c, r, i) => {
      await expect(
        resolveWebhookIngressBinding(
          { integrationKey: "acme-v2", connectionId: "connection-1" },
          deps(c, r, i)
        )
      ).resolves.toBeNull();
    }
  );

  it("does not fall back from a wrong authoritative catalog key", async () => {
    await expect(
      resolveWebhookIngressBinding(
        { integrationKey: "acme-v3", connectionId: "connection-1" },
        deps()
      )
    ).resolves.toBeNull();
  });
});
