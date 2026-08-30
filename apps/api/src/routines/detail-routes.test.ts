import type { RoutineCatalog, RoutineCatalogSummary } from "@tulipfarm/soul";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type RoutineDetailDeps, registerRoutineDetailRoutes } from "./detail-routes";

/** Everything the list can show, derived server-side by `routineSummary()`. */
const SUMMARY: RoutineCatalogSummary = {
  owner: "user:owner",
  stateCount: 1,
  stateTypes: ["wait"],
  effects: ["wait"],
  toolAbilities: [],
  maxRiskClass: null,
  requiresApproval: false,
  concurrencyPolicy: null,
  compensationPolicy: null,
};

const DEFINITION = {
  apiVersion: "tulipfarm.ai/v1",
  kind: "Routine",
  metadata: {
    id: "11111111-1111-4111-8111-111111111111",
    slug: "daily-wait",
    displayName: "Daily wait",
    schemaVersion: 1,
    authoredVersion: 2,
    lifecycle: "active",
  },
  spec: {
    owner: "user:owner",
    start: "Notify",
    states: [
      {
        type: "tool",
        name: "Notify",
        toolRef: { name: "slack", version: "1" },
        action: "post",
        end: true,
      },
    ],
  },
};

describe("Routine detail routes", () => {
  let app: FastifyInstance;

  const catalog = {
    list: vi.fn<RoutineCatalog["list"]>(async () => []),
    get: vi.fn<RoutineCatalog["get"]>(async (slug) =>
      slug === "daily-wait"
        ? {
            id: "routine-1",
            slug: "daily-wait",
            displayName: "Daily wait",
            authoredVersion: 2,
            triggers: [{ slug: "daily-wait-manual", type: "manual", summary: "manual" }],
            summary: SUMMARY,
            definition: DEFINITION,
            bundleDigest: "sha256:abc",
          }
        : undefined
    ),
  };

  const runs = { listByRoutine: vi.fn(async () => []) };
  const trigger = vi.fn<RoutineDetailDeps["trigger"]>(async () => ({ runId: "run-1" }));

  beforeEach(async () => {
    app = Fastify();
    app.addHook("onRequest", async (request) => {
      (request as { user?: unknown }).user = { _id: "user-1" };
    });
    registerRoutineDetailRoutes(
      app,
      { catalog, runs, trigger } as unknown as RoutineDetailDeps,
      async () => undefined,
      () => async () => undefined
    );
    await app.ready();
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await app.close();
  });

  it("serves the canonical document the bundle publishes", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/routines/daily-wait" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      id: "routine-1",
      slug: "daily-wait",
      displayName: "Daily wait",
      authoredVersion: 2,
      triggers: [{ slug: "daily-wait-manual", type: "manual", summary: "manual" }],
      summary: SUMMARY,
      definition: DEFINITION,
      hash: "sha256:abc",
    });
  });

  it("reports an unpublished slug as absent rather than empty", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/routines/missing" });

    expect(response.statusCode).toBe(404);
    expect(runs.listByRoutine).not.toHaveBeenCalled();
  });

  it("lists Runs by the Routine's identity, not its slug", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/routines/daily-wait/runs?limit=5",
    });

    expect(response.statusCode).toBe(200);
    expect(runs.listByRoutine).toHaveBeenCalledWith({
      routineId: "routine-1",
      routineSlug: "daily-wait",
      limit: 5,
    });
  });

  it("starts a Run as the signed-in user", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/routines/daily-wait/runs",
      payload: { inputs: { note: "hi" } },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ runId: "run-1" });
    expect(trigger).toHaveBeenCalledWith(
      "daily-wait",
      { note: "hi" },
      { kind: "user", id: "user-1" },
      undefined
    );
  });

  it("starts a second Run for a second press, and dedupes only on an explicit key", async () => {
    await app.inject({ method: "POST", url: "/api/v1/routines/daily-wait/runs", payload: {} });
    await app.inject({ method: "POST", url: "/api/v1/routines/daily-wait/runs", payload: {} });
    await app.inject({
      method: "POST",
      url: "/api/v1/routines/daily-wait/runs",
      headers: { "idempotency-key": "retry-1" },
      payload: {},
    });

    expect(trigger.mock.calls.map((call) => call[3])).toEqual([undefined, undefined, "retry-1"]);
  });

  it("answers a refused trigger with the caller's error, not a 500", async () => {
    trigger.mockRejectedValueOnce(new Error("payload does not satisfy the Routine's input schema"));

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/routines/daily-wait/runs",
      payload: {},
    });

    expect(response.statusCode).toBe(422);
  });

  it("rehearses the published Routine and proves nothing was dispatched", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/routines/daily-wait/dry-run",
      payload: { inputs: { note: "hi" } },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.risk).toBe("high");
    expect(body.effects).toHaveLength(1);
    // The kernel sets these, not the route. A rehearsal that claimed them would be worthless.
    expect(body.effects[0]).toMatchObject({
      stateName: "Notify",
      action: "post",
      dispatched: false,
      secretLeased: false,
    });
    // The Tool was never called, so its output was invented — say so rather than imply it ran.
    expect(body.stubbedStates).toEqual(["Notify"]);
    // Rehearsing must never mint a Run.
    expect(trigger).not.toHaveBeenCalled();
  });

  it("does not stub a State the caller supplied an output for", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/routines/daily-wait/dry-run",
      payload: { outputs: { Notify: { ok: true } } },
    });

    expect(response.json().stubbedStates).toEqual([]);
  });

  it("answers a dry run of an unknown Routine with 404, not an empty simulation", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/routines/nope/dry-run",
      payload: {},
    });

    expect(response.statusCode).toBe(404);
  });
});
