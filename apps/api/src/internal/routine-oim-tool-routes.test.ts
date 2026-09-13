import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerRoutineOimToolRoutes } from "./routine-oim-tool-routes";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const EFFECT_ID = "22222222-2222-4222-8222-222222222222";

describe("Routine OIM internal routes", () => {
  it("passes the exact State preparation request through the service-authenticated seam", async () => {
    const prepare = vi.fn(async () => ({
      kind: "ready" as const,
      adapter: { kind: "native" as const, ref: "oim-acme" },
      integrationId: "acme",
      integrationMajorVersion: 2,
      operationId: "read_issue",
      manifestDigest: "a".repeat(64),
      configurationDigest: "b".repeat(64),
    }));
    const app = Fastify();
    const requireAuth = vi.fn(async () => undefined);
    registerRoutineOimToolRoutes(app, { prepare, dispatch: vi.fn() }, [requireAuth]);

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/internal/runs/${RUN_ID}/routine-states/ReadIssue/tool/resolve`,
      payload: {
        connectionId: "connection-1",
        arguments: { issue: "TF-42" },
        claim: { leaseOwner: "worker-1", leaseGeneration: 3 },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      kind: "ready",
      integrationId: "acme",
      operationId: "read_issue",
    });
    expect(prepare).toHaveBeenCalledWith(RUN_ID, {
      stateKey: "ReadIssue",
      connectionId: "connection-1",
      arguments: { issue: "TF-42" },
      claim: { leaseOwner: "worker-1", leaseGeneration: 3 },
    });
    expect(requireAuth).toHaveBeenCalledOnce();
    await app.close();
  });

  it("passes the persisted effect identity, attempt, and Run claim to dispatch", async () => {
    const dispatch = vi.fn(async () => ({ kind: "succeeded" as const, output: { id: "issue-1" } }));
    const app = Fastify();
    registerRoutineOimToolRoutes(app, { prepare: vi.fn(), dispatch }, [async () => undefined]);

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/internal/runs/${RUN_ID}/routine-tools/${EFFECT_ID}/dispatch`,
      payload: {
        attempt: 2,
        claim: { leaseOwner: "worker-1", leaseGeneration: 3 },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ kind: "succeeded", output: { id: "issue-1" } });
    expect(dispatch).toHaveBeenCalledWith(RUN_ID, EFFECT_ID, {
      attempt: 2,
      claim: { leaseOwner: "worker-1", leaseGeneration: 3 },
    });
    await app.close();
  });

  it("does not expose the service route when the Routine OIM host is not composed", async () => {
    const app = Fastify();
    registerRoutineOimToolRoutes(app, undefined, [async () => undefined]);

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/internal/runs/${RUN_ID}/routine-states/ReadIssue/tool/resolve`,
      payload: { arguments: {} },
    });

    expect(response.statusCode).toBe(404);
    await app.close();
  });
});
