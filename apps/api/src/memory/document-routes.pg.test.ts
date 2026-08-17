import type { PGlite } from "@electric-sql/pglite";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import { MEMORY_DOCUMENT_STORAGE_STATEMENTS, MemoryDocumentRepo } from "@tulipfarm/memory";
import type { PaginatedResult, Queryable, TransactionPort } from "@tulipfarm/storage";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app";
import type { TokenDoc, TokenRepo } from "../auth/api-tokens";
import { SESSION_COOKIE } from "../auth/routes";
import { MemorySessionStore } from "../auth/session-store";
import { createUser, type UserDoc, type UserRepo } from "../auth/users";
import { makeMigratedPglite } from "../test/pglite";

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

const BUSINESS = DEPLOYMENT_BUSINESS_ID;
const URL = "/api/v1/memory/document";

describe("the memory document route", () => {
  let app: FastifyInstance;
  let db: PGlite;
  let documents: MemoryDocumentRepo;
  let mineSid: string;
  let mineId: string;
  let theirsId: string;

  beforeEach(async () => {
    db = await makeMigratedPglite();
    for (const statement of MEMORY_DOCUMENT_STORAGE_STATEMENTS) await db.exec(statement);
    const transactions: TransactionPort = {
      withTransaction: (operation) => db.transaction((tx) => operation(tx as Queryable)),
    };
    documents = new MemoryDocumentRepo(transactions);

    const store = new MemorySessionStore();
    const userRepo = new FakeUserRepo();
    const mine = await createUser(userRepo, "mine@example.com", "pass", "admin");
    const theirs = await createUser(userRepo, "theirs@example.com", "pass", "member");
    mineId = mine._id;
    theirsId = theirs._id;
    mineSid = await store.create(mine._id);

    app = await buildApp({
      sessionStore: store,
      userRepo,
      tokenRepo: new FakeTokenRepo(),
      memoryDocuments: documents,
    });
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  const write = (userId: string, add: string[]) =>
    documents.applyDelta({
      businessId: BUSINESS,
      userId,
      delta: { section: "identity", add },
      writer: "tool",
      now: new Date(),
    });

  const get = (sid?: string) =>
    app.inject({ method: "GET", url: URL, cookies: sid ? { [SESSION_COOKIE]: sid } : {} });

  it("refuses an unauthenticated caller", async () => {
    expect((await get()).statusCode).toBe(401);
  });

  it("returns the caller's document as Markdown with its budget", async () => {
    await write(mineId, ["Lives in Bangalore"]);

    const res = await get(mineSid);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      document: "## Identity\n\nLives in Bangalore",
      characters: "## Identity\n\nLives in Bangalore".length,
      characterBudget: 20_000,
    });
    expect(res.json().updatedAt).toEqual(expect.any(String));
  });

  /** The document is one row per user, and this route is the only surface that reads one. */
  it("never returns another user's document", async () => {
    await write(theirsId, ["Works in Berlin"]);

    const res = await get(mineSid);

    expect(res.statusCode).toBe(200);
    expect(res.json().document).toBe("");
    expect(JSON.stringify(res.json())).not.toContain("Berlin");
  });

  it("returns an empty document rather than 404 before anything is written", async () => {
    const res = await get(mineSid);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ document: "", characters: 0 });
    expect(res.json().updatedAt).toBeUndefined();
  });

  /**
   * Read-only is the contract, not an unfinished feature. A write verb here would make Memory a
   * second Custom instructions field with none of that field's guarantees.
   */
  it("exposes no way to write the document", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      const res = await app.inject({
        method,
        url: URL,
        cookies: { [SESSION_COOKIE]: mineSid },
      });
      expect(res.statusCode).not.toBe(200);
    }
  });
});
