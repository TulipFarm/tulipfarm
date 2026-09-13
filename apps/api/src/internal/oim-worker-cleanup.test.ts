import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import {
  ConnectionResolver,
  createOimFixturePaginationRuntime,
  type EgressHttpRequest,
} from "@tulipfarm/integrations";
import {
  canonicalHash,
  type OimConnection,
  type OimManifest,
  oimPackageDigest,
} from "@tulipfarm/schema";
import {
  type SecretDoc,
  type SecretEnvelopeFields,
  type SecretMeta,
  type SecretRepo,
  SecretsService,
  secretStorageKey,
} from "@tulipfarm/secrets";
import type { SoulIntegration } from "@tulipfarm/soul";
import {
  ConnectionAuthStepStore,
  ConnectionStore,
  ConnectionVerificationEvidenceStore,
  IngressTeardownStore,
  transactionPort,
  WebhookRegistrationStore,
} from "@tulipfarm/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CatalogBoundOimOperationConnectionResolver } from "../integrations/catalog-bound-oim-operation-resolver";
import { createOimAvailableConnectionReader } from "../integrations/oim-connection-reader";
import { makeMigratedPglite } from "../test/pglite";
import { captureOimWebhookCleanupPackage } from "./oim-webhook-cleanup-package";
import { createOimWorkerCleanupServices } from "./oim-worker-cleanup";
import { InternalOimWorkerHost } from "./oim-worker-host";

const BUSINESS_ID = "business-1";
const CONNECTION_ID = "connection-1";
const NOW = new Date("2026-09-13T18:00:00.000Z");
const accessRef = "secret://00000000-0000-4000-8000-000000000001" as const;

const manifest: OimManifest = {
  oimVersion: "1.0",
  kind: "Integration",
  metadata: {
    id: "acme",
    name: "Acme",
    version: "1.0.0",
    description: "Acme webhooks.",
    license: "Apache-2.0",
  },
  profiles: { core: "1.0", auth: "1.0", events: "1.0" },
  operations: [
    {
      id: "list-events",
      name: "acme_list_events",
      description: "List events.",
      effect: "read",
      identityMode: "shared_only",
      credentialSlot: "access",
      credentialInjection: {
        in: "header",
        name: "Authorization",
        format: "Bearer {token}",
      },
      source: {
        type: "http",
        method: "GET",
        baseUrl: "https://api.acme.example",
        path: "/events",
      },
      response: { schema: { type: "object" }, maxBytes: 4096 },
    },
    {
      id: "register-hook",
      name: "acme_register_hook",
      description: "Register a webhook.",
      effect: "create",
      identityMode: "shared_only",
      source: {
        type: "http",
        method: "POST",
        baseUrl: "https://api.acme.example",
        path: "/webhooks",
      },
      response: { schema: { type: "object" }, maxBytes: 4096 },
    },
    {
      id: "remove-hook",
      name: "acme_remove_hook",
      description: "Remove a webhook.",
      effect: "delete",
      identityMode: "shared_only",
      credentialSlot: "access",
      credentialInjection: {
        in: "header",
        name: "Authorization",
        format: "Bearer {token}",
      },
      source: {
        type: "http",
        method: "DELETE",
        baseUrl: "https://api.acme.example",
        path: "/webhooks/{subscriptionId}",
        parameters: [{ name: "subscriptionId", in: "path", schema: { type: "string" } }],
      },
      requestSchema: {
        type: "object",
        properties: { subscriptionId: { type: "string" } },
        required: ["subscriptionId"],
      },
      response: { schema: { type: "object" }, maxBytes: 4096 },
    },
  ],
  auth: {
    credentialSlots: [
      { id: "access", label: "Access token", kind: "api_key" },
      { id: "webhook_secret", label: "Webhook secret", kind: "webhook_secret" },
    ],
    steps: [
      {
        id: "webhook",
        title: "Register webhook",
        type: "webhook",
        operationId: "register-hook",
        unregisterOperationId: "remove-hook",
        subscriptionIdPath: "/id",
        secretSlot: "webhook_secret",
        registration: { callbackUrl: { in: "body", pointer: "/callback" } },
        unregistration: { subscriptionId: { in: "parameter", name: "subscriptionId" } },
      },
    ],
  },
  ingress: {
    kind: "polling",
    operationId: "list-events",
    intervalSeconds: 60,
    eventTypes: [
      {
        type: "ticket.created",
        selector: { pointer: "/type", equals: "ticket_created" },
        schema: { type: "object" },
      },
    ],
    cursor: {
      mode: "max_integer_plus_one",
      responsePointer: "/items",
      itemPointer: "/id",
      requestParameter: "after",
    },
  },
  events: {
    path: "/events",
    verification: {
      scheme: "hmac_sha256",
      secretSlot: "webhook_secret",
      signatureHeader: "x-acme-signature",
    },
    deduplication: { kind: "none" },
    eventTypes: [
      {
        type: "ticket.created",
        selector: { pointer: "/type", equals: "ticket_created" },
        schema: { type: "object" },
      },
    ],
  },
};

class MemorySecretRepo implements SecretRepo {
  private readonly values = new Map<string, SecretDoc>();

  async list(): Promise<SecretMeta[]> {
    return [...this.values.values()];
  }

  async findByKey(key: string) {
    return this.values.get(key) ?? null;
  }

  async upsert(key: string, fields: SecretEnvelopeFields) {
    const now = new Date();
    this.values.set(key, {
      _id: key,
      key,
      ...fields,
      dekId: fields.dekId ?? null,
      createdAt: now,
      updatedAt: now,
    });
  }

  async delete(key: string) {
    this.values.delete(key);
  }

  async listLegacyKeys() {
    return [];
  }

  async findRevision(key: string) {
    return this.values.get(key)?.updatedAt ?? null;
  }
}

function webhookSecretReference(generation: number): `secret://${string}` {
  const attemptId = `${BUSINESS_ID}:${CONNECTION_ID}:register:${generation}`;
  const digest = createHash("sha256")
    .update("tulipfarm-oim-webhook-attempt-v1\0")
    .update(attemptId)
    .digest("hex");
  const variant = (Number.parseInt(digest.slice(16, 17), 16) & 0x3) | 0x8;
  return `secret://${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(
    13,
    16
  )}-${variant.toString(16)}${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

describe("createOimWorkerCleanupServices", () => {
  let database: PGlite;

  beforeEach(async () => {
    database = await makeMigratedPglite();
  });

  afterEach(async () => {
    await database.close();
  });

  it("uses raw persisted authority to clean the sealed target after teardown and catalog removal", async () => {
    const transactions = transactionPort(database);
    const connections = new ConnectionStore(transactions);
    const authSteps = new ConnectionAuthStepStore(transactions);
    const teardowns = new IngressTeardownStore(transactions);
    const registrations = new WebhookRegistrationStore(transactions);
    const verificationEvidence = new ConnectionVerificationEvidenceStore(transactions);
    const integration: SoulIntegration = {
      slug: "acme",
      sourceIntegration: "acme",
      oimManifest: manifest,
    };
    const active = new Map([["acme", integration] as const]);
    const services = createOimWorkerCleanupServices({
      database,
      connections,
      authSteps,
      verifiedIntegrations: () => active.entries(),
    });
    const catalog = () =>
      [...active].map(([key, value]) => ({
        key,
        manifest: value.oimManifest as OimManifest,
        packageDigest: oimPackageDigest(value.oimManifest as OimManifest),
      }));
    const available = createOimAvailableConnectionReader(
      connections,
      teardowns,
      catalog,
      verificationEvidence
    );
    const normalOperations = new CatalogBoundOimOperationConnectionResolver(
      new ConnectionResolver(available, {
        async canUse(principal) {
          return principal.kind === "service" && principal.id === "integration-worker";
        },
      }),
      authSteps,
      catalog,
      () => NOW
    );
    const secrets = new SecretsService(new MemorySecretRepo(), {
      dekId: randomUUID(),
      key: randomBytes(32),
    });
    await secrets.set(secretStorageKey(accessRef), "provider-access-token");
    const connection: OimConnection = {
      id: CONNECTION_ID,
      integration: { id: "acme", majorVersion: 1 },
      label: "Acme",
      owner: { scope: "organization" },
      status: "active",
      isDefault: true,
      configuration: {},
      agentVisibleConfiguration: [],
      secretBindings: { access: accessRef },
      health: { status: "healthy", checkedAt: NOW.toISOString() },
      expiresAt: null,
    };
    await connections.put(BUSINESS_ID, connection);
    await authSteps.put({
      businessId: BUSINESS_ID,
      connectionId: CONNECTION_ID,
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

    const package_ = await services.registrationPackages.packageFor("acme");
    if (package_ === null) throw new Error("missing package");
    const target = {
      integrationKey: "acme",
      manifestDigest: canonicalHash(manifest),
      stepId: "webhook",
      callbackUrl: "https://api.example.test/hooks/acme/connection-1",
      operationId: "register-hook",
      unregisterOperationId: "remove-hook",
      secretSlot: "webhook_secret",
      packageSnapshot: captureOimWebhookCleanupPackage(package_),
    };
    const key = {
      businessId: BUSINESS_ID,
      connectionId: CONNECTION_ID,
      integrationId: "acme",
      integrationMajorVersion: 1,
    };
    await registrations.requestRegistration(key, target, NOW);
    const registrationClaim = await registrations.claim(key, "register-lease", 120, NOW);
    if (registrationClaim === null) throw new Error("registration not claimed");
    const webhookSecretRef = webhookSecretReference(registrationClaim.generation);
    await registrations.stageSecret(key, "register-lease", webhookSecretRef);
    await registrations.recordDispatchedAttempt(registrationClaim, {
      attemptId: "registration-attempt",
      idempotencyKey: "registration-attempt",
      secretRef: webhookSecretRef,
      now: NOW,
    });
    const verifiedIdentity = {
      ...key,
      externalTenantId: "tenant-1",
      externalAccountId: "account-1",
      proofKind: "auth" as const,
      proofDigest: "a".repeat(64),
      verifiedAt: NOW.toISOString(),
      verifiedBy: "acme-account-api",
    };
    await registrations.recordAttemptSuccess("registration-attempt", {
      subscriptionId: "subscription-1",
      verifiedIdentity,
      now: NOW,
    });
    await expect(
      registrations.completeRegistration(registrationClaim, {
        attemptId: "registration-attempt",
        subscriptionId: "subscription-1",
        secretRef: webhookSecretRef,
        verifiedIdentity,
        now: NOW,
      })
    ).resolves.toMatchObject({ kind: "active" });
    await connections.updateHealth(
      BUSINESS_ID,
      CONNECTION_ID,
      { status: "healthy", checkedAt: NOW.toISOString() },
      null
    );
    await teardowns.disable(key, NOW);
    await registrations.requestRemoval(key, NOW);
    const removal = await registrations.claim(key, "remove-lease", 120, NOW);
    if (removal?.active === null || removal?.action !== "remove") {
      throw new Error("removal not claimed");
    }

    const requests: EgressHttpRequest[] = [];
    const removeOperation = manifest.operations.find(({ id }) => id === "remove-hook");
    if (removeOperation === undefined) throw new Error("remove operation missing");
    const cleanupResolution = await services.cleanupConnectionOperations.resolve({
      businessId: BUSINESS_ID,
      manifest,
      operation: removeOperation,
      principal: { kind: "service", id: "integration-worker" },
      connectionId: CONNECTION_ID,
      requireExplicitConnection: true,
    });
    if (cleanupResolution.kind !== "ready") {
      throw new Error(JSON.stringify(cleanupResolution));
    }
    await expect(
      services.cleanupConnectionOperations.resolve({
        businessId: BUSINESS_ID,
        manifest,
        operation: removeOperation,
        principal: { kind: "user", id: "user-1" },
        connectionId: CONNECTION_ID,
        requireExplicitConnection: true,
      })
    ).resolves.toMatchObject({ kind: "connection_denied" });
    const host = new InternalOimWorkerHost({
      releaseDispatch: {
        async dispatch(_input, run) {
          return run((operation) => operation());
        },
      },
      integrations: () => active.entries(),
      connections: {
        findById: (...args) => available.findById(...args),
        listForOwner: (...args) => available.listForOwner(...args),
        listForIntegration: (...args) => available.listForIntegration(...args),
        listPollingFallbacks: () => connections.listPollingFallbacks(),
      },
      connectionOperations: normalOperations,
      ...services,
      verificationEvidence,
      secrets,
      http: {
        async send(request) {
          requests.push(request);
          return { status: 200, headers: {}, body: {} };
        },
      },
      paginationRuntime: createOimFixturePaginationRuntime(),
      payloadKey: Buffer.alloc(32, 7),
      knowledgeRegistrations: {
        async list() {
          return [];
        },
      },
      externalIdentities: {
        async findMapping() {
          return null;
        },
      },
      now: () => NOW,
    });

    await expect(
      host.executePollingOperation({
        businessId: BUSINESS_ID,
        connectionId: CONNECTION_ID,
        integrationId: "acme",
        integrationMajorVersion: 1,
        operationId: "list-events",
        expectedManifestDigest: canonicalHash(manifest),
        cursor: null,
        leaseToken: "poll-lease",
        purpose: "ingress_poll",
      })
    ).rejects.toMatchObject({ code: "oim_connection_not_found" });

    active.clear();
    await expect(services.registrationPackages.packageFor("acme")).resolves.toBeNull();
    await expect(
      host.unregisterWebhook({
        key,
        target: removal.target,
        registration: removal.active,
        idempotencyKey: `${BUSINESS_ID}:${CONNECTION_ID}:remove:subscription-1`,
      })
    ).resolves.toBeUndefined();
    expect(requests).toEqual([
      expect.objectContaining({
        method: "DELETE",
        url: "https://api.acme.example/webhooks/subscription-1",
      }),
    ]);
  });
});
