import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import { InMemoryGroupRepo, InMemoryPrincipalRepo, InMemoryRoleRepo } from "@tulipfarm/storage";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app";
import type { AuditRecordInput } from "../audit/service";
import type { TokenDoc, TokenRepo } from "../auth/api-tokens";
import { CSRF_COOKIE, CSRF_HEADER } from "../auth/csrf";
import { SESSION_COOKIE } from "../auth/routes";
import { MemorySessionStore } from "../auth/session-store";
import { createUser, type UserDoc, type UserRepo } from "../auth/users";
import { LiveAuthorityLayerResolver } from "../identity/authority-layers";
import type { PaginatedResult } from "../pagination";
import { AUTHZ_ADMIN_CHANGE, AuthzAdminService } from "./service";

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

const BUSINESS = DEPLOYMENT_BUSINESS_ID;

describe("authz admin routes", () => {
  let app: FastifyInstance;
  let adminSid: string;
  let memberSid: string;
  let roles: InMemoryRoleRepo;
  let groups: InMemoryGroupRepo;
  let principals: InMemoryPrincipalRepo;
  let audits: AuditRecordInput[];

  beforeEach(async () => {
    const store = new MemorySessionStore();
    const userRepo = new FakeUserRepo();
    const tokenRepo = new FakeTokenRepo();
    const admin = await createUser(userRepo, "admin@example.com", "pass", "admin");
    const member = await createUser(userRepo, "member@example.com", "pass", "member");
    adminSid = await store.create(admin._id);
    memberSid = await store.create(member._id);

    roles = new InMemoryRoleRepo();
    groups = new InMemoryGroupRepo();
    principals = new InMemoryPrincipalRepo();
    audits = [];

    // A reserved (built-in) Role and an authored one, so `listRoles` can distinguish them.
    await roles.putRole({
      id: "admin",
      businessId: BUSINESS,
      assignableTo: ["user"],
      parentRoleIds: [],
      grants: [],
    });
    await roles.putRole({
      id: "support",
      businessId: BUSINESS,
      assignableTo: ["user"],
      parentRoleIds: [],
      grants: [{ action: "record.read", resourceType: "ticket", effect: "allow" }],
    });
    // A Role a user principal may not hold — drives the not_assignable path.
    await roles.putRole({
      id: "agent-only",
      businessId: BUSINESS,
      assignableTo: ["agent"],
      parentRoleIds: [],
      grants: [],
    });

    await principals.put({ id: "p-user", businessId: BUSINESS, kind: "user", status: "active" });
    await principals.put({ id: "p-two", businessId: BUSINESS, kind: "user", status: "active" });
    // A real, durable Agent principal that holds no roles. Explain must distinguish this — an
    // Agent that genuinely grants nothing — from an id that names no principal at all.
    await principals.put({ id: "a-bare", businessId: BUSINESS, kind: "agent", status: "active" });
    await roles.assign({ businessId: BUSINESS, principalId: "p-user", roleId: "support" });

    const resolver = new LiveAuthorityLayerResolver({ principals, roles, groups });
    const service = new AuthzAdminService({
      roles,
      groups,
      principals,
      resolver,
      businessId: BUSINESS,
      audit: { recordOrWarn: async (input) => void audits.push(input) },
    });

    app = await buildApp({ sessionStore: store, userRepo, tokenRepo, authzAdmin: service });
  });

  afterEach(async () => {
    await app.close();
  });

  // ── Admin gate ────────────────────────────────────────────────────────────

  describe("admin gate", () => {
    it("returns 401 without auth", async () => {
      const res = await app.inject({ method: "GET", url: "/api/v1/authz/roles" });
      expect(res.statusCode).toBe(401);
    });

    it("returns 403 for a non-admin user", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/authz/roles",
        cookies: { [SESSION_COOKIE]: memberSid },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: "forbidden" });
    });

    it("returns 200 for an admin user", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/authz/roles",
        cookies: { [SESSION_COOKIE]: adminSid },
      });
      expect(res.statusCode).toBe(200);
    });
  });

  // ── Read ──────────────────────────────────────────────────────────────────

  it("lists roles distinguishing built-in from authored", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/authz/roles",
      cookies: { [SESSION_COOKIE]: adminSid },
    });
    expect(res.statusCode).toBe(200);
    const bySource = Object.fromEntries(
      res.json().roles.map((r: { id: string; source: string }) => [r.id, r.source])
    );
    expect(bySource.admin).toBe("builtin");
    expect(bySource.support).toBe("authored");
  });

  it("lists a role's assignees and 404s an unknown role", async () => {
    const ok = await app.inject({
      method: "GET",
      url: "/api/v1/authz/roles/support/assignees",
      cookies: { [SESSION_COOKIE]: adminSid },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().assignees.map((a: { principalId: string }) => a.principalId)).toContain(
      "p-user"
    );

    const missing = await app.inject({
      method: "GET",
      url: "/api/v1/authz/roles/nope/assignees",
      cookies: { [SESSION_COOKIE]: adminSid },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("lists a principal's effective grants and 404s an unknown principal", async () => {
    const ok = await app.inject({
      method: "GET",
      url: "/api/v1/authz/principals/p-user/grants",
      cookies: { [SESSION_COOKIE]: adminSid },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().grants).toContainEqual(
      expect.objectContaining({ effect: "allow", action: "record.read", resourceType: "ticket" })
    );

    const missing = await app.inject({
      method: "GET",
      url: "/api/v1/authz/principals/ghost/grants",
      cookies: { [SESSION_COOKIE]: adminSid },
    });
    expect(missing.statusCode).toBe(404);
  });

  // ── Explain ─────────────────────────────────────────────────────────────────

  describe("explain", () => {
    const explain = (body: Record<string, unknown>) => ({
      method: "POST" as const,
      url: "/api/v1/authz/explain",
      ...write(adminSid),
      payload: body,
    });

    it("allows a covered request", async () => {
      const res = await app.inject(
        explain({ principalId: "p-user", action: "record.read", resourceType: "ticket" })
      );
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ allowed: true, reason: "allowed", kind: "user" });
    });

    it("denies an uncovered request and names the denying layer", async () => {
      const res = await app.inject(
        explain({ principalId: "p-user", action: "record.delete", resourceType: "ticket" })
      );
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        allowed: false,
        reason: "no_matching_allow",
        deniedLayer: "user",
      });
    });

    /**
     * `decideEffectivePermission` allows only when EVERY layer allows, so evaluating a subset can
     * only ever be more permissive than the real gate. This endpoint reaches the live layers but
     * not the pinned run/guardrail/credential ones, which makes an `allowed` an upper bound rather
     * than a guarantee. A diagnostic tool that silently answers "yes" where the gate says "no" is
     * worse than no tool, because it is trusted — so the partiality must travel in the response.
     */
    it("marks an allow as partial and names the layers it could not reach", async () => {
      const res = await app.inject(
        explain({ principalId: "p-user", action: "record.read", resourceType: "ticket" })
      );
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.allowed).toBe(true);
      expect(body.partial).toBe(true);
      expect(body.evaluatedLayers).toEqual(["user"]);
      // The agent layer is unevaluated because no agentId was supplied; the other three are
      // structurally unreachable outside a Run.
      expect(body.unevaluatedLayers).toEqual(["agent", "run", "guardrail", "credential"]);
    });

    it("intersects the Agent layer when an agentId is supplied, and says so", async () => {
      const res = await app.inject(
        explain({
          principalId: "p-user",
          action: "record.read",
          resourceType: "ticket",
          agentId: "a-bare",
        })
      );
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.evaluatedLayers).toEqual(["user", "agent"]);
      expect(body.unevaluatedLayers).not.toContain("agent");
      // An Agent holding no roles resolves to an empty layer, and intersection narrows: the same
      // request the caller layer allows is denied once the Agent layer joins it. This is the whole
      // reason a one-layer answer cannot be trusted as a gate answer.
      expect(body.allowed).toBe(false);
      expect(body.deniedLayer).toBe("agent");
    });

    it("names why an evaluated layer is empty instead of passing a data fault off as policy", async () => {
      // A principal whose only assignment names a Role the durable store does not have. The
      // resolver correctly fails the whole layer closed, so the observable result is identical to
      // a principal who simply holds nothing — and an operator told "holds nothing, expected" at
      // the moment of an unrecoverable lockout will go looking in the wrong place entirely.
      await principals.put({
        id: "p-dangling",
        businessId: BUSINESS,
        kind: "user",
        status: "active",
      });
      await roles.assign({ businessId: BUSINESS, principalId: "p-dangling", roleId: "vanished" });

      const res = await app.inject(
        explain({ principalId: "p-dangling", action: "record.read", resourceType: "ticket" })
      );
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.allowed).toBe(false);
      expect(body.layerEmptyReasons).toEqual({ user: "unknown-role" });
      expect(body.unresolvedRoleIds).toEqual(["vanished"]);

      const grants = await app.inject({
        method: "GET",
        url: "/api/v1/authz/principals/p-dangling/grants",
        cookies: { [SESSION_COOKIE]: adminSid },
      });
      expect(grants.json().grants).toEqual([]);
      expect(grants.json().emptyReason).toBe("unknown-role");
      expect(grants.json().unresolvedRoleIds).toEqual(["vanished"]);
    });

    it("distinguishes a principal that genuinely holds no roles from one that could not resolve", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/authz/principals/p-two/grants",
        cookies: { [SESSION_COOKIE]: adminSid },
      });
      expect(res.json().grants).toEqual([]);
      expect(res.json().emptyReason).toBe("no-roles-assigned");
      expect(res.json().unresolvedRoleIds).toBeUndefined();
    });

    it("404s an unknown agentId instead of reporting it as an agent-layer denial", async () => {
      const res = await app.inject(
        explain({
          principalId: "p-user",
          action: "record.read",
          resourceType: "ticket",
          agentId: "no-such-agent",
        })
      );
      // The empty layer a missing principal resolves to would otherwise render as a confident
      // `deniedLayer: "agent"`, sending an operator to author grants for a principal that is not
      // there. A typo is a 404, not a policy finding.
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toContain("no-such-agent");
    });

    it("404s an unknown principal", async () => {
      const res = await app.inject(
        explain({ principalId: "ghost", action: "record.read", resourceType: "ticket" })
      );
      expect(res.statusCode).toBe(404);
    });
  });

  // ── Role definition authoring is Soul-only ───────────────────────────────────

  it("returns 501 for role definition authoring", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/authz/roles",
      ...write(adminSid),
      payload: {},
    });
    expect(res.statusCode).toBe(501);
    expect(res.json().error).toMatch(/authored in Soul/i);
  });

  // ── Assign / revoke ───────────────────────────────────────────────────────

  describe("assign / revoke roles", () => {
    it("assigns a role, audits it, then revokes", async () => {
      const assigned = await app.inject({
        method: "POST",
        url: "/api/v1/authz/roles/support/assignments",
        ...write(adminSid),
        payload: { principalId: "p-two" },
      });
      expect(assigned.statusCode).toBe(200);
      expect(await roles.listAssignees(BUSINESS, "support", new Date())).toEqual(
        expect.arrayContaining([expect.objectContaining({ principalId: "p-two" })])
      );
      expect(audits).toContainEqual(
        expect.objectContaining({
          action: "authz.assignment.create",
          reasonCodes: [AUTHZ_ADMIN_CHANGE],
        })
      );

      const revoked = await app.inject({
        method: "DELETE",
        url: "/api/v1/authz/roles/support/assignments/p-two",
        ...write(adminSid),
      });
      expect(revoked.statusCode).toBe(200);
      const after = await roles.listAssignees(BUSINESS, "support", new Date());
      expect(after.map((a) => a.principalId)).not.toContain("p-two");
    });

    it("404s assigning an unknown role", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/authz/roles/nope/assignments",
        ...write(adminSid),
        payload: { principalId: "p-two" },
      });
      expect(res.statusCode).toBe(404);
    });

    it("404s assigning to an unknown principal", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/authz/roles/support/assignments",
        ...write(adminSid),
        payload: { principalId: "ghost" },
      });
      expect(res.statusCode).toBe(404);
    });

    it("400s assigning a role the principal kind may not hold", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/authz/roles/agent-only/assignments",
        ...write(adminSid),
        payload: { principalId: "p-user" },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ── Groups ────────────────────────────────────────────────────────────────

  describe("groups", () => {
    it("creates, inspects, mutates, and deletes a group", async () => {
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/authz/groups",
        ...write(adminSid),
        payload: { id: "ops" },
      });
      expect(created.statusCode).toBe(201);

      await app.inject({
        method: "POST",
        url: "/api/v1/authz/groups/ops/members",
        ...write(adminSid),
        payload: { principalId: "p-user" },
      });
      await app.inject({
        method: "POST",
        url: "/api/v1/authz/groups/ops/roles",
        ...write(adminSid),
        payload: { roleId: "support" },
      });

      const detail = await app.inject({
        method: "GET",
        url: "/api/v1/authz/groups/ops",
        cookies: { [SESSION_COOKIE]: adminSid },
      });
      expect(detail.statusCode).toBe(200);
      expect(detail.json().members.map((m: { principalId: string }) => m.principalId)).toContain(
        "p-user"
      );
      expect(detail.json().roles.map((r: { roleId: string }) => r.roleId)).toContain("support");

      // Membership in a group holding `support` grants the member the group role's grants.
      // Asserted against `p-two`, which holds NO direct assignment — `p-user` is directly assigned
      // `support` in the fixture, so the same assertion on it would pass with group inheritance
      // entirely broken and prove nothing.
      await app.inject({
        method: "POST",
        url: "/api/v1/authz/groups/ops/members",
        ...write(adminSid),
        payload: { principalId: "p-two" },
      });
      expect(await roles.listAssignments(BUSINESS, "p-two", new Date())).toEqual([]);
      const grants = await app.inject({
        method: "GET",
        url: "/api/v1/authz/principals/p-two/grants",
        cookies: { [SESSION_COOKIE]: adminSid },
      });
      expect(grants.json().grants).toContainEqual(
        expect.objectContaining({ action: "record.read", resourceType: "ticket" })
      );

      const deleted = await app.inject({
        method: "DELETE",
        url: "/api/v1/authz/groups/ops",
        ...write(adminSid),
      });
      expect(deleted.statusCode).toBe(200);
      expect(await groups.getGroup(BUSINESS, "ops")).toBeUndefined();
    });

    it("re-stating a group answers 200 and records the expiry it overwrote", async () => {
      // `putGroup` is a full upsert, so re-posting without `expiresAt` clears a deliberate expiry.
      // A 201 there would report "created" for a silent widening of a time-boxed group.
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/authz/groups",
        ...write(adminSid),
        payload: { id: "temp", expiresAt: "2999-01-01T00:00:00.000Z" },
      });
      expect(created.statusCode).toBe(201);

      const restated = await app.inject({
        method: "POST",
        url: "/api/v1/authz/groups",
        ...write(adminSid),
        payload: { id: "temp" },
      });
      expect(restated.statusCode).toBe(200);
      expect((await groups.getGroup(BUSINESS, "temp"))?.expiresAt).toBeUndefined();

      const upserts = audits.filter((e) => e.action === "authz.group.upsert");
      const last = upserts[upserts.length - 1];
      expect(last?.safeMetadata).toMatchObject({
        created: false,
        previousExpiresAt: "2999-01-01T00:00:00.000Z",
        expiryCleared: true,
      });
    });

    it("404s deleting an unknown group", async () => {
      const res = await app.inject({
        method: "DELETE",
        url: "/api/v1/authz/groups/ghost",
        ...write(adminSid),
      });
      expect(res.statusCode).toBe(404);
    });

    it("404s adding a member to an unknown group", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/authz/groups/ghost/members",
        ...write(adminSid),
        payload: { principalId: "p-user" },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // The gap that made default-deny unrecoverable. Production mints subjects that are not users —
  // `integration:<slug>` for a Slack or Telegram delivery, `agent:assistant` for a chat-started
  // Routine, `service:cron-scheduler` for a schedule fire — and a principal with no durable row
  // resolves to an empty authority layer, which under intersection denies everything. Nothing
  // could write those rows, so no UI could restore a deployment that had locked its channels out.
  describe("non-human principals", () => {
    const register = (body: { readonly id: string; readonly kind: string }) => ({
      method: "POST" as const,
      url: "/api/v1/authz/principals",
      payload: body,
      ...write(adminSid),
    });

    it("registers an Integration adapter and makes it grantable", async () => {
      const res = await app.inject(
        register({ id: "integration:slack", kind: "integration_adapter" })
      );
      expect(res.statusCode).toBe(200);
      expect(await principals.get(BUSINESS, "integration:slack")).toMatchObject({
        kind: "integration_adapter",
        status: "active",
      });

      // Grantable is the point: a registered principal can now hold a Role authored for its kind.
      await roles.putRole({
        id: "channel-ingress",
        businessId: BUSINESS,
        assignableTo: ["integration_adapter"],
        parentRoleIds: [],
        grants: [{ action: "record.read", resourceType: "ticket", effect: "allow" }],
      });
      const assigned = await app.inject({
        method: "POST",
        url: "/api/v1/authz/roles/channel-ingress/assignments",
        payload: { principalId: "integration:slack" },
        ...write(adminSid),
      });
      expect(assigned.statusCode).toBe(200);

      const grants = await app.inject({
        method: "GET",
        url: "/api/v1/authz/principals/integration:slack/grants",
        cookies: { [SESSION_COOKIE]: adminSid },
      });
      expect(grants.json().grants).toHaveLength(1);
    });

    it("audits the registration", async () => {
      await app.inject(register({ id: "service:cron-scheduler", kind: "service" }));
      expect(audits).toContainEqual(
        expect.objectContaining({
          action: "authz.principal.register",
          target: "principal:service:cron-scheduler",
          reasonCodes: [AUTHZ_ADMIN_CHANGE],
        })
      );
    });

    it("lists every principal, so a non-human one can be found at all", async () => {
      await app.inject(register({ id: "agent:assistant", kind: "agent" }));
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/authz/principals",
        cookies: { [SESSION_COOKIE]: adminSid },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().map((p: { id: string }) => p.id)).toContain("agent:assistant");
    });

    // Those rows are owned by the `sync_user_authorization()` trigger. A hand-written one would be
    // overwritten without notice, or drift from the account it claims to represent.
    it("refuses to register a user principal", async () => {
      const res = await app.inject(register({ id: "p-three", kind: "user" }));
      expect(res.statusCode).toBe(400);
      expect(await principals.get(BUSINESS, "p-three")).toBeUndefined();
    });

    // Silently re-pointing an id at a different kind would re-interpret every Role assignment
    // already made against it, because `assertRoleAssignable` is evaluated per kind.
    it("refuses to change an existing principal's kind", async () => {
      const res = await app.inject(register({ id: "a-bare", kind: "service" }));
      expect(res.statusCode).toBe(409);
      expect(await principals.get(BUSINESS, "a-bare")).toMatchObject({ kind: "agent" });
    });

    it("is idempotent when the kind is unchanged", async () => {
      await app.inject(register({ id: "agent:assistant", kind: "agent" }));
      const again = await app.inject(register({ id: "agent:assistant", kind: "agent" }));
      expect(again.statusCode).toBe(200);
    });

    it("is admin-gated like every other authorization change", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/authz/principals",
        payload: { id: "service:rogue", kind: "service" },
        ...write(memberSid),
      });
      expect(res.statusCode).toBe(403);
      expect(await principals.get(BUSINESS, "service:rogue")).toBeUndefined();
    });
  });

  describe("last-owner protection", () => {
    // `owner` is the only Role that can grant `authz.*`, and Role *definitions* are Soul-owned — this
    // API answers 501 to authoring one. So an owner set that reaches zero cannot be repaired from the
    // product at all. There are four doors to emptying it, not one, and each is tested here.
    async function seedOwner() {
      await roles.putRole({
        id: "owner",
        businessId: BUSINESS,
        assignableTo: ["user"],
        parentRoleIds: [],
        grants: [{ action: "authz.manage", resourceType: "authz", effect: "allow" }],
      });
    }

    it("refuses to revoke the last direct owner assignment", async () => {
      await seedOwner();
      await roles.assign({ businessId: BUSINESS, principalId: "p-user", roleId: "owner" });

      const res = await app.inject({
        method: "DELETE",
        url: "/api/v1/authz/roles/owner/assignments/p-user",
        ...write(adminSid),
      });
      expect(res.statusCode).toBe(409);
      expect(await roles.listAssignees(BUSINESS, "owner", new Date())).toHaveLength(1);
    });

    it("allows revoking an owner assignment while another owner remains", async () => {
      await seedOwner();
      await roles.assign({ businessId: BUSINESS, principalId: "p-user", roleId: "owner" });
      await roles.assign({ businessId: BUSINESS, principalId: "p-two", roleId: "owner" });

      const res = await app.inject({
        method: "DELETE",
        url: "/api/v1/authz/roles/owner/assignments/p-user",
        ...write(adminSid),
      });
      expect(res.statusCode).toBe(200);
    });

    it("refuses to remove the last member of the group that holds owner", async () => {
      await seedOwner();
      await groups.putGroup({ businessId: BUSINESS, id: "owners" });
      await groups.assignRole({ businessId: BUSINESS, groupId: "owners", roleId: "owner" });
      await groups.addMember({ businessId: BUSINESS, groupId: "owners", principalId: "p-user" });

      const res = await app.inject({
        method: "DELETE",
        url: "/api/v1/authz/groups/owners/members/p-user",
        ...write(adminSid),
      });
      expect(res.statusCode).toBe(409);
      expect(await groups.listMembers(BUSINESS, "owners", new Date())).toHaveLength(1);
    });

    it("refuses to revoke owner from the group that is the only source of it", async () => {
      await seedOwner();
      await groups.putGroup({ businessId: BUSINESS, id: "owners" });
      await groups.assignRole({ businessId: BUSINESS, groupId: "owners", roleId: "owner" });
      await groups.addMember({ businessId: BUSINESS, groupId: "owners", principalId: "p-user" });

      const res = await app.inject({
        method: "DELETE",
        url: "/api/v1/authz/groups/owners/roles/owner",
        ...write(adminSid),
      });
      expect(res.statusCode).toBe(409);
    });

    it("refuses to delete the group that is the only source of owner", async () => {
      await seedOwner();
      await groups.putGroup({ businessId: BUSINESS, id: "owners" });
      await groups.assignRole({ businessId: BUSINESS, groupId: "owners", roleId: "owner" });
      await groups.addMember({ businessId: BUSINESS, groupId: "owners", principalId: "p-user" });

      const res = await app.inject({
        method: "DELETE",
        url: "/api/v1/authz/groups/owners",
        ...write(adminSid),
      });
      expect(res.statusCode).toBe(409);
      expect(await groups.getGroup(BUSINESS, "owners")).not.toBeUndefined();
    });

    it("does not block ordinary group mutations when no owner exists at all", async () => {
      // The invariant is "do not be the action that drops ownership to zero", not "an owner must
      // exist". A deployment with no owner yet must stay operable, or the operator cannot reach the
      // state that satisfies the invariant.
      await groups.putGroup({ businessId: BUSINESS, id: "ops" });
      const res = await app.inject({
        method: "DELETE",
        url: "/api/v1/authz/groups/ops",
        ...write(adminSid),
      });
      expect(res.statusCode).toBe(200);
    });
  });
});
