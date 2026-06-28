import { readdir, readFile, realpath, stat } from "node:fs/promises";
import type { GitSyncService } from "@tulipfarm/soul";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app";
import type { TokenDoc, TokenRepo } from "../auth/api-tokens";
import { CSRF_COOKIE, CSRF_HEADER } from "../auth/csrf";
import { SESSION_COOKIE } from "../auth/middleware";
import { MemorySessionStore } from "../auth/session-store";
import { createUser, type UserDoc, type UserRepo } from "../auth/users";
import type { PaginatedResult } from "../pagination";
import { inferLanguage } from "./tree";

// Override only the FS calls used by the soul tree/file routes; keep everything else real.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readdir: vi.fn(),
    readFile: vi.fn(),
    realpath: vi.fn(),
    stat: vi.fn(),
  };
});

const TEST_CSRF = "a".repeat(64);

const SOUL_ROOT = "/soul";

const enoent = () => Object.assign(new Error("ENOENT"), { code: "ENOENT" });

type Kind = "dir" | "file" | "link";
function dirent(name: string, kind: Kind) {
  return {
    name,
    isDirectory: () => kind === "dir",
    isFile: () => kind === "file",
    isSymbolicLink: () => kind === "link",
  };
}

// Configure the mocked FS to model a tiny soul repo on disk.
function mockSoulFs() {
  vi.mocked(readdir).mockImplementation((async (p: string) => {
    const key = String(p);
    if (key === SOUL_ROOT) {
      return [dirent("agents", "dir"), dirent(".git", "dir"), dirent("soul.yaml", "file")];
    }
    if (key === `${SOUL_ROOT}/agents`) return [dirent("demo", "dir"), dirent("AGENT.md", "file")];
    if (key === `${SOUL_ROOT}/agents/demo`) return [dirent("AGENT.md", "file")];
    throw enoent();
  }) as unknown as typeof readdir);

  vi.mocked(stat).mockImplementation((async () => ({
    isFile: () => true,
    size: 42,
  })) as unknown as typeof stat);

  vi.mocked(realpath).mockImplementation((async (p: string) => {
    const key = String(p);
    if (key.includes("missing")) throw enoent();
    return key;
  }) as unknown as typeof realpath);

  vi.mocked(readFile).mockImplementation((async (p: string) => {
    if (String(p).includes("data.bin")) return Buffer.from([0x68, 0x69, 0x00, 0x69]);
    return Buffer.from("name: demo\n", "utf8");
  }) as unknown as typeof readFile);
}

// ── Fake dependencies ─────────────────────────────────────────────────────────

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

function makeFakeGitSync(overrides: Partial<{ commit: unknown; push: unknown }> = {}) {
  return {
    path: SOUL_ROOT,
    commit: vi.fn().mockResolvedValue({ sha: "abc1234", filesChanged: 2 }),
    push: vi.fn().mockResolvedValue(true),
    ...overrides,
  } as unknown as GitSyncService;
}

// ── Test setup ────────────────────────────────────────────────────────────────

describe("soul routes", () => {
  let app: FastifyInstance;
  let store: MemorySessionStore;
  let userRepo: FakeUserRepo;
  let tokenRepo: FakeTokenRepo;
  let gitSync: GitSyncService;
  let sid: string;

  beforeEach(async () => {
    store = new MemorySessionStore();
    userRepo = new FakeUserRepo();
    tokenRepo = new FakeTokenRepo();
    gitSync = makeFakeGitSync();

    const user = await createUser(userRepo, "user@example.com", "pass", "member");
    sid = await store.create(user._id);

    app = await buildApp({ sessionStore: store, userRepo, tokenRepo, gitSync });
  });

  afterEach(async () => {
    await app.close();
  });

  // ── POST /api/v1/soul/commit ──────────────────────────────────────────────

  describe("POST /api/v1/soul/commit", () => {
    it("returns 401 without auth", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/soul/commit",
        payload: { message: "chore: update soul" },
      });
      expect(res.statusCode).toBe(401);
    });

    it("returns 200 with sha and filesChanged on successful commit", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/soul/commit",
        cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
        headers: { [CSRF_HEADER]: TEST_CSRF },
        payload: { message: "chore: update soul" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ sha: "abc1234", filesChanged: 2 });
    });

    it("returns 204 when nothing to commit (empty sha)", async () => {
      gitSync = makeFakeGitSync({
        commit: vi.fn().mockResolvedValue({ sha: "", filesChanged: 0 }),
      });
      await app.close();
      app = await buildApp({ sessionStore: store, userRepo, tokenRepo, gitSync });

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/soul/commit",
        cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
        headers: { [CSRF_HEADER]: TEST_CSRF },
        payload: { message: "chore: update soul" },
      });
      expect(res.statusCode).toBe(204);
    });

    it("returns 400 when message is missing", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/soul/commit",
        cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
        headers: { [CSRF_HEADER]: TEST_CSRF },
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ── POST /api/v1/soul/push ────────────────────────────────────────────────

  describe("POST /api/v1/soul/push", () => {
    it("returns 401 without auth", async () => {
      const res = await app.inject({ method: "POST", url: "/api/v1/soul/push" });
      expect(res.statusCode).toBe(401);
    });

    it("returns 200 with pushed: true when remote is configured", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/soul/push",
        cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
        headers: { [CSRF_HEADER]: TEST_CSRF },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ pushed: true });
    });

    it("returns 200 with pushed: false when no remote configured", async () => {
      gitSync = makeFakeGitSync({ push: vi.fn().mockResolvedValue(false) });
      await app.close();
      app = await buildApp({ sessionStore: store, userRepo, tokenRepo, gitSync });

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/soul/push",
        cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
        headers: { [CSRF_HEADER]: TEST_CSRF },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ pushed: false });
    });
  });

  // ── GET /api/v1/soul/tree ─────────────────────────────────────────────────

  describe("GET /api/v1/soul/tree", () => {
    beforeEach(() => mockSoulFs());

    it("returns 401 without auth", async () => {
      const res = await app.inject({ method: "GET", url: "/api/v1/soul/tree" });
      expect(res.statusCode).toBe(401);
    });

    it("returns the tree with .git excluded and dirs sorted first", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/soul/tree",
        cookies: { [SESSION_COOKIE]: sid },
      });
      expect(res.statusCode).toBe(200);
      type Node = { name: string; children?: Node[] };
      const { root } = res.json() as { root: Node[] };
      expect(root.map((n) => n.name)).toEqual(["agents", "soul.yaml"]);
      // dirs sorted before files at each level
      expect(root[0].children?.map((c) => c.name)).toEqual(["demo", "AGENT.md"]);
      // depth-2 children survive serialization (recursive response schema)
      expect(root[0].children?.[0].children?.map((c) => c.name)).toEqual(["AGENT.md"]);
    });

    it("returns an empty tree when the soul directory is missing", async () => {
      vi.mocked(readdir).mockRejectedValueOnce(enoent());
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/soul/tree",
        cookies: { [SESSION_COOKIE]: sid },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ root: [] });
    });
  });

  // ── GET /api/v1/soul/file ─────────────────────────────────────────────────

  describe("GET /api/v1/soul/file", () => {
    beforeEach(() => mockSoulFs());

    it("returns 401 without auth", async () => {
      const res = await app.inject({ method: "GET", url: "/api/v1/soul/file?path=soul.yaml" });
      expect(res.statusCode).toBe(401);
    });

    it("returns raw content with inferred language", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/soul/file?path=soul.yaml",
        cookies: { [SESSION_COOKIE]: sid },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        path: "soul.yaml",
        content: "name: demo\n",
        language: "yaml",
      });
    });

    it("flags binary files without returning their bytes", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/soul/file?path=data.bin",
        cookies: { [SESSION_COOKIE]: sid },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ binary: true, content: "" });
    });

    it("rejects path traversal with 400", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/soul/file?path=../../../etc/passwd",
        cookies: { [SESSION_COOKIE]: sid },
      });
      expect(res.statusCode).toBe(400);
    });

    it("rejects .git access with 400", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/soul/file?path=.git/config",
        cookies: { [SESSION_COOKIE]: sid },
      });
      expect(res.statusCode).toBe(400);
    });

    it("rejects nested .git access (e.g. submodules) with 400", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/soul/file?path=agents/.git/config",
        cookies: { [SESSION_COOKIE]: sid },
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 404 for a missing file", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/soul/file?path=missing.yaml",
        cookies: { [SESSION_COOKIE]: sid },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("inferLanguage", () => {
    it("maps soul filenames to Shiki languages", () => {
      expect(inferLanguage("AGENT.md")).toBe("markdown");
      expect(inferLanguage("hooks.ts")).toBe("typescript");
      expect(inferLanguage("schema.yml")).toBe("yaml");
      expect(inferLanguage("skills-lock.json")).toBe("json");
      expect(inferLanguage("setup.sh")).toBe("bash");
      expect(inferLanguage("LICENSE")).toBe("plaintext");
    });
  });
});
