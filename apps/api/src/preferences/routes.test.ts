import type { PGlite } from "@electric-sql/pglite";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app";
import type { TokenDoc, TokenRepo } from "../auth/api-tokens";
import { CSRF_COOKIE, CSRF_HEADER } from "../auth/csrf";
import { SESSION_COOKIE } from "../auth/routes";
import { MemorySessionStore } from "../auth/session-store";
import { createUser, type UserDoc, type UserRepo } from "../auth/users";
import { PgKvRepo } from "../kv/repo";
import { KvService } from "../kv/service";
import type { PaginatedResult } from "../pagination";
import { runPgMigrations } from "../pg-migrate";
import { makePglite } from "../test/pglite";
import { readCustomInstructions } from "./custom-instructions";

const TEST_CSRF = "a".repeat(64);
const write = (sid: string) => ({
  cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
  headers: { [CSRF_HEADER]: TEST_CSRF },
});

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
  private tokens: TokenDoc[] = [];
  async create(token: TokenDoc): Promise<void> {
    this.tokens.push(token);
  }
  async findByHash(hash: string): Promise<TokenDoc | null> {
    return this.tokens.find((t) => t.tokenHash === hash) ?? null;
  }
  async findByUserId(userId: string): Promise<TokenDoc[]> {
    return this.tokens.filter((t) => t.userId === userId);
  }
  async findAll(): Promise<TokenDoc[]> {
    return [...this.tokens];
  }
  async findById(id: string): Promise<TokenDoc | null> {
    return this.tokens.find((t) => t._id === id) ?? null;
  }
  async deleteById(id: string): Promise<void> {
    this.tokens = this.tokens.filter((t) => t._id !== id);
  }
  async findAllPaginated(): Promise<PaginatedResult<TokenDoc>> {
    return { items: [], nextCursor: null };
  }
  async findByUserIdPaginated(): Promise<PaginatedResult<TokenDoc>> {
    return { items: [], nextCursor: null };
  }
}

const URL = "/api/v1/preferences/custom-instructions";

describe("custom instruction routes", () => {
  let app: FastifyInstance;
  let db: PGlite;
  let kvService: KvService;
  let memberSid: string;
  let otherSid: string;
  let memberId: string;

  beforeEach(async () => {
    db = await makePglite();
    await runPgMigrations(db);
    kvService = new KvService(new PgKvRepo(db));

    const store = new MemorySessionStore();
    const userRepo = new FakeUserRepo();
    const tokenRepo = new FakeTokenRepo();
    const member = await createUser(userRepo, "member@example.com", "pass", "member");
    const other = await createUser(userRepo, "other@example.com", "pass", "member");
    memberId = member._id;
    memberSid = await store.create(member._id);
    otherSid = await store.create(other._id);

    app = await buildApp({ sessionStore: store, userRepo, tokenRepo, kvService });
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it("requires authentication", async () => {
    expect((await app.inject({ method: "GET", url: URL })).statusCode).toBe(401);
  });

  it("reads back as empty before anything is written", async () => {
    const res = await app.inject({
      method: "GET",
      url: URL,
      cookies: { [SESSION_COOKIE]: memberSid },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().instructions).toBe("");
    expect(res.json().maxChars).toBeGreaterThan(0);
  });

  it("round-trips instructions and exposes them to prompt assembly", async () => {
    const put = await app.inject({
      method: "PUT",
      url: URL,
      ...write(memberSid),
      payload: { instructions: "  Reply in Marathi. Keep answers under five lines.  " },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().instructions).toBe("Reply in Marathi. Keep answers under five lines.");

    const get = await app.inject({
      method: "GET",
      url: URL,
      cookies: { [SESSION_COOKIE]: memberSid },
    });
    expect(get.json().instructions).toBe("Reply in Marathi. Keep answers under five lines.");

    // The turn resolver reads through this helper, not the route — so it has to agree.
    await expect(readCustomInstructions(kvService, memberId)).resolves.toBe(
      "Reply in Marathi. Keep answers under five lines."
    );
  });

  it("keeps one participant's instructions out of another's turn", async () => {
    await app.inject({
      method: "PUT",
      url: URL,
      ...write(memberSid),
      payload: { instructions: "Address me as Devika." },
    });

    const other = await app.inject({
      method: "GET",
      url: URL,
      cookies: { [SESSION_COOKIE]: otherSid },
    });
    expect(other.json().instructions).toBe("");
  });

  it("clears the instructions when given blank text", async () => {
    await app.inject({
      method: "PUT",
      url: URL,
      ...write(memberSid),
      payload: { instructions: "Be terse." },
    });
    const cleared = await app.inject({
      method: "PUT",
      url: URL,
      ...write(memberSid),
      payload: { instructions: "   " },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().instructions).toBe("");
    await expect(readCustomInstructions(kvService, memberId)).resolves.toBeUndefined();
  });

  it("rejects text past the cap instead of storing what the prompt would drop", async () => {
    // The prompt drops an over-budget block whole. Accepting the write would leave the setting
    // looking saved while doing nothing on every turn.
    const cap = (
      await app.inject({ method: "GET", url: URL, cookies: { [SESSION_COOKIE]: memberSid } })
    ).json().maxChars as number;

    const res = await app.inject({
      method: "PUT",
      url: URL,
      ...write(memberSid),
      payload: { instructions: "x".repeat(cap + 1) },
    });
    expect(res.statusCode).toBe(400);
    await expect(readCustomInstructions(kvService, memberId)).resolves.toBeUndefined();
  });
});
