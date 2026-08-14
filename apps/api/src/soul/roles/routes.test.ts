/** Access-level route tests pin the gate for reads and writes of grantable authority. */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitSyncService } from "@tulipfarm/soul";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../app";
import type { SoulAuditWriter } from "../../audit/soul-write";
import type { TokenDoc, TokenRepo } from "../../auth/api-tokens";
import { CSRF_COOKIE, CSRF_HEADER } from "../../auth/csrf";
import { makeRequireAuth, SESSION_COOKIE } from "../../auth/middleware";
import { MemorySessionStore } from "../../auth/session-store";
import { createUser, type UserDoc, type UserRepo } from "../../auth/users";
import type { CapabilityCatalog } from "../../authz/capabilities";
import { registerAccessLevelRoutes } from "./routes";

const TEST_CSRF = "a".repeat(64);

class FakeUserRepo implements UserRepo {
  private users: UserDoc[] = [];
  async findByEmail(email: string) {
    return this.users.find((u) => u.email === email.trim().toLowerCase()) ?? null;
  }
  async findById(id: string) {
    return this.users.find((u) => u._id === id) ?? null;
  }
  async count() {
    return this.users.length;
  }
  async insert(user: UserDoc) {
    this.users.push(user);
  }
}

class FakeTokenRepo implements TokenRepo {
  async create() {}
  async findByHash() {
    return null;
  }
  async findByUserId() {
    return [];
  }
  async findAll() {
    return [] as TokenDoc[];
  }
  async findById() {
    return null;
  }
  async deleteById() {}
  async findAllPaginated() {
    return { items: [] as TokenDoc[], nextCursor: null };
  }
  async findByUserIdPaginated() {
    return { items: [] as TokenDoc[], nextCursor: null };
  }
}

const CATALOG: CapabilityCatalog = {
  areas: [
    {
      id: "record",
      label: "Records",
      capabilities: [
        {
          id: "record.read",
          action: "record.read",
          resourceTypes: ["record"],
          label: "See record",
          changesThings: false,
          tools: ["record_get"],
        },
        {
          id: "record.create",
          action: "record.create",
          resourceTypes: ["record"],
          label: "Add record",
          changesThings: true,
          tools: ["record_create"],
        },
      ],
    },
  ],
  unavailable: [
    {
      action: "soul.repo.push",
      resourceTypes: ["Tool"],
      tools: ["soul_repo_push"],
      reason: "resource_not_authorable",
    },
  ],
};

describe("access level routes", () => {
  let app: FastifyInstance;
  let store: MemorySessionStore;
  let soulPath: string;
  let withSync: ReturnType<typeof vi.fn>;
  let reconcile: ReturnType<typeof vi.fn>;
  let adminSid: string;
  let memberSid: string;
  let auditWrite: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    soulPath = await mkdtemp(join(tmpdir(), "tf-level-routes-"));
    withSync = vi.fn(async () => undefined);
    reconcile = vi.fn(async () => undefined);
    auditWrite = vi.fn(async () => undefined);
    store = new MemorySessionStore();
    const userRepo = new FakeUserRepo();
    const tokenRepo = new FakeTokenRepo();
    const admin = await createUser(userRepo, "admin@example.com", "pass", "admin");
    const member = await createUser(userRepo, "member@example.com", "pass", "member");
    adminSid = await store.create(admin._id);
    memberSid = await store.create(member._id);

    app = await buildApp({ sessionStore: store, userRepo, tokenRepo });
    registerAccessLevelRoutes(app, {
      gitSync: { path: soulPath, withSync } as unknown as GitSyncService,
      requireAuth: makeRequireAuth({ store, userRepo, tokenRepo }),
      catalog: () => CATALOG,
      reconcile: reconcile as unknown as () => Promise<void>,
      auditWrite: auditWrite as unknown as SoulAuditWriter,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await rm(soulPath, { recursive: true, force: true });
  });

  const as = (
    sid: string,
    method: "GET" | "POST" | "PATCH" | "DELETE",
    url: string,
    payload?: Record<string, unknown>
  ) => ({
    method,
    url,
    cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
    headers: { [CSRF_HEADER]: TEST_CSRF },
    ...(payload === undefined ? {} : { payload }),
  });

  const CREATE = { name: "Kitchen staff", capabilities: ["record.read"] };

  describe("the gate", () => {
    it.each([
      ["GET", "/api/v1/authz/capabilities", undefined],
      ["POST", "/api/v1/authz/levels", CREATE],
      ["PATCH", "/api/v1/authz/levels/anything", CREATE],
      ["DELETE", "/api/v1/authz/levels/anything", undefined],
    ] as const)("refuses %s %s without a session", async (method, url, payload) => {
      const res = await app.inject({
        method,
        url,
        ...(payload === undefined ? {} : { payload }),
        headers: { [CSRF_HEADER]: TEST_CSRF },
        cookies: { [CSRF_COOKIE]: TEST_CSRF },
      });
      expect(res.statusCode).toBe(401);
    });

    it.each([
      ["GET", "/api/v1/authz/capabilities", undefined],
      ["POST", "/api/v1/authz/levels", CREATE],
      ["PATCH", "/api/v1/authz/levels/anything", CREATE],
      ["DELETE", "/api/v1/authz/levels/anything", undefined],
    ] as const)("refuses %s %s for a member", async (method, url, payload) => {
      const res = await app.inject(as(memberSid, method, url, payload));
      expect(res.statusCode).toBe(403);
      expect(withSync).not.toHaveBeenCalled();
    });

    /* The catalog maps grantable authority, so it is owner-only. */
    it("keeps the capability catalog behind the same gate as the writes", async () => {
      const denied = await app.inject(as(memberSid, "GET", "/api/v1/authz/capabilities"));
      expect(denied.statusCode).toBe(403);
      expect(denied.body).not.toContain("record.read");
    });
  });

  describe("GET /api/v1/authz/capabilities", () => {
    it("returns capabilities in plain language, grouped by area", async () => {
      const res = await app.inject(as(adminSid, "GET", "/api/v1/authz/capabilities"));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(CATALOG);
    });

    /*
     * Silently dropping what cannot be granted would leave an owner hunting for a permission the
     * screen has decided not to mention.
     */
    it("admits what it cannot offer instead of hiding it", async () => {
      const res = await app.inject(as(adminSid, "GET", "/api/v1/authz/capabilities"));
      expect(res.json().unavailable).toEqual([
        {
          action: "soul.repo.push",
          resourceTypes: ["Tool"],
          tools: ["soul_repo_push"],
          reason: "resource_not_authorable",
        },
      ]);
    });
  });

  describe("POST /api/v1/authz/levels", () => {
    it("creates a level and reports where it landed", async () => {
      const res = await app.inject(as(adminSid, "POST", "/api/v1/authz/levels", CREATE));
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ slug: "kitchen-staff", displayName: "Kitchen staff" });

      const written = await readFile(join(soulPath, "roles", "kitchen-staff", "role.yaml"), "utf8");
      expect(written).toContain("record.read");
      expect(reconcile).toHaveBeenCalledOnce();
    });

    it("names the capability it could not grant rather than failing vaguely", async () => {
      const res = await app.inject(
        as(adminSid, "POST", "/api/v1/authz/levels", {
          name: "Bad",
          capabilities: ["record.read", "integration.create"],
        })
      );
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        code: "unknown_capabilities",
        unknown: ["integration.create"],
      });
    });

    it("answers 409 when the name is taken", async () => {
      await app.inject(as(adminSid, "POST", "/api/v1/authz/levels", CREATE));
      const res = await app.inject(as(adminSid, "POST", "/api/v1/authz/levels", CREATE));
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("slug_taken");
    });

    it("answers 409 for a built-in name", async () => {
      const res = await app.inject(
        as(adminSid, "POST", "/api/v1/authz/levels", {
          name: "Owner",
          capabilities: ["record.read"],
        })
      );
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("reserved_slug");
    });

    it("rejects a level that grants nothing before it reaches the Soul repo", async () => {
      const res = await app.inject(
        as(adminSid, "POST", "/api/v1/authz/levels", { name: "Empty", capabilities: [] })
      );
      expect(res.statusCode).toBe(400);
      expect(withSync).not.toHaveBeenCalled();
    });
  });

  describe("PATCH /api/v1/authz/levels/:slug", () => {
    it("edits a level in place, keeping its identity", async () => {
      const created = await app.inject(as(adminSid, "POST", "/api/v1/authz/levels", CREATE));
      const res = await app.inject(
        as(adminSid, "PATCH", "/api/v1/authz/levels/kitchen-staff", {
          name: "Kitchen crew",
          capabilities: ["record.read", "record.create"],
        })
      );
      expect(res.statusCode).toBe(200);
      // Same id means the same durable row, which means everybody holding the level still holds it.
      expect(res.json().id).toBe(created.json().id);
      expect(res.json().slug).toBe("kitchen-staff");
      expect(res.json().displayName).toBe("Kitchen crew");
    });

    it("refuses to edit a built-in level", async () => {
      const res = await app.inject(as(adminSid, "PATCH", "/api/v1/authz/levels/owner", CREATE));
      expect(res.statusCode).toBe(409);
    });

    it("answers 404 for a level that does not exist", async () => {
      const res = await app.inject(as(adminSid, "PATCH", "/api/v1/authz/levels/ghost", CREATE));
      expect(res.statusCode).toBe(404);
    });

    it("does not let a slug walk out of the roles directory", async () => {
      const res = await app.inject(
        as(adminSid, "PATCH", `/api/v1/authz/levels/${encodeURIComponent("../..")}`, CREATE)
      );
      expect(res.statusCode).toBe(404);
      expect(withSync).not.toHaveBeenCalled();
    });

    it("refuses a level with no capabilities", async () => {
      await app.inject(as(adminSid, "POST", "/api/v1/authz/levels", CREATE));
      withSync.mockClear();
      const res = await app.inject(
        as(adminSid, "PATCH", "/api/v1/authz/levels/kitchen-staff", {
          name: "Kitchen staff",
          capabilities: [],
        })
      );
      expect(res.statusCode).toBe(400);
      expect(withSync).not.toHaveBeenCalled();
    });
  });

  describe("DELETE /api/v1/authz/levels/:slug", () => {
    it("deletes an authored level", async () => {
      await app.inject(as(adminSid, "POST", "/api/v1/authz/levels", CREATE));
      const res = await app.inject(as(adminSid, "DELETE", "/api/v1/authz/levels/kitchen-staff"));
      expect(res.statusCode).toBe(204);
      await expect(
        readFile(join(soulPath, "roles", "kitchen-staff", "role.yaml"), "utf8")
      ).rejects.toThrow();
    });

    it("refuses to delete a built-in level", async () => {
      const res = await app.inject(as(adminSid, "DELETE", "/api/v1/authz/levels/owner"));
      expect(res.statusCode).toBe(409);
    });

    it("answers 404 for a level that does not exist", async () => {
      const res = await app.inject(as(adminSid, "DELETE", "/api/v1/authz/levels/ghost"));
      expect(res.statusCode).toBe(404);
    });

    it("does not let a slug walk out of the roles directory", async () => {
      const res = await app.inject(
        as(adminSid, "DELETE", `/api/v1/authz/levels/${encodeURIComponent("../..")}`)
      );
      expect(res.statusCode).toBe(404);
      expect(withSync).not.toHaveBeenCalled();
    });
  });

  /* Access-level writes must record actor and timestamp like sibling Soul write routes. */
  describe("writes are recorded in the audit ledger", () => {
    it("records who created a level", async () => {
      const res = await app.inject(
        as(adminSid, "POST", "/api/v1/authz/levels", {
          name: "Kitchen staff",
          capabilities: ["record.read"],
        })
      );
      expect(res.statusCode).toBe(201);
      expect(auditWrite).toHaveBeenCalledWith(
        expect.anything(),
        "authz.level.create",
        "authz-level:kitchen-staff",
        { capabilities: 1 }
      );
    });

    it("records who deleted a level", async () => {
      await app.inject(
        as(adminSid, "POST", "/api/v1/authz/levels", {
          name: "Kitchen staff",
          capabilities: ["record.read"],
        })
      );
      auditWrite.mockClear();
      const res = await app.inject(as(adminSid, "DELETE", "/api/v1/authz/levels/kitchen-staff"));
      expect(res.statusCode).toBe(204);
      expect(auditWrite).toHaveBeenCalledWith(
        expect.anything(),
        "authz.level.delete",
        "authz-level:kitchen-staff"
      );
    });

    it("records who edited a level", async () => {
      await app.inject(
        as(adminSid, "POST", "/api/v1/authz/levels", {
          name: "Kitchen staff",
          capabilities: ["record.read"],
        })
      );
      auditWrite.mockClear();
      const res = await app.inject(
        as(adminSid, "PATCH", "/api/v1/authz/levels/kitchen-staff", {
          name: "Kitchen crew",
          capabilities: ["record.read"],
        })
      );
      expect(res.statusCode).toBe(200);
      expect(auditWrite).toHaveBeenCalledWith(
        expect.anything(),
        "authz.level.update",
        "authz-level:kitchen-staff",
        expect.anything()
      );
    });

    it("does not record a write that never happened", async () => {
      await app.inject(as(adminSid, "DELETE", "/api/v1/authz/levels/ghost"));
      expect(auditWrite).not.toHaveBeenCalled();
    });
  });

  it("publishes every endpoint in the OpenAPI spec", async () => {
    const res = await app.inject(as(adminSid, "GET", "/api/v1/openapi.json"));
    const paths = res.json().paths;
    expect(paths["/api/v1/authz/capabilities"]).toBeDefined();
    expect(paths["/api/v1/authz/levels"].post.security).toEqual([
      { sessionCookie: [] },
      { bearerToken: [] },
    ]);
    expect(paths["/api/v1/authz/levels/{slug}"].delete).toBeDefined();
    expect(paths["/api/v1/authz/levels/{slug}"].patch.security).toEqual([
      { sessionCookie: [] },
      { bearerToken: [] },
    ]);
  });
});
