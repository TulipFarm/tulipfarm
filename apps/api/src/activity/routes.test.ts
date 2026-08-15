import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app";
import type { TokenDoc, TokenRepo } from "../auth/api-tokens";
import { SESSION_COOKIE } from "../auth/routes";
import { MemorySessionStore } from "../auth/session-store";
import { createUser, type UserDoc, type UserRepo } from "../auth/users";
import type { PaginatedResult } from "../pagination";
import { makeMigratedPglite } from "../test/pglite";
import { PgActivityRepo } from "./repo";
import { ActivityService } from "./service";

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

describe("activity routes", () => {
  let app: FastifyInstance;
  let db: PGlite;
  let service: ActivityService;
  let memberSid: string;

  beforeEach(async () => {
    db = await makeMigratedPglite();
    service = new ActivityService(new PgActivityRepo(db));

    const store = new MemorySessionStore();
    const userRepo = new FakeUserRepo();
    const tokenRepo = new FakeTokenRepo();
    const member = await createUser(userRepo, "member@example.com", "pass", "member");
    memberSid = await store.create(member._id);

    app = await buildApp({ sessionStore: store, userRepo, tokenRepo, activityService: service });
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  async function seed(category: string, summary: string, createdAt: Date): Promise<void> {
    // Insert directly via the repo so the timestamp is controllable.
    await new PgActivityRepo(db).insert({
      _id: randomUUID(),
      category,
      action: `${category}.created`,
      actorType: "user",
      actorId: "11111111-1111-1111-1111-111111111111",
      targetType: category,
      targetId: summary,
      summary,
      status: "ok",
      metadata: {},
      createdAt,
    });
  }

  it("returns 401 without auth", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/activities" });
    expect(res.statusCode).toBe(401);
  });

  it("lists newest-first for an authenticated user", async () => {
    await seed("resource", "old", new Date("2024-01-01T00:00:00Z"));
    await seed("chat", "new", new Date("2024-02-01T00:00:00Z"));
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/activities",
      cookies: { [SESSION_COOKIE]: memberSid },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: { summary: string }[]; nextCursor: string | null };
    expect(body.items.map((i) => i.summary)).toEqual(["new", "old"]);
    expect(body.nextCursor).toBeNull();
  });

  it("paginates with the cursor", async () => {
    for (let i = 0; i < 3; i++) {
      await seed("resource", `a${i}`, new Date(`2024-01-0${i + 1}T00:00:00Z`));
    }
    const first = await app.inject({
      method: "GET",
      url: "/api/v1/activities?limit=2",
      cookies: { [SESSION_COOKIE]: memberSid },
    });
    const firstBody = first.json() as { items: { summary: string }[]; nextCursor: string | null };
    expect(firstBody.items.map((i) => i.summary)).toEqual(["a2", "a1"]);
    expect(firstBody.nextCursor).not.toBeNull();

    const second = await app.inject({
      method: "GET",
      url: `/api/v1/activities?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor as string)}`,
      cookies: { [SESSION_COOKIE]: memberSid },
    });
    const secondBody = second.json() as { items: { summary: string }[] };
    expect(secondBody.items.map((i) => i.summary)).toEqual(["a0"]);
  });

  it("filters by category", async () => {
    await seed("resource", "r", new Date("2024-01-01T00:00:00Z"));
    await seed("chat", "c", new Date("2024-01-02T00:00:00Z"));
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/activities?category=chat",
      cookies: { [SESSION_COOKIE]: memberSid },
    });
    const body = res.json() as { items: { summary: string }[] };
    expect(body.items.map((i) => i.summary)).toEqual(["c"]);
  });
});
