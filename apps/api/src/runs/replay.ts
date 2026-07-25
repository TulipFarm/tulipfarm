import type {
  CompiledRoutine,
  RecordedRun,
  ReplayAuthorization,
  ReplayPlan,
} from "@tulipfarm/run-kernel";
import { planReplay, ReplayError } from "@tulipfarm/run-kernel";
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from "fastify";
import { ErrorSchema } from "../auth/schemas";
import { makeRateLimitHook, type RateLimiter } from "../rate-limit";

export interface RunReplayDeps {
  /** The recorded Run, or `null` when the caller may not see it. */
  loadRecordedRun(req: FastifyRequest, runId: string): Promise<RecordedRun | null>;
  loadRoutine(recorded: RecordedRun): Promise<CompiledRoutine | null>;
  /**
   * Authorize a live replay and mint a fresh effect identity for it. Returning `null` denies.
   * Only called on the live path — the default simulation path never needs it.
   */
  authorizeLiveReplay(req: FastifyRequest, runId: string): Promise<ReplayAuthorization | null>;
  startReplayRun(plan: ReplayPlan): Promise<{ runId: string }>;
  now?: () => number;
}

const NOT_FOUND = { error: "run not found" };

/** A replay re-executes a whole Run, so it is far costlier than the request that asks for it. */
const REPLAY_LIMIT = 30;
const REPLAY_WINDOW_MS = 60_000;

/**
 * `POST /api/v1/runs/:id/replay` (SPEC §18).
 *
 * Replay defaults to a new simulation Run: the recorded fixture is re-executed with effect
 * previews only and the response carries the diff against the original Run. A live replay must be
 * asked for explicitly, and is granted only when the caller holds the live-replay grant and a
 * fresh effect identity — a stale or missing one denies rather than falling back to simulation,
 * so the caller always knows which of the two happened.
 */
export function registerRunReplayRoutes(
  app: FastifyInstance,
  deps: RunReplayDeps,
  requireAuth: preHandlerHookHandler,
  rateLimiter?: RateLimiter
): void {
  // Limit per caller when a limiter is wired, keyed on the authenticated user so one caller
  // cannot spend another's budget, falling back to the address for the unauthenticated case.
  const rateLimitHook = rateLimiter
    ? makeRateLimitHook(
        rateLimiter,
        (req) => `rl:run-replay:${req.user?._id ?? req.ip}`,
        REPLAY_LIMIT,
        REPLAY_WINDOW_MS
      )
    : undefined;

  app.post(
    "/api/v1/runs/:id/replay",
    {
      preHandler: rateLimitHook ? [requireAuth, rateLimitHook] : requireAuth,
      schema: {
        description:
          "Replay a finished Run. Defaults to a new simulation Run whose effects are previewed " +
          'rather than dispatched, returning the diff against the recorded Run. `mode: "live"` ' +
          "requires separate authorization and a fresh effect identity.",
        tags: ["runs"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", minLength: 1 } },
        },
        body: {
          type: "object",
          additionalProperties: false,
          properties: { mode: { type: "string", enum: ["simulation", "live"] } },
        },
        response: {
          202: {
            type: "object",
            required: ["runId", "mode", "dispatch", "routineChanged"],
            properties: {
              runId: { type: "string" },
              mode: { type: "string", enum: ["simulation", "live"] },
              dispatch: { type: "boolean" },
              routineChanged: { type: "boolean" },
              diff: {
                type: "object",
                required: ["identical", "states"],
                properties: {
                  identical: { type: "boolean" },
                  states: {
                    type: "array",
                    items: {
                      type: "object",
                      required: ["stateName", "change"],
                      properties: {
                        stateName: { type: "string" },
                        change: {
                          type: "string",
                          enum: ["added", "output_changed", "removed"],
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
          429: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const { mode } = (req.body ?? {}) as { mode?: "live" | "simulation" };

      const recorded = await deps.loadRecordedRun(req, id);
      if (recorded === null) return reply.code(404).send(NOT_FOUND);
      const routine = await deps.loadRoutine(recorded);
      if (routine === null) return reply.code(404).send(NOT_FOUND);

      const authorization =
        mode === "live" ? ((await deps.authorizeLiveReplay(req, id)) ?? undefined) : undefined;
      const now = (deps.now ?? Date.now)();

      let plan: ReplayPlan;
      try {
        plan = planReplay(recorded, routine, { mode, authorization }, now);
      } catch (error) {
        if (error instanceof ReplayError) {
          req.log.warn({ runId: id, code: error.code }, "run replay denied");
          const status = error.code === "replay_not_eligible" ? 409 : 403;
          return reply.code(status).send({ error: error.code });
        }
        throw error;
      }

      const { runId } = await deps.startReplayRun(plan);
      return reply.code(202).send({
        runId,
        mode: plan.mode,
        dispatch: plan.dispatch,
        routineChanged: plan.routineChanged,
        ...(plan.mode === "simulation" ? { diff: plan.diff } : {}),
      });
    }
  );
}
