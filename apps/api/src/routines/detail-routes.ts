import { compileRoutine, simulateRoutine } from "@tulipfarm/run-kernel";
import { routine } from "@tulipfarm/schema";
import type { RoutineCatalog, RoutineCatalogDetail } from "@tulipfarm/soul";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../auth/schemas";
import type { UserDoc } from "../auth/users";
import type { RequireAuthorization, RouteAuthorization } from "../authz/route-gate";
import type { TeamAssetService } from "../team-assets/service";
import { routineSchema, security } from "./catalog-routes";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

/** One Run of one Routine, as the Routine screen's history list reads it. */
export interface RoutineRunSummary {
  readonly id: string;
  readonly routineSlug: string;
  readonly status: string;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

export interface RoutineRunReader {
  /** Newest first, and only Runs executing `routineId` as pinned in their bundle. */
  listByRoutine(input: {
    readonly routineId: string;
    readonly routineSlug: string;
    readonly limit: number;
  }): Promise<readonly RoutineRunSummary[]>;
}

export interface RoutineDetailDeps {
  readonly catalog: RoutineCatalog;
  readonly runs: RoutineRunReader;
  /**
   * Mints the Run. The caller is the signed-in user, not a service identity: a Run started from
   * this button acts with exactly the authority of the person who pressed it.
   */
  readonly trigger: (
    slug: string,
    inputs: Record<string, unknown> | undefined,
    caller: { readonly kind: string; readonly id: string },
    idempotencyKey?: string
  ) => Promise<{ readonly runId: string }>;
  readonly teamAssets?: TeamAssetService;
}

const READ: RouteAuthorization = {
  action: "routine.read",
  resourceType: "routine",
  fallback: "authenticated",
};

const TRIGGER: RouteAuthorization = {
  action: "routine.trigger",
  resourceType: "routine",
  fallback: "authenticated",
};

const PARAMS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["slug"],
  properties: { slug: { type: "string", minLength: 1, maxLength: 200 } },
} as const;

const DETAIL_SCHEMA = {
  ...routineSchema,
  required: [...routineSchema.required, "definition", "hash"],
  properties: {
    ...routineSchema.properties,
    definition: { type: "object", additionalProperties: true },
    hash: { type: "string" },
  },
} as const;

const RUN_SCHEMA = {
  type: "object",
  required: ["id", "routineSlug", "status", "createdAt"],
  properties: {
    id: { type: "string" },
    routineSlug: { type: "string" },
    status: { type: "string" },
    createdAt: { type: "string" },
    startedAt: { type: ["string", "null"] },
    finishedAt: { type: ["string", "null"] },
  },
} as const;

const EFFECT_SCHEMA = {
  type: "object",
  required: ["stateName", "toolRef", "action", "dispatched", "secretLeased"],
  properties: {
    stateName: { type: "string" },
    toolRef: { type: "string" },
    action: { type: "string" },
    credentialRef: { type: ["string", "null"] },
    identity: {
      type: "object",
      properties: { principalKind: { type: "string" }, principalId: { type: "string" } },
    },
    input: { type: "object", additionalProperties: true },
    inputHash: { type: "string" },
    idempotencyKey: { type: "string" },
    dispatched: { type: "boolean" },
    secretLeased: { type: "boolean" },
  },
} as const;

const DRY_RUN_SCHEMA = {
  type: "object",
  required: ["risk", "steps", "effects", "resultHash", "stubbedStates"],
  properties: {
    risk: { type: "string", enum: ["medium", "high"] },
    resultHash: { type: "string" },
    stubbedStates: { type: "array", items: { type: "string" } },
    steps: {
      type: "array",
      items: {
        type: "object",
        required: ["stateName"],
        properties: {
          stateName: { type: "string" },
          type: { type: "string" },
          atMs: { type: "number" },
          source: { type: "string" },
          next: { type: ["object", "string", "null"], additionalProperties: true },
        },
      },
    },
    effects: { type: "array", items: EFFECT_SCHEMA },
  },
} as const;

const NOT_FOUND = { error: "No published Routine with that slug." };

/**
 * States whose output the simulator cannot invent, keyed by the fixture slot it reads.
 *
 * Mirrors `simulateRoutine`'s own dispatch: a Tool it will not call, an Agent it will not prompt
 * and a person it will not wait for all leave a hole where a real Run would have had a value, and
 * the simulator refuses to walk past one rather than guess.
 */
const STUB_SLOT: Readonly<Record<string, "tools" | "model" | "events">> = {
  action: "tools",
  tool: "tools",
  compensate: "tools",
  agent: "model",
  script: "model",
  approval: "events",
  child_routine: "events",
  form: "events",
  human_task: "events",
};

/**
 * Fills every hole the simulator would refuse to walk past with an empty object.
 *
 * A rehearsal launched from a button has no canned outputs, and demanding them would make the
 * button unusable for exactly the Routines worth rehearsing. The stub is honest only because the
 * caller is told which States got one: a branch reading a stubbed output may take a path a real
 * Run would not, so the effect list is the trustworthy part and the path is not.
 */
function stubFixture(
  definition: { readonly spec: { readonly states: readonly { type: string; name: string }[] } },
  supplied: Record<string, Record<string, unknown>> | undefined
): {
  readonly slots: Record<"tools" | "model" | "events", Record<string, Record<string, unknown>>>;
  readonly stubbed: string[];
} {
  const slots = { tools: {}, model: {}, events: {} } as Record<
    "tools" | "model" | "events",
    Record<string, Record<string, unknown>>
  >;
  const stubbed: string[] = [];
  for (const state of definition.spec.states) {
    const slot = STUB_SLOT[state.type];
    if (slot === undefined) continue;
    const given = supplied?.[state.name];
    slots[slot][state.name] = given ?? {};
    if (given === undefined) stubbed.push(state.name);
  }
  return { slots, stubbed };
}

function caller(request: FastifyRequest): { kind: string; id: string } {
  return { kind: "user", id: (request.user as UserDoc)._id };
}

/**
 * The Routine screen's read and trigger plane. Reads come from the verified active bundle only,
 * never the authored checkout: the screen must describe the Routine a Run would actually execute.
 */
export function registerRoutineDetailRoutes(
  app: FastifyInstance,
  deps: RoutineDetailDeps,
  requireAuth: PreHandler,
  requireAuthorization: RequireAuthorization
): void {
  const load = (slug: string): Promise<RoutineCatalogDetail | undefined> => deps.catalog.get(slug);

  app.get(
    "/api/v1/routines/:slug",
    {
      preHandler: [requireAuth, requireAuthorization(READ)],
      schema: {
        description: "Read one published Routine from the verified active Soul bundle.",
        tags: ["routines"],
        security,
        params: PARAMS_SCHEMA,
        response: { 200: DETAIL_SCHEMA, 401: ErrorSchema, 403: ErrorSchema, 404: ErrorSchema },
      },
    },
    async (request, reply) => {
      const { slug } = request.params as { slug: string };
      const detail = await load(slug);
      if (!detail) return reply.status(404).send(NOT_FOUND);
      if (deps.teamAssets && request.principal) {
        try {
          await deps.teamAssets.require(
            "routine",
            detail.id,
            request.principal,
            "view",
            detail.summary.ownership ?? undefined
          );
        } catch {
          return reply.status(404).send(NOT_FOUND);
        }
      }
      return {
        id: detail.id,
        slug: detail.slug,
        displayName: detail.displayName,
        authoredVersion: detail.authoredVersion,
        triggers: detail.triggers,
        summary: detail.summary,
        definition: detail.definition,
        hash: detail.bundleDigest,
      };
    }
  );

  app.get(
    "/api/v1/routines/:slug/runs",
    {
      preHandler: [requireAuth, requireAuthorization(READ)],
      schema: {
        description: "List the newest Runs that executed this Routine.",
        tags: ["routines"],
        security,
        params: PARAMS_SCHEMA,
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { limit: { type: "integer", minimum: 1, maximum: 100, default: 50 } },
        },
        response: {
          200: {
            type: "object",
            required: ["items"],
            properties: { items: { type: "array", items: RUN_SCHEMA } },
          },
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const { slug } = request.params as { slug: string };
      const { limit } = request.query as { limit?: number };
      const detail = await load(slug);
      if (!detail) return reply.status(404).send(NOT_FOUND);
      if (deps.teamAssets && request.principal) {
        try {
          await deps.teamAssets.require(
            "routine",
            detail.id,
            request.principal,
            "view",
            detail.summary.ownership ?? undefined
          );
        } catch {
          return reply.status(404).send(NOT_FOUND);
        }
      }
      return {
        items: await deps.runs.listByRoutine({
          routineId: detail.id,
          routineSlug: detail.slug,
          limit: limit ?? 50,
        }),
      };
    }
  );

  app.post(
    "/api/v1/routines/:slug/runs",
    {
      preHandler: [requireAuth, requireAuthorization(TRIGGER)],
      schema: {
        description:
          "Start one Run of this Routine as the signed-in user. Send an `Idempotency-Key` " +
          "header to make a retried request safe; without one every request starts a Run, " +
          "because a second deliberate press is a second Run.",
        tags: ["routines"],
        security,
        params: PARAMS_SCHEMA,
        headers: {
          type: "object",
          properties: { "idempotency-key": { type: "string", minLength: 1, maxLength: 200 } },
        },
        body: {
          type: "object",
          additionalProperties: false,
          properties: { inputs: { type: "object", additionalProperties: true } },
        },
        response: {
          202: {
            type: "object",
            required: ["runId"],
            properties: { runId: { type: "string" } },
          },
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          422: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const { slug } = request.params as { slug: string };
      const detail = await load(slug);
      if (!detail) return reply.status(404).send(NOT_FOUND);
      if (deps.teamAssets && request.principal) {
        try {
          await deps.teamAssets.require(
            "routine",
            detail.id,
            request.principal,
            "use",
            detail.summary.ownership ?? undefined
          );
        } catch {
          return reply.status(403).send({ error: "Routine use access is required." });
        }
      }
      const body = (request.body ?? {}) as { inputs?: Record<string, unknown> };
      const key = (request.headers["idempotency-key"] as string | undefined) ?? undefined;
      try {
        const { runId } = await deps.trigger(slug, body.inputs, caller(request), key);
        return reply.status(202).send({ runId });
      } catch (error) {
        // The gateway refuses an unpublished definition or a payload its schema rejects. Both are
        // the caller's request being wrong about this Routine, not the server failing.
        request.log.warn({ err: error, slug }, "manual Routine trigger refused");
        return reply
          .status(422)
          .send({ error: "This Routine could not be started with those inputs." });
      }
    }
  );

  app.post(
    "/api/v1/routines/:slug/dry-run",
    {
      preHandler: [requireAuth, requireAuthorization(TRIGGER)],
      schema: {
        description:
          "Rehearse this Routine without doing anything. Walks the published definition with " +
          "the same authority a real Run would carry and reports every call it would have " +
          "made. No Tool is dispatched and no secret is leased.",
        tags: ["routines"],
        security,
        params: PARAMS_SCHEMA,
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            inputs: { type: "object", additionalProperties: true },
            outputs: { type: "object", additionalProperties: true },
          },
        },
        response: {
          200: DRY_RUN_SCHEMA,
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          422: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const { slug } = request.params as { slug: string };
      const detail = await load(slug);
      if (!detail) return reply.status(404).send(NOT_FOUND);
      if (deps.teamAssets && request.principal) {
        try {
          await deps.teamAssets.require(
            "routine",
            detail.id,
            request.principal,
            "use",
            detail.summary.ownership ?? undefined
          );
        } catch {
          return reply.status(403).send({ error: "Routine use access is required." });
        }
      }
      const { inputs, outputs } = (request.body ?? {}) as {
        inputs?: Record<string, unknown>;
        outputs?: Record<string, Record<string, unknown>>;
      };
      const who = caller(request);
      try {
        // The rehearsal carries the presser's own authority, not a service identity, so a
        // simulation a viewer sees is the one their own Run would produce.
        // The catalog hands back the verified bundle's document as plain JSON; re-validating is
        // how it regains its type, and it cannot fail for a document the bundle already verified.
        const document = routine.validateRoutineDefinition(detail.definition).document;
        const compiled = compileRoutine(document, {
          identityCeiling: {
            principalKind: who.kind,
            principalId: who.id,
            grants: [],
            maxRiskClass: "high",
          },
        });
        const { slots, stubbed } = stubFixture(document, outputs);
        const simulation = simulateRoutine(compiled, {
          startedAtMs: 0,
          ...(inputs ? { input: inputs } : {}),
          tools: slots.tools,
          model: slots.model,
          events: slots.events,
        });
        return reply.status(200).send({
          risk: simulation.effects.length > 0 ? "high" : "medium",
          steps: simulation.steps,
          effects: simulation.effects,
          resultHash: simulation.resultHash,
          stubbedStates: stubbed,
        });
      } catch (error) {
        // A State the simulator cannot walk, or a fixture that resolves no input, is this
        // Routine being un-rehearsable with those inputs — not the server failing.
        request.log.warn({ err: error, slug }, "Routine dry run refused");
        return reply
          .status(422)
          .send({ error: "This Routine could not be rehearsed with those inputs." });
      }
    }
  );
}
