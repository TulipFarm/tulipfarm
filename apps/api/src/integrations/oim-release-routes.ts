import type {
  InstalledOimReleaseProvenance,
  OimTrustRoot,
  OimTrustRootPurpose,
} from "@tulipfarm/storage";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../auth/schemas";
import type { RequireAuthorization, RouteAuthorization } from "../authz/route-gate";
import { AUTHZ_SECURITY } from "../authz/schemas";
import { OimReleaseAdminError, type OimReleaseTrustHost } from "./oim-release-compose";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

export type OimReleaseRouteService = Pick<
  OimReleaseTrustHost,
  | "acceptRevocationList"
  | "addRoot"
  | "disableRevocationFeed"
  | "disableRoot"
  | "getRevocationFeed"
  | "getInstalledAutoPatchPreference"
  | "listRoots"
  | "setInstalledAutoPatchPreference"
  | "setRevocationFeed"
>;

const TRUST_ADMIN = {
  action: "deployment.oim_trust.manage",
  resourceType: "deployment",
  fallback: "admin",
} as const satisfies RouteAuthorization;

const INTEGRATION_UPDATE = {
  action: "integration.update",
  resourceType: "integration",
  fallback: "admin",
} as const satisfies RouteAuthorization;

const TrustRootSchema = {
  type: "object",
  additionalProperties: false,
  required: ["purpose", "keyId", "publicKeyPem", "createdAt", "createdBy"],
  properties: {
    purpose: { type: "string", enum: ["release", "revocation"] },
    keyId: { type: "string" },
    publicKeyPem: { type: "string" },
    createdAt: { type: "string", format: "date-time" },
    createdBy: { type: "string" },
    disabledAt: { type: "string", format: "date-time" },
    disabledBy: { type: "string" },
  },
} as const;

const RevocationFeedSchema = {
  type: "object",
  additionalProperties: false,
  required: ["url", "updatedAt", "updatedBy"],
  properties: {
    url: { type: "string", format: "uri" },
    updatedAt: { type: "string", format: "date-time" },
    updatedBy: { type: "string" },
    disabledAt: { type: "string", format: "date-time" },
    disabledBy: { type: "string" },
  },
} as const;

const RevocationEntrySchema = {
  type: "object",
  additionalProperties: false,
  required: ["integrationId", "version", "packageDigest", "reason"],
  properties: {
    integrationId: { type: "string", minLength: 1 },
    version: { type: "string", minLength: 1 },
    packageDigest: { type: "string", pattern: "^[0-9a-f]{64}$" },
    reason: { type: "string", minLength: 1, maxLength: 1024 },
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
      required: ["sequence", "issuedAt", "expiresAt", "revocations"],
      properties: {
        sequence: { type: "integer", minimum: 1 },
        issuedAt: { type: "string", format: "date-time" },
        expiresAt: { type: "string", format: "date-time" },
        revocations: { type: "array", items: RevocationEntrySchema },
      },
    },
    signature: {
      type: "object",
      additionalProperties: false,
      required: ["algorithm", "keyId", "value"],
      properties: {
        algorithm: { type: "string", const: "Ed25519" },
        keyId: { type: "string", minLength: 1, maxLength: 128 },
        value: { type: "string", minLength: 1 },
      },
    },
  },
} as const;

const AutoPatchPreferenceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["integration_id", "major_version", "version", "support", "auto_patch_opt_in"],
  properties: {
    integration_id: { type: "string", minLength: 1 },
    major_version: { type: "integer", minimum: 0 },
    version: { type: "string", minLength: 1 },
    support: { type: "string", enum: ["official", "community"] },
    auto_patch_opt_in: { type: "boolean" },
  },
} as const;

function actorId(req: FastifyRequest): string {
  if (req.principal === undefined) {
    throw new Error("authenticated principal required for OIM trust administration");
  }
  return req.principal.id;
}

function businessId(req: FastifyRequest): string {
  if (req.principal === undefined) {
    throw new Error("authenticated principal required for OIM release preference");
  }
  return req.principal.businessId;
}

function rootView(root: OimTrustRoot) {
  return {
    purpose: root.purpose,
    keyId: root.keyId,
    publicKeyPem: root.publicKeyPem,
    createdAt: root.createdAt,
    createdBy: root.createdBy,
    ...(root.disabledAt === undefined ? {} : { disabledAt: root.disabledAt }),
    ...(root.disabledBy === undefined ? {} : { disabledBy: root.disabledBy }),
  };
}

function autoPatchPreferenceView(provenance: InstalledOimReleaseProvenance) {
  return {
    integration_id: provenance.integrationId,
    major_version: provenance.majorVersion,
    version: provenance.version,
    support: provenance.trustClass,
    auto_patch_opt_in: provenance.autoPatchOptIn,
  };
}

function errorResponse(error: unknown): { status: 404 | 409 | 422; message: string } | undefined {
  if (error instanceof OimReleaseAdminError) {
    return {
      status: ["feed_not_found", "installed_release_not_found", "root_not_found"].includes(
        error.code
      )
        ? 404
        : ["community_auto_patch_forbidden", "root_conflict"].includes(error.code)
          ? 409
          : 422,
      message: error.message,
    };
  }
  if (
    error instanceof Error &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string" &&
    (error as { code: string }).code.startsWith("REVOCATION_")
  ) {
    const code = (error as { code: string }).code;
    const conflict = [
      "REVOCATION_SEQUENCE_STALE",
      "REVOCATION_TIME_ROLLBACK",
      "REVOCATION_SET_ROLLBACK",
      "REVOCATION_UPDATE_CONFLICT",
    ].includes(code);
    return { status: conflict ? 409 : 422, message: error.message };
  }
  if (error instanceof Error && error.message === "invalid_oim_trust_root") {
    return { status: 422, message: error.message };
  }
  return undefined;
}

async function sendMutation<T>(
  reply: FastifyReply,
  success: 200 | 201 | 202 | 204,
  operation: () => Promise<T>
): Promise<T | FastifyReply> {
  try {
    const result = await operation();
    return reply.code(success).send(result);
  } catch (error) {
    const response = errorResponse(error);
    if (response !== undefined) {
      return reply.code(response.status).send({ error: response.message });
    }
    throw error;
  }
}

/** Protected operator surfaces for explicit OIM roots and signed revocation ingestion. */
export function registerOimReleaseRoutes(
  app: FastifyInstance,
  service: OimReleaseRouteService,
  requireAuth: PreHandler,
  requireAuthorization: RequireAuthorization
): void {
  const requirePrincipal: PreHandler = async (req, reply) => {
    if (req.principal === undefined) {
      await reply.code(401).send({ error: "authentication required" });
    }
  };
  const gate = [requireAuth, requirePrincipal, requireAuthorization(TRUST_ADMIN)];
  const integrationUpdateGate = [
    requireAuth,
    requirePrincipal,
    requireAuthorization(INTEGRATION_UPDATE),
  ];

  app.get(
    "/api/v1/integrations/oim/:integrationId/majors/:majorVersion/auto-patch",
    {
      preHandler: integrationUpdateGate,
      schema: {
        description:
          "Read the saved automatic-patch preference for an installed OIM Integration release.",
        tags: ["integrations"],
        security: AUTHZ_SECURITY,
        params: {
          type: "object",
          additionalProperties: false,
          required: ["integrationId", "majorVersion"],
          properties: {
            integrationId: { type: "string", minLength: 1 },
            majorVersion: { type: "integer", minimum: 0 },
          },
        },
        response: {
          200: AutoPatchPreferenceSchema,
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { integrationId, majorVersion } = req.params as {
        integrationId: string;
        majorVersion: number;
      };
      return sendMutation(reply, 200, async () =>
        autoPatchPreferenceView(
          await service.getInstalledAutoPatchPreference(
            businessId(req),
            integrationId,
            majorVersion
          )
        )
      );
    }
  );

  app.patch(
    "/api/v1/integrations/oim/:integrationId/majors/:majorVersion/auto-patch",
    {
      preHandler: integrationUpdateGate,
      schema: {
        description:
          "Change only the saved automatic-patch preference for an installed OIM Integration release.",
        tags: ["integrations"],
        security: AUTHZ_SECURITY,
        params: {
          type: "object",
          additionalProperties: false,
          required: ["integrationId", "majorVersion"],
          properties: {
            integrationId: { type: "string", minLength: 1 },
            majorVersion: { type: "integer", minimum: 0 },
          },
        },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["auto_patch_opt_in"],
          properties: { auto_patch_opt_in: { type: "boolean" } },
        },
        response: {
          200: AutoPatchPreferenceSchema,
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { integrationId, majorVersion } = req.params as {
        integrationId: string;
        majorVersion: number;
      };
      const { auto_patch_opt_in } = req.body as { auto_patch_opt_in: boolean };
      return sendMutation(reply, 200, async () =>
        autoPatchPreferenceView(
          await service.setInstalledAutoPatchPreference(
            businessId(req),
            integrationId,
            majorVersion,
            auto_patch_opt_in
          )
        )
      );
    }
  );

  app.get(
    "/api/v1/integrations/oim/release-trust/roots",
    {
      preHandler: gate,
      schema: {
        description: "List operator-configured OIM release and revocation public-key roots.",
        tags: ["integrations"],
        security: AUTHZ_SECURITY,
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { includeDisabled: { type: "boolean", default: false } },
        },
        response: {
          200: {
            type: "object",
            additionalProperties: false,
            required: ["roots"],
            properties: { roots: { type: "array", items: TrustRootSchema } },
          },
          401: ErrorSchema,
          403: ErrorSchema,
        },
      },
    },
    async (req) => {
      const { includeDisabled = false } = req.query as { includeDisabled?: boolean };
      return { roots: (await service.listRoots(includeDisabled)).map(rootView) };
    }
  );

  app.get(
    "/api/v1/integrations/oim/release-trust/feed",
    {
      preHandler: gate,
      schema: {
        description: "Read the operator-configured signed OIM revocation feed.",
        tags: ["integrations"],
        security: AUTHZ_SECURITY,
        response: {
          200: {
            type: "object",
            additionalProperties: false,
            required: ["feed"],
            properties: {
              feed: { anyOf: [RevocationFeedSchema, { type: "null" }] },
            },
          },
          401: ErrorSchema,
          403: ErrorSchema,
        },
      },
    },
    async () => ({ feed: await service.getRevocationFeed() })
  );

  app.put(
    "/api/v1/integrations/oim/release-trust/feed",
    {
      preHandler: gate,
      schema: {
        description:
          "Configure the credential-free HTTPS feed used to retrieve signed OIM revocations.",
        tags: ["integrations"],
        security: AUTHZ_SECURITY,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["url"],
          properties: { url: { type: "string", format: "uri", maxLength: 2048 } },
        },
        response: {
          200: {
            type: "object",
            additionalProperties: false,
            required: ["feed"],
            properties: { feed: RevocationFeedSchema },
          },
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          422: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { url } = req.body as { url: string };
      return sendMutation(reply, 200, async () => ({
        feed: await service.setRevocationFeed(url, actorId(req)),
      }));
    }
  );

  app.delete(
    "/api/v1/integrations/oim/release-trust/feed",
    {
      preHandler: gate,
      schema: {
        description: "Disable automatic retrieval from the configured OIM revocation feed.",
        tags: ["integrations"],
        security: AUTHZ_SECURITY,
        response: {
          204: { type: "null" },
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
        },
      },
    },
    async (req, reply) =>
      sendMutation(reply, 204, async () => {
        await service.disableRevocationFeed(actorId(req));
        return undefined;
      })
  );

  app.post(
    "/api/v1/integrations/oim/release-trust/roots",
    {
      preHandler: gate,
      schema: {
        description:
          "Add an explicit operator-trusted Ed25519 public key. Remote packages cannot supply roots.",
        tags: ["integrations"],
        security: AUTHZ_SECURITY,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["purpose", "keyId", "publicKeyPem"],
          properties: {
            purpose: { type: "string", enum: ["release", "revocation"] },
            keyId: { type: "string", minLength: 1, maxLength: 128 },
            publicKeyPem: { type: "string", minLength: 1, maxLength: 16_384 },
          },
        },
        response: {
          201: {
            type: "object",
            additionalProperties: false,
            required: ["root"],
            properties: { root: TrustRootSchema },
          },
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          409: ErrorSchema,
          422: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const body = req.body as {
        purpose: OimTrustRootPurpose;
        keyId: string;
        publicKeyPem: string;
      };
      return sendMutation(reply, 201, async () => ({
        root: rootView(await service.addRoot({ ...body, actorId: actorId(req) })),
      }));
    }
  );

  app.delete(
    "/api/v1/integrations/oim/release-trust/roots/:purpose/:keyId",
    {
      preHandler: gate,
      schema: {
        description:
          "Disable an OIM public-key root without deleting its operator attribution history.",
        tags: ["integrations"],
        security: AUTHZ_SECURITY,
        params: {
          type: "object",
          additionalProperties: false,
          required: ["purpose", "keyId"],
          properties: {
            purpose: { type: "string", enum: ["release", "revocation"] },
            keyId: { type: "string", minLength: 1, maxLength: 128 },
          },
        },
        response: {
          200: {
            type: "object",
            additionalProperties: false,
            required: ["root"],
            properties: { root: TrustRootSchema },
          },
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { purpose, keyId } = req.params as {
        purpose: OimTrustRootPurpose;
        keyId: string;
      };
      return sendMutation(reply, 200, async () => ({
        root: rootView(await service.disableRoot(purpose, keyId, actorId(req))),
      }));
    }
  );

  app.post(
    "/api/v1/integrations/oim/release-trust/revocations",
    {
      preHandler: gate,
      schema: {
        description:
          "Verify and atomically accept a newer signed OIM revocation list using operator roots.",
        tags: ["integrations"],
        security: AUTHZ_SECURITY,
        body: SignedRevocationListSchema,
        response: {
          202: {
            type: "object",
            additionalProperties: false,
            required: ["sequence", "expiresAt"],
            properties: {
              sequence: { type: "integer" },
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
    async (req, reply) =>
      sendMutation(reply, 202, async () => {
        const accepted = await service.acceptRevocationList(req.body);
        return {
          sequence: accepted.list.sequence,
          expiresAt: accepted.list.expiresAt,
        };
      })
  );
}
