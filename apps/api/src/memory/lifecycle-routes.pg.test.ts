import type { PGlite } from "@electric-sql/pglite";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type { RememberRequest } from "@tulipfarm/memory";
import {
  EngineMemoryRepo,
  MemoryLifecycleService,
  MemoryRecallService,
  MemoryService,
  PgMemoryEpisodeStore,
  PgPendingMemoryStore,
} from "@tulipfarm/memory";
import type { PaginatedResult } from "@tulipfarm/storage";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app";
import type { TokenDoc, TokenRepo } from "../auth/api-tokens";
import { CSRF_COOKIE, CSRF_HEADER } from "../auth/csrf";
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

const TEST_CSRF = "a".repeat(64);
const ERASED_STATEMENT = "When I ask for rollout notes, always lead with risks.";

interface TextColumnRow {
  table_name: string;
  column_name: string;
  data_type: string;
  udt_name: string;
}

function quoteIdent(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

async function assertNoMemoryCopy(db: PGlite, marker: string, assertionId: string): Promise<void> {
  const { rows } = await db.query<TextColumnRow>(
    `SELECT table_name, column_name, data_type, udt_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name LIKE 'memory_%'
        AND (data_type IN ('text', 'jsonb') OR udt_name = '_text')
      ORDER BY table_name, column_name`
  );
  const leaks: string[] = [];
  for (const row of rows) {
    const table = quoteIdent(row.table_name);
    const column = quoteIdent(row.column_name);
    const { rows: matches } = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM ${table}
        WHERE position($1 in coalesce(${column}::text, '')) > 0
           OR position($2 in coalesce(${column}::text, '')) > 0`,
      [marker, assertionId]
    );
    if (matches[0]?.n !== "0") leaks.push(`${row.table_name}.${row.column_name}`);
  }
  expect(leaks).toEqual([]);
}

describe("memory lifecycle routes", () => {
  let app: FastifyInstance;
  let db: PGlite;
  let userId: string;
  let sid: string;
  let otherSid: string;

  beforeEach(async () => {
    db = await makeMigratedPglite();

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
      memoryLifecycleService: new MemoryLifecycleService(db),
    });
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  async function rememberCorrection(statement: string = ERASED_STATEMENT): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/memory/corrections",
      cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
      headers: { [CSRF_HEADER]: TEST_CSRF },
      payload: { subject: "rollout-note-style", statement },
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { assertionId: string }).assertionId;
  }

  it("records explicit human corrections as user-stated procedural Assertions", async () => {
    const assertionId = await rememberCorrection();
    const { rows } = await db.query<{
      memory_type: string;
      trust_tier: string;
      origin: string;
      confirmation: string;
      statement: string;
    }>(
      `SELECT memory_type, trust_tier, origin, confirmation, statement
         FROM memory_assertions
        WHERE assertion_id = $1`,
      [assertionId]
    );

    expect(rows[0]).toEqual({
      memory_type: "procedural",
      trust_tier: "user_stated",
      origin: "explicit",
      confirmation: "confirmed",
      statement: ERASED_STATEMENT,
    });
    const recalled = await new MemoryRecallService(db).recall(userId, "rollout risks", 5);
    expect(recalled.map((assertion) => assertion.assertionId)).toContain(assertionId);
  });

  it("erases Assertions and every derived Memory copy without leaving text behind", async () => {
    const assertionId = await rememberCorrection();
    await new PgPendingMemoryStore(db).put({
      pendingId: "pending-erased-copy",
      businessId: DEPLOYMENT_BUSINESS_ID,
      request: pendingRequest(assertionId, userId),
      requestedAt: new Date("2026-08-08T00:00:00.000Z").toISOString(),
      expiresAt: new Date("2026-08-09T00:00:00.000Z").toISOString(),
    });
    await new PgMemoryEpisodeStore(db).recordConversationEpisode({
      principalId: userId,
      target: {
        scope: "user_private",
        businessId: DEPLOYMENT_BUSINESS_ID,
        subjectPrincipalId: userId,
      },
      conversationId: "erased-copy-chat",
      summary: `Decision: ${ERASED_STATEMENT}`,
      outcome: `Outcome copied ${ERASED_STATEMENT}`,
    });

    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/memory/assertions/${assertionId}`,
      cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
      headers: { [CSRF_HEADER]: TEST_CSRF },
    });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { outcome: string }).outcome).toBe("erased");
    await assertNoMemoryCopy(db, ERASED_STATEMENT, assertionId);
    expect(await new MemoryRecallService(db).recall(userId, "rollout risks", 5)).toEqual([]);
  });

  it("answers unauthorized erase exactly like an unknown Assertion", async () => {
    const assertionId = await rememberCorrection("When I ask for budgets, always include runway.");

    const stranger = await app.inject({
      method: "DELETE",
      url: `/api/v1/memory/assertions/${assertionId}`,
      cookies: { [SESSION_COOKIE]: otherSid, [CSRF_COOKIE]: TEST_CSRF },
      headers: { [CSRF_HEADER]: TEST_CSRF },
    });
    const unknown = await app.inject({
      method: "DELETE",
      url: "/api/v1/memory/assertions/missing-assertion",
      cookies: { [SESSION_COOKIE]: otherSid, [CSRF_COOKIE]: TEST_CSRF },
      headers: { [CSRF_HEADER]: TEST_CSRF },
    });

    expect(stranger.statusCode).toBe(unknown.statusCode);
    expect(stranger.body).toBe(unknown.body);
    const { rows } = await db.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM memory_assertions WHERE assertion_id = $1",
      [assertionId]
    );
    expect(rows[0]?.n).toBe("1");
  });
});

function pendingRequest(assertionId: string, userId: string): RememberRequest {
  return {
    target: {
      scope: "user_private",
      businessId: DEPLOYMENT_BUSINESS_ID,
      subjectPrincipalId: userId,
    },
    subject: "rollout-note-style",
    statement: ERASED_STATEMENT,
    confidence: 0.9,
    memoryType: "fact",
    trustTier: "agent_inferred",
    provenance: {
      origin: "inferred",
      authorPrincipalId: userId,
      evidence: [{ kind: "message", ref: "pending-copy" }],
    },
    supersedesId: assertionId,
  };
}
