import { EventEmitter } from "node:events";
import type { PGlite } from "@electric-sql/pglite";
import type { SoulLoader } from "@tulipfarm/soul";
import { DOMAIN_EVENTS, type PaginatedResult } from "@tulipfarm/storage";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app";
import type { TokenDoc, TokenRepo } from "../auth/api-tokens";
import { CSRF_COOKIE, CSRF_HEADER } from "../auth/csrf";
import { SESSION_COOKIE } from "../auth/middleware";
import { MemorySessionStore } from "../auth/session-store";
import { createUser, type UserDoc, type UserRepo } from "../auth/users";
import type { Queryable } from "../db";
import { makeMigratedPglite } from "../test/pglite";
import { PgResourceRepo, PgResourceRepoFactory, type ResourceDoc } from "./repo";
import { createHistoryTableSql, createResourceTableSql } from "./schema";

const TYPE = "ticket";
const TEST_CSRF = "a".repeat(64);

class FakeUserRepo implements UserRepo {
  private users: UserDoc[] = [];
  async findByEmail(e: string): Promise<UserDoc | null> {
    return this.users.find((u) => u.email === e.trim().toLowerCase()) ?? null;
  }
  async findById(id: string): Promise<UserDoc | null> {
    return this.users.find((u) => u._id === id) ?? null;
  }
  async count(): Promise<number> {
    return this.users.length;
  }
  async insert(u: UserDoc): Promise<void> {
    this.users.push(u);
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

/** Lets every Record mutation through and rejects only the history append, as a transient would. */
function rejectHistoryWrites(db: PGlite): Queryable {
  const wrap = (q: Queryable): Queryable => ({
    query: async (text, params) => {
      if (/INSERT INTO resources\."ticket_history"/.test(text)) {
        throw new Error("transient: history insert failed");
      }
      return q.query(text, params);
    },
  });
  const base = db as unknown as Queryable & {
    transaction?: (fn: (tx: Queryable) => Promise<unknown>) => Promise<unknown>;
  };
  return {
    ...wrap(base),
    ...(typeof base.transaction === "function"
      ? {
          transaction: (fn: (tx: Queryable) => Promise<unknown>) =>
            // biome-ignore lint/suspicious/noExplicitAny: PGlite's tx handle is structurally Queryable.
            (base.transaction as any)((tx: Queryable) => fn(wrap(tx))),
        }
      : {}),
  } as Queryable;
}

describe("record write atomicity", () => {
  let db: PGlite;
  let app: FastifyInstance;
  let sid: string;
  let plain: PgResourceRepo;
  let emitted: string[];

  beforeEach(async () => {
    emitted = [];
    const domainEventEmitter = new EventEmitter();
    for (const name of [DOMAIN_EVENTS.RESOURCE_CREATED, DOMAIN_EVENTS.RESOURCE_UPDATED]) {
      domainEventEmitter.on(name, () => emitted.push(name));
    }
    db = await makeMigratedPglite();
    await db.query(createResourceTableSql(TYPE));
    await db.query(createHistoryTableSql(TYPE));
    plain = new PgResourceRepo(db, TYPE);

    const store = new MemorySessionStore();
    const userRepo = new FakeUserRepo();
    const user = await createUser(userRepo, "user@example.com", "pass", "member");
    sid = await store.create(user._id);

    app = await buildApp({
      sessionStore: store,
      userRepo,
      tokenRepo: new FakeTokenRepo(),
      soulLoader: {
        resources: new Map([
          [
            TYPE,
            {
              name: TYPE,
              schema: { type: "object", properties: { title: { type: "string" } } },
              hasHooks: false,
              hooksEnabled: true,
            },
          ],
        ]),
      } as unknown as SoulLoader,
      resourceRepoFactory: new PgResourceRepoFactory(rejectHistoryWrites(db)),
      counterStore: { makeCounterFn: () => async () => 1 },
      domainEventEmitter,
    });
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  function withSession(extra: Record<string, string> = {}) {
    return {
      cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
      headers: { [CSRF_HEADER]: TEST_CSRF, ...extra },
    };
  }

  async function historyCount(): Promise<number> {
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM resources."${TYPE}_history"`);
    return (rows[0] as { n: number }).n;
  }

  async function liveRows(): Promise<ResourceDoc[]> {
    const page = await plain.list({ limit: 50, includeDeleted: true });
    return page.items;
  }

  /** Seeds through a repo the fault injector does not wrap, so setup is not the write under test. */
  async function seed(): Promise<ResourceDoc> {
    const now = new Date();
    const doc: ResourceDoc = {
      _id: "11111111-1111-4111-8111-111111111111",
      version: 1,
      createdAt: now,
      updatedAt: now,
      title: "seeded",
    };
    await plain.insert(doc);
    return doc;
  }

  it("does not commit a created Record when its history append fails", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/resources/${TYPE}`,
      ...withSession(),
      payload: { title: "Bug" },
    });

    expect(res.statusCode).toBe(500);
    expect(await liveRows()).toHaveLength(0);
    expect(await historyCount()).toBe(0);
  });

  it("does not commit a replaced Record when its history append fails", async () => {
    const doc = await seed();
    const historyBefore = await historyCount();
    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/resources/${TYPE}/${doc._id}`,
      ...withSession({ "if-match": "1" }),
      payload: { title: "replaced" },
    });

    expect(res.statusCode).toBe(500);
    const rows = await liveRows();
    expect(rows[0]?.version).toBe(1);
    expect(rows[0]?.title).toBe("seeded");
    expect(await historyCount()).toBe(historyBefore);
  });

  it("does not commit a patched Record when its history append fails", async () => {
    const doc = await seed();
    const historyBefore = await historyCount();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/resources/${TYPE}/${doc._id}`,
      ...withSession({ "if-match": "1" }),
      payload: { title: "patched" },
    });

    expect(res.statusCode).toBe(500);
    const rows = await liveRows();
    expect(rows[0]?.version).toBe(1);
    expect(rows[0]?.title).toBe("seeded");
    expect(await historyCount()).toBe(historyBefore);
  });

  it("does not commit a soft delete when its history append fails", async () => {
    const doc = await seed();
    const historyBefore = await historyCount();
    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/resources/${TYPE}/${doc._id}`,
      ...withSession({ "if-match": "1" }),
    });

    expect(res.statusCode).toBe(500);
    const rows = await liveRows();
    expect(rows[0]?.version).toBe(1);
    expect(rows[0]?.deletedAt).toBeUndefined();
    expect(await historyCount()).toBe(historyBefore);
  });

  it("emits no domain event for a write that did not commit", async () => {
    await app.inject({
      method: "POST",
      url: `/api/v1/resources/${TYPE}`,
      ...withSession(),
      payload: { title: "Bug" },
    });
    expect(emitted).toEqual([]);
  });
});
