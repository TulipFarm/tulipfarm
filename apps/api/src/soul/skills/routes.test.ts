import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { GitSyncService, SoulLoader, SoulSkill } from "@tulipfarm/soul";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../app";
import type { TokenDoc, TokenRepo } from "../../auth/api-tokens";
import { CSRF_COOKIE, CSRF_HEADER } from "../../auth/csrf";
import { SESSION_COOKIE } from "../../auth/middleware";
import { MemorySessionStore } from "../../auth/session-store";
import { createUser, type UserDoc, type UserRepo } from "../../auth/users";
import type { PaginatedResult } from "../../pagination";

// Keep the report schema real (used in the route's response schema); mock only the LLM call.
const buildAudit = vi.fn();
vi.mock("./audit", async (orig) => {
  const actual = await orig<typeof import("./audit")>();
  return { ...actual, buildAudit: (...args: unknown[]) => buildAudit(...args) };
});

const execFileP = promisify(execFile);
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
  async findAllPaginated(): Promise<PaginatedResult<TokenDoc>> {
    return { items: [], nextCursor: null };
  }
  async findByUserIdPaginated(): Promise<PaginatedResult<TokenDoc>> {
    return { items: [], nextCursor: null };
  }
}

const skill = (name: string, description: string): SoulSkill => ({
  name,
  frontmatter: { name, description },
  body: `# ${name}\n${description}`,
});

// Build a throwaway local git repo containing one installable skill — `git clone <path>` reads it
// offline, so the scan flow is exercised without any network.
async function makeRemoteRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "skill-remote-"));
  const skillDir = join(dir, "skills", "demo-skill");
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, "SKILL.md"),
    "---\nname: demo-skill\ndescription: A demo skill.\n---\nDo the demo.",
    "utf8"
  );
  const git = (args: string[]) => execFileP("git", args, { cwd: dir });
  await git(["init", "-q"]);
  await git(["config", "user.email", "t@t.t"]);
  await git(["config", "user.name", "t"]);
  await git(["add", "-A"]);
  await git(["commit", "-q", "-m", "init"]);
  return dir;
}

describe("skills routes", () => {
  let app: FastifyInstance;
  let store: MemorySessionStore;
  let sid: string;
  let soulPath: string;
  let withSync: ReturnType<typeof vi.fn>;
  let reload: ReturnType<typeof vi.fn>;
  let soulLoader: SoulLoader;
  const temps: string[] = [];

  beforeEach(async () => {
    store = new MemorySessionStore();
    const userRepo = new FakeUserRepo();
    const tokenRepo = new FakeTokenRepo();
    const user = await createUser(userRepo, "user@example.com", "pass", "member");
    sid = await store.create(user._id);

    soulPath = await mkdtemp(join(tmpdir(), "skill-soul-"));
    temps.push(soulPath);
    withSync = vi.fn().mockResolvedValue({ sha: "abc1234", filesChanged: 2 });
    reload = vi.fn().mockResolvedValue(undefined);

    soulLoader = {
      skills: new Map<string, SoulSkill>([
        ["installed-skill", skill("installed-skill", "From the marketplace.")],
        ["my-skill", skill("my-skill", "Authored by hand.")],
      ]),
      agents: new Map(),
      reload,
    } as unknown as SoulLoader;

    const gitSync = {
      path: soulPath,
      withSync,
      commit: vi.fn(),
      push: vi.fn(),
    } as unknown as GitSyncService;

    // Mark one skill as marketplace-installed so provenance differs from the hand-authored one.
    await writeFile(
      join(soulPath, "skills-lock.json"),
      JSON.stringify({
        version: 1,
        skills: { "installed-skill": { source: "owner/repo", sourceType: "github" } },
      }),
      "utf8"
    );

    const llmService = { select: vi.fn().mockReturnValue({}) } as never;
    app = await buildApp({
      sessionStore: store,
      userRepo,
      tokenRepo,
      gitSync,
      soulLoader,
      llmService,
    });
    buildAudit.mockReset();
  });

  afterEach(async () => {
    await app.close();
    for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  // `sid` is assigned in beforeEach, so read it lazily per-request (not captured at describe time).
  const auth = () => ({ [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF });
  const headers = { [CSRF_HEADER]: TEST_CSRF };

  describe("GET /api/v1/skills", () => {
    it("returns 401 without auth", async () => {
      const res = await app.inject({ method: "GET", url: "/api/v1/skills" });
      expect(res.statusCode).toBe(401);
    });

    it("lists skills with provenance derived from skills-lock.json", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/skills",
        cookies: auth(),
        headers,
      });
      expect(res.statusCode).toBe(200);
      const { skills } = res.json();
      expect(skills).toContainEqual({
        name: "installed-skill",
        description: "From the marketplace.",
        provenance: "marketplace",
        source: "owner/repo",
      });
      expect(skills).toContainEqual({
        name: "my-skill",
        description: "Authored by hand.",
        provenance: "user",
      });
    });

    it("does not crash when skills-lock.json is an empty object", async () => {
      // A freshly-initialized soul has `{}` — no `skills` key (regression: would 500 on lock.skills).
      await writeFile(join(soulPath, "skills-lock.json"), "{}", "utf8");
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/skills",
        cookies: auth(),
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().skills.every((s: { provenance: string }) => s.provenance === "user")).toBe(
        true
      );
    });
  });

  describe("GET /api/v1/skills/:name", () => {
    it("returns the skill with its markdown body", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/skills/my-skill",
        cookies: auth(),
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().body).toContain("Authored by hand");
    });

    it("returns 404 for an unknown skill", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/skills/ghost",
        cookies: auth(),
        headers,
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("POST /api/v1/skills/scan", () => {
    it("returns 400 when the repo cannot be cloned", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/skills/scan",
        cookies: auth(),
        headers,
        payload: { source: `file://${join(tmpdir(), "does-not-exist-xyz")}` },
      });
      expect(res.statusCode).toBe(400);
    });

    it("rejects a disallowed source scheme (ssh) before cloning", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/skills/scan",
        cookies: auth(),
        headers,
        payload: { source: "ssh://internal-host/repo.git" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/owner\/repo|http/);
    });
  });

  describe("scan → audit → install flow", () => {
    it("scans a local repo, audits a discovered skill (advisory), then installs on confirm", async () => {
      const remote = await makeRemoteRepo();
      temps.push(remote);
      // Cloned via a file:// URL so the source guard allows it (bare local paths are rejected).
      const fileUrl = `file://${remote}`;

      // 1. SCAN — discovers the skill, does NOT install it.
      const scanRes = await app.inject({
        method: "POST",
        url: "/api/v1/skills/scan",
        cookies: auth(),
        headers,
        payload: { source: fileUrl },
      });
      expect(scanRes.statusCode).toBe(200);
      const { scanId, skills } = scanRes.json();
      expect(skills).toEqual([{ name: "demo-skill", description: "A demo skill." }]);
      // Nothing written to the soul repo by scanning.
      await expect(access(join(soulPath, "skills", "demo-skill", "SKILL.md"))).rejects.toThrow();

      // 2. AUDIT — advisory report; install still required.
      buildAudit.mockResolvedValue({
        riskRating: "medium",
        summary: "Reads files.",
        toolsReach: ["filesystem"],
        findings: [{ severity: "warning", category: "credential-access", detail: "reads ~/.ssh" }],
      });
      const auditRes = await app.inject({
        method: "POST",
        url: "/api/v1/skills/audit",
        cookies: auth(),
        headers,
        payload: { scanId, name: "demo-skill" },
      });
      expect(auditRes.statusCode).toBe(200);
      expect(auditRes.json().report.riskRating).toBe("medium");
      expect(buildAudit).toHaveBeenCalledOnce();
      // Audit alone installs nothing.
      expect(withSync).not.toHaveBeenCalled();
      await expect(access(join(soulPath, "skills", "demo-skill", "SKILL.md"))).rejects.toThrow();

      // 3. INSTALL — operator confirm. Writes the file, updates the lock, commits, reloads.
      const installRes = await app.inject({
        method: "POST",
        url: "/api/v1/skills/install",
        cookies: auth(),
        headers,
        payload: { scanId, names: ["demo-skill"] },
      });
      expect(installRes.statusCode).toBe(200);
      expect(installRes.json()).toEqual({ installed: ["demo-skill"] });

      const written = await readFile(join(soulPath, "skills", "demo-skill", "SKILL.md"), "utf8");
      expect(written).toContain("Do the demo.");
      const lock = JSON.parse(await readFile(join(soulPath, "skills-lock.json"), "utf8"));
      expect(lock.skills["demo-skill"]).toMatchObject({ source: fileUrl, sourceType: "git" });
      expect(lock.skills["demo-skill"].computedHash).toMatch(/^[0-9a-f]{64}$/);
      expect(withSync).toHaveBeenCalledOnce();
      expect(reload).toHaveBeenCalledOnce();
    });

    it("returns 404 when auditing an unknown scan", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/skills/audit",
        cookies: auth(),
        headers,
        payload: { scanId: "nope", name: "demo-skill" },
      });
      expect(res.statusCode).toBe(404);
    });

    it("refuses to install a skill that has not been audited (409) and writes nothing", async () => {
      const remote = await makeRemoteRepo();
      temps.push(remote);
      const scanRes = await app.inject({
        method: "POST",
        url: "/api/v1/skills/scan",
        cookies: auth(),
        headers,
        payload: { source: `file://${remote}` },
      });
      const { scanId } = scanRes.json();

      // Skip audit → install must be rejected (AC-V1-003: confirm only after seeing the report).
      const installRes = await app.inject({
        method: "POST",
        url: "/api/v1/skills/install",
        cookies: auth(),
        headers,
        payload: { scanId, names: ["demo-skill"] },
      });
      expect(installRes.statusCode).toBe(409);
      expect(withSync).not.toHaveBeenCalled();
      await expect(access(join(soulPath, "skills", "demo-skill", "SKILL.md"))).rejects.toThrow();
    });
  });
});
