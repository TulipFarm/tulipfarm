import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UserDoc } from "../auth/users";
import type { CanonicalRoutineAuthoringService } from "./authoring";
import { registerRoutineAuthoringRoutes } from "./authoring-routes";

describe("Routine authoring routes", () => {
  let app: FastifyInstance;
  const service = {
    load: vi.fn<CanonicalRoutineAuthoringService["load"]>(async () => ({
      definition: {
        apiVersion: "tulipfarm.ai/v1",
        kind: "Routine",
        metadata: {
          id: "00000000-0000-4000-8000-000000000001",
          slug: "daily-wait",
          displayName: "Daily wait",
          schemaVersion: 1,
          authoredVersion: 2,
          lifecycle: "published",
        },
        spec: {
          owner: "operations",
          start: "Wait",
          states: [
            {
              type: "wait",
              name: "Wait",
              waitFor: { kind: "timer", durationMs: 100 },
              end: true,
            },
          ],
        },
      },
      baseCommit: "base-commit",
    })),
    analyze: vi.fn<CanonicalRoutineAuthoringService["analyze"]>(async () => ({
      yaml: "kind: Routine\n",
      validationState: "valid",
      risk: "medium",
      approval: "required",
      publicationState: "draft",
      simulation: {
        mode: "simulation",
        routine: { slug: "daily-wait", authoredVersion: 3, digest: "digest" },
        status: "completed",
        startedAtMs: 1000,
        endedAtMs: 1100,
        steps: [],
        effects: [],
        outputs: {},
        resultHash: "a".repeat(64),
      },
    })),
    propose: vi.fn<CanonicalRoutineAuthoringService["propose"]>(async () => ({
      changesetId: "changeset-1",
      status: "awaiting_approval",
    })),
  };

  beforeEach(async () => {
    app = Fastify();
    registerRoutineAuthoringRoutes(app, service, async (request) => {
      request.user = { _id: "alice" } as UserDoc;
    });
    await app.ready();
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await app.close();
  });

  it("loads the canonical published base", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/routines/daily-wait/authoring",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      baseCommit: "base-commit",
      definition: { kind: "Routine" },
    });
    expect(service.load).toHaveBeenCalledWith("daily-wait", "user:alice");
  });

  it("analyzes and proposes only through the service boundary", async () => {
    const body = {
      baseCommit: "base-commit",
      yaml: "kind: Routine\n",
      fixture: { startedAtMs: 1000 },
    };
    const analyzed = await app.inject({
      method: "POST",
      url: "/api/v1/routines/daily-wait/authoring/analyze",
      payload: body,
    });
    expect(analyzed.statusCode).toBe(200);
    expect(service.analyze).toHaveBeenCalledWith({
      ...body,
      slug: "daily-wait",
      principal: "user:alice",
    });

    const proposed = await app.inject({
      method: "POST",
      url: "/api/v1/routines/daily-wait/changesets",
      headers: { "idempotency-key": "proposal-1" },
      payload: body,
    });
    expect(proposed.statusCode).toBe(202);
    expect(proposed.json()).toEqual({
      changesetId: "changeset-1",
      status: "awaiting_approval",
    });
    expect(service.propose).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "proposal-1",
        principal: "user:alice",
        businessId: "tulipfarm-local",
      })
    );
  });
});
