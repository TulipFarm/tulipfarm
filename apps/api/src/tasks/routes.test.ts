import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { vector } from "@electric-sql/pglite-pgvector";
import { InMemoryAuditEventRepo } from "@tulipfarm/audit";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type { MemoryAssertionView, MemoryRepo } from "@tulipfarm/memory";
import { MemoryService } from "@tulipfarm/memory";
import { type GitSyncService, makeSoulWriterDouble } from "@tulipfarm/soul";
import { TASK_STORAGE_STATEMENTS, type TaskAction, TaskRepo } from "@tulipfarm/storage";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app";
import { AuditService } from "../audit/service";
import type { TokenDoc, TokenRepo } from "../auth/api-tokens";
import { CSRF_COOKIE, CSRF_HEADER } from "../auth/csrf";
import { SESSION_COOKIE } from "../auth/middleware";
import { MemorySessionStore } from "../auth/session-store";
import { createUser, type UserDoc, type UserRepo } from "../auth/users";

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
  private tokens: TokenDoc[] = [];
  async create(token: TokenDoc) {
    this.tokens.push(token);
  }
  async findByHash(hash: string) {
    return this.tokens.find((t) => t.tokenHash === hash) ?? null;
  }
  async findByUserId(userId: string) {
    return this.tokens.filter((t) => t.userId === userId);
  }
  async findAll() {
    return [...this.tokens];
  }
  async findById(id: string) {
    return this.tokens.find((t) => t._id === id) ?? null;
  }
  async deleteById(id: string) {
    this.tokens = this.tokens.filter((t) => t._id !== id);
  }
  async findAllPaginated() {
    return { items: [], nextCursor: null };
  }
  async findByUserIdPaginated() {
    return { items: [], nextCursor: null };
  }
}

class FakeMemoryRepo implements MemoryRepo {
  rows: MemoryAssertionView[] = [];
  async upsert(doc: MemoryAssertionView) {
    const i = this.rows.findIndex((r) => r.userId === doc.userId && r.key === doc.key);
    if (i >= 0) this.rows[i] = doc;
    else this.rows.push(doc);
  }
  async deleteByKey(userId: string, key: string) {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => !(r.userId === userId && r.key === key));
    return this.rows.length < before;
  }
  async listByUser(userId: string) {
    return this.rows.filter((r) => r.userId === userId);
  }
}

function makeFakeGitSync() {
  return {
    commit: vi.fn().mockResolvedValue({ sha: "abc1234", filesChanged: 0 }),
    push: vi.fn().mockResolvedValue(true),
    emit: vi.fn(),
    path: "/tmp/soul",
  } as unknown as GitSyncService;
}

/** Real TaskRepo against in-process PGlite, mirroring `task-repo.pg.test.ts`'s setup. */
async function makeTaskRepo(): Promise<{ repo: TaskRepo; database: PGlite }> {
  const database = await PGlite.create({ extensions: { vector, citext, pg_trgm } });
  for (const sql of TASK_STORAGE_STATEMENTS) await database.exec(sql);
  const repo = new TaskRepo({
    withTransaction: (operation) => database.transaction((tx) => operation(tx as never)),
  });
  return { repo, database };
}

interface Harness {
  app: FastifyInstance;
  database: PGlite;
  repo: TaskRepo;
  memoryRepo: FakeMemoryRepo;
  auditRepo: InMemoryAuditEventRepo;
  adminSid: string;
  memberSid: string;
  adminId: string;
  memberId: string;
}

async function appWith(): Promise<Harness> {
  const { repo, database } = await makeTaskRepo();
  const sessionStore = new MemorySessionStore();
  const userRepo = new FakeUserRepo();
  const tokenRepo = new FakeTokenRepo();
  const admin = await createUser(userRepo, "admin@example.com", "pass", "admin");
  const member = await createUser(userRepo, "member@example.com", "pass", "member");
  const adminSid = await sessionStore.create(admin._id);
  const memberSid = await sessionStore.create(member._id);
  const memoryRepo = new FakeMemoryRepo();
  const auditRepo = new InMemoryAuditEventRepo();

  const app = await buildApp({
    sessionStore,
    userRepo,
    tokenRepo,
    gitSync: makeFakeGitSync(),
    soulWriter: makeSoulWriterDouble().writer,
    taskStore: repo,
    auditService: new AuditService(auditRepo, DEPLOYMENT_BUSINESS_ID),
    memoryService: new MemoryService(memoryRepo),
  });

  return {
    app,
    database,
    repo,
    memoryRepo,
    auditRepo,
    adminSid,
    memberSid,
    adminId: admin._id,
    memberId: member._id,
  };
}

function req(sid: string, method: "GET" | "POST", url: string, payload?: object) {
  return {
    method,
    url,
    payload,
    cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
    headers: { [CSRF_HEADER]: TEST_CSRF },
  };
}

async function seedTask(
  h: Harness,
  overrides: {
    assigneeKind?: "user" | "role";
    assigneeId?: string;
    dedupeKey?: string;
    title?: string;
    action?: TaskAction;
    blocking?: boolean;
  } = {}
) {
  return h.repo.upsertOpen(
    {
      businessId: DEPLOYMENT_BUSINESS_ID,
      assigneeKind: overrides.assigneeKind ?? "role",
      assigneeId: overrides.assigneeId ?? "admin",
      dedupeKey: overrides.dedupeKey ?? "provider-key",
      title: overrides.title ?? "Plant your model key",
      action: overrides.action ?? { kind: "link", href: "/settings/secrets" },
      ...(overrides.blocking === undefined ? {} : { blocking: overrides.blocking }),
    },
    new Date("2026-01-01T00:00:00Z")
  );
}

describe("tasks routes", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await appWith();
  });

  afterEach(async () => {
    await h.app.close();
    await h.database.close();
  });

  describe("GET /api/v1/tasks", () => {
    it("returns 401 without auth", async () => {
      const res = await h.app.inject({ method: "GET", url: "/api/v1/tasks" });
      expect(res.statusCode).toBe(401);
    });

    it("returns direct-user and role-matched tasks, ranked", async () => {
      await seedTask(h, { dedupeKey: "provider-key", assigneeId: "admin" });
      await seedTask(h, {
        assigneeKind: "user",
        assigneeId: h.adminId,
        dedupeKey: "meeting-nudge",
        action: { kind: "ack" },
      });
      // Different assignee must not leak in.
      await seedTask(h, {
        assigneeKind: "user",
        assigneeId: "some-other-user",
        dedupeKey: "not-mine",
        action: { kind: "ack" },
      });

      const res = await h.app.inject(req(h.adminSid, "GET", "/api/v1/tasks"));
      expect(res.statusCode).toBe(200);
      const body = res.json() as { tasks: { id: string }[] };
      expect(body.tasks).toHaveLength(2);
    });
  });

  describe("POST /api/v1/tasks/:id/answer", () => {
    it("business_profile sink requires admin: 403 for member, then succeeds for admin", async () => {
      const task = await seedTask(h, {
        dedupeKey: "business-name",
        action: { kind: "answer", field: "businessName", sink: "business_profile" },
      });

      const memberRes = await h.app.inject(
        req(h.memberSid, "POST", `/api/v1/tasks/${task.id}/answer`, { value: "Acme" })
      );
      expect(memberRes.statusCode).toBe(403);

      const adminRes = await h.app.inject(
        req(h.adminSid, "POST", `/api/v1/tasks/${task.id}/answer`, { value: "Acme Tulips" })
      );
      expect(adminRes.statusCode).toBe(200);
      expect(adminRes.json()).toMatchObject({ id: task.id, answered: true });

      const stored = await h.repo.get(DEPLOYMENT_BUSINESS_ID, task.id);
      expect(stored?.status).toBe("done");
      const auditChain = await h.auditRepo.listChain(DEPLOYMENT_BUSINESS_ID);
      expect(auditChain.length).toBeGreaterThan(0);
    });

    it("memory sink calls MemoryService.update for the caller", async () => {
      const task = await seedTask(h, {
        assigneeKind: "user",
        assigneeId: h.memberId,
        dedupeKey: "employee-count",
        action: { kind: "answer", field: "employeeCount", sink: "memory" },
      });

      const res = await h.app.inject(
        req(h.memberSid, "POST", `/api/v1/tasks/${task.id}/answer`, { value: "12" })
      );
      expect(res.statusCode).toBe(200);
      const stored = await h.memoryRepo.listByUser(h.memberId);
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({ key: "employeeCount", value: "12" });
    });

    it("400s when the task's action is not answer", async () => {
      const task = await seedTask(h, {
        dedupeKey: "first-agent",
        action: { kind: "chat", prompt: "Help me create an agent" },
      });
      const res = await h.app.inject(
        req(h.adminSid, "POST", `/api/v1/tasks/${task.id}/answer`, { value: "x" })
      );
      expect(res.statusCode).toBe(400);
    });
  });

  describe("POST /api/v1/tasks/:id/claim", () => {
    it("claims an open role task, and a second claim 409s", async () => {
      const task = await seedTask(h, {
        dedupeKey: "github-triage-agent-missing",
        assigneeId: "admin",
        action: { kind: "chat", prompt: "Set up GitHub triage?" },
      });

      const first = await h.app.inject(req(h.adminSid, "POST", `/api/v1/tasks/${task.id}/claim`));
      expect(first.statusCode).toBe(200);
      expect(first.json()).toMatchObject({ id: task.id, status: "claimed" });

      const second = await h.app.inject(req(h.adminSid, "POST", `/api/v1/tasks/${task.id}/claim`));
      expect(second.statusCode).toBe(409);
    });
  });

  describe("POST /api/v1/tasks/:id/done", () => {
    it("marks a chat/link/ack task done", async () => {
      const task = await seedTask(h, {
        dedupeKey: "first-knowledge",
        action: { kind: "chat", prompt: "Add a knowledge page" },
      });
      const res = await h.app.inject(req(h.adminSid, "POST", `/api/v1/tasks/${task.id}/done`));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id: task.id, status: "done" });

      const second = await h.app.inject(req(h.adminSid, "POST", `/api/v1/tasks/${task.id}/done`));
      expect(second.statusCode).toBe(409);
    });
  });

  describe("POST /api/v1/tasks/:id/snooze", () => {
    it("hides a task until a given time", async () => {
      const task = await seedTask(h, { dedupeKey: "invite-teammates" });
      const res = await h.app.inject(
        req(h.adminSid, "POST", `/api/v1/tasks/${task.id}/snooze`, {
          until: "2026-02-01T00:00:00Z",
        })
      );
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id: task.id, status: "snoozed" });

      const listRes = await h.app.inject(req(h.adminSid, "GET", "/api/v1/tasks"));
      expect((listRes.json() as { tasks: unknown[] }).tasks).toHaveLength(0);
    });

    it("409s snoozing an already-dismissed task", async () => {
      const task = await seedTask(h, { dedupeKey: "invite-teammates" });
      await h.app.inject(req(h.adminSid, "POST", `/api/v1/tasks/${task.id}/dismiss`));
      const res = await h.app.inject(
        req(h.adminSid, "POST", `/api/v1/tasks/${task.id}/snooze`, {
          until: "2026-02-01T00:00:00Z",
        })
      );
      expect(res.statusCode).toBe(409);
    });
  });

  describe("POST /api/v1/tasks/:id/dismiss", () => {
    it("permanently dismisses a task", async () => {
      const task = await seedTask(h, { dedupeKey: "invite-teammates" });
      const res = await h.app.inject(req(h.adminSid, "POST", `/api/v1/tasks/${task.id}/dismiss`));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id: task.id, status: "dismissed" });

      const second = await h.app.inject(
        req(h.adminSid, "POST", `/api/v1/tasks/${task.id}/dismiss`)
      );
      expect(second.statusCode).toBe(409);
    });
  });
});
