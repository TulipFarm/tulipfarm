import { createHash } from "node:crypto";
import {
  createOimFixturePaginationRuntime,
  type EgressHttpRequest,
  type OimOperationConnectionResolver,
} from "@tulipfarm/integrations";
import {
  canonicalHash,
  type OimConnectionVerificationEvidence,
  type OimManifest,
  oimPackageIssues,
} from "@tulipfarm/schema";
import type { SecretsService } from "@tulipfarm/secrets";
import type { SoulIntegration } from "@tulipfarm/soul";
import type { PersistedConnection } from "@tulipfarm/storage";
import { AdapterDispatchError } from "@tulipfarm/tool-broker";
import { describe, expect, it, vi } from "vitest";
import type { ExternalIdentityMappingDoc, ExternalIdentityRepo } from "../identity/external-links";
import type { OimReleaseDispatchPort } from "../integrations/releases/dispatch-host";
import {
  captureOimWebhookCleanupPackage,
  loadOimWebhookCleanupPackage,
} from "./oim-webhook-cleanup-package";
import { InternalOimWorkerHost } from "./oim-worker-host";

vi.mock("@tulipfarm/soul", () => ({
  isPersonalCredentialStep: () => false,
  resolveAuthSteps: () => [],
}));

const manifest: OimManifest = {
  oimVersion: "1.0",
  kind: "Integration",
  metadata: {
    id: "acme",
    name: "Acme",
    version: "1.0.0",
    description: "Poll Acme events.",
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
      source: {
        type: "http",
        method: "GET",
        baseUrl: "https://api.acme.example",
        path: "/events",
        parameters: [{ name: "after", in: "query", schema: { type: "integer" } }],
      },
      response: { schema: { type: "object" }, maxBytes: 16_384 },
    },
    {
      id: "register-hook",
      name: "acme_register_hook",
      description: "Register an Acme webhook.",
      effect: "create",
      identityMode: "shared_only",
      credentialSlot: "access",
      credentialInjection: { in: "header", name: "Authorization", format: "Bearer {token}" },
      source: {
        type: "http",
        method: "POST",
        baseUrl: "https://api.acme.example",
        path: "/webhooks",
      },
      requestSchema: {
        type: "object",
        properties: { callback: { type: "string" } },
        required: ["callback"],
      },
      response: { schema: { type: "object" }, maxBytes: 16_384 },
    },
    {
      id: "remove-hook",
      name: "acme_remove_hook",
      description: "Remove an Acme webhook.",
      effect: "delete",
      identityMode: "shared_only",
      credentialSlot: "access",
      credentialInjection: { in: "header", name: "Authorization", format: "Bearer {token}" },
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
      response: { schema: { type: "object" }, maxBytes: 16_384 },
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

const connection: PersistedConnection = {
  businessId: "business-1",
  id: "connection-1",
  integration: { id: "acme", majorVersion: 1 },
  label: "Acme",
  owner: { scope: "organization" },
  status: "active",
  isDefault: true,
  configuration: {},
  agentVisibleConfiguration: [],
  secretBindings: {
    access: "secret://00000000-0000-4000-8000-000000000001",
  },
  health: { status: "healthy", checkedAt: "2026-09-12T00:00:00.000Z" },
  expiresAt: null,
  createdAt: new Date("2026-09-12T00:00:00.000Z"),
  updatedAt: new Date("2026-09-12T00:00:00.000Z"),
};

function memorySecrets() {
  const values = new Map<string, string>();
  return {
    service: {
      async get(key: string) {
        const value = values.get(key);
        if (value === undefined) throw new Error("missing");
        return value;
      },
      async resolveCurrent(key: string) {
        const value = values.get(key);
        if (value === undefined) throw new Error("missing");
        return { value, version: "1" };
      },
      async revision(key: string) {
        return values.has(key) ? "1" : null;
      },
      async set(key: string, value: string) {
        values.set(key, value);
      },
      async delete(key: string) {
        values.delete(key);
      },
    } as unknown as SecretsService,
    values,
  };
}

function host(
  overrides: {
    readonly send?: (request: EgressHttpRequest) => Promise<{
      readonly status: number;
      readonly headers: Readonly<Record<string, string>>;
      readonly body: unknown;
    }>;
    readonly findMapping?: ExternalIdentityRepo["findMapping"];
    readonly normalResolution?: Awaited<ReturnType<OimOperationConnectionResolver["resolve"]>>;
    readonly cleanupGeneration?: number | null;
    readonly activeIntegration?: SoulIntegration;
    readonly releaseDispatch?: OimReleaseDispatchPort;
  } = {}
) {
  const secrets = memorySecrets();
  const integration: SoulIntegration = {
    slug: "acme",
    sourceIntegration: "acme",
    oimManifest: manifest,
  };
  const send =
    overrides.send ??
    vi.fn(async () => ({
      status: 200,
      headers: {},
      body: { items: [{ id: 8, type: "ticket_created" }] },
    }));
  secrets.values.set("00000000-0000-4000-8000-000000000001", "provider-access-token");
  const cleanupBinding = {
    connectionId: connection.id,
    integrationId: "acme",
    integrationMajorVersion: 1,
    operationId: "remove-hook",
    credentialSlot: "access",
    identityMode: "shared_only" as const,
    principalKind: "service",
    principalId: "integration-worker",
    manifestDigest: canonicalHash(manifest),
    configurationDigest: canonicalHash(connection.configuration),
  };
  const cleanupResolution = {
    kind: "ready" as const,
    connection,
    availableCredentialSlots: ["access"],
    credentialRef: connection.secretBindings.access,
    binding: cleanupBinding,
  };
  const activeManifest = overrides.activeIntegration?.oimManifest ?? manifest;
  const evidence: OimConnectionVerificationEvidence = {
    issuer: "https://api.acme.example",
    binding: {
      businessId: connection.businessId,
      connectionId: connection.id,
      integrationId: connection.integration.id,
      integrationMajorVersion: connection.integration.majorVersion,
      packageDigest: canonicalHash(activeManifest),
      configurationDigest: canonicalHash(connection.configuration),
      authSteps: [
        {
          stepId: "access",
          revision: 1,
          credentials: [{ slot: "access", referenceDigest: "b".repeat(64) }],
        },
      ],
    },
    proofDigest: "a".repeat(64),
    verifiedAt: "2026-09-12T00:00:00.000Z",
    verifiedBy: "oim-auth-1.1",
    assurance: "identified",
    subject: {
      id: "account-1",
      kind: "account",
      namespace: "https://api.acme.example",
    },
    tenant: { id: "tenant-1", kind: "organization" },
  };
  const mapping: ExternalIdentityMappingDoc = {
    provider: "acme",
    externalSubject: "provider-user-1",
    externalTenantId: "tenant-1",
    userId: "user-1",
    verifiedAt: new Date("2026-09-12T00:00:00.000Z"),
    expiresAt: null,
    verifiedVia: "bind_link",
  };
  return {
    secrets,
    send,
    host: new InternalOimWorkerHost({
      integrations: () => new Map([["acme", overrides.activeIntegration ?? integration]]).entries(),
      releaseDispatch: overrides.releaseDispatch ?? {
        async dispatch(_input, run) {
          return run((operation) => operation());
        },
      },
      connections: {
        findById: vi.fn(async (businessId, connectionId) =>
          businessId === connection.businessId && connectionId === connection.id ? connection : null
        ),
        listForOwner: vi.fn(async () => [connection]),
        listForIntegration: vi.fn(async () => [connection]),
        listPollingFallbacks: vi.fn(async () => [connection]),
      },
      connectionOperations: {
        resolve: vi.fn(async () => overrides.normalResolution ?? { kind: "public" as const }),
        reauthorizeConnection: vi.fn(async () => connection),
      } as unknown as OimOperationConnectionResolver,
      cleanupConnectionOperations: {
        resolve: vi.fn(async () => cleanupResolution),
        reauthorizeConnection: vi.fn(async () => connection),
      } as unknown as OimOperationConnectionResolver,
      cleanupAuthorization: {
        authorize: vi.fn(async () =>
          overrides.cleanupGeneration === null
            ? null
            : { generation: overrides.cleanupGeneration ?? 1 }
        ),
      },
      verificationEvidence: {
        findCurrentForConnection: vi.fn(async () => evidence),
      },
      secrets: secrets.service,
      http: { send },
      paginationRuntime: createOimFixturePaginationRuntime(),
      payloadKey: Buffer.alloc(32, 7),
      hookExecutor: { runPureHook: vi.fn(async () => undefined) },
      knowledgeRegistrations: { list: vi.fn(async () => []) },
      externalIdentities: {
        findMapping: overrides.findMapping ?? vi.fn(async () => mapping),
      },
      now: () => new Date("2026-09-12T00:00:00.000Z"),
    }),
  };
}

function webhookReferenceForGeneration(generation: number): `secret://${string}` {
  const attemptId = `business-1:connection-1:register:${generation}`;
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

function unregisterInput() {
  const target = {
    integrationKey: "acme",
    manifestDigest: canonicalHash(manifest),
    stepId: "webhook",
    callbackUrl: "https://api.example.test/hooks/acme/connection-1",
    operationId: "register-hook",
    unregisterOperationId: "remove-hook",
    secretSlot: "webhook_secret",
    packageSnapshot: captureOimWebhookCleanupPackage({ manifest, files: new Map() }),
  };
  return {
    key: {
      businessId: "business-1",
      connectionId: "connection-1",
      integrationId: "acme",
      integrationMajorVersion: 1,
    },
    target,
    registration: {
      ...target,
      subscriptionId: "subscription-1",
      secretRef: webhookReferenceForGeneration(1),
    },
    idempotencyKey: "business-1:connection-1:remove:subscription-1",
  } as const;
}

describe("InternalOimWorkerHost", () => {
  it("rejects an existing unsupported socket declaration rather than silently omitting it", async () => {
    const fixture = host({
      activeIntegration: {
        slug: "acme",
        sourceIntegration: "acme",
        oimManifest: {
          ...manifest,
          ingress: {
            kind: "websocket",
            operationId: "list-events",
            urlPointer: "/url",
            eventTypes: [
              {
                type: "ticket.created",
                selector: { pointer: "/type", equals: "ticket_created" },
                schema: { type: "object" },
              },
            ],
            deduplication: { kind: "body_pointer", bodyPointer: "/id" },
            reconnect: { maxAttempts: 3, initialDelaySeconds: 1, maxDelaySeconds: 8 },
          },
        },
      },
    });
    await expect(fixture.host.listPollingRegistrations()).rejects.toMatchObject({
      statusCode: 409,
      code: "oim_websocket_ingress_unsupported",
    });
    expect(fixture.send).not.toHaveBeenCalled();
  });
  it("executes polling only through the exact Connection and returns bound evidence", async () => {
    const fixture = host();

    const result = await fixture.host.executePollingOperation({
      businessId: "business-1",
      connectionId: "connection-1",
      integrationId: "acme",
      integrationMajorVersion: 1,
      operationId: "list-events",
      expectedManifestDigest: canonicalHash(manifest),
      cursor: 7,
      leaseToken: "lease-1",
      purpose: "ingress_poll",
    });

    expect(result).toMatchObject({
      response: { items: [{ id: 8, type: "ticket_created" }] },
      authenticatedEvidenceDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      verifiedIdentity: {
        externalTenantId: "tenant-1",
        externalAccountId: "account-1",
      },
    });
    expect(fixture.send).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://api.acme.example/events?after=7" })
    );
  });

  it("keeps a mutating after-dispatch timeout under reconciliation", async () => {
    const mutatingManifest: OimManifest = {
      ...manifest,
      operations: manifest.operations.map((operation) =>
        operation.id === "list-events" ? { ...operation, effect: "send" as const } : operation
      ),
    };
    let settlement: string | undefined;
    const fixture = host({
      activeIntegration: {
        slug: "acme",
        sourceIntegration: "acme",
        oimManifest: mutatingManifest,
      },
      send: async () => {
        throw new AdapterDispatchError("after_dispatch", "timeout", true);
      },
      releaseDispatch: {
        async dispatch(_input, run, readSettlement) {
          try {
            return await run((operation) => operation());
          } finally {
            settlement = await readSettlement();
          }
        },
      },
    });

    await expect(
      fixture.host.executePollingOperation({
        businessId: "business-1",
        connectionId: "connection-1",
        integrationId: "acme",
        integrationMajorVersion: 1,
        operationId: "list-events",
        expectedManifestDigest: canonicalHash(mutatingManifest),
        cursor: null,
        leaseToken: "lease-1",
        purpose: "ingress_poll",
      })
    ).rejects.toThrow("transport_error");
    expect(settlement).toBe("ambiguous");
  });

  it("blocks ordinary work during teardown but permits the exact sealed unregister target", async () => {
    expect(oimPackageIssues(manifest, new Map())).toEqual([]);
    const input = unregisterInput();
    expect(() =>
      loadOimWebhookCleanupPackage(input.target.integrationKey, input.target.packageSnapshot)
    ).not.toThrow();
    const releaseDispatch: OimReleaseDispatchPort = {
      async dispatch() {
        throw new Error("oim_release_uninstall_pending");
      },
    };
    const fixture = host({
      releaseDispatch,
    });

    await expect(
      fixture.host.executePollingOperation({
        businessId: "business-1",
        connectionId: "connection-1",
        integrationId: "acme",
        integrationMajorVersion: 1,
        operationId: "list-events",
        expectedManifestDigest: canonicalHash(manifest),
        cursor: null,
        leaseToken: "lease-1",
        purpose: "ingress_poll",
      })
    ).rejects.toThrow("oim_release_uninstall_pending");

    await expect(fixture.host.unregisterWebhook(input)).resolves.toBeUndefined();
    expect(fixture.send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        method: "DELETE",
        url: "https://api.acme.example/webhooks/subscription-1",
      })
    );
  });

  it("denies changed cleanup operation, package, or registration generation", async () => {
    const operation = unregisterInput();
    await expect(
      host().host.unregisterWebhook({
        ...operation,
        target: { ...operation.target, unregisterOperationId: "other-operation" },
      })
    ).rejects.toMatchObject({ code: "oim_webhook_target_mismatch" });

    const changedManifest: OimManifest = {
      ...manifest,
      metadata: { ...manifest.metadata, version: "1.0.1" },
    };
    await expect(
      host({
        activeIntegration: {
          slug: "acme",
          sourceIntegration: "acme",
          oimManifest: changedManifest,
        },
      }).host.unregisterWebhook(operation)
    ).resolves.toBeUndefined();

    await expect(
      host().host.unregisterWebhook({
        ...operation,
        target: {
          ...operation.target,
          packageSnapshot: {
            ...operation.target.packageSnapshot,
            manifestText: operation.target.packageSnapshot.manifestText.replace(
              "Poll Acme events.",
              "Tampered"
            ),
          },
        },
      })
    ).rejects.toMatchObject({ code: "oim_webhook_cleanup_package_mismatch" });

    await expect(
      host({ cleanupGeneration: 2 }).host.unregisterWebhook(operation)
    ).rejects.toMatchObject({ code: "oim_webhook_cleanup_not_authorized" });
  });

  it("encrypts payloads with authenticated encryption and rejects tampering", async () => {
    const fixture = host();
    const encrypted = await fixture.host.encryptPayload(Buffer.from("payload"));

    await expect(fixture.host.decryptPayload(encrypted)).resolves.toEqual(Buffer.from("payload"));
    await expect(fixture.host.decryptPayload(`${encrypted}x`)).rejects.toMatchObject({
      code: "oim_payload_invalid",
    });
  });

  it("stages deterministic Secret handles while returning only an opaque use token", async () => {
    const fixture = host();
    const staged = await fixture.host.stageWebhookCredential({
      attemptId: "attempt-1",
      integrationId: "acme",
      credentialSlot: "webhook_secret",
      existingRef: null,
    });
    const token = await staged.use((value) => value);

    expect(staged.ref).toMatch(
      /^secret:\/\/[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    const plaintext = [...fixture.secrets.values.values()][0];
    expect(plaintext).toBeDefined();
    expect(token).not.toContain(plaintext as string);
    expect(fixture.secrets.values.has(staged.ref.slice("secret://".length))).toBe(true);

    await fixture.host.revokeWebhookCredentialAttempt("attempt-1");
    expect(fixture.secrets.values.size).toBe(1);
    expect(fixture.secrets.values.has("00000000-0000-4000-8000-000000000001")).toBe(true);
  });

  it("resolves only proven same-tenant provider users and marks gaps incomplete", async () => {
    const fixture = host();

    await expect(
      fixture.host.resolveKnowledgeIdentities(
        {
          businessId: "business-1",
          connectionId: "connection-1",
          integrationId: "acme",
          integrationMajorVersion: 1,
          externalTenantId: "tenant-1",
          externalAccountId: "account-1",
        },
        [
          { kind: "user", id: "provider-user-1" },
          { kind: "group", id: "group-1" },
          { kind: "public" },
        ]
      )
    ).resolves.toEqual({
      principals: [
        { kind: "user", id: "user-1" },
        { kind: "role", id: "role-everyone" },
      ],
      incomplete: true,
    });
  });
});
