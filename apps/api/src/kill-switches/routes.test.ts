import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type { EnableKillSwitchInput, KillSwitchRecord, PaginatedResult } from "@tulipfarm/storage";
import { KillSwitchStoreError } from "@tulipfarm/storage";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app";
import type { AuditRecordInput } from "../audit/service";
import type { TokenDoc, TokenRepo } from "../auth/api-tokens";
import { CSRF_COOKIE, CSRF_HEADER } from "../auth/csrf";
import { SESSION_COOKIE } from "../auth/routes";
import { MemorySessionStore } from "../auth/session-store";
import { createUser, type UserDoc, type UserRepo } from "../auth/users";
import { KillSwitchService, type KillSwitchStorePort } from "./service";

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

/** Mirrors the storage contract the SQL repo enforces; semantics are pinned by its own pg test. */
class FakeKillSwitchRepo implements KillSwitchStorePort {
  private records: KillSwitchRecord[] = [];

  async list(businessId: string): Promise<readonly KillSwitchRecord[]> {
    return this.records.filter((record) => record.businessId === businessId);
  }

  async enable(input: EnableKillSwitchInput): Promise<KillSwitchRecord> {
    const live = this.records.find(
      (record) =>
        record.businessId === input.businessId &&
        record.disabledAt === undefined &&
        record.scope.kind === input.scope.kind &&
        record.scope.value === input.scope.value
    );
    if (live) return live;
    const record: KillSwitchRecord = {
      id: input.id,
      businessId: input.businessId,
      scope: input.scope,
      reasonCode: input.reasonCode,
      enabledAt: "2026-08-14T00:00:00.000Z",
      enabledBy: input.enabledBy,
    };
    this.records.push(record);
    return record;
  }

  async disable(businessId: string, id: string, disabledBy: string): Promise<KillSwitchRecord> {
    const index = this.records.findIndex(
      (record) => record.businessId === businessId && record.id === id
    );
    const found = this.records[index];
    if (!found) throw new KillSwitchStoreError("not_found", `kill switch ${id} does not exist`);
    if (found.disabledAt !== undefined) {
      throw new KillSwitchStoreError("already_disabled", `kill switch ${id} is already disabled`);
    }
    const disabled: KillSwitchRecord = {
      ...found,
      disabledAt: "2026-08-14T01:00:00.000Z",
      disabledBy,
    };
    this.records[index] = disabled;
    return disabled;
  }
}

describe("kill switch routes", () => {
  let app: FastifyInstance;
  let adminSid: string;
  let memberSid: string;
  let audits: AuditRecordInput[];
  let repo: FakeKillSwitchRepo;

  beforeEach(async () => {
    const store = new MemorySessionStore();
    const userRepo = new FakeUserRepo();
    const tokenRepo = new FakeTokenRepo();
    const admin = await createUser(userRepo, "admin@example.com", "pass", "admin");
    const member = await createUser(userRepo, "member@example.com", "pass", "member");
    adminSid = await store.create(admin._id);
    memberSid = await store.create(member._id);

    audits = [];
    repo = new FakeKillSwitchRepo();
    let seq = 0;
    const service = new KillSwitchService(
      repo,
      { recordOrWarn: async (input) => void audits.push(input) },
      DEPLOYMENT_BUSINESS_ID,
      () => `ks-${++seq}`
    );

    app = await buildApp({ sessionStore: store, userRepo, tokenRepo, killSwitches: service });
  });

  afterEach(async () => {
    await app.close();
  });

  async function arm(body: Record<string, unknown>, sid = adminSid) {
    return app.inject({
      method: "POST",
      url: "/api/v1/kill-switches",
      payload: body,
      ...write(sid),
    });
  }

  describe("admin gate", () => {
    it("refuses an anonymous caller", async () => {
      const res = await app.inject({ method: "GET", url: "/api/v1/kill-switches" });
      expect(res.statusCode).toBe(401);
    });

    it("refuses a signed-in non-admin", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/kill-switches",
        cookies: { [SESSION_COOKIE]: memberSid },
      });
      expect(res.statusCode).toBe(403);
    });

    it("refuses a non-admin arming a switch", async () => {
      const res = await arm({ scopeKind: "all_mutations", reasonCode: "incident-42" }, memberSid);
      expect(res.statusCode).toBe(403);
      expect(await repo.list(DEPLOYMENT_BUSINESS_ID)).toEqual([]);
    });
  });

  it("arms a switch and reports it as live", async () => {
    const armed = await arm({ scopeKind: "all_mutations", reasonCode: "incident-42" });
    expect(armed.statusCode).toBe(201);
    expect(armed.json().killSwitch).toMatchObject({
      id: "ks-1",
      scopeKind: "all_mutations",
      reasonCode: "incident-42",
      enabled: true,
    });

    const listed = await app.inject({
      method: "GET",
      url: "/api/v1/kill-switches",
      cookies: { [SESSION_COOKIE]: adminSid },
    });
    expect(listed.json().killSwitches).toHaveLength(1);
  });

  it("refuses a scope no guard evaluates rather than storing a switch that stops nothing", async () => {
    const res = await arm({ scopeKind: "agent", scopeValue: "a-1", reasonCode: "incident-42" });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toContain("agent");
    expect(await repo.list(DEPLOYMENT_BUSINESS_ID)).toEqual([]);
  });

  it("advertises only the scope kinds a guard can enforce", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/kill-switches",
      cookies: { [SESSION_COOKIE]: adminSid },
    });
    expect(res.json().enforceableScopeKinds).toContain("all_mutations");
    expect(res.json().enforceableScopeKinds).not.toContain("agent");
    expect(res.json().enforceableScopeKinds).not.toContain("model");
  });

  it("rejects a scope value that its kind does not take", async () => {
    const res = await arm({ scopeKind: "tool", reasonCode: "incident-42" });
    expect(res.statusCode).toBe(422);
  });

  it("stands a switch down but keeps it in the history", async () => {
    await arm({ scopeKind: "provider", scopeValue: "slack", reasonCode: "incident-42" });
    const stood = await app.inject({
      method: "DELETE",
      url: "/api/v1/kill-switches/ks-1",
      ...write(adminSid),
    });
    expect(stood.statusCode).toBe(200);
    expect(stood.json().killSwitch).toMatchObject({
      enabled: false,
      disabledBy: expect.any(String),
    });

    const listed = await app.inject({
      method: "GET",
      url: "/api/v1/kill-switches",
      cookies: { [SESSION_COOKIE]: adminSid },
    });
    expect(listed.json().killSwitches).toHaveLength(1);
  });

  it("separates an unknown switch from one already stood down", async () => {
    await arm({ scopeKind: "provider", scopeValue: "slack", reasonCode: "incident-42" });
    await app.inject({
      method: "DELETE",
      url: "/api/v1/kill-switches/ks-1",
      ...write(adminSid),
    });

    const again = await app.inject({
      method: "DELETE",
      url: "/api/v1/kill-switches/ks-1",
      ...write(adminSid),
    });
    expect(again.statusCode).toBe(409);

    const missing = await app.inject({
      method: "DELETE",
      url: "/api/v1/kill-switches/nope",
      ...write(adminSid),
    });
    expect(missing.statusCode).toBe(404);
  });

  it("leaves audit evidence naming who armed and who stood down", async () => {
    await arm({ scopeKind: "all_mutations", reasonCode: "incident-42" });
    await app.inject({
      method: "DELETE",
      url: "/api/v1/kill-switches/ks-1",
      ...write(adminSid),
    });

    expect(audits.map((entry) => entry.action)).toEqual([
      "kill_switch.enabled",
      "kill_switch.disabled",
    ]);
    expect(audits[0]).toMatchObject({
      target: "kill_switch:all_mutations",
      reasonCodes: ["incident-42"],
    });
    expect(audits[0]?.actorId).toEqual(expect.any(String));
  });
});
