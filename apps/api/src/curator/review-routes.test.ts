import type { CuratorShadowEffectRow, CuratorShadowSummary } from "@tulipfarm/storage";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { RouteAuthorization } from "../authz/route-gate";
import { type CuratorReviewDeps, registerCuratorReviewRoutes } from "./review-routes";

const BUSINESS = "biz-1";

const EMPTY_SUMMARY: CuratorShadowSummary = { jobs: [], effects: [], rejections: [] };

function effect(overrides: Partial<CuratorShadowEffectRow> = {}): CuratorShadowEffectRow {
  return {
    id: "eff-1",
    jobId: "job-1",
    scope: "user",
    userId: "user-1",
    kind: "memory_patch",
    state: "shadowed",
    payload: { section: "identity", add: ["Lives in Bangalore"], citations: [{ turnId: "t" }] },
    createdAt: new Date("2026-02-01T10:00:00Z"),
    ...overrides,
  };
}

interface Capture {
  readonly windows: Date[];
  readonly limits: number[];
  readonly authorizations: RouteAuthorization[];
}

async function buildServer(
  rows: readonly CuratorShadowEffectRow[],
  principal: Record<string, unknown> | undefined,
  summary: CuratorShadowSummary = EMPTY_SUMMARY
): Promise<{ app: FastifyInstance; capture: Capture }> {
  const capture: Capture = { windows: [], limits: [], authorizations: [] };
  const deps: CuratorReviewDeps = {
    summary: async (_businessId, since) => {
      capture.windows.push(since);
      return summary;
    },
    effects: async (_businessId, _since, limit) => {
      capture.limits.push(limit);
      return [...rows];
    },
  };
  const app = Fastify();
  registerCuratorReviewRoutes(
    app,
    deps,
    BUSINESS,
    async (req: { principal?: unknown }) => {
      if (principal) req.principal = principal;
    },
    (authorization) => {
      capture.authorizations.push(authorization);
      return async (req: { principal?: { role?: string } }, reply) => {
        if (req.principal?.role !== "admin") await reply.code(403).send({ error: "denied" });
      };
    }
  );
  await app.ready();
  return { app, capture };
}

const ADMIN = { kind: "user", id: "user-9", userId: "user-9", role: "admin" };

describe("curator shadow review route", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("declares an admin-fallback authorization, never authenticated", async () => {
    const built = await buildServer([], ADMIN);
    app = built.app;
    expect(built.capture.authorizations).toEqual([
      { action: "curator.review", resourceType: "curator", fallback: "admin" },
    ]);
  });

  it("refuses a caller the authorizer denies", async () => {
    const built = await buildServer([effect()], { kind: "user", id: "user-1", role: "member" });
    app = built.app;
    const res = await app.inject({ method: "GET", url: "/api/v1/curator/shadow" });
    expect(res.statusCode).toBe(403);
  });

  it("shows an admin only the shape of another user's memory patch", async () => {
    const built = await buildServer([effect()], ADMIN);
    app = built.app;
    const res = await app.inject({ method: "GET", url: "/api/v1/curator/shadow" });
    expect(res.statusCode).toBe(200);
    const [row] = res.json().recent;
    expect(row).toEqual({
      id: "eff-1",
      kind: "memory_patch",
      state: "shadowed",
      scope: "user",
      createdAt: "2026-02-01T10:00:00.000Z",
      disclosure: "shape",
      content: { section: "identity", addCount: 1, removeCount: 0, citationCount: 1 },
    });
    expect(res.body).not.toContain("Bangalore");
  });

  it("shows a user their own patch in full", async () => {
    const built = await buildServer([effect({ userId: "user-9" })], ADMIN);
    app = built.app;
    const res = await app.inject({ method: "GET", url: "/api/v1/curator/shadow" });
    const [row] = res.json().recent;
    expect(row.disclosure).toBe("full");
    expect(row.content.add).toEqual(["Lives in Bangalore"]);
  });

  it("treats a service principal as nobody's subject even when the ids collide", async () => {
    const built = await buildServer([effect({ userId: "svc-1" })], {
      kind: "service",
      id: "svc-1",
      role: "admin",
    });
    app = built.app;
    const res = await app.inject({ method: "GET", url: "/api/v1/curator/shadow" });
    expect(res.json().recent[0].disclosure).toBe("shape");
  });

  it("serves business-scoped output in full — it is not one person's", async () => {
    const built = await buildServer(
      [effect({ scope: "business", userId: null, kind: "knowledge_page" })],
      ADMIN
    );
    app = built.app;
    const res = await app.inject({ method: "GET", url: "/api/v1/curator/shadow" });
    expect(res.json().recent[0].disclosure).toBe("full");
  });

  it("returns the counts an operator judges the loop by", async () => {
    const built = await buildServer([], ADMIN, {
      jobs: [{ scope: "user", state: "succeeded", count: 4 }],
      effects: [{ kind: "memory_patch", state: "shadowed", count: 7 }],
      rejections: [{ reason: "quote_not_found", count: 2 }],
    });
    app = built.app;
    const res = await app.inject({ method: "GET", url: "/api/v1/curator/shadow" });
    expect(res.json().summary).toEqual({
      jobs: [{ scope: "user", state: "succeeded", count: 4 }],
      effects: [{ kind: "memory_patch", state: "shadowed", count: 7 }],
      rejections: [{ reason: "quote_not_found", count: 2 }],
    });
  });

  it("defaults to a seven-day window and fifty rows", async () => {
    const built = await buildServer([], ADMIN);
    app = built.app;
    const res = await app.inject({ method: "GET", url: "/api/v1/curator/shadow" });
    expect(res.json().windowDays).toBe(7);
    expect(built.capture.limits).toEqual([50]);
    const age = Date.now() - (built.capture.windows[0]?.getTime() ?? 0);
    expect(age).toBeGreaterThan(6.9 * 86_400_000);
    expect(age).toBeLessThan(7.1 * 86_400_000);
  });

  it("honours an explicit window and cap", async () => {
    const built = await buildServer([], ADMIN);
    app = built.app;
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/curator/shadow?days=1&limit=3",
    });
    expect(res.json().windowDays).toBe(1);
    expect(built.capture.limits).toEqual([3]);
  });

  it("refuses a window or cap outside its bounds", async () => {
    const built = await buildServer([], ADMIN);
    app = built.app;
    for (const query of ["days=0", "days=91", "limit=0", "limit=201"]) {
      expect(
        (await app.inject({ method: "GET", url: `/api/v1/curator/shadow?${query}` })).statusCode
      ).toBe(400);
    }
  });
});
