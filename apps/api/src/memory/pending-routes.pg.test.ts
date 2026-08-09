import type { PGlite } from "@electric-sql/pglite";
import type { MemoryCandidate, MemoryExtractionPort } from "@tulipfarm/memory";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app";
import type { TokenDoc, TokenRepo } from "../auth/api-tokens";
import { CSRF_COOKIE, CSRF_HEADER } from "../auth/csrf";
import { SESSION_COOKIE } from "../auth/routes";
import { MemorySessionStore } from "../auth/session-store";
import { createUser, type UserDoc, type UserRepo } from "../auth/users";
import type { PaginatedResult } from "../pagination";
import { runPgMigrations } from "../pg-migrate";
import { makePglite } from "../test/pglite";
import { EngineMemoryRepo } from "./engine-repo";
import { MemoryExtractionService } from "./extraction-service";
import { MemoryService } from "./service";

/**
 * The review queue over HTTP.
 *
 * The interesting cases are the ones where the caller is not who the record belongs to. A pending
 * memory is a statement about a person, so listing it, confirming it, or even learning that it
 * exists all have to be closed to everyone else — including through the 404-vs-403 distinction,
 * which is why a stranger's confirm and a nonexistent id have to answer identically.
 */

class FakeUserRepo implements UserRepo {
  private users: UserDoc[] = [];
  async findByEmail(email: string): Promise<UserDoc | null> {
    return this.users.find((u) => u.email === email.trim().toLowerCase()) ?? null;
  }
  async findById(id: string): Promise<UserDoc | null> {
    return this.users.find((u) => u._id === id) ?? null;
  }
  async count(): Promise<number> {
    return this.users.length;
  }
  async insert(user: UserDoc): Promise<void> {
    this.users.push(user);
  }
}

class FakeTokenRepo implements TokenRepo {
  async create(_t: TokenDoc): Promise<void> {}
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

class StubExtractor implements MemoryExtractionPort {
  candidates: readonly MemoryCandidate[] = [
    {
      subject: "employer",
      statement: "Works at Acme as a staff engineer.",
      memoryType: "fact",
      confidence: 0.9,
      importance: 0.8,
      entities: ["Acme"],
    },
  ];

  async extract(): Promise<readonly MemoryCandidate[]> {
    return this.candidates;
  }
}

const TEST_CSRF = "a".repeat(64);

type ApiPending = {
  pendingId: string;
  subject: string;
  statement: string;
  memoryType: string;
  confidence?: number;
  requestedAt: string;
  expiresAt: string;
};

describe("pending memory routes", () => {
  let app: FastifyInstance;
  let db: PGlite;
  let extraction: MemoryExtractionService;
  let userId: string;
  let sid: string;
  let otherSid: string;

  beforeEach(async () => {
    db = await makePglite();
    await runPgMigrations(db);
    extraction = new MemoryExtractionService(db, new StubExtractor());

    const store = new MemorySessionStore();
    const userRepo = new FakeUserRepo();
    const member = await createUser(userRepo, "member@example.com", "pass", "member");
    userId = member._id;
    sid = await store.create(member._id);
    const other = await createUser(userRepo, "other@example.com", "pass", "member");
    otherSid = await store.create(other._id);

    app = await buildApp({
      sessionStore: store,
      userRepo,
      tokenRepo: new FakeTokenRepo(),
      memoryService: new MemoryService(new EngineMemoryRepo(db)),
      memoryExtractionService: extraction,
    });
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  async function propose(): Promise<string> {
    await extraction.extractFromTurn({
      userId,
      messages: [{ role: "user", content: "I work at Acme." }],
    });
    const [pending] = await extraction.listPending(userId);
    if (pending === undefined) throw new Error("expected a pending candidate");
    return pending.pendingId;
  }

  function resolve(pendingId: string, decision: string, session: string) {
    return app.inject({
      method: "POST",
      url: `/api/v1/memory/pending/${pendingId}`,
      cookies: { [SESSION_COOKIE]: session, [CSRF_COOKIE]: TEST_CSRF },
      headers: { [CSRF_HEADER]: TEST_CSRF },
      payload: { decision },
    });
  }

  async function assertionCount(): Promise<number> {
    const res = await db.query<{ n: string }>("select count(*)::text as n from memory_assertions");
    return Number(res.rows[0]?.n ?? "0");
  }

  it("returns 401 without auth", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/memory/pending" });
    expect(res.statusCode).toBe(401);
  });

  it("returns 401 when resolving without auth", async () => {
    const pendingId = await propose();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/memory/pending/${pendingId}`,
      payload: { decision: "confirm" },
    });
    expect(res.statusCode).toBe(401);
    expect(await assertionCount()).toBe(0);
  });

  it("lists nothing when the user has no pending candidates", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/memory/pending",
      cookies: { [SESSION_COOKIE]: sid },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { pending: ApiPending[] }).pending).toEqual([]);
  });

  it("lists the user's own pending candidates", async () => {
    await propose();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/memory/pending",
      cookies: { [SESSION_COOKIE]: sid },
    });

    expect(res.statusCode).toBe(200);
    const { pending } = res.json() as { pending: ApiPending[] };
    expect(pending).toHaveLength(1);
    expect(pending[0].subject).toBe("employer");
    expect(pending[0].statement).toBe("Works at Acme as a staff engineer.");
    expect(pending[0].memoryType).toBe("fact");
  });

  it("does not leak internal provenance into the listing", async () => {
    await propose();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/memory/pending",
      cookies: { [SESSION_COOKIE]: sid },
    });

    const raw = res.body;
    expect(raw).not.toContain("provenance");
    expect(raw).not.toContain("subjectPrincipalId");
    expect(raw).not.toContain("evidence");
  });

  it("does not list another user's pending candidates", async () => {
    await propose();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/memory/pending",
      cookies: { [SESSION_COOKIE]: otherSid },
    });

    expect((res.json() as { pending: ApiPending[] }).pending).toEqual([]);
  });

  it("confirms the user's own candidate and writes the assertion", async () => {
    const pendingId = await propose();
    const res = await resolve(pendingId, "confirm", sid);

    expect(res.statusCode).toBe(200);
    expect((res.json() as { outcome: string }).outcome).toBe("saved");
    expect(await assertionCount()).toBe(1);
    expect(await extraction.listPending(userId)).toEqual([]);
  });

  it("denies without storing anything", async () => {
    const pendingId = await propose();
    const res = await resolve(pendingId, "deny", sid);

    expect(res.statusCode).toBe(200);
    expect((res.json() as { outcome: string }).outcome).toBe("denied");
    expect(await assertionCount()).toBe(0);
  });

  it("answers 404 when another user tries to confirm, and stores nothing", async () => {
    const pendingId = await propose();
    const res = await resolve(pendingId, "confirm", otherSid);

    expect(res.statusCode).toBe(404);
    expect(await assertionCount()).toBe(0);
    expect(await extraction.listPending(userId)).toHaveLength(1);
  });

  it("answers a stranger's confirm exactly as it answers an unknown id", async () => {
    const pendingId = await propose();
    const stranger = await resolve(pendingId, "confirm", otherSid);
    const unknown = await resolve("33333333-3333-3333-3333-333333333333", "confirm", sid);

    expect(stranger.statusCode).toBe(unknown.statusCode);
    expect(stranger.body).toBe(unknown.body);
  });

  it("rejects a decision it does not recognise", async () => {
    const pendingId = await propose();
    const res = await resolve(pendingId, "maybe", sid);

    expect(res.statusCode).toBe(400);
    expect(await assertionCount()).toBe(0);
  });

  it("rejects a request with no decision", async () => {
    const pendingId = await propose();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/memory/pending/${pendingId}`,
      cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
      headers: { [CSRF_HEADER]: TEST_CSRF },
      payload: {},
    });

    expect(res.statusCode).toBe(400);
  });

  it("leaves the routes unregistered when extraction is not configured", async () => {
    const bare = await buildApp({
      sessionStore: new MemorySessionStore(),
      userRepo: new FakeUserRepo(),
      tokenRepo: new FakeTokenRepo(),
      memoryService: new MemoryService(new EngineMemoryRepo(db)),
    });
    const res = await bare.inject({ method: "GET", url: "/api/v1/memory/pending" });

    expect(res.statusCode).toBe(404);
    await bare.close();
  });
});
