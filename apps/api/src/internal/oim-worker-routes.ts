import type {
  OimKnowledgeSyncOptions,
  ProviderAclEntry,
  VerifiedProviderIdentity,
  WebhookRegistrationCredentialPort,
  WebhookRegistrationProvider,
} from "@tulipfarm/integrations";
import { canonicalHash, type OimManifest } from "@tulipfarm/schema";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface InternalOimPollingRegistration {
  readonly businessId: string;
  readonly connectionId: string;
  readonly integrationId: string;
  readonly integrationMajorVersion: number;
}

export interface InternalOimKnowledgeRegistration {
  readonly id: string;
  readonly manifest: OimManifest;
  readonly manifestDigest: string;
  readonly options: OimKnowledgeSyncOptions;
  readonly verifiedIdentity: VerifiedProviderIdentity;
}

export interface InternalOimWorkerRouteDeps {
  listPollingRegistrations(): Promise<readonly InternalOimPollingRegistration[]>;
  resolveConnectionManifest(input: {
    readonly businessId: string;
    readonly connectionId: string;
    readonly integrationId: string;
    readonly integrationMajorVersion: number;
  }): Promise<{ readonly integrationKey: string; readonly manifest: OimManifest } | null>;
  resolveIntegrationManifest(input: {
    readonly businessId: string;
    readonly integrationId: string;
    readonly integrationMajorVersion: number;
  }): Promise<{ readonly integrationKey: string; readonly manifest: OimManifest } | null>;
  resolveRegistrationManifest(
    integrationKey: string
  ): Promise<{ readonly integrationKey: string; readonly manifest: OimManifest } | null>;
  executePollingOperation(input: {
    readonly businessId: string;
    readonly connectionId: string;
    readonly integrationId: string;
    readonly integrationMajorVersion: number;
    readonly operationId: string;
    readonly expectedManifestDigest: string;
    readonly cursor: string | number | null;
    readonly leaseToken: string;
    readonly purpose: "ingress_poll";
  }): Promise<{
    readonly response: unknown;
    readonly authenticatedEvidenceDigest: string;
    readonly verifiedIdentity: VerifiedProviderIdentity;
  }>;
  executeKnowledgeOperation(input: {
    readonly businessId: string;
    readonly connectionId: string;
    readonly integrationId: string;
    readonly integrationMajorVersion: number;
    readonly operationId: string;
    readonly expectedManifestDigest: string;
    readonly parameters: Readonly<Record<string, unknown>>;
    readonly pageToken?: string;
    readonly purpose: "knowledge_sync";
  }): Promise<{ readonly body: unknown; readonly nextPageToken?: string }>;
  stageWebhookCredential: WebhookRegistrationCredentialPort["stage"];
  revokeWebhookCredential: WebhookRegistrationCredentialPort["revoke"];
  revokeWebhookCredentialAttempt: WebhookRegistrationCredentialPort["revokeAttempt"];
  registerWebhook: WebhookRegistrationProvider["register"];
  reconcileWebhook: WebhookRegistrationProvider["reconcile"];
  renewWebhook: WebhookRegistrationProvider["renew"];
  unregisterWebhook: WebhookRegistrationProvider["unregister"];
  encryptPayload(payload: Buffer): Promise<string>;
  decryptPayload(encryptedPayload: string): Promise<Buffer>;
  runHook(input: {
    readonly businessId: string;
    readonly integrationId: string;
    readonly integrationMajorVersion: number;
    readonly hook: unknown;
    readonly phaseInput: unknown;
  }): Promise<unknown>;
  listKnowledgeRegistrations(): Promise<readonly InternalOimKnowledgeRegistration[]>;
  resolveKnowledgeIdentities(
    input: {
      readonly businessId: string;
      readonly integrationId: string;
      readonly integrationMajorVersion: number;
      readonly connectionId: string;
      readonly externalTenantId: string;
      readonly externalAccountId: string;
    },
    entries: readonly ProviderAclEntry[]
  ): Promise<{
    readonly principals: readonly Readonly<{ kind: string; id: string }>[];
    readonly incomplete: boolean;
  }>;
}

export class InternalOimWorkerRouteError extends Error {
  constructor(
    readonly statusCode: 400 | 404 | 409 | 503,
    readonly code: string
  ) {
    super(code);
    this.name = "InternalOimWorkerRouteError";
  }
}

const errorResponse = {
  type: "object",
  required: ["error"],
  properties: { error: { type: "string" } },
  additionalProperties: false,
} as const;

const manifestResponse = {
  type: "object",
  required: ["integrationKey", "manifest", "manifestDigest"],
  properties: {
    integrationKey: { type: "string" },
    manifest: { type: "object", additionalProperties: true },
    manifestDigest: { type: "string", pattern: "^[0-9a-f]{64}$" },
  },
  additionalProperties: false,
} as const;

const identityResponse = {
  type: "object",
  required: ["externalTenantId", "externalAccountId"],
  properties: {
    externalTenantId: { type: "string" },
    externalAccountId: { type: "string" },
  },
  additionalProperties: false,
} as const;

const exactConnectionBody = {
  type: "object",
  required: ["businessId", "connectionId", "integrationId", "integrationMajorVersion"],
  properties: {
    businessId: { type: "string", minLength: 1 },
    connectionId: { type: "string", minLength: 1 },
    integrationId: { type: "string", minLength: 1 },
    integrationMajorVersion: { type: "integer", minimum: 0 },
  },
  additionalProperties: false,
} as const;

function manifestResult(
  resolved: { readonly integrationKey: string; readonly manifest: OimManifest } | null
) {
  if (resolved === null) throw new InternalOimWorkerRouteError(404, "oim_manifest_not_found");
  return {
    ...resolved,
    manifestDigest: canonicalManifestDigest(resolved.manifest),
  };
}

function canonicalManifestDigest(manifest: OimManifest): string {
  return canonicalHash(manifest);
}

async function serve<T>(reply: FastifyReply, operation: () => Promise<T>): Promise<T | undefined> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof InternalOimWorkerRouteError) {
      await reply.code(error.statusCode).send({ error: error.code });
      return undefined;
    }
    throw error;
  }
}

export function registerInternalOimWorkerRoutes(
  app: FastifyInstance,
  deps: InternalOimWorkerRouteDeps,
  requireAuth: PreHandler
): void {
  const requireService: PreHandler = async (request, reply) => {
    if (request.principal?.kind !== "service") {
      await reply.code(403).send({ error: "OIM worker routes are service-only" });
    }
  };
  const preHandler = [requireAuth, requireService];

  app.get(
    "/api/v1/internal/oim/worker-contract",
    {
      preHandler,
      schema: {
        description: "Report the internal OIM Worker host contract and enabled capabilities.",
        tags: ["internal"],
        security: [{ bearerToken: [] }],
        response: {
          200: {
            type: "object",
            required: ["version", "capabilities"],
            properties: {
              version: { const: 1 },
              capabilities: { type: "array", items: { type: "string" } },
            },
          },
          401: errorResponse,
          403: errorResponse,
        },
      },
    },
    async () => ({
      version: 1,
      capabilities: [
        "connection-bound-operations",
        "exact-manifest-resolution",
        "hooks",
        "knowledge-registrations",
        "payload-crypto",
        "verified-provider-identity",
        "webhook-registration",
      ],
    })
  );

  app.get(
    "/api/v1/internal/oim/polling-registrations",
    {
      preHandler,
      schema: {
        description: "List current Connection-bound OIM polling registrations.",
        tags: ["internal"],
        security: [{ bearerToken: [] }],
        response: {
          200: { type: "array", items: exactConnectionBody },
          401: errorResponse,
          403: errorResponse,
        },
      },
    },
    async () => deps.listPollingRegistrations()
  );

  app.post(
    "/api/v1/internal/oim/manifests/connection",
    {
      preHandler,
      schema: {
        description: "Resolve the exact trusted OIM manifest bound to a Connection.",
        tags: ["internal"],
        security: [{ bearerToken: [] }],
        body: exactConnectionBody,
        response: {
          200: manifestResponse,
          401: errorResponse,
          403: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (request, reply) =>
      serve(reply, async () =>
        manifestResult(
          await deps.resolveConnectionManifest(
            request.body as Parameters<typeof deps.resolveConnectionManifest>[0]
          )
        )
      )
  );

  app.post(
    "/api/v1/internal/oim/manifests/integration",
    {
      preHandler,
      schema: {
        description: "Resolve one unambiguous trusted OIM manifest by Integration identity.",
        tags: ["internal"],
        security: [{ bearerToken: [] }],
        body: {
          type: "object",
          required: ["businessId", "integrationId", "integrationMajorVersion"],
          properties: exactConnectionBody.properties,
          additionalProperties: false,
        },
        response: {
          200: manifestResponse,
          401: errorResponse,
          403: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (request, reply) =>
      serve(reply, async () =>
        manifestResult(
          await deps.resolveIntegrationManifest(
            request.body as Parameters<typeof deps.resolveIntegrationManifest>[0]
          )
        )
      )
  );

  app.post(
    "/api/v1/internal/oim/manifests/registration",
    {
      preHandler,
      schema: {
        description: "Resolve a trusted OIM manifest by its persisted Integration key.",
        tags: ["internal"],
        security: [{ bearerToken: [] }],
        body: {
          type: "object",
          required: ["integrationKey"],
          properties: { integrationKey: { type: "string", minLength: 1 } },
          additionalProperties: false,
        },
        response: {
          200: manifestResponse,
          401: errorResponse,
          403: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (request, reply) =>
      serve(reply, async () => {
        const body = request.body as { readonly integrationKey: string };
        return manifestResult(await deps.resolveRegistrationManifest(body.integrationKey));
      })
  );

  const operationBody = {
    type: "object",
    required: [
      "businessId",
      "connectionId",
      "integrationId",
      "integrationMajorVersion",
      "operationId",
      "expectedManifestDigest",
      "purpose",
    ],
    properties: {
      ...exactConnectionBody.properties,
      operationId: { type: "string", minLength: 1 },
      expectedManifestDigest: { type: "string", pattern: "^[0-9a-f]{64}$" },
      parameters: { type: "object", additionalProperties: true },
      pageToken: { type: "string" },
      cursor: {
        anyOf: [{ type: "string" }, { type: "integer" }, { type: "null" }],
      },
      leaseToken: { type: "string", minLength: 1 },
      purpose: { type: "string" },
    },
    additionalProperties: false,
  } as const;

  app.post(
    "/api/v1/internal/oim/operations/poll",
    {
      preHandler,
      schema: {
        description: "Run one exact polling operation through its current Connection lease.",
        tags: ["internal"],
        security: [{ bearerToken: [] }],
        body: {
          ...operationBody,
          required: [...operationBody.required, "cursor", "leaseToken"],
          properties: {
            ...operationBody.properties,
            purpose: { const: "ingress_poll" },
          },
        },
        response: {
          200: {
            type: "object",
            required: ["response", "authenticatedEvidenceDigest", "verifiedIdentity"],
            properties: {
              response: {},
              authenticatedEvidenceDigest: { type: "string", pattern: "^[0-9a-f]{64}$" },
              verifiedIdentity: identityResponse,
            },
          },
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
          404: errorResponse,
          409: errorResponse,
        },
      },
    },
    async (request, reply) =>
      serve(reply, () =>
        deps.executePollingOperation(
          request.body as Parameters<typeof deps.executePollingOperation>[0]
        )
      )
  );

  app.post(
    "/api/v1/internal/oim/operations/execute",
    {
      preHandler,
      schema: {
        description: "Run one exact OIM Knowledge operation through its current Connection lease.",
        tags: ["internal"],
        security: [{ bearerToken: [] }],
        body: {
          ...operationBody,
          required: [...operationBody.required, "parameters"],
          properties: {
            ...operationBody.properties,
            purpose: { const: "knowledge_sync" },
          },
        },
        response: {
          200: {
            type: "object",
            required: ["body"],
            properties: { body: {}, nextPageToken: { type: "string" } },
          },
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
          404: errorResponse,
          409: errorResponse,
        },
      },
    },
    async (request, reply) =>
      serve(reply, () =>
        deps.executeKnowledgeOperation(
          request.body as Parameters<typeof deps.executeKnowledgeOperation>[0]
        )
      )
  );

  app.post(
    "/api/v1/internal/oim/webhook-credentials/stage",
    {
      preHandler,
      schema: {
        description: "Stage a webhook verification Secret and return only an opaque use token.",
        tags: ["internal"],
        security: [{ bearerToken: [] }],
        body: {
          type: "object",
          required: ["attemptId", "integrationId", "credentialSlot", "existingRef"],
          properties: {
            attemptId: { type: "string", minLength: 1 },
            integrationId: { type: "string", minLength: 1 },
            credentialSlot: { type: "string", minLength: 1 },
            existingRef: {
              anyOf: [{ type: "string", pattern: "^secret://" }, { type: "null" }],
            },
          },
          additionalProperties: false,
        },
        response: {
          200: {
            type: "object",
            required: ["stagedCredentialRef", "useToken"],
            properties: {
              stagedCredentialRef: { type: "string", pattern: "^secret://" },
              useToken: { type: "string", minLength: 1 },
            },
          },
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
          409: errorResponse,
        },
      },
    },
    async (request, reply) =>
      serve(reply, async () => {
        const staged = await deps.stageWebhookCredential(
          request.body as Parameters<typeof deps.stageWebhookCredential>[0]
        );
        let useToken = "";
        await staged.use((token) => {
          useToken = token;
        });
        return { stagedCredentialRef: staged.ref, useToken };
      })
  );

  app.post(
    "/api/v1/internal/oim/webhook-credentials/revoke",
    {
      preHandler,
      schema: {
        description: "Revoke one staged OIM webhook Secret handle.",
        tags: ["internal"],
        security: [{ bearerToken: [] }],
        body: {
          type: "object",
          required: ["reference"],
          properties: { reference: { type: "string", pattern: "^secret://" } },
          additionalProperties: false,
        },
        response: {
          200: {
            type: "object",
            required: ["revoked"],
            properties: { revoked: { const: true } },
          },
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
        },
      },
    },
    async (request, reply) =>
      serve(reply, async () => {
        const body = request.body as { readonly reference: `secret://${string}` };
        await deps.revokeWebhookCredential(body.reference);
        return { revoked: true };
      })
  );

  app.post(
    "/api/v1/internal/oim/webhook-credentials/revoke-attempt",
    {
      preHandler,
      schema: {
        description: "Revoke the staged OIM webhook Secret owned by one registration attempt.",
        tags: ["internal"],
        security: [{ bearerToken: [] }],
        body: {
          type: "object",
          required: ["attemptId"],
          properties: { attemptId: { type: "string", minLength: 1 } },
          additionalProperties: false,
        },
        response: {
          200: {
            type: "object",
            required: ["revoked"],
            properties: { revoked: { const: true } },
          },
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
        },
      },
    },
    async (request, reply) =>
      serve(reply, async () => {
        const body = request.body as { readonly attemptId: string };
        await deps.revokeWebhookCredentialAttempt(body.attemptId);
        return { revoked: true };
      })
  );

  for (const [path, operation] of [
    ["/api/v1/internal/oim/webhooks/register", deps.registerWebhook],
    ["/api/v1/internal/oim/webhooks/reconcile", deps.reconcileWebhook],
    ["/api/v1/internal/oim/webhooks/renew", deps.renewWebhook],
    ["/api/v1/internal/oim/webhooks/unregister", deps.unregisterWebhook],
  ] as const) {
    app.post(
      path,
      {
        preHandler,
        schema: {
          description: `Run the provider webhook ${path.split("/").at(-1)} action.`,
          tags: ["internal"],
          security: [{ bearerToken: [] }],
          body: { type: "object", additionalProperties: true },
          response: {
            200: {},
            400: errorResponse,
            401: errorResponse,
            403: errorResponse,
            404: errorResponse,
            409: errorResponse,
          },
        },
      },
      async (request, reply) =>
        serve(reply, async () => {
          const result = await operation(request.body as never);
          return result === undefined ? { completed: true } : result;
        })
    );
  }

  app.post(
    "/api/v1/internal/oim/payloads/encrypt",
    {
      preHandler,
      schema: {
        description: "Encrypt authenticated OIM ingress bytes under the deployment data key.",
        tags: ["internal"],
        security: [{ bearerToken: [] }],
        body: {
          type: "object",
          required: ["plaintextBase64"],
          properties: { plaintextBase64: { type: "string" } },
          additionalProperties: false,
        },
        response: {
          200: {
            type: "object",
            required: ["encryptedPayload"],
            properties: { encryptedPayload: { type: "string" } },
          },
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
        },
      },
    },
    async (request, reply) =>
      serve(reply, async () => {
        const body = request.body as { readonly plaintextBase64: string };
        return {
          encryptedPayload: await deps.encryptPayload(Buffer.from(body.plaintextBase64, "base64")),
        };
      })
  );

  app.post(
    "/api/v1/internal/oim/payloads/decrypt",
    {
      preHandler,
      schema: {
        description: "Decrypt an authenticated OIM ingress payload inside the API trust boundary.",
        tags: ["internal"],
        security: [{ bearerToken: [] }],
        body: {
          type: "object",
          required: ["encryptedPayload"],
          properties: { encryptedPayload: { type: "string", minLength: 1 } },
          additionalProperties: false,
        },
        response: {
          200: {
            type: "object",
            required: ["plaintextBase64"],
            properties: { plaintextBase64: { type: "string" } },
          },
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
        },
      },
    },
    async (request, reply) =>
      serve(reply, async () => {
        const body = request.body as { readonly encryptedPayload: string };
        return {
          plaintextBase64: (await deps.decryptPayload(body.encryptedPayload)).toString("base64"),
        };
      })
  );

  app.post(
    "/api/v1/internal/oim/hooks/run",
    {
      preHandler,
      schema: {
        description: "Run one declared OIM hook inside the trusted API sandbox.",
        tags: ["internal"],
        security: [{ bearerToken: [] }],
        body: {
          type: "object",
          required: [
            "businessId",
            "integrationId",
            "integrationMajorVersion",
            "hook",
            "phaseInput",
          ],
          properties: {
            businessId: { type: "string", minLength: 1 },
            integrationId: { type: "string", minLength: 1 },
            integrationMajorVersion: { type: "integer", minimum: 0 },
            hook: { type: "object", additionalProperties: true },
            phaseInput: {},
          },
          additionalProperties: false,
        },
        response: {
          200: {},
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
          404: errorResponse,
          409: errorResponse,
          503: errorResponse,
        },
      },
    },
    async (request, reply) =>
      serve(reply, () => deps.runHook(request.body as Parameters<typeof deps.runHook>[0]))
  );

  app.get(
    "/api/v1/internal/oim/knowledge-registrations",
    {
      preHandler,
      schema: {
        description: "List durable, reviewed OIM Knowledge registrations and exact identities.",
        tags: ["internal"],
        security: [{ bearerToken: [] }],
        response: {
          200: { type: "array", items: { type: "object", additionalProperties: true } },
          401: errorResponse,
          403: errorResponse,
        },
      },
    },
    async () => deps.listKnowledgeRegistrations()
  );

  app.post(
    "/api/v1/internal/oim/knowledge-identities/resolve",
    {
      preHandler,
      schema: {
        description: "Resolve provider ACL entries against the exact verified Connection tenant.",
        tags: ["internal"],
        security: [{ bearerToken: [] }],
        body: {
          type: "object",
          required: [
            "businessId",
            "connectionId",
            "integrationId",
            "integrationMajorVersion",
            "externalTenantId",
            "externalAccountId",
            "entries",
          ],
          properties: {
            ...exactConnectionBody.properties,
            externalTenantId: { type: "string", minLength: 1 },
            externalAccountId: { type: "string", minLength: 1 },
            entries: { type: "array", items: { type: "object", additionalProperties: true } },
          },
          additionalProperties: false,
        },
        response: {
          200: {
            type: "object",
            required: ["principals", "incomplete"],
            properties: {
              principals: {
                type: "array",
                items: {
                  type: "object",
                  required: ["kind", "id"],
                  properties: { kind: { type: "string" }, id: { type: "string" } },
                  additionalProperties: false,
                },
              },
              incomplete: { type: "boolean" },
            },
          },
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
          404: errorResponse,
          409: errorResponse,
        },
      },
    },
    async (request, reply) =>
      serve(reply, async () => {
        const body = request.body as Parameters<typeof deps.resolveKnowledgeIdentities>[0] & {
          readonly entries: readonly ProviderAclEntry[];
        };
        return deps.resolveKnowledgeIdentities(body, body.entries);
      })
  );
}
