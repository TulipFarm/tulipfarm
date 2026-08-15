import { promises as soulConfigFs } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { InMemoryAuditEventRepo } from "@tulipfarm/audit";
import type { SecretMeta, SecretsService } from "@tulipfarm/secrets";
import type { GitSyncService } from "@tulipfarm/soul";
import { inferLanguage, makeSoulWriterDouble, type SoulWriterDouble } from "@tulipfarm/soul";
import type { PaginatedResult } from "@tulipfarm/storage";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app";
import { AuditService } from "../audit/service";
import type { TokenDoc, TokenRepo } from "../auth/api-tokens";
import { CSRF_COOKIE, CSRF_HEADER } from "../auth/csrf";
import { SESSION_COOKIE } from "../auth/middleware";
import { MemorySessionStore } from "../auth/session-store";
import { createUser, type UserDoc, type UserRepo } from "../auth/users";

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

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    promises: {
      ...actual.promises,
      readFile: vi.fn(),
      mkdir: vi.fn(),
      writeFile: vi.fn(),
    },
  };
});

const TEST_CSRF = "a".repeat(64);

const AUDIT_BUSINESS = "deployment";
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

function makeFakeGitSync(
  overrides: Partial<{ commit: unknown; push: unknown; emit: unknown }> = {}
) {
  return {
    path: SOUL_ROOT,
    commit: vi.fn().mockResolvedValue({ sha: "abc1234", filesChanged: 2 }),
    push: vi.fn().mockResolvedValue(true),
    emit: vi.fn(),
    ...overrides,
  } as unknown as GitSyncService;
}

describe("soul routes", () => {
  let app: FastifyInstance;
  let store: MemorySessionStore;
  let userRepo: FakeUserRepo;
  let tokenRepo: FakeTokenRepo;
  let gitSync: GitSyncService;
  let soul: SoulWriterDouble;
  let sid: string;
  let adminSid: string;

  beforeEach(async () => {
    store = new MemorySessionStore();
    userRepo = new FakeUserRepo();
    tokenRepo = new FakeTokenRepo();
    gitSync = makeFakeGitSync();
    soul = makeSoulWriterDouble();

    const user = await createUser(userRepo, "user@example.com", "pass", "member");
    sid = await store.create(user._id);
    const admin = await createUser(userRepo, "admin@example.com", "pass", "admin");
    adminSid = await store.create(admin._id);

    app = await buildApp({
      sessionStore: store,
      userRepo,
      tokenRepo,
      gitSync,
      soulWriter: soul.writer,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  describe("POST /api/v1/soul/push", () => {
    it("returns 401 without auth", async () => {
      const res = await app.inject({ method: "POST", url: "/api/v1/soul/push" });
      expect(res.statusCode).toBe(401);
    });

    it("returns 200 with pushed: true when remote is configured", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/soul/push",
        cookies: { [SESSION_COOKIE]: adminSid, [CSRF_COOKIE]: TEST_CSRF },
        headers: { [CSRF_HEADER]: TEST_CSRF },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ pushed: true });
    });

    it("returns 200 with pushed: false when no remote configured", async () => {
      gitSync = makeFakeGitSync({ push: vi.fn().mockResolvedValue(false) });
      await app.close();
      app = await buildApp({
        sessionStore: store,
        userRepo,
        tokenRepo,
        gitSync,
        soulWriter: soul.writer,
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/soul/push",
        cookies: { [SESSION_COOKIE]: adminSid, [CSRF_COOKIE]: TEST_CSRF },
        headers: { [CSRF_HEADER]: TEST_CSRF },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ pushed: false });
    });
  });

  describe("POST /api/v1/soul/reload", () => {
    it("returns 401 without auth", async () => {
      const res = await app.inject({ method: "POST", url: "/api/v1/soul/reload" });
      expect(res.statusCode).toBe(401);
    });

    it("emits soul.synced and returns 204", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/soul/reload",
        cookies: { [SESSION_COOKIE]: adminSid, [CSRF_COOKIE]: TEST_CSRF },
        headers: { [CSRF_HEADER]: TEST_CSRF },
      });
      expect(res.statusCode).toBe(204);
      expect(gitSync.emit).toHaveBeenCalledWith("soul.synced");
    });
  });

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
      expect(root[0].children?.map((c) => c.name)).toEqual(["demo", "AGENT.md"]);
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

  describe("git-config routes", () => {
    function makeFakeSecretsService(keys: string[] = []) {
      return {
        list: vi.fn().mockResolvedValue(keys.map((key) => ({ key }) as SecretMeta)),
        set: vi.fn().mockResolvedValue(undefined),
      } as unknown as SecretsService;
    }

    let auditRepo: InMemoryAuditEventRepo;

    async function rebuild(gitSyncOverrides: Record<string, unknown>, secretKeys: string[] = []) {
      gitSync = {
        ...makeFakeGitSync(),
        getStatus: vi.fn().mockResolvedValue({
          remoteConfigured: false,
          ahead: 0,
          behind: 0,
          headSha: null,
          lastSyncError: null,
          lastSyncAt: null,
        }),
        configureRemote: vi.fn().mockResolvedValue(undefined),
        syncNow: vi.fn().mockResolvedValue(undefined),
        ...gitSyncOverrides,
      } as unknown as GitSyncService;
      const secretsService = makeFakeSecretsService(secretKeys);
      auditRepo = new InMemoryAuditEventRepo();
      await app.close();
      app = await buildApp({
        auditService: new AuditService(auditRepo, AUDIT_BUSINESS),
        sessionStore: store,
        userRepo,
        tokenRepo,
        gitSync,
        secretsService,
        soulWriter: soul.writer,
      });
      return secretsService;
    }

    beforeEach(() => {
      vi.mocked(soulConfigFs.readFile).mockRejectedValue(
        Object.assign(new Error("ENOENT"), { code: "ENOENT" })
      );
    });

    describe("GET /api/v1/soul/git-config", () => {
      it("returns 401 without auth", async () => {
        await rebuild({});
        const res = await app.inject({ method: "GET", url: "/api/v1/soul/git-config" });
        expect(res.statusCode).toBe(401);
      });

      it("reports not-configured with no remote and no credential", async () => {
        await rebuild({});
        const res = await app.inject({
          method: "GET",
          url: "/api/v1/soul/git-config",
          cookies: { [SESSION_COOKIE]: adminSid },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({
          credentialSet: false,
          status: {
            remoteConfigured: false,
            ahead: 0,
            behind: 0,
            headSha: null,
            lastSyncError: null,
            lastSyncAt: null,
          },
        });
      });

      it("reports remote url, credentialSet, and ahead/behind when configured", async () => {
        vi.mocked(soulConfigFs.readFile).mockResolvedValue(
          "gitRemoteUrl: https://github.com/acme/soul.git\n"
        );
        await rebuild(
          {
            getStatus: vi.fn().mockResolvedValue({
              remoteConfigured: true,
              remoteUrl: "https://github.com/acme/soul.git",
              ahead: 1,
              behind: 2,
              headSha: "abc1234",
              lastSyncError: null,
              lastSyncAt: "2026-07-02T07:00:00.000Z",
            }),
          },
          ["soul-git-credential"]
        );
        const res = await app.inject({
          method: "GET",
          url: "/api/v1/soul/git-config",
          cookies: { [SESSION_COOKIE]: adminSid },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({
          remoteUrl: "https://github.com/acme/soul.git",
          credentialSet: true,
          status: {
            remoteConfigured: true,
            ahead: 1,
            behind: 2,
            headSha: "abc1234",
            lastSyncError: null,
            lastSyncAt: "2026-07-02T07:00:00.000Z",
          },
        });
      });

      it("reports a lastSyncError when the last sync attempt failed", async () => {
        await rebuild({
          getStatus: vi.fn().mockResolvedValue({
            remoteConfigured: true,
            remoteUrl: "https://github.com/acme/soul.git",
            ahead: 0,
            behind: 0,
            headSha: "abc1234",
            lastSyncError: "could not read Username for 'https://github.com'",
            lastSyncAt: "2026-07-02T07:00:00.000Z",
          }),
        });
        const res = await app.inject({
          method: "GET",
          url: "/api/v1/soul/git-config",
          cookies: { [SESSION_COOKIE]: adminSid },
        });
        expect(res.json().status.lastSyncError).toBe(
          "could not read Username for 'https://github.com'"
        );
      });
    });

    describe("POST /api/v1/soul/sync", () => {
      it("returns 401 without auth", async () => {
        await rebuild({});
        const res = await app.inject({ method: "POST", url: "/api/v1/soul/sync" });
        expect(res.statusCode).toBe(401);
      });

      it("triggers a manual sync and returns 204 on success", async () => {
        await rebuild({});
        const res = await app.inject({
          method: "POST",
          url: "/api/v1/soul/sync",
          cookies: { [SESSION_COOKIE]: adminSid, [CSRF_COOKIE]: TEST_CSRF },
          headers: { [CSRF_HEADER]: TEST_CSRF },
        });
        expect(res.statusCode).toBe(204);
        expect(gitSync.syncNow).toHaveBeenCalled();
      });

      it("surfaces a syncNow failure as 400", async () => {
        await rebuild({
          syncNow: vi.fn().mockRejectedValue(new Error("could not read Username")),
        });
        const res = await app.inject({
          method: "POST",
          url: "/api/v1/soul/sync",
          cookies: { [SESSION_COOKIE]: adminSid, [CSRF_COOKIE]: TEST_CSRF },
          headers: { [CSRF_HEADER]: TEST_CSRF },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toContain("could not read Username");
      });
    });

    describe("PUT /api/v1/soul/git-config", () => {
      it("refuses a member re-pointing the Soul git remote, which would exfiltrate the config", async () => {
        await rebuild({});
        const res = await app.inject({
          method: "PUT",
          url: "/api/v1/soul/git-config",
          cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
          headers: { [CSRF_HEADER]: TEST_CSRF },
          payload: { remoteUrl: "https://attacker.example/soul.git" },
        });
        expect(res.statusCode).toBe(403);
        expect(gitSync.configureRemote).not.toHaveBeenCalled();
      });

      it("returns 401 without auth", async () => {
        await rebuild({});
        const res = await app.inject({
          method: "PUT",
          url: "/api/v1/soul/git-config",
          payload: { remoteUrl: "https://github.com/acme/soul.git" },
        });
        expect(res.statusCode).toBe(401);
      });

      it("returns 400 when remoteUrl is missing", async () => {
        await rebuild({});
        const res = await app.inject({
          method: "PUT",
          url: "/api/v1/soul/git-config",
          cookies: { [SESSION_COOKIE]: adminSid, [CSRF_COOKIE]: TEST_CSRF },
          headers: { [CSRF_HEADER]: TEST_CSRF },
          payload: {},
        });
        expect(res.statusCode).toBe(400);
      });

      it("records the remote change even when the sync attempt fails", async () => {
        await rebuild({
          configureRemote: vi.fn().mockRejectedValue(new Error("could not read Username")),
        });
        const res = await app.inject({
          method: "PUT",
          url: "/api/v1/soul/git-config",
          cookies: { [SESSION_COOKIE]: adminSid, [CSRF_COOKIE]: TEST_CSRF },
          headers: { [CSRF_HEADER]: TEST_CSRF },
          payload: { remoteUrl: "https://github.com/acme/soul.git", credential: "ghp_test" },
        });

        expect(res.statusCode).toBe(400);
        const [event] = await auditRepo.listChain(AUDIT_BUSINESS);
        expect(event?.action).toBe("soul-config.git-remote");
        expect(event?.reasonCodes).toContain("SOUL_DIRECT_WRITE");
        expect(event?.safeMetadata?.synced).toBe(false);
      });

      it("keeps the credential out of the ledger entirely", async () => {
        await rebuild({});
        await app.inject({
          method: "PUT",
          url: "/api/v1/soul/git-config",
          cookies: { [SESSION_COOKIE]: adminSid, [CSRF_COOKIE]: TEST_CSRF },
          headers: { [CSRF_HEADER]: TEST_CSRF },
          payload: { remoteUrl: "https://gituser:ghp_supersecret@github.com/acme/soul.git" },
        });

        const [event] = await auditRepo.listChain(AUDIT_BUSINESS);
        expect(event?.safeMetadata?.remote).toBe("https://github.com/acme/soul.git");
        expect(event?.safeMetadata?.synced).toBe(true);
        expect(JSON.stringify(event)).not.toContain("ghp_supersecret");
        expect(JSON.stringify(event)).not.toContain("gituser");
      });

      it("persists remote url, sets credential secret, and calls configureRemote", async () => {
        const secretsService = await rebuild({});
        const res = await app.inject({
          method: "PUT",
          url: "/api/v1/soul/git-config",
          cookies: { [SESSION_COOKIE]: adminSid, [CSRF_COOKIE]: TEST_CSRF },
          headers: { [CSRF_HEADER]: TEST_CSRF },
          payload: { remoteUrl: "https://github.com/acme/soul.git", credential: "ghp_test" },
        });
        expect(res.statusCode).toBe(204);
        expect(soul.applied.at(-1)?.changes[0]).toEqual({
          op: "put",
          target: { kind: "Settings" },
          content: expect.stringContaining("https://github.com/acme/soul.git"),
        });
        expect(secretsService.set).toHaveBeenCalledWith("soul-git-credential", "ghp_test");
        expect(gitSync.configureRemote).toHaveBeenCalledWith(
          "https://github.com/acme/soul.git",
          expect.any(Function)
        );
        const providerArg = vi.mocked(gitSync.configureRemote).mock.calls[0][1];
        await expect(providerArg()).resolves.toBe("ghp_test");
      });

      it("surfaces a configureRemote failure as 400", async () => {
        await rebuild({
          configureRemote: vi.fn().mockRejectedValue(new Error("Authentication failed")),
        });
        const res = await app.inject({
          method: "PUT",
          url: "/api/v1/soul/git-config",
          cookies: { [SESSION_COOKIE]: adminSid, [CSRF_COOKIE]: TEST_CSRF },
          headers: { [CSRF_HEADER]: TEST_CSRF },
          payload: { remoteUrl: "https://github.com/acme/soul.git", credential: "bad_token" },
        });
        expect(res.statusCode).toBe(400);
      });
    });
  });

  describe("business profile routes", () => {
    let adminSid: string;

    beforeEach(async () => {
      const admin = await createUser(userRepo, "admin@example.com", "pass", "admin");
      adminSid = await store.create(admin._id);
      vi.mocked(soulConfigFs.readFile).mockRejectedValue(enoent());
    });

    it("returns 401 without auth", async () => {
      const res = await app.inject({ method: "GET", url: "/api/v1/business" });
      expect(res.statusCode).toBe(401);
    });

    it("reads name/description/website out of soul.yaml", async () => {
      vi.mocked(soulConfigFs.readFile).mockResolvedValue(
        "businessName: Fernwood Roasters\n" +
          "businessDescription: Speciality coffee wholesale.\n" +
          "businessWebsite: https://fernwood.coffee\n"
      );
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/business",
        cookies: { [SESSION_COOKIE]: sid },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        name: "Fernwood Roasters",
        description: "Speciality coffee wholesale.",
        website: "https://fernwood.coffee",
      });
    });

    it("answers with empty strings rather than nulls when nothing is set", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/business",
        cookies: { [SESSION_COOKIE]: sid },
      });
      expect(res.json()).toEqual({ name: "", description: "", website: "" });
    });

    it("writes the soul.yaml keys and re-emits soul.synced", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/api/v1/business",
        cookies: { [SESSION_COOKIE]: adminSid, [CSRF_COOKIE]: TEST_CSRF },
        headers: { [CSRF_HEADER]: TEST_CSRF },
        payload: { name: "  Fernwood Roasters  ", description: " Coffee. ", website: "" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        name: "Fernwood Roasters",
        description: "Coffee.",
        website: "",
      });
      expect(soul.applied.at(-1)?.changes[0]).toEqual({
        op: "put",
        target: { kind: "Settings" },
        content: expect.stringContaining("businessName: Fernwood Roasters"),
      });
      expect(vi.mocked(gitSync.emit)).toHaveBeenCalledWith("soul.synced");
    });

    it("refuses a write from a non-admin", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/api/v1/business",
        cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
        headers: { [CSRF_HEADER]: TEST_CSRF },
        payload: { name: "Anything" },
      });
      expect(res.statusCode).toBe(403);
    });

    it("rejects a blank name", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/api/v1/business",
        cookies: { [SESSION_COOKIE]: adminSid, [CSRF_COOKIE]: TEST_CSRF },
        headers: { [CSRF_HEADER]: TEST_CSRF },
        payload: { name: "   " },
      });
      expect(res.statusCode).toBe(400);
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
