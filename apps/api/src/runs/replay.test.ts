import type {
  CompiledRoutine,
  RecordedRun,
  ReplayAuthorization,
  SimulationFixture,
} from "@tulipfarm/run-kernel";
import { compileRoutine, simulateRoutine } from "@tulipfarm/run-kernel";
import type { routine as routineSchema } from "@tulipfarm/schema";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { buildApp } from "../app";
import type { TokenDoc, TokenRepo } from "../auth/api-tokens";
import { CSRF_COOKIE, CSRF_HEADER } from "../auth/csrf";
import { SESSION_COOKIE } from "../auth/routes";
import { MemorySessionStore } from "../auth/session-store";
import { createUser, type UserDoc, type UserRepo } from "../auth/users";
import type { PaginatedResult } from "../pagination";
import type { RunReplayDeps } from "./replay";

const TEST_CSRF = "a".repeat(64);
const RUN_ID = "00000000-0000-4000-8000-000000000001";
const NOW = Date.UTC(2026, 6, 25, 12, 0, 0);

class FakeUserRepo implements UserRepo {
  private users: UserDoc[] = [];
  async findByEmail(email: string): Promise<UserDoc | null> {
    return this.users.find((user) => user.email === email.trim().toLowerCase()) ?? null;
  }
  async findById(id: string): Promise<UserDoc | null> {
    return this.users.find((user) => user._id === id) ?? null;
  }
  async count(): Promise<number> {
    return this.users.length;
  }
  async insert(user: UserDoc): Promise<void> {
    this.users.push(user);
  }
}

class FakeTokenRepo implements TokenRepo {
  async create(): Promise<void> {}
  async findByHash(): Promise<TokenDoc | null> {
    return null;
  }
  async findByUserId(): Promise<TokenDoc[]> {
    return [];
  }
  async findAll(): Promise<TokenDoc[]> {
    return [];
  }
  async findById(): Promise<TokenDoc | null> {
    return null;
  }
  async deleteById(): Promise<void> {}
  async findAllPaginated(): Promise<PaginatedResult<TokenDoc>> {
    return { items: [], nextCursor: null };
  }
  async findByUserIdPaginated(): Promise<PaginatedResult<TokenDoc>> {
    return { items: [], nextCursor: null };
  }
}

const states: routineSchema.RoutineState[] = [
  {
    type: "tool",
    name: "Label",
    toolRef: { name: "github", version: "2.0.0" },
    action: "issues.addLabels",
    credentialRef: "github-app",
    input: { label: "bug" },
    end: true,
  },
];

const routine: CompiledRoutine = compileRoutine(
  {
    apiVersion: "tulipfarm.ai/v1",
    kind: "Routine",
    metadata: {
      id: "01J0000000000000000000ROUT",
      slug: "issue-triage",
      schemaVersion: 1,
      authoredVersion: 4,
      lifecycle: "published",
    },
    spec: { owner: "platform", start: "Label", states },
  } as routineSchema.RoutineDefinition,
  {
    identityCeiling: {
      principalKind: "service",
      principalId: "triage-bot",
      grants: ["github:issues:write"],
      maxRiskClass: "low",
    },
  }
);

const fixture: SimulationFixture = {
  startedAtMs: Date.UTC(2026, 6, 25, 10, 0, 0),
  tickMs: 1_000,
  input: { issueId: 42 },
  model: {},
  tools: { Label: { applied: true } },
  events: {},
};

function recordedRun(): RecordedRun {
  const baseline = simulateRoutine(routine, fixture);
  return {
    runId: RUN_ID,
    status: "succeeded",
    routine: {
      slug: routine.slug,
      authoredVersion: routine.authoredVersion,
      digest: routine.digest,
    },
    fixture,
    steps: baseline.steps.map((step) => ({
      stateName: step.stateName,
      outputHash: step.outputHash,
    })),
  };
}

describe("POST /api/v1/runs/:id/replay", () => {
  let app: FastifyInstance;
  let sid: string;
  let loadRecordedRun: Mock<RunReplayDeps["loadRecordedRun"]>;
  let authorizeLiveReplay: Mock<RunReplayDeps["authorizeLiveReplay"]>;
  let startReplayRun: Mock<RunReplayDeps["startReplayRun"]>;
  let authorization: ReplayAuthorization | null;

  beforeEach(async () => {
    const store = new MemorySessionStore();
    const userRepo = new FakeUserRepo();
    const user = await createUser(userRepo, "user@example.com", "pass", "member");
    sid = await store.create(user._id);
    authorization = null;

    loadRecordedRun = vi.fn<RunReplayDeps["loadRecordedRun"]>(async () => recordedRun());
    authorizeLiveReplay = vi.fn<RunReplayDeps["authorizeLiveReplay"]>(async () => authorization);
    startReplayRun = vi.fn<RunReplayDeps["startReplayRun"]>(async () => ({ runId: "run-2" }));

    app = await buildApp({
      sessionStore: store,
      userRepo,
      tokenRepo: new FakeTokenRepo(),
      runReplay: {
        loadRecordedRun,
        loadRoutine: async () => routine,
        authorizeLiveReplay,
        startReplayRun,
        now: () => NOW,
      },
    });
  });

  afterEach(async () => {
    await app.close();
  });

  function replay(payload: Record<string, unknown> = {}) {
    return app.inject({
      method: "POST",
      url: `/api/v1/runs/${RUN_ID}/replay`,
      cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
      headers: { [CSRF_HEADER]: TEST_CSRF },
      payload,
    });
  }

  it("refuses an unauthenticated replay", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/runs/${RUN_ID}/replay`,
      payload: {},
    });

    expect(response.statusCode).toBe(401);
    expect(startReplayRun).not.toHaveBeenCalled();
  });

  it("replays into a simulation Run by default and returns the diff", async () => {
    const response = await replay();

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      runId: "run-2",
      mode: "simulation",
      dispatch: false,
      diff: { identical: true, states: [] },
    });
    expect(startReplayRun.mock.calls[0]?.[0]).toMatchObject({ mode: "simulation" });
  });

  it("never asks for live authorization on the default path", async () => {
    await replay();

    expect(authorizeLiveReplay).not.toHaveBeenCalled();
  });

  it("denies a live replay the caller is not authorized for", async () => {
    const response = await replay({ mode: "live" });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "live_replay_not_authorized" });
    expect(startReplayRun).not.toHaveBeenCalled();
  });

  it("denies a live replay carrying a stale effect identity", async () => {
    authorization = {
      grants: ["run:replay:live"],
      approvedByPrincipalId: "owner-1",
      effectIdentity: {
        principalKind: "service",
        principalId: "triage-bot",
        issuedAtMs: NOW - 60 * 60_000,
      },
    };

    const response = await replay({ mode: "live" });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "stale_effect_identity" });
  });

  it("starts a live replay under a fresh effect identity", async () => {
    authorization = {
      grants: ["run:replay:live"],
      approvedByPrincipalId: "owner-1",
      effectIdentity: {
        principalKind: "service",
        principalId: "triage-bot",
        issuedAtMs: NOW - 60_000,
      },
    };

    const response = await replay({ mode: "live" });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ runId: "run-2", mode: "live", dispatch: true });
    expect(startReplayRun.mock.calls[0]?.[0]).toMatchObject({
      mode: "live",
      effectIdentity: { issuedAtMs: NOW - 60_000 },
    });
  });

  it("refuses to replay a Run that has not finished", async () => {
    loadRecordedRun.mockResolvedValue({ ...recordedRun(), status: "running" });

    const response = await replay();

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "replay_not_eligible" });
  });

  it("returns 404 for a Run the caller cannot see", async () => {
    loadRecordedRun.mockResolvedValue(null);

    const response = await replay();

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "run not found" });
  });

  it("refuses to start a replay once the caller is over the rate limit", async () => {
    await app.close();

    const store = new MemorySessionStore();
    const userRepo = new FakeUserRepo();
    const user = await createUser(userRepo, "user@example.com", "pass", "member");
    sid = await store.create(user._id);
    const keys: string[] = [];

    app = await buildApp({
      sessionStore: store,
      userRepo,
      tokenRepo: new FakeTokenRepo(),
      rateLimiter: {
        async check(key, limit) {
          keys.push(key);
          return { allowed: false, limit, remaining: 0, resetAt: Date.now() + 60_000 };
        },
      },
      runReplay: {
        loadRecordedRun,
        loadRoutine: async () => routine,
        authorizeLiveReplay,
        startReplayRun,
        now: () => NOW,
      },
    });

    const response = await replay();

    expect(response.statusCode).toBe(429);
    expect(response.json()).toEqual({ error: "rate_limit_exceeded" });
    // The bucket is the authenticated caller, so one caller cannot exhaust another's budget.
    expect(keys).toEqual([`rl:run-replay:${user._id}`]);
    expect(loadRecordedRun).not.toHaveBeenCalled();
    expect(startReplayRun).not.toHaveBeenCalled();
  });
});
