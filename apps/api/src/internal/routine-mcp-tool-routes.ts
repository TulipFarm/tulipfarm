import { type Static, Type } from "@sinclair/typebox";
import { McpExecutionBindingSchema } from "@tulipfarm/schema";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { InternalRoutineMcpToolHost } from "./routine-mcp-tool-host";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
const objectOptions = { additionalProperties: false } as const;
const ErrorSchema = Type.Object({ error: Type.String() }, objectOptions);
const failures = {
  400: ErrorSchema,
  401: ErrorSchema,
  403: ErrorSchema,
  404: ErrorSchema,
  409: ErrorSchema,
};
const ClaimSchema = Type.Object(
  {
    leaseOwner: Type.String({ minLength: 1 }),
    leaseGeneration: Type.Integer({ minimum: 1 }),
  },
  objectOptions
);
const StateParamsSchema = Type.Object(
  { runId: Type.String({ minLength: 1 }), stateKey: Type.String({ minLength: 1 }) },
  objectOptions
);
const FailureSchema = Type.Object(
  {
    kind: Type.Union([Type.Literal("failed"), Type.Literal("unavailable")]),
    reason: Type.String(),
  },
  objectOptions
);
const PreparationSchema = Type.Union([
  FailureSchema,
  Type.Object(
    {
      kind: Type.Literal("ready"),
      adapter: Type.Object(
        { kind: Type.Literal("mcp"), ref: Type.String({ minLength: 1 }) },
        objectOptions
      ),
      mcp: McpExecutionBindingSchema,
      destination: Type.Optional(Type.String()),
    },
    objectOptions
  ),
]);
const ResolveSchema = Type.Object(
  {
    arguments: Type.Record(Type.String(), Type.Unknown()),
    claim: ClaimSchema,
    binding: Type.Optional(McpExecutionBindingSchema),
  },
  objectOptions
);
const ReauthorizeSchema = Type.Object(
  { binding: McpExecutionBindingSchema, claim: ClaimSchema },
  objectOptions
);
const DispatchSchema = Type.Object(
  { attempt: Type.Integer({ minimum: 1 }), claim: ClaimSchema },
  objectOptions
);
const EffectParamsSchema = Type.Object(
  { runId: Type.String({ minLength: 1 }), effectId: Type.String({ format: "uuid" }) },
  objectOptions
);
const DispatchResultSchema = Type.Union([
  Type.Object({ kind: Type.Literal("succeeded"), output: Type.Unknown() }, objectOptions),
  Type.Object(
    {
      kind: Type.Literal("failed"),
      error: Type.Object(
        {
          phase: Type.Union([Type.Literal("before_dispatch"), Type.Literal("after_dispatch")]),
          code: Type.String(),
          retryable: Type.Literal(false),
        },
        objectOptions
      ),
    },
    objectOptions
  ),
]);

export function registerRoutineMcpToolRoutes(
  app: FastifyInstance,
  host: Pick<InternalRoutineMcpToolHost, "prepare" | "reauthorize" | "dispatch">,
  preHandler: PreHandler[]
): void {
  app.post<{
    Params: Static<typeof StateParamsSchema>;
    Body: Static<typeof ResolveSchema>;
  }>(
    "/api/v1/internal/runs/:runId/routine-states/:stateKey/tool/resolve",
    {
      preHandler,
      schema: {
        description: "Resolve the exact MCP account for a pinned Routine Tool State.",
        tags: ["internal"],
        security: [{ bearerToken: [] }],
        params: StateParamsSchema,
        body: ResolveSchema,
        response: { 200: PreparationSchema, ...failures },
      },
    },
    async (req) => host.prepare(req.params.runId, { stateKey: req.params.stateKey, ...req.body })
  );
  app.post<{
    Params: Static<typeof StateParamsSchema>;
    Body: Static<typeof ReauthorizeSchema>;
  }>(
    "/api/v1/internal/runs/:runId/routine-states/:stateKey/tool/reauthorize",
    {
      preHandler,
      schema: {
        description: "Reauthorize exact MCP account and Run authority before replaying an effect.",
        tags: ["internal"],
        security: [{ bearerToken: [] }],
        params: StateParamsSchema,
        body: ReauthorizeSchema,
        response: {
          200: Type.Union([
            Type.Object({ kind: Type.Literal("allowed") }, objectOptions),
            FailureSchema,
          ]),
          ...failures,
        },
      },
    },
    async (req) =>
      host.reauthorize(req.params.runId, { stateKey: req.params.stateKey, ...req.body })
  );
  app.post<{
    Params: Static<typeof EffectParamsSchema>;
    Body: Static<typeof DispatchSchema>;
  }>(
    "/api/v1/internal/runs/:runId/routine-tools/:effectId/dispatch",
    {
      preHandler,
      schema: {
        description: "Dispatch one broker-reserved MCP effect with live account and Run checks.",
        tags: ["internal"],
        security: [{ bearerToken: [] }],
        params: EffectParamsSchema,
        body: DispatchSchema,
        response: { 200: DispatchResultSchema, ...failures },
      },
    },
    async (req) => host.dispatch(req.params.runId, req.params.effectId, req.body)
  );
}
