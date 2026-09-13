import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { InternalRoutineOimToolHost } from "./routine-oim-tool-host";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

const ErrorSchema = {
  type: "object",
  additionalProperties: false,
  required: ["error"],
  properties: { error: { type: "string" } },
} as const;

const RoutineStateParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["runId", "stateKey"],
  properties: {
    runId: { type: "string", minLength: 1 },
    stateKey: { type: "string", minLength: 1 },
  },
} as const;

const EffectParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["runId", "effectId"],
  properties: {
    runId: { type: "string", minLength: 1 },
    effectId: { type: "string", minLength: 1 },
  },
} as const;

const RunClaimSchema = {
  type: "object",
  additionalProperties: false,
  required: ["leaseOwner", "leaseGeneration"],
  properties: {
    leaseOwner: { type: "string", minLength: 1 },
    leaseGeneration: { type: "integer", minimum: 1 },
  },
} as const;

const ConnectionSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "connectionId",
    "integrationId",
    "integrationMajorVersion",
    "operationId",
    "identityMode",
    "manifestDigest",
    "configurationDigest",
  ],
  properties: {
    connectionId: { type: "string" },
    integrationId: { type: "string" },
    integrationMajorVersion: { type: "integer", minimum: 1 },
    operationId: { type: "string" },
    credentialSlot: { type: "string" },
    credentialRevision: { type: "string" },
    identityMode: { type: "string" },
    principalKind: { type: "string" },
    principalId: { type: "string" },
    manifestDigest: { type: "string" },
    configurationDigest: { type: "string" },
  },
} as const;

const PreparationSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["kind"],
      properties: { kind: { const: "unmanaged" } },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "reason"],
      properties: {
        kind: { enum: ["failed", "unavailable"] },
        reason: { type: "string" },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: [
        "kind",
        "adapter",
        "integrationId",
        "integrationMajorVersion",
        "operationId",
        "manifestDigest",
        "configurationDigest",
      ],
      properties: {
        kind: { const: "ready" },
        adapter: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "ref"],
          properties: {
            kind: { enum: ["native", "openapi", "graphql", "integration", "sandbox"] },
            ref: { type: "string" },
          },
        },
        destination: { type: "string" },
        credentialRef: { type: "string" },
        connection: ConnectionSchema,
        secondaryCredentialRef: { type: "string" },
        secondaryConnection: ConnectionSchema,
        filePrincipalId: { type: "string" },
        fileIds: { type: "array", items: { type: "string" } },
        agentPrincipalId: { type: "string" },
        integrationId: { type: "string" },
        integrationMajorVersion: { type: "integer", minimum: 1 },
        operationId: { type: "string" },
        manifestDigest: { type: "string" },
        configurationDigest: { type: "string" },
      },
    },
  ],
} as const;

const DispatchSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "output"],
      properties: { kind: { const: "succeeded" }, output: {} },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "error"],
      properties: {
        kind: { const: "failed" },
        error: {
          type: "object",
          additionalProperties: false,
          required: ["phase", "code", "retryable"],
          properties: {
            phase: { enum: ["before_dispatch", "after_dispatch"] },
            code: { type: "string" },
            retryable: { type: "boolean" },
            providerRequestId: { type: "string" },
            retryAfterMs: { type: "number", minimum: 0 },
          },
        },
      },
    },
  ],
} as const;

export function registerRoutineOimToolRoutes(
  app: FastifyInstance,
  host: Pick<InternalRoutineOimToolHost, "prepare" | "dispatch"> | undefined,
  preHandler: PreHandler[]
): void {
  if (host === undefined) return;

  app.post(
    "/api/v1/internal/runs/:runId/routine-states/:stateKey/tool/resolve",
    {
      preHandler,
      schema: {
        description:
          "Resolve the exact Connection and immutable OIM adapter for a Routine Tool State.",
        tags: ["internal"],
        security: [{ bearerToken: [] }],
        params: RoutineStateParamsSchema,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["arguments", "claim"],
          properties: {
            connectionId: { type: "string", minLength: 1 },
            arguments: {},
            claim: RunClaimSchema,
          },
        },
        response: {
          200: PreparationSchema,
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { runId, stateKey } = req.params as { runId: string; stateKey: string };
      const body = req.body as {
        connectionId?: string;
        arguments: unknown;
        claim: { leaseOwner: string; leaseGeneration: number };
      };
      return reply.send(
        await host.prepare(runId, {
          stateKey,
          arguments: body.arguments,
          claim: body.claim,
          ...(body.connectionId === undefined ? {} : { connectionId: body.connectionId }),
        })
      );
    }
  );

  app.post(
    "/api/v1/internal/runs/:runId/routine-tools/:effectId/dispatch",
    {
      preHandler,
      schema: {
        description:
          "Dispatch a reserved Routine OIM effect after re-authorizing its Run and Connection.",
        tags: ["internal"],
        security: [{ bearerToken: [] }],
        params: EffectParamsSchema,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["attempt", "claim"],
          properties: {
            attempt: { type: "integer", minimum: 1 },
            claim: RunClaimSchema,
          },
        },
        response: {
          200: DispatchSchema,
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { runId, effectId } = req.params as { runId: string; effectId: string };
      return reply.send(
        await host.dispatch(
          runId,
          effectId,
          req.body as {
            attempt: number;
            claim: { leaseOwner: string; leaseGeneration: number };
          }
        )
      );
    }
  );
}
