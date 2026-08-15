/** E2E route tests catch missing gates or wiring that unit tests would not. */

import type { PGlite } from "@electric-sql/pglite";
import { type AuditEventInput, AuditWriter } from "@tulipfarm/audit";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app";
import type { TokenDoc, TokenRepo } from "../auth/api-tokens";
import { SESSION_COOKIE } from "../auth/routes";
import { MemorySessionStore } from "../auth/session-store";
import { createUser, type UserDoc, type UserRepo } from "../auth/users";
import type { PaginatedResult } from "../pagination";
import { makeMigratedPglite } from "../test/pglite";
import { AuditReadService } from "./read-service";
import { PgAuditEventRepo } from "./repo";

const BUSINESS = "biz-1";

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

function input(overrides: Partial<AuditEventInput> = {}): AuditEventInput {
  return {
    actor: { principalId: "user-1", businessId: BUSINESS },
    effectivePrincipal: { principalId: "user-1", businessId: BUSINESS },
    action: "skill.install",
    target: "skill:acme/deploy",
    decision: "allow",
    reasonCodes: ["SOUL_DIRECT_WRITE"],
    correlationId: "corr-1",
    occurredAt: new Date("2024-05-01T10:00:00.000Z"),
    ...overrides,
  };
}

describe("audit read routes", () => {
  let app: FastifyInstance;
  let db: PGlite;
  let adminSid: string;
  let memberSid: string;
  let writer: AuditWriter;

  beforeEach(async () => {
    db = await makeMigratedPglite();

    const repo = new PgAuditEventRepo(db);
    writer = new AuditWriter(repo);

    const store = new MemorySessionStore();
    const userRepo = new FakeUserRepo();
    const admin = await createUser(userRepo, "admin@example.com", "pass", "admin");
    const member = await createUser(userRepo, "member@example.com", "pass", "member");
    adminSid = await store.create(admin._id);
    memberSid = await store.create(member._id);

    app = await buildApp({
      sessionStore: store,
      userRepo,
      tokenRepo: new FakeTokenRepo(),
      auditReadService: new AuditReadService(repo, BUSINESS),
    });
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  // A function, not a const: `adminSid` is assigned in `beforeEach`, so a value captured here
  // would be the `undefined` from before the first hook ran.
  const asAdmin = () => ({ cookies: { [SESSION_COOKIE]: adminSid } });

  describe("GET /api/v1/audit/events", () => {
    it("returns 401 without auth", async () => {
      const res = await app.inject({ method: "GET", url: "/api/v1/audit/events" });
      expect(res.statusCode).toBe(401);
    });

    it("returns 403 for a member", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/audit/events",
        cookies: { [SESSION_COOKIE]: memberSid },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: "forbidden" });
    });

    it("returns the ledger newest-first for an admin", async () => {
      await writer.append(input({ correlationId: "c-0" }));
      await writer.append(input({ action: "integration.connect", correlationId: "c-1" }));

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/audit/events",
        ...asAdmin(),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.items.map((e: { action: string }) => e.action)).toEqual([
        "integration.connect",
        "skill.install",
      ]);
      expect(body.nextCursor).toBeNull();
    });

    it("exposes the chain fields an auditor needs to re-derive evidence", async () => {
      await writer.append(input());
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/audit/events",
        ...asAdmin(),
      });
      const [event] = res.json().items;
      // Serialization is schema-filtered by Fastify, so a field absent from the response schema
      // is silently dropped no matter what the service returns.
      expect(event).toMatchObject({
        chainIndex: 0,
        previousHash: null,
        actorPrincipalId: "user-1",
        action: "skill.install",
        target: "skill:acme/deploy",
        decision: "allow",
        reasonCodes: ["SOUL_DIRECT_WRITE"],
      });
      expect(event.hash).toEqual(expect.any(String));
      expect(event.occurredAt).toBe("2024-05-01T10:00:00.000Z");
    });

    it("pages with the cursor and filters by action", async () => {
      for (let i = 0; i < 3; i++) await writer.append(input({ correlationId: `c-${i}` }));
      await writer.append(input({ action: "llm-config.update", correlationId: "c-x" }));

      const first = await app.inject({
        method: "GET",
        url: "/api/v1/audit/events?limit=2",
        ...asAdmin(),
      });
      expect(first.json().items).toHaveLength(2);
      expect(first.json().nextCursor).toBe(2);

      const next = await app.inject({
        method: "GET",
        url: `/api/v1/audit/events?limit=2&cursor=${first.json().nextCursor}`,
        ...asAdmin(),
      });
      expect(next.json().items.map((e: { chainIndex: number }) => e.chainIndex)).toEqual([1, 0]);

      const filtered = await app.inject({
        method: "GET",
        url: "/api/v1/audit/events?action=llm-config.update",
        ...asAdmin(),
      });
      expect(filtered.json().items).toHaveLength(1);
    });

    it("rejects a limit above the cap at the schema boundary", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/audit/events?limit=100000",
        ...asAdmin(),
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("GET /api/v1/audit/verify", () => {
    it("returns 403 for a member", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/audit/verify",
        cookies: { [SESSION_COOKIE]: memberSid },
      });
      expect(res.statusCode).toBe(403);
    });

    it("reports a clean chain", async () => {
      await writer.append(input());
      const res = await app.inject({ method: "GET", url: "/api/v1/audit/verify", ...asAdmin() });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ valid: true, eventCount: 1, issues: [] });
      expect(res.json().tailHash).toEqual(expect.any(String));
    });

    it("reports tampering through the API, not just in the service", async () => {
      await writer.append(input());
      await writer.append(input({ correlationId: "c-2" }));
      await db.query("ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_mutate");
      await db.query("UPDATE audit_events SET target = 'skill:evil' WHERE chain_index = 0");
      await db.query("ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_mutate");

      const res = await app.inject({ method: "GET", url: "/api/v1/audit/verify", ...asAdmin() });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.valid).toBe(false);
      expect(body.issues.map((i: { type: string }) => i.type)).toContain("tampered");
    });
  });

  it("publishes both endpoints in the OpenAPI spec", async () => {
    // Repo rule: the spec at /api/v1/openapi.json is generated from route schemas, so a route
    // without one is invisible in the docs. Asserted rather than eyeballed.
    await app.ready();
    const spec = (
      app as unknown as { swagger: () => { paths: Record<string, unknown> } }
    ).swagger();
    expect(Object.keys(spec.paths)).toEqual(
      expect.arrayContaining(["/api/v1/audit/events", "/api/v1/audit/verify"])
    );
  });

  it("does not register the routes when no read service is configured", async () => {
    // Proves the endpoints come from the wiring under test rather than from somewhere else, and
    // that a deployment without the reader does not expose a half-built surface.
    const store = new MemorySessionStore();
    const userRepo = new FakeUserRepo();
    const admin = await createUser(userRepo, "a2@example.com", "pass", "admin");
    const sid = await store.create(admin._id);
    const bare = await buildApp({ sessionStore: store, userRepo, tokenRepo: new FakeTokenRepo() });
    try {
      const res = await bare.inject({
        method: "GET",
        url: "/api/v1/audit/events",
        cookies: { [SESSION_COOKIE]: sid },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await bare.close();
    }
  });
});
