import {
  type CuratorHost,
  type CuratorHostDenial,
  CuratorHostError,
  type CuratorMinter,
  type CuratorRecovery,
} from "@tulipfarm/curator-host";
import type { CuratorObservedPayload } from "@tulipfarm/storage";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../auth/schemas";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

const DENIAL_STATUS: Readonly<Record<CuratorHostDenial, number>> = {
  job_not_found: 404,
  // Not a retryable conflict: the manifest is an integrity binding, so a mismatch means the output
  // belongs to inputs this job never claimed, and retrying would produce the same answer.
  digest_mismatch: 422,
  // A genuine conflict, unlike the two above: this job already has an answer on the ledger, and a
  // second, different one would overwrite the only record of what the loop actually proposed.
  already_settled: 409,
  // The content this job was resolved against moved. It is retired and re-minted rather than
  // re-based, because output validated against inputs it never saw proves nothing.
  context_drifted: 409,
  // An answer arrived for a job whose context was never resolved, so there is nothing to check it
  // against.
  context_not_resolved: 409,
};

/** Every route here is service-only and behind the same gate, so all four refuse identically. */
const SERVICE_ERRORS = { 401: ErrorSchema, 403: ErrorSchema } as const;
const JOB_PARAMS = {
  type: "object",
  required: ["jobId"],
  properties: { jobId: { type: "string" } },
} as const;

export interface CuratorRouteDeps {
  readonly host: CuratorHost;
  readonly minter: CuratorMinter;
  readonly recovery: CuratorRecovery;
  /** Metrics only, and never a subject id — see `CuratorObservedPayload`. Swallowed below, so a
   *  broken exporter can never refuse a settlement. */
  readonly observe?: (payload: CuratorObservedPayload) => void;
  /** Read on the reconcile tick, the one call that happens exactly once per sweep. */
  readonly backlogAgeSeconds?: (businessId: string) => Promise<number | null>;
}

export function registerCuratorRoutes(
  app: FastifyInstance,
  deps: CuratorRouteDeps,
  businessId: string,
  requireAuth: PreHandler
): void {
  const { host, minter, recovery, observe, backlogAgeSeconds } = deps;
  /** Telemetry never fails the work it describes, but a broken subscriber is still a defect. */
  const report = (payload: CuratorObservedPayload): void => {
    try {
      observe?.(payload);
    } catch (error) {
      app.log.warn({ err: error, stage: payload.stage }, "[curator] observation failed");
    }
  };
  const requireService: PreHandler = async (req, reply) => {
    if (req.principal?.kind !== "service") {
      await reply.code(403).send({ error: "curator host is service-only" });
    }
  };
  const preHandler = [requireAuth, requireService];

  const guard = async <T>(
    reply: FastifyReply,
    run: () => Promise<T>,
    scope?: "user" | "business"
  ): Promise<T | undefined> => {
    try {
      return await run();
    } catch (error) {
      if (error instanceof CuratorHostError) {
        report({ stage: "denial", outcome: error.code, ...(scope ? { scope } : {}) });
        await reply.code(DENIAL_STATUS[error.code]).send({ error: error.code });
        return undefined;
      }
      throw error;
    }
  };

  app.post(
    "/api/v1/internal/curator/reconcile",
    {
      preHandler,
      schema: {
        description:
          "Repairs Curator jobs that stopped making progress: replays the Run of a mint that " +
          "crashed before the gateway, and frees the target of a job whose Run died without " +
          "answering. Without it one crash retires a target from the loop permanently.",
        tags: ["internal"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        response: {
          200: {
            type: "object",
            required: ["recovered", "abandoned"],
            additionalProperties: false,
            properties: {
              recovered: { type: "number" },
              abandoned: { type: "number" },
            },
          },
          ...SERVICE_ERRORS,
        },
      },
    },
    async (_req, reply) =>
      guard(reply, async () => {
        const result = await recovery.run(businessId);
        report({ stage: "recovery", outcome: "recovered", count: result.recovered });
        report({ stage: "recovery", outcome: "abandoned", count: result.abandoned });
        const age = await backlogAgeSeconds?.(businessId).catch(() => null);
        if (age != null) report({ stage: "recovery", outcome: "swept", backlogAgeSeconds: age });
        return result;
      })
  );

  app.post(
    "/api/v1/internal/curator/mint",
    {
      preHandler,
      schema: {
        description:
          "Mints one Curator job for a target and starts its Run. Takes a target only — never " +
          "Turn, candidate or seed ids — so no caller can point the loop at inputs the target " +
          "never produced. Which work the job reasons over is chosen and claimed server-side.",
        tags: ["internal"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        body: {
          type: "object",
          required: ["scope"],
          additionalProperties: false,
          properties: {
            scope: { type: "string", enum: ["user", "business"] },
            userId: { type: "string", minLength: 1 },
          },
        },
        response: {
          200: {
            type: "object",
            required: ["outcome"],
            additionalProperties: false,
            properties: {
              outcome: { type: "string", enum: ["minted", "skipped"] },
              jobId: { type: "string" },
              runId: { type: "string" },
              reason: { type: "string" },
            },
          },
          400: ErrorSchema,
          ...SERVICE_ERRORS,
        },
      },
    },
    async (req, reply) => {
      const body = req.body as { scope: "user" | "business"; userId?: string };
      if (body.scope === "user" && !body.userId) {
        await reply.code(400).send({ error: "userId is required for a user-scoped mint" });
        return undefined;
      }
      const mint = () =>
        body.scope === "user" && body.userId
          ? minter.mintForUser(businessId, body.userId)
          : minter.mintForBusiness(businessId);
      return guard(
        reply,
        async () => {
          const result = await mint();
          const reason = "reason" in result ? { reason: result.reason } : {};
          report({ stage: "mint", scope: body.scope, outcome: result.outcome, ...reason });
          return result;
        },
        body.scope
      );
    }
  );

  app.get(
    "/api/v1/internal/curator/jobs/:jobId/context",
    {
      preHandler,
      schema: {
        description:
          "Resolves the pinned inputs one Curator job may reason over, plus the context digest " +
          "the Worker must return with the model's output.",
        tags: ["internal"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: JOB_PARAMS,
        response: {
          200: {
            type: "object",
            required: ["jobId", "scope", "contextDigest"],
            additionalProperties: true,
            properties: {
              jobId: { type: "string" },
              scope: { type: "string", enum: ["user", "business"] },
              contextDigest: { type: "string" },
            },
          },
          ...SERVICE_ERRORS,
          404: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { jobId } = req.params as { jobId: string };
      return guard(reply, () => host.context(businessId, jobId));
    }
  );

  app.post(
    "/api/v1/internal/curator/jobs/:jobId/effects",
    {
      preHandler,
      schema: {
        description:
          "Submits raw Curator model output. The API re-derives parsing, citation checks, " +
          "guardrails and templating from the job's own pinned inputs, then records the " +
          "surviving effects and every rejection. It never applies them.",
        tags: ["internal"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: JOB_PARAMS,
        body: {
          type: "object",
          required: ["contextDigest", "output"],
          additionalProperties: false,
          properties: {
            contextDigest: { type: "string", minLength: 1 },
            output: {},
          },
        },
        response: {
          200: {
            type: "object",
            required: ["recorded", "rejected"],
            additionalProperties: false,
            properties: { recorded: { type: "number" }, rejected: { type: "number" } },
          },
          ...SERVICE_ERRORS,
          404: ErrorSchema,
          409: ErrorSchema,
          422: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { jobId } = req.params as { jobId: string };
      const { contextDigest, output } = req.body as { contextDigest: string; output: unknown };
      return guard(reply, async () => {
        const result = await host.submit(businessId, jobId, contextDigest, output);
        report({
          stage: "settle",
          scope: result.scope,
          outcome: "settled",
          recorded: result.recorded,
          rejected: result.rejected,
        });
        return result;
      });
    }
  );
}
