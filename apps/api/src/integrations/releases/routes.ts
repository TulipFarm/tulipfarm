import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../../auth/schemas";
import { commitActorFromRequest } from "../../soul/commit-actor";
import type { OimReleaseControlPlane, OimReleaseSelectionRequest } from "./control-plane";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface OimReleaseRouteAuthorization {
  readonly read: PreHandler;
  readonly install: PreHandler;
  readonly uninstall: PreHandler;
  readonly trust: PreHandler;
  readonly maintenance: PreHandler;
}

const SelectionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["integrationId", "version", "packageDigest"],
  properties: {
    integrationId: { type: "string", minLength: 1 },
    version: { type: "string", minLength: 1 },
    packageDigest: { type: "string", pattern: "^[0-9a-f]{64}$" },
  },
} as const;

const ScopeParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["integrationId", "majorVersion"],
  properties: {
    integrationId: { type: "string", minLength: 1 },
    majorVersion: { type: "integer", minimum: 0 },
  },
} as const;

const GenerationParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["installationId", "integrationId", "majorVersion"],
  properties: {
    ...ScopeParamsSchema.properties,
    installationId: { type: "string", format: "uuid" },
  },
} as const;

const AnyResponse = {
  type: ["array", "boolean", "null", "number", "object", "string"],
} as const;

const UninstallResultSchema = {
  type: "object",
  additionalProperties: false,
  required: ["scope", "status"],
  properties: {
    scope: {
      type: "object",
      additionalProperties: false,
      required: [
        "businessId",
        "installationId",
        "integrationId",
        "majorVersion",
        "packageDigest",
        "slug",
        "soulRevision",
      ],
      properties: {
        businessId: { type: "string", minLength: 1 },
        integrationId: { type: "string", minLength: 1 },
        majorVersion: { type: "integer", minimum: 0 },
        installationId: { type: "string", format: "uuid" },
        packageDigest: { type: "string", pattern: "^[0-9a-f]{64}$" },
        slug: { type: "string", minLength: 1 },
        soulRevision: { type: "string", minLength: 1 },
      },
    },
    status: { type: "string", const: "complete" },
  },
} as const;

const InstallResultSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "installationId",
    "integrationId",
    "majorVersion",
    "packageDigest",
    "revision",
    "trustClass",
    "version",
  ],
  properties: {
    installationId: { type: "string", format: "uuid" },
    integrationId: { type: "string", minLength: 1 },
    version: { type: "string", minLength: 1 },
    majorVersion: { type: "integer", minimum: 0 },
    packageDigest: { type: "string", pattern: "^[0-9a-f]{64}$" },
    trustClass: { type: "string", enum: ["community", "official"] },
    revision: { type: "string", minLength: 1 },
  },
} as const;

const RecoveryResultSchema = {
  type: "object",
  additionalProperties: false,
  required: ["installationId"],
  properties: {
    installationId: { type: "string", format: "uuid" },
  },
} as const;

const UninstallStatusSchema = {
  type: "object",
  additionalProperties: false,
  required: ["activationAllowed", "retryRequired", "scope", "status"],
  properties: {
    scope: GenerationParamsSchema,
    status: { type: "string", enum: ["not_started", "pending", "complete"] },
    activationAllowed: { type: "boolean" },
    retryRequired: { type: "boolean" },
  },
} as const;

const SignedRevocationListSchema = {
  type: "object",
  additionalProperties: false,
  required: ["envelopeVersion", "list", "signature"],
  properties: {
    envelopeVersion: { type: "integer", const: 1 },
    list: {
      type: "object",
      additionalProperties: false,
      required: ["expiresAt", "issuedAt", "revocations", "sequence"],
      properties: {
        sequence: { type: "integer", minimum: 1 },
        issuedAt: { type: "string", format: "date-time" },
        expiresAt: { type: "string", format: "date-time" },
        revocations: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["integrationId", "packageDigest", "reason", "version"],
            properties: {
              integrationId: { type: "string", minLength: 1 },
              version: { type: "string", minLength: 1 },
              packageDigest: { type: "string", pattern: "^[0-9a-f]{64}$" },
              reason: { type: "string", minLength: 1, maxLength: 1024 },
            },
          },
        },
      },
    },
    signature: {
      type: "object",
      additionalProperties: false,
      required: ["algorithm", "keyId", "value"],
      properties: {
        algorithm: { type: "string", const: "Ed25519" },
        keyId: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" },
        value: { type: "string", pattern: "^[A-Za-z0-9+/]{86}==$" },
      },
    },
  },
} as const;

export function registerOimReleaseRoutes(
  app: FastifyInstance,
  control: OimReleaseControlPlane,
  authorization: OimReleaseRouteAuthorization,
  businessId: string
): void {
  app.post(
    "/api/v1/integrations/oim/releases/inspect",
    {
      preHandler: authorization.read,
      schema: {
        description: "Inspect OIM release candidates without installing them.",
        tags: ["integrations"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        body: {
          type: "object",
          additionalProperties: false,
          required: ["source"],
          properties: { source: { type: "string", minLength: 1 } },
        },
        response: { 200: AnyResponse, 400: ErrorSchema, 401: ErrorSchema, 403: ErrorSchema },
      },
    },
    async (request) => {
      const { source } = request.body as { source: string };
      return control.inspect(source, commitActorFromRequest(request).principalId);
    }
  );

  app.post(
    "/api/v1/integrations/oim/releases/install",
    {
      preHandler: authorization.install,
      schema: {
        description: "Install one exact inspected OIM release candidate.",
        tags: ["integrations"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        body: {
          type: "object",
          additionalProperties: false,
          required: ["autoPatchOptIn", "selection", "slug", "source", "trustClass"],
          properties: {
            source: { type: "string", minLength: 1 },
            slug: { type: "string", minLength: 1 },
            selection: SelectionSchema,
            trustClass: { type: "string", enum: ["official", "community"] },
            approvedCommunityDigest: { type: "string", pattern: "^[0-9a-f]{64}$" },
            autoPatchOptIn: { type: "boolean" },
          },
        },
        response: {
          200: InstallResultSchema,
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          409: ErrorSchema,
          422: ErrorSchema,
        },
      },
    },
    async (request) => {
      const body = request.body as {
        source: string;
        slug: string;
        selection: OimReleaseSelectionRequest;
        trustClass: "community" | "official";
        approvedCommunityDigest?: string;
        autoPatchOptIn: boolean;
      };
      return control.install({
        businessId,
        actorId: commitActorFromRequest(request).principalId,
        ...body,
      });
    }
  );

  app.delete(
    "/api/v1/integrations/oim/:integrationId/majors/:majorVersion/installations/:installationId",
    {
      preHandler: authorization.uninstall,
      schema: {
        description: "Resume an exact-major OIM uninstall until teardown completes.",
        tags: ["integrations"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: GenerationParamsSchema,
        response: {
          200: UninstallResultSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          409: ErrorSchema,
        },
      },
    },
    async (request) => {
      const params = request.params as {
        integrationId: string;
        majorVersion: number;
        installationId: string;
      };
      return control.uninstall({
        businessId,
        actorId: commitActorFromRequest(request).principalId,
        ...params,
      });
    }
  );

  app.get(
    "/api/v1/integrations/oim/:integrationId/majors/:majorVersion/installations/:installationId/uninstall",
    {
      preHandler: authorization.read,
      schema: {
        description: "Read the durable exact-major OIM uninstall status.",
        tags: ["integrations"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: GenerationParamsSchema,
        response: { 200: UninstallStatusSchema, 401: ErrorSchema, 403: ErrorSchema },
      },
    },
    async (request) => {
      const params = request.params as {
        integrationId: string;
        majorVersion: number;
        installationId: string;
      };
      return control.uninstallStatus({ businessId, ...params });
    }
  );

  app.post(
    "/api/v1/integrations/oim/:integrationId/majors/:majorVersion/recovery",
    {
      preHandler: authorization.install,
      schema: {
        description:
          "Recover quarantined legacy OIM provenance after immutable source and Soul verification.",
        tags: ["integrations"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: ScopeParamsSchema,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["candidatePath", "slug", "source", "sourceRef"],
          properties: {
            source: { type: "string", minLength: 1 },
            sourceRef: { type: "string", minLength: 1 },
            candidatePath: { type: "string", minLength: 1 },
            slug: { type: "string", minLength: 1 },
          },
        },
        response: {
          200: RecoveryResultSchema,
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
          422: ErrorSchema,
        },
      },
    },
    async (request) => {
      const params = request.params as { integrationId: string; majorVersion: number };
      const body = request.body as {
        source: string;
        sourceRef: string;
        candidatePath: string;
        slug: string;
      };
      return control.recover({
        businessId,
        actorId: commitActorFromRequest(request).principalId,
        ...params,
        ...body,
      });
    }
  );

  app.get(
    "/api/v1/integrations/oim/:integrationId/majors/:majorVersion/auto-patch",
    {
      preHandler: authorization.read,
      schema: {
        description: "Read automatic patching for one installed OIM Integration major.",
        tags: ["integrations"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: ScopeParamsSchema,
        response: { 200: AnyResponse, 401: ErrorSchema, 403: ErrorSchema, 404: ErrorSchema },
      },
    },
    async (request) => {
      const params = request.params as { integrationId: string; majorVersion: number };
      return control.getAutoPatchPreference({ businessId, ...params });
    }
  );

  app.patch(
    "/api/v1/integrations/oim/:integrationId/majors/:majorVersion/auto-patch",
    {
      preHandler: authorization.install,
      schema: {
        description: "Change automatic patching for one installed OIM Integration major.",
        tags: ["integrations"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: ScopeParamsSchema,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["enabled"],
          properties: { enabled: { type: "boolean" } },
        },
        response: {
          200: AnyResponse,
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
        },
      },
    },
    async (request) => {
      const params = request.params as { integrationId: string; majorVersion: number };
      const { enabled } = request.body as { enabled: boolean };
      return control.setAutoPatchPreference({ businessId, ...params, enabled });
    }
  );

  app.get(
    "/api/v1/integrations/oim/release-trust/roots",
    {
      preHandler: authorization.read,
      schema: {
        description: "List active OIM release trust roots.",
        tags: ["integrations"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { includeDisabled: { type: "boolean", default: false } },
        },
        response: { 200: AnyResponse, 401: ErrorSchema, 403: ErrorSchema },
      },
    },
    (request) => {
      const { includeDisabled = false } = request.query as { includeDisabled?: boolean };
      return control.listTrustRoots(includeDisabled);
    }
  );

  app.post(
    "/api/v1/integrations/oim/release-trust/roots",
    {
      preHandler: authorization.trust,
      schema: {
        description: "Add an immutable OIM release or revocation trust root.",
        tags: ["integrations"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        body: {
          type: "object",
          additionalProperties: false,
          required: ["keyId", "publicKeyPem", "purpose"],
          properties: {
            purpose: { type: "string", enum: ["release", "revocation"] },
            keyId: { type: "string", minLength: 1, maxLength: 128 },
            publicKeyPem: { type: "string", minLength: 1, maxLength: 16384 },
          },
        },
        response: {
          200: AnyResponse,
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          409: ErrorSchema,
        },
      },
    },
    async (request) => {
      const body = request.body as {
        purpose: "release" | "revocation";
        keyId: string;
        publicKeyPem: string;
      };
      return control.addTrustRoot({
        ...body,
        actorId: commitActorFromRequest(request).principalId,
      });
    }
  );

  app.delete(
    "/api/v1/integrations/oim/release-trust/roots/:purpose/:keyId",
    {
      preHandler: authorization.trust,
      schema: {
        description: "Disable an OIM trust root without deleting its audit history.",
        tags: ["integrations"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: {
          type: "object",
          additionalProperties: false,
          required: ["keyId", "purpose"],
          properties: {
            purpose: { type: "string", enum: ["release", "revocation"] },
            keyId: { type: "string", minLength: 1 },
          },
        },
        response: { 200: AnyResponse, 401: ErrorSchema, 403: ErrorSchema, 404: ErrorSchema },
      },
    },
    async (request) => {
      const params = request.params as {
        purpose: "release" | "revocation";
        keyId: string;
      };
      return control.disableTrustRoot({
        ...params,
        actorId: commitActorFromRequest(request).principalId,
      });
    }
  );

  app.get(
    "/api/v1/integrations/oim/release-trust/feed",
    {
      preHandler: authorization.read,
      schema: {
        description: "Read the configured OIM revocation and maintenance feed.",
        tags: ["integrations"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        response: { 200: AnyResponse, 401: ErrorSchema, 403: ErrorSchema },
      },
    },
    () => control.getRevocationFeed()
  );

  app.put(
    "/api/v1/integrations/oim/release-trust/feed",
    {
      preHandler: authorization.trust,
      schema: {
        description: "Configure a credential-free HTTPS OIM maintenance feed.",
        tags: ["integrations"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        body: {
          type: "object",
          additionalProperties: false,
          required: ["url"],
          properties: { url: { type: "string", minLength: 1, maxLength: 2048 } },
        },
        response: { 200: AnyResponse, 400: ErrorSchema, 401: ErrorSchema, 403: ErrorSchema },
      },
    },
    async (request) => {
      const { url } = request.body as { url: string };
      return control.setRevocationFeed({
        url,
        actorId: commitActorFromRequest(request).principalId,
      });
    }
  );

  app.delete(
    "/api/v1/integrations/oim/release-trust/feed",
    {
      preHandler: authorization.trust,
      schema: {
        description: "Disable OIM release maintenance without deleting its history.",
        tags: ["integrations"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        response: { 200: AnyResponse, 401: ErrorSchema, 403: ErrorSchema, 404: ErrorSchema },
      },
    },
    (request) => control.disableRevocationFeed(commitActorFromRequest(request).principalId)
  );

  app.post(
    "/api/v1/integrations/oim/release-trust/revocations",
    {
      preHandler: authorization.trust,
      schema: {
        description: "Verify and accept a newer signed OIM revocation list.",
        tags: ["integrations"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        body: SignedRevocationListSchema,
        response: {
          202: {
            type: "object",
            additionalProperties: false,
            required: ["expiresAt", "sequence"],
            properties: {
              sequence: { type: "integer", minimum: 1 },
              expiresAt: { type: "string", format: "date-time" },
            },
          },
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          409: ErrorSchema,
          422: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const accepted = await control.acceptRevocationList(request.body);
      return reply.code(202).send({
        sequence: accepted.sequence,
        expiresAt: accepted.expiresAt,
      });
    }
  );

  app.post(
    "/api/v1/integrations/oim/release-trust/maintenance",
    {
      preHandler: authorization.maintenance,
      schema: {
        description: "Run one bounded OIM revocation and patch maintenance cycle.",
        tags: ["integrations"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        response: { 200: AnyResponse, 401: ErrorSchema, 403: ErrorSchema, 409: ErrorSchema },
      },
    },
    () => control.runMaintenance(businessId)
  );
}
