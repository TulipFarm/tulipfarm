import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { LlmNotConfiguredError } from "@tulipfarm/schema";
import type { BundledSkill } from "@tulipfarm/soul";
import {
  type CommitSigner,
  convertLegacySkill,
  type GitSyncService,
  type Logger,
  SoulGitStore,
  SoulLoader,
  type SoulSkill,
  SoulWriter,
} from "@tulipfarm/soul";
import type { PaginatedResult } from "@tulipfarm/storage";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../app";
import type { TokenDoc, TokenRepo } from "../../auth/api-tokens";
import { CSRF_COOKIE, CSRF_HEADER } from "../../auth/csrf";
import { SESSION_COOKIE } from "../../auth/middleware";
import { MemorySessionStore } from "../../auth/session-store";
import { createUser, type UserDoc, type UserRepo } from "../../auth/users";

// Keep the report schema real (used in the route's response schema); mock only the LLM call.
const buildAudit = vi.fn();
vi.mock("./audit", async (orig) => {
  const actual = await orig<typeof import("./audit")>();
  return { ...actual, buildAudit: (...args: unknown[]) => buildAudit(...args) };
});

const execFileP = promisify(execFile);
const TEST_CSRF = "a".repeat(64);
const CLEAN_DETERMINISTIC_SCAN = {
  verdict: "safe" as const,
  trustLevel: "community" as const,
  findings: [],
};

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
// offline, so the scan flow is exercised without any network. Optionally writes a root
// marketplace.json (the curated-catalog manifest read by GET /api/v1/skills/marketplace).
async function makeRemoteRepo(
  manifest?: unknown,
  skillContent = "---\nname: demo-skill\ndescription: A demo skill.\n---\nDo the demo.",
  category?: string
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "skill-remote-"));
  const skillDir = category ? join(dir, category, "demo-skill") : join(dir, "skills", "demo-skill");
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), skillContent, "utf8");
  if (manifest !== undefined) {
    await writeFile(join(dir, "marketplace.json"), JSON.stringify(manifest), "utf8");
  }
  const git = (args: string[]) => execFileP("git", args, { cwd: dir });
  await git(["init", "-q"]);
  await git(["config", "user.email", "t@t.t"]);
  await git(["config", "user.name", "t"]);
  await git(["add", "-A"]);
  await git(["commit", "-q", "-m", "init"]);
  return dir;
}

async function headOf(dir: string): Promise<string> {
  const { stdout } = await execFileP("git", ["rev-parse", "HEAD"], { cwd: dir });
  return stdout.trim();
}

describe("skills routes", () => {
  let app: FastifyInstance;
  let store: MemorySessionStore;
  let sid: string;
  let soulPath: string;
  let soulWriter: SoulWriter;
  let commitPaths: ReturnType<typeof vi.fn>;
  /** Commit subjects the gateway accepted, in order. */
  let commits: string[];
  let reload: ReturnType<typeof vi.fn>;
  let soulLoader: SoulLoader;
  let bundledSkills: Map<string, BundledSkill>;
  let disabledBundledSkills: Set<string>;
  const temps: string[] = [];

  beforeEach(async () => {
    // These tests serve their fixtures from local git repos, which the clone policy denies unless
    // the deployment opted in. The policy itself is exercised in "clone source policy" below.
    process.env.GIT_SOURCE_ALLOW_LOCAL_PATHS = "1";
    store = new MemorySessionStore();
    const userRepo = new FakeUserRepo();
    const tokenRepo = new FakeTokenRepo();
    const user = await createUser(userRepo, "user@example.com", "pass", "member");
    sid = await store.create(user._id);

    soulPath = await mkdtemp(join(tmpdir(), "skill-soul-"));
    temps.push(soulPath);
    // A real repository, not a double: these tests assert what landed on disk, and the whole
    // point of routing installs through the gateway is that the tree it produces is the contract.
    for (const args of [
      ["init", "--quiet", "--initial-branch=main"],
      ["config", "user.email", "bot@example.com"],
      ["config", "user.name", "bot"],
    ]) {
      execFileSync("git", args, { cwd: soulPath });
    }
    reload = vi.fn().mockResolvedValue(undefined);

    soulLoader = {
      skills: new Map<string, SoulSkill>([
        ["installed-skill", skill("installed-skill", "From the marketplace.")],
        ["my-skill", skill("my-skill", "Authored by hand.")],
      ]),
      agents: new Map(),
      reload,
    } as unknown as SoulLoader;
    bundledSkills = new Map([
      [
        "resource-forge",
        {
          ...skill("resource-forge", "Bundled Resource forge."),
          category: "forge",
          categoryDescription: "Forge Skills.",
          directory: "/app/skills/forge/resource-forge",
          references: [],
        },
      ],
    ]);
    disabledBundledSkills = new Set();

    commitPaths = vi.fn().mockResolvedValue({ sha: "abc1234", filesChanged: 1 });
    const gitSync = {
      path: soulPath,
      commitPaths,
      commit: vi.fn(),
      push: vi.fn(),
    } as unknown as GitSyncService;

    // Mark one skill as marketplace-installed so provenance differs from the hand-authored one.
    await writeFile(
      join(soulPath, "skills-lock.json"),
      JSON.stringify({
        version: 1,
        skills: { "installed-skill": { sourceUrl: "owner/repo", sourceType: "github" } },
      }),
      "utf8"
    );

    const noop = () => undefined;
    const logger = { info: noop, warn: noop, error: noop, debug: noop } as unknown as Logger;
    const signer: CommitSigner = { keyId: "test-key", sign: () => "signature" };
    const writer = new SoulWriter(new SoulGitStore(soulPath, signer, logger), logger);
    commits = [];
    soulWriter = {
      exists: (kind, slug) => writer.exists(kind, slug),
      read: (kind, slug) => writer.read(kind, slug),
      readCompanion: (kind, slug, name) => writer.readCompanion(kind, slug, name),
      apply: async (request) => {
        const result = await writer.apply(request);
        commits.push(request.subject);
        return result;
      },
    } as SoulWriter;

    const llmService = { effortModel: vi.fn().mockReturnValue({}) } as never;
    app = await buildApp({
      sessionStore: store,
      userRepo,
      tokenRepo,
      gitSync,
      soulLoader,
      llmService,
      bundledSkills,
      disabledBundledSkills,
      soulWriter,
    });
    buildAudit.mockReset();
  });

  afterEach(async () => {
    delete process.env.GIT_SOURCE_ALLOW_LOCAL_PATHS;
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
        pendingAudit: false,
      });
      expect(skills).toContainEqual({
        name: "my-skill",
        description: "Authored by hand.",
        provenance: "user",
        pendingAudit: false,
      });
    });

    it("marks forge-created skills with pendingAudit: true", async () => {
      // Add a pending skill to the soul loader.
      (soulLoader.skills as Map<string, SoulSkill>).set("pending-skill", {
        name: "pending-skill",
        frontmatter: { _pendingAudit: true, description: "Pending." },
        body: "Pending body.",
      });
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/skills",
        cookies: auth(),
        headers,
      });
      expect(res.statusCode).toBe(200);
      const { skills } = res.json();
      expect(skills).toContainEqual(
        expect.objectContaining({ name: "pending-skill", pendingAudit: true })
      );
    });

    it("lists bundled Skills with builtin provenance", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/skills",
        cookies: auth(),
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().skills).toContainEqual({
        name: "resource-forge",
        description: "Bundled Resource forge.",
        provenance: "builtin",
        pendingAudit: false,
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
      expect(
        res
          .json()
          .skills.filter((entry: { name: string }) => entry.name !== "resource-forge")
          .every((entry: { provenance: string }) => entry.provenance === "user")
      ).toBe(true);
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

    it("returns a bundled Skill with builtin provenance", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/skills/resource-forge",
        cookies: auth(),
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        name: "resource-forge",
        provenance: "builtin",
        body: "# resource-forge\nBundled Resource forge.",
      });
    });

    it("returns package files and executable command runtime status", async () => {
      const directory = join(soulPath, "skills", "reporting");
      await mkdir(join(directory, "scripts"), { recursive: true });
      await writeFile(join(directory, "SKILL.md"), "# Reporting", "utf8");
      await writeFile(join(directory, "scripts", "report.py"), "print('ok')\n", "utf8");
      await writeFile(
        join(directory, "skill.yaml"),
        `apiVersion: tulipfarm.ai/v1
kind: Skill
metadata:
  id: 22222222-2222-2222-2222-222222222222
  slug: reporting
  schemaVersion: 1
  authoredVersion: 1
  lifecycle: draft
spec:
  instructions:
    path: SKILL.md
  scripts:
    - scripts/report.py
  commands:
    - name: generate
      toolRef: report.generate
      runtimeProfile: shell-ts-python-v1
      entrypoint: scripts/report.py
      requiredCommands:
        - python3
  trustTier: first_party
`,
        "utf8"
      );
      soulLoader.skills.set("reporting", skill("reporting", "Reports."));
      const previous = process.env.SANDBOX_RUNTIME_IMAGE_DIGEST;
      process.env.SANDBOX_RUNTIME_IMAGE_DIGEST = `sha256:${"a".repeat(64)}`;
      try {
        const res = await app.inject({
          method: "GET",
          url: "/api/v1/skills/reporting",
          cookies: auth(),
          headers,
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().files).toContainEqual({ path: "scripts/report.py", size: 12 });
        expect(res.json().commands).toEqual([
          expect.objectContaining({
            name: "generate",
            runtimeProfile: "shell-ts-python-v1",
            runtimeAvailable: true,
          }),
        ]);
      } finally {
        if (previous === undefined) delete process.env.SANDBOX_RUNTIME_IMAGE_DIGEST;
        else process.env.SANDBOX_RUNTIME_IMAGE_DIGEST = previous;
      }
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

    it("scans a non-default branch when the source carries a #ref suffix", async () => {
      const remote = await makeRemoteRepo();
      temps.push(remote);
      // Add a second skill on a feature branch only.
      const git = (args: string[]) => execFileP("git", args, { cwd: remote });
      await git(["checkout", "-q", "-b", "feat/branch-skill"]);
      const branchSkillDir = join(remote, "skills", "branch-skill");
      await mkdir(branchSkillDir, { recursive: true });
      await writeFile(
        join(branchSkillDir, "SKILL.md"),
        "---\nname: branch-skill\ndescription: Only on the branch.\n---\nBranch only.",
        "utf8"
      );
      await git(["add", "-A"]);
      await git(["commit", "-q", "-m", "add branch skill"]);
      await git(["checkout", "-q", "-"]);

      const scan = (source: string) =>
        app.inject({
          method: "POST",
          url: "/api/v1/skills/scan",
          cookies: auth(),
          headers,
          payload: { source },
        });

      // Default branch: only the original skill.
      const main = await scan(`file://${remote}`);
      expect(main.statusCode).toBe(200);
      expect(main.json().skills.map((s: { name: string }) => s.name)).toEqual(["demo-skill"]);

      // #branch: both skills discovered.
      const branch = await scan(`file://${remote}#feat/branch-skill`);
      expect(branch.statusCode).toBe(200);
      expect(
        branch
          .json()
          .skills.map((s: { name: string }) => s.name)
          .sort()
      ).toEqual(["branch-skill", "demo-skill"]);
    });

    it("flags an installed skill and an available update against the lock", async () => {
      const remote = await makeRemoteRepo();
      temps.push(remote);
      const fileUrl = `file://${remote}`;
      const content = "---\nname: demo-skill\ndescription: A demo skill.\n---\nDo the demo.";
      const hash = createHash("sha256").update(content).digest("hex");

      // Pretend demo-skill is already installed from this source.
      soulLoader.skills.set("demo-skill", skill("demo-skill", "A demo skill."));

      const scan = (url: string) =>
        app.inject({
          method: "POST",
          url: "/api/v1/skills/scan",
          cookies: auth(),
          headers,
          payload: { source: url },
        });

      // Lock hash matches the upstream content → installed, no update.
      await writeFile(
        join(soulPath, "skills-lock.json"),
        JSON.stringify({ version: 1, skills: { "demo-skill": { sourceUrl: fileUrl, hash } } }),
        "utf8"
      );
      const current = await scan(fileUrl);
      expect(current.json().skills[0]).toMatchObject({ installed: true, updateAvailable: false });

      // Lock hash no longer matches → update available.
      await writeFile(
        join(soulPath, "skills-lock.json"),
        JSON.stringify({
          version: 1,
          skills: { "demo-skill": { sourceUrl: fileUrl, hash: "0".repeat(64) } },
        }),
        "utf8"
      );
      const stale = await scan(fileUrl);
      expect(stale.json().skills[0]).toMatchObject({ installed: true, updateAvailable: true });
    });
  });

  describe("POST /api/v1/skills/scan — clone source policy", () => {
    beforeEach(() => {
      delete process.env.GIT_SOURCE_ALLOW_LOCAL_PATHS;
    });

    const scan = (source: string) =>
      app.inject({
        method: "POST",
        url: "/api/v1/skills/scan",
        cookies: auth(),
        headers,
        payload: { source },
      });

    // Every row must be refused by the URL/address policy, before any git process is started.
    const forbidden: ReadonlyArray<readonly [string, string]> = [
      ["a local filesystem repository", "file:///srv/secrets/repo"],
      ["plain HTTP", "http://github.com/owner/repo.git"],
      ["embedded credentials", "https://user:pass@github.com/owner/repo.git"],
      ["IPv4 loopback", "https://127.0.0.1/owner/repo.git"],
      ["IPv6 loopback", "https://[::1]/owner/repo.git"],
      ["the unspecified address", "https://0.0.0.0/owner/repo.git"],
      ["the cloud metadata address", "https://169.254.169.254/latest/repo.git"],
      ["RFC 1918 10/8", "https://10.1.2.3/owner/repo.git"],
      ["RFC 1918 192.168/16", "https://192.168.1.1/owner/repo.git"],
      ["RFC 1918 172.16/12", "https://172.20.0.1/owner/repo.git"],
      ["unique local IPv6", "https://[fd00::1]/owner/repo.git"],
      ["link-local IPv6", "https://[fe80::1]/owner/repo.git"],
      ["decimal-encoded IPv4", "https://2130706433/owner/repo.git"],
      ["hex-encoded IPv4", "https://0x7f000001/owner/repo.git"],
      ["octal-encoded IPv4", "https://0177.0.0.1/owner/repo.git"],
      ["IPv4-mapped IPv6", "https://[::ffff:127.0.0.1]/owner/repo.git"],
      ["an unapproved host", "https://git.internal.example/owner/repo.git"],
      ["a trailing-dot unapproved host", "https://git.internal.example./owner/repo.git"],
      ["an scp-style source", "git@internal.example.com:secrets/repo.git"],
      ["a git:// source", "git://internal.example.com/repo.git"],
      ["an ssh source", "ssh://internal-host/repo.git"],
      ["an unsafe #ref suffix", "owner/repo#--upload-pack=evil"],
    ];

    it.each(forbidden)("rejects %s without cloning", async (_label, source) => {
      const res = await scan(source);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).not.toContain("git clone");
    });

    // Issue #437: the operator sees a verdict, never the command, its stderr or a server path.
    it("reports a clone failure without leaking the command, stderr or temp paths", async () => {
      process.env.GIT_SOURCE_ALLOW_LOCAL_PATHS = "1";
      const res = await scan(`file://${join(tmpdir(), "does-not-exist-qa-stress-xyz")}`);
      expect(res.statusCode).toBe(400);
      const { error } = res.json() as { error: string };
      expect(error).toBe("Repository not found or not accessible.");
      expect(error).not.toContain("git clone");
      expect(error).not.toContain("Command failed");
      expect(error).not.toContain("fatal:");
      expect(error).not.toContain(tmpdir());
    });
  });

  describe("scan → audit → install flow", () => {
    it("scans a local repo, audits a discovered skill (advisory), then installs on confirm", async () => {
      const remote = await makeRemoteRepo();
      temps.push(remote);
      const scripts = join(remote, "skills", "demo-skill", "scripts");
      await mkdir(scripts, { recursive: true });
      await writeFile(join(scripts, "run.py"), "print('ok')\n", "utf8");
      await execFileP("git", ["add", "-A"], { cwd: remote });
      await execFileP("git", ["commit", "-q", "-m", "add Skill script"], { cwd: remote });
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
      expect(skills).toEqual([
        {
          name: "demo-skill",
          skillPath: join("skills", "demo-skill", "SKILL.md"),
          description: "A demo skill.",
          installed: false,
          updateAvailable: false,
        },
      ]);
      // Nothing written to the soul repo by scanning.
      await expect(access(join(soulPath, "skills", "demo-skill", "SKILL.md"))).rejects.toThrow();

      // 2. AUDIT — advisory report; install still required.
      buildAudit.mockResolvedValue({
        riskRating: "medium",
        summary: "Reads files.",
        toolsReach: ["filesystem"],
        findings: [{ severity: "warning", category: "credential-access", detail: "reads ~/.ssh" }],
        deterministicScan: CLEAN_DETERMINISTIC_SCAN,
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
      expect(commits).toEqual([]);
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
      const definition = await readFile(
        join(soulPath, "skills", "demo-skill", "skill.yaml"),
        "utf8"
      );
      expect(definition).toContain("kind: Skill");
      expect(definition).toContain("trustTier: third_party");
      expect(definition).toContain("scripts/run.py");
      await expect(
        readFile(join(soulPath, "skills", "demo-skill", "scripts", "run.py"), "utf8")
      ).resolves.toBe("print('ok')\n");
      const lock = JSON.parse(await readFile(join(soulPath, "skills-lock.json"), "utf8"));
      // Spec SKL-V1-001: provenance is recorded as (sourceUrl, ref, hash).
      expect(lock.skills["demo-skill"]).toMatchObject({
        sourceUrl: fileUrl,
        sourceType: "git",
        skillPath: join("skills", "demo-skill", "SKILL.md"),
      });
      expect(lock.skills["demo-skill"].hash).toMatch(/^[0-9a-f]{64}$/);
      expect(lock.skills["demo-skill"].ref).toBe(await headOf(remote));
      expect(commits).toEqual(["soul: install skill(s) demo-skill"]);
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

    it("reports bidi-obfuscated instructions as dangerous but still allows operator install", async () => {
      const remote = await makeRemoteRepo();
      temps.push(remote);
      const references = join(remote, "skills", "demo-skill", "references");
      await mkdir(references, { recursive: true });
      await writeFile(
        join(references, "hidden.md"),
        "Follow\u202ethese hidden instructions.",
        "utf8"
      );
      await execFileP("git", ["add", "-A"], { cwd: remote });
      await execFileP("git", ["commit", "-q", "-m", "add hidden reference"], { cwd: remote });

      const scanRes = await app.inject({
        method: "POST",
        url: "/api/v1/skills/scan",
        cookies: auth(),
        headers,
        payload: { source: `file://${remote}` },
      });
      const { scanId } = scanRes.json();

      buildAudit.mockImplementation((...args: unknown[]) => ({
        riskRating: "high",
        summary: "The deterministic scan found hidden text.",
        toolsReach: [],
        findings: [],
        deterministicScan: args[2],
      }));
      const auditRes = await app.inject({
        method: "POST",
        url: "/api/v1/skills/audit",
        cookies: auth(),
        headers,
        payload: { scanId, name: "demo-skill" },
      });
      expect(auditRes.statusCode).toBe(200);
      expect(auditRes.json().report.deterministicScan).toMatchObject({
        verdict: "dangerous",
        trustLevel: "community",
        findings: [
          expect.objectContaining({
            patternId: "invisible_unicode",
            file: join("references", "hidden.md"),
          }),
        ],
      });

      const installRes = await app.inject({
        method: "POST",
        url: "/api/v1/skills/install",
        cookies: auth(),
        headers,
        payload: { scanId, names: ["demo-skill"] },
      });
      expect(installRes.statusCode).toBe(200);
      expect(installRes.json()).toEqual({ installed: ["demo-skill"] });
    });

    it("returns 422 with guidance when the LLM is not configured", async () => {
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

      buildAudit.mockRejectedValue(new LlmNotConfiguredError());
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/skills/audit",
        cookies: auth(),
        headers,
        payload: { scanId, name: "demo-skill" },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error).toMatch(/Operate → Business → Models/);
    });

    it("returns 502 when the audit model call fails", async () => {
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

      buildAudit.mockRejectedValue(new Error("upstream 529"));
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/skills/audit",
        cookies: auth(),
        headers,
        payload: { scanId, name: "demo-skill" },
      });
      expect(res.statusCode).toBe(502);
      expect(res.json().error).toMatch(/SkillAudit failed: upstream 529/);
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

      // Skip audit → install must be rejected (confirm only after seeing the report).
      const installRes = await app.inject({
        method: "POST",
        url: "/api/v1/skills/install",
        cookies: auth(),
        headers,
        payload: { scanId, names: ["demo-skill"] },
      });
      expect(installRes.statusCode).toBe(409);
      expect(commits).toEqual([]);
      await expect(access(join(soulPath, "skills", "demo-skill", "SKILL.md"))).rejects.toThrow();
    });

    it("refuses a malformed audited Skill at install and writes nothing", async () => {
      const remote = await makeRemoteRepo(
        undefined,
        "---\nname: demo-skill\n---\nMissing the required description."
      );
      temps.push(remote);
      const scanRes = await app.inject({
        method: "POST",
        url: "/api/v1/skills/scan",
        cookies: auth(),
        headers,
        payload: { source: `file://${remote}` },
      });
      const { scanId } = scanRes.json();
      buildAudit.mockResolvedValue({
        riskRating: "low",
        summary: "No issue found.",
        toolsReach: [],
        findings: [],
        deterministicScan: CLEAN_DETERMINISTIC_SCAN,
      });
      await app.inject({
        method: "POST",
        url: "/api/v1/skills/audit",
        cookies: auth(),
        headers,
        payload: { scanId, name: "demo-skill" },
      });

      const installRes = await app.inject({
        method: "POST",
        url: "/api/v1/skills/install",
        cookies: auth(),
        headers,
        payload: { scanId, names: ["demo-skill"] },
      });

      expect(installRes.statusCode).toBe(400);
      expect(installRes.json().error).toMatch(/invalid Skill.*description/);
      expect(commits).toEqual([]);
      expect(reload).not.toHaveBeenCalled();
      await expect(access(join(soulPath, "skills", "demo-skill", "SKILL.md"))).rejects.toThrow();
    });

    it("validates every selected Skill before an atomic multi-Skill install", async () => {
      const remote = await makeRemoteRepo();
      temps.push(remote);
      const invalidDir = join(remote, "skills", "invalid-skill");
      await mkdir(invalidDir, { recursive: true });
      await writeFile(
        join(invalidDir, "SKILL.md"),
        "---\nname: invalid-skill\n---\nMissing the required description.",
        "utf8"
      );
      const git = (args: string[]) => execFileP("git", args, { cwd: remote });
      await git(["add", "-A"]);
      await git(["commit", "-q", "-m", "add invalid skill"]);

      const scanRes = await app.inject({
        method: "POST",
        url: "/api/v1/skills/scan",
        cookies: auth(),
        headers,
        payload: { source: `file://${remote}` },
      });
      const { scanId } = scanRes.json();
      buildAudit.mockResolvedValue({
        riskRating: "low",
        summary: "No issue found.",
        toolsReach: [],
        findings: [],
        deterministicScan: CLEAN_DETERMINISTIC_SCAN,
      });
      for (const name of ["demo-skill", "invalid-skill"]) {
        await app.inject({
          method: "POST",
          url: "/api/v1/skills/audit",
          cookies: auth(),
          headers,
          payload: { scanId, name },
        });
      }

      const installRes = await app.inject({
        method: "POST",
        url: "/api/v1/skills/install",
        cookies: auth(),
        headers,
        payload: { scanId, names: ["demo-skill", "invalid-skill"] },
      });

      expect(installRes.statusCode).toBe(400);
      expect(commits).toEqual([]);
      expect(reload).not.toHaveBeenCalled();
      await expect(access(join(soulPath, "skills", "demo-skill", "SKILL.md"))).rejects.toThrow();
      await expect(access(join(soulPath, "skills", "invalid-skill", "SKILL.md"))).rejects.toThrow();
    });

    it("measures the exact raw marketplace file when enforcing the size limit", async () => {
      const oversized =
        "---\nname: demo-skill\ndescription: A demo skill.\n" +
        `${"# padding\n".repeat(12_000)}---\nDo the demo.`;
      const remote = await makeRemoteRepo(undefined, oversized);
      temps.push(remote);
      const scanRes = await app.inject({
        method: "POST",
        url: "/api/v1/skills/scan",
        cookies: auth(),
        headers,
        payload: { source: `file://${remote}` },
      });
      const { scanId } = scanRes.json();
      buildAudit.mockResolvedValue({
        riskRating: "low",
        summary: "No issue found.",
        toolsReach: [],
        findings: [],
        deterministicScan: CLEAN_DETERMINISTIC_SCAN,
      });
      await app.inject({
        method: "POST",
        url: "/api/v1/skills/audit",
        cookies: auth(),
        headers,
        payload: { scanId, name: "demo-skill" },
      });

      const installRes = await app.inject({
        method: "POST",
        url: "/api/v1/skills/install",
        cookies: auth(),
        headers,
        payload: { scanId, names: ["demo-skill"] },
      });

      expect(installRes.statusCode).toBe(400);
      expect(installRes.json().error).toMatch(/100,000 characters/);
      expect(commits).toEqual([]);
    });

    // A real marketplace Skill is a package: reference material, helper scripts, and the licence
    // and dependency files its author shipped. Every file has to reach the soul, or the operator
    // installs a Skill whose `load_skill_reference` targets are simply missing.
    it("installs a Skill package's references, scripts and root provenance files", async () => {
      const remote = await makeRemoteRepo();
      temps.push(remote);
      const skillDir = join(remote, "skills", "demo-skill");
      await mkdir(join(skillDir, "references"), { recursive: true });
      await mkdir(join(skillDir, "scripts"), { recursive: true });
      await writeFile(join(skillDir, "references", "playbook.md"), "# Playbook\n", "utf8");
      await writeFile(join(skillDir, "scripts", "convert.py"), "print('convert')\n", "utf8");
      await writeFile(join(skillDir, "LICENSE.txt"), "MIT\n", "utf8");
      await writeFile(join(skillDir, "requirements.txt"), "pandas\n", "utf8");
      await execFileP("git", ["add", "-A"], { cwd: remote });
      await execFileP("git", ["commit", "-q", "-m", "add package files"], { cwd: remote });

      const scanRes = await app.inject({
        method: "POST",
        url: "/api/v1/skills/scan",
        cookies: auth(),
        headers,
        payload: { source: `file://${remote}` },
      });
      const { scanId } = scanRes.json();
      buildAudit.mockResolvedValue({
        riskRating: "low",
        summary: "No issue found.",
        toolsReach: [],
        findings: [],
        deterministicScan: CLEAN_DETERMINISTIC_SCAN,
      });
      await app.inject({
        method: "POST",
        url: "/api/v1/skills/audit",
        cookies: auth(),
        headers,
        payload: { scanId, name: "demo-skill" },
      });

      const installRes = await app.inject({
        method: "POST",
        url: "/api/v1/skills/install",
        cookies: auth(),
        headers,
        payload: { scanId, names: ["demo-skill"] },
      });

      expect(installRes.statusCode).toBe(200);
      const installed = join(soulPath, "skills", "demo-skill");
      await expect(readFile(join(installed, "references", "playbook.md"), "utf8")).resolves.toBe(
        "# Playbook\n"
      );
      await expect(readFile(join(installed, "scripts", "convert.py"), "utf8")).resolves.toBe(
        "print('convert')\n"
      );
      await expect(readFile(join(installed, "LICENSE.txt"), "utf8")).resolves.toBe("MIT\n");
      await expect(readFile(join(installed, "requirements.txt"), "utf8")).resolves.toBe("pandas\n");
    });

    // A 200 from install is not the claim that matters; the claim is that the package is usable.
    // `load_skill_reference` reaches a companion only once `SoulLoader` has resolved the Skill it
    // sits under, so a tree that committed but quarantines — or whose companions never landed —
    // is an install that reported success and delivered nothing a Turn can read. The fixture is
    // the shape of the packages #446 reported: `LICENSE.txt` and `requirements.txt` beside the
    // definition, which is what the layout could not address, not the directories it named.
    it("resolves an installed package's companions through the reader's own path", async () => {
      const remote = await makeRemoteRepo();
      temps.push(remote);
      const skillDir = join(remote, "skills", "demo-skill");
      await mkdir(join(skillDir, "references"), { recursive: true });
      await mkdir(join(skillDir, "scripts"), { recursive: true });
      await writeFile(join(skillDir, "references", "01-playbook.md"), "# Playbook\n", "utf8");
      await writeFile(join(skillDir, "scripts", "convert_to_asm.py"), "print('convert')\n", "utf8");
      await writeFile(join(skillDir, "LICENSE.txt"), "MIT\n", "utf8");
      await writeFile(join(skillDir, "requirements.txt"), "pandas\n", "utf8");
      await execFileP("git", ["add", "-A"], { cwd: remote });
      await execFileP("git", ["commit", "-q", "-m", "add package files"], { cwd: remote });

      const scanRes = await app.inject({
        method: "POST",
        url: "/api/v1/skills/scan",
        cookies: auth(),
        headers,
        payload: { source: `file://${remote}` },
      });
      const { scanId } = scanRes.json();
      buildAudit.mockResolvedValue({
        riskRating: "low",
        summary: "No issue found.",
        toolsReach: [],
        findings: [],
        deterministicScan: CLEAN_DETERMINISTIC_SCAN,
      });
      await app.inject({
        method: "POST",
        url: "/api/v1/skills/audit",
        cookies: auth(),
        headers,
        payload: { scanId, name: "demo-skill" },
      });

      const installRes = await app.inject({
        method: "POST",
        url: "/api/v1/skills/install",
        cookies: auth(),
        headers,
        payload: { scanId, names: ["demo-skill"] },
      });
      expect(installRes.statusCode).toBe(200);

      const reader = new SoulLoader(soulPath, { info() {}, warn() {}, error() {} });
      await reader.load();
      expect(reader.quarantined.filter((entry) => entry.name === "demo-skill")).toEqual([]);
      expect(reader.skills.get("demo-skill")).toBeDefined();
      // The exact resolution `load_skill_reference` performs beside the loaded Skill.
      const base = join(soulPath, "skills", "demo-skill");
      await expect(readFile(join(base, "references", "01-playbook.md"), "utf8")).resolves.toBe(
        "# Playbook\n"
      );
      await expect(readFile(join(base, "scripts", "convert_to_asm.py"), "utf8")).resolves.toBe(
        "print('convert')\n"
      );
      await expect(readFile(join(base, "LICENSE.txt"), "utf8")).resolves.toBe("MIT\n");
    });

    // A canonical-format package ships its own `skill.yaml`. That file is the Skill's definition,
    // not a companion, so installing it has to address it as one — otherwise the whole package is
    // rejected and none of its references or scripts ever reach the soul.
    it("installs a Skill package that ships its own skill.yaml definition", async () => {
      const remote = await makeRemoteRepo();
      temps.push(remote);
      const skillDir = join(remote, "skills", "demo-skill");
      const definition = convertLegacySkill({
        name: "demo-skill",
        frontmatter: { trustTier: "third_party", references: ["references/playbook.md"] },
        body: "Do the demo.",
      }).files.find((file) => file.path.endsWith("skill.yaml"));
      if (definition?.operation !== "upsert") throw new Error("no skill.yaml fixture");
      await mkdir(join(skillDir, "references"), { recursive: true });
      await writeFile(join(skillDir, "skill.yaml"), definition.content, "utf8");
      await writeFile(join(skillDir, "references", "playbook.md"), "# Playbook\n", "utf8");
      await execFileP("git", ["add", "-A"], { cwd: remote });
      await execFileP("git", ["commit", "-q", "-m", "add canonical package"], { cwd: remote });

      const scanRes = await app.inject({
        method: "POST",
        url: "/api/v1/skills/scan",
        cookies: auth(),
        headers,
        payload: { source: `file://${remote}` },
      });
      const { scanId } = scanRes.json();
      buildAudit.mockResolvedValue({
        riskRating: "low",
        summary: "No issue found.",
        toolsReach: [],
        findings: [],
        deterministicScan: CLEAN_DETERMINISTIC_SCAN,
      });
      await app.inject({
        method: "POST",
        url: "/api/v1/skills/audit",
        cookies: auth(),
        headers,
        payload: { scanId, name: "demo-skill" },
      });

      const installRes = await app.inject({
        method: "POST",
        url: "/api/v1/skills/install",
        cookies: auth(),
        headers,
        payload: { scanId, names: ["demo-skill"] },
      });

      expect(installRes.statusCode).toBe(200);
      const installed = join(soulPath, "skills", "demo-skill");
      await expect(readFile(join(installed, "skill.yaml"), "utf8")).resolves.toBe(
        definition.content
      );
      await expect(readFile(join(installed, "references", "playbook.md"), "utf8")).resolves.toBe(
        "# Playbook\n"
      );
    });

    it("names the offending file when a package carries something the soul cannot store", async () => {
      const remote = await makeRemoteRepo();
      temps.push(remote);
      await writeFile(join(remote, "skills", "demo-skill", "notes.rst"), "notes\n", "utf8");
      await execFileP("git", ["add", "-A"], { cwd: remote });
      await execFileP("git", ["commit", "-q", "-m", "add unstorable file"], { cwd: remote });

      const scanRes = await app.inject({
        method: "POST",
        url: "/api/v1/skills/scan",
        cookies: auth(),
        headers,
        payload: { source: `file://${remote}` },
      });
      const { scanId } = scanRes.json();
      buildAudit.mockResolvedValue({
        riskRating: "low",
        summary: "No issue found.",
        toolsReach: [],
        findings: [],
        deterministicScan: CLEAN_DETERMINISTIC_SCAN,
      });
      await app.inject({
        method: "POST",
        url: "/api/v1/skills/audit",
        cookies: auth(),
        headers,
        payload: { scanId, name: "demo-skill" },
      });

      const installRes = await app.inject({
        method: "POST",
        url: "/api/v1/skills/install",
        cookies: auth(),
        headers,
        payload: { scanId, names: ["demo-skill"] },
      });

      expect(installRes.statusCode).toBe(400);
      expect(installRes.json().error).toContain("notes.rst");
      expect(commits).toEqual([]);
    });

    // A Skill's name is its soul directory, so two same-named packages in one source cannot both
    // be installed. Say so instead of installing whichever the scan happened to list first.
    it("refuses an ambiguous install when one source defines two skills with the same name", async () => {
      const remote = await makeRemoteRepo();
      temps.push(remote);
      const second = join(remote, "extra", "demo-skill");
      await mkdir(second, { recursive: true });
      await writeFile(
        join(second, "SKILL.md"),
        "---\nname: demo-skill\ndescription: A rival demo skill.\n---\nDo it differently.",
        "utf8"
      );
      await execFileP("git", ["add", "-A"], { cwd: remote });
      await execFileP("git", ["commit", "-q", "-m", "add duplicate name"], { cwd: remote });

      const scanRes = await app.inject({
        method: "POST",
        url: "/api/v1/skills/scan",
        cookies: auth(),
        headers,
        payload: { source: `file://${remote}` },
      });
      const { scanId, skills } = scanRes.json();
      expect(skills).toHaveLength(2);
      // The two rows are distinguishable, which is what lets a client key them apart.
      expect(new Set(skills.map((s: { skillPath: string }) => s.skillPath)).size).toBe(2);

      buildAudit.mockResolvedValue({
        riskRating: "low",
        summary: "No issue found.",
        toolsReach: [],
        findings: [],
        deterministicScan: CLEAN_DETERMINISTIC_SCAN,
      });
      await app.inject({
        method: "POST",
        url: "/api/v1/skills/audit",
        cookies: auth(),
        headers,
        payload: { scanId, name: "demo-skill" },
      });

      const installRes = await app.inject({
        method: "POST",
        url: "/api/v1/skills/install",
        cookies: auth(),
        headers,
        payload: { scanId, names: ["demo-skill"] },
      });

      expect(installRes.statusCode).toBe(400);
      expect(installRes.json().error).toContain("more than one skill with the same name");
      expect(commits).toEqual([]);
    });

    // Selecting by name loses which of two same-named rows the operator reviewed, so the whole
    // pair became uninstallable. `paths` carries that identity from the scan to the write.
    it("installs the one same-named row the operator selected when identified by path", async () => {
      const remote = await makeRemoteRepo();
      temps.push(remote);
      const second = join(remote, "extra", "demo-skill");
      await mkdir(second, { recursive: true });
      await writeFile(
        join(second, "SKILL.md"),
        "---\nname: demo-skill\ndescription: A rival demo skill.\n---\nDo it differently.",
        "utf8"
      );
      await execFileP("git", ["add", "-A"], { cwd: remote });
      await execFileP("git", ["commit", "-q", "-m", "add duplicate name"], { cwd: remote });

      const scanRes = await app.inject({
        method: "POST",
        url: "/api/v1/skills/scan",
        cookies: auth(),
        headers,
        payload: { source: `file://${remote}` },
      });
      const { scanId, skills } = scanRes.json();
      const rival = (skills as { skillPath: string }[]).find((skill) =>
        skill.skillPath.startsWith("extra/")
      )?.skillPath;
      expect(rival).toBeDefined();

      buildAudit.mockResolvedValue({
        riskRating: "low",
        summary: "No issue found.",
        toolsReach: [],
        findings: [],
        deterministicScan: CLEAN_DETERMINISTIC_SCAN,
      });
      await app.inject({
        method: "POST",
        url: "/api/v1/skills/audit",
        cookies: auth(),
        headers,
        payload: { scanId, name: "demo-skill", skillPath: rival },
      });
      // The audit resolved the selected row, not whichever the scan listed first.
      expect(buildAudit.mock.calls[0][1]).toMatchObject({ description: "A rival demo skill." });

      const installRes = await app.inject({
        method: "POST",
        url: "/api/v1/skills/install",
        cookies: auth(),
        headers,
        payload: { scanId, paths: [rival] },
      });

      expect(installRes.statusCode).toBe(200);
      const written = await readFile(join(soulPath, "skills", "demo-skill", "SKILL.md"), "utf8");
      expect(written).toContain("Do it differently.");
    });

    it("refuses to install two selected rows that share a name, naming both paths", async () => {
      const remote = await makeRemoteRepo();
      temps.push(remote);
      const second = join(remote, "extra", "demo-skill");
      await mkdir(second, { recursive: true });
      await writeFile(
        join(second, "SKILL.md"),
        "---\nname: demo-skill\ndescription: A rival demo skill.\n---\nDo it differently.",
        "utf8"
      );
      await execFileP("git", ["add", "-A"], { cwd: remote });
      await execFileP("git", ["commit", "-q", "-m", "add duplicate name"], { cwd: remote });

      const scanRes = await app.inject({
        method: "POST",
        url: "/api/v1/skills/scan",
        cookies: auth(),
        headers,
        payload: { source: `file://${remote}` },
      });
      const { scanId, skills } = scanRes.json();
      const paths = (skills as { skillPath: string }[]).map((skill) => skill.skillPath);

      buildAudit.mockResolvedValue({
        riskRating: "low",
        summary: "No issue found.",
        toolsReach: [],
        findings: [],
        deterministicScan: CLEAN_DETERMINISTIC_SCAN,
      });
      for (const skillPath of paths) {
        await app.inject({
          method: "POST",
          url: "/api/v1/skills/audit",
          cookies: auth(),
          headers,
          payload: { scanId, name: "demo-skill", skillPath },
        });
      }

      const installRes = await app.inject({
        method: "POST",
        url: "/api/v1/skills/install",
        cookies: auth(),
        headers,
        payload: { scanId, paths },
      });

      expect(installRes.statusCode).toBe(400);
      for (const skillPath of paths) expect(installRes.json().error).toContain(skillPath);
      expect(commits).toEqual([]);
    });
  });

  describe("DELETE /api/v1/skills/:name", () => {
    // Seed the skill's directory on disk — the loader-backed map alone is not enough to remove.
    async function seedSkillDir(name: string): Promise<string> {
      const dir = join(soulPath, "skills", name);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\n---\nBody.`, "utf8");
      return dir;
    }

    it("returns 401 without auth", async () => {
      const res = await app.inject({ method: "DELETE", url: "/api/v1/skills/installed-skill" });
      expect(res.statusCode).toBe(401);
    });

    it("removes the skill dir and its lock entry, commits, and reloads", async () => {
      const dir = await seedSkillDir("installed-skill");
      const res = await app.inject({
        method: "DELETE",
        url: "/api/v1/skills/installed-skill",
        cookies: auth(),
        headers,
      });
      expect(res.statusCode).toBe(204);
      await expect(access(dir)).rejects.toThrow();
      const lock = JSON.parse(await readFile(join(soulPath, "skills-lock.json"), "utf8"));
      expect(lock.skills["installed-skill"]).toBeUndefined();
      expect(commits).toEqual(["soul: remove skill installed-skill"]);
      expect(reload).toHaveBeenCalledOnce();
    });

    it("removes a hand-authored skill (no lock entry) without touching other entries", async () => {
      await seedSkillDir("my-skill");
      const res = await app.inject({
        method: "DELETE",
        url: "/api/v1/skills/my-skill",
        cookies: auth(),
        headers,
      });
      expect(res.statusCode).toBe(204);
      const lock = JSON.parse(await readFile(join(soulPath, "skills-lock.json"), "utf8"));
      expect(lock.skills["installed-skill"]).toBeDefined();
    });

    it("hides a bundled Skill with a persistent tombstone", async () => {
      const res = await app.inject({
        method: "DELETE",
        url: "/api/v1/skills/resource-forge",
        cookies: auth(),
        headers,
      });
      expect(res.statusCode).toBe(204);
      expect(disabledBundledSkills).toEqual(new Set(["resource-forge"]));
      expect(
        JSON.parse(await readFile(join(soulPath, "skills", ".bundled-disabled.json"), "utf8"))
      ).toEqual(["resource-forge"]);

      const get = await app.inject({
        method: "GET",
        url: "/api/v1/skills/resource-forge",
        cookies: auth(),
        headers,
      });
      expect(get.statusCode).toBe(404);
    });

    it("returns 404 for an unknown skill and commits nothing", async () => {
      const res = await app.inject({
        method: "DELETE",
        url: "/api/v1/skills/ghost",
        cookies: auth(),
        headers,
      });
      expect(res.statusCode).toBe(404);
      expect(commits).toEqual([]);
    });
  });

  describe("GET /api/v1/skills/marketplace", () => {
    afterEach(() => {
      delete process.env.MARKETPLACE_SOURCE;
    });

    it("returns 401 without auth", async () => {
      const res = await app.inject({ method: "GET", url: "/api/v1/skills/marketplace" });
      expect(res.statusCode).toBe(401);
    });

    it("merges marketplace.json metadata onto discovered skills (discovery authoritative)", async () => {
      const remote = await makeRemoteRepo({
        version: 1,
        skills: [
          {
            id: "tulipfarm/skills/demo-skill",
            skillId: "demo-skill",
            name: "demo-skill",
            description: "Manifest description.",
            category: "productivity",
            installs: 42,
            source: "tulipfarm/skills",
          },
          // Manifest-only entry with no SKILL.md on disk — must NOT appear in the response.
          { id: "tulipfarm/skills/ghost", skillId: "ghost", name: "ghost", installs: 9 },
        ],
      });
      temps.push(remote);
      process.env.MARKETPLACE_SOURCE = `file://${remote}`;

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/skills/marketplace",
        cookies: auth(),
        headers,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.source).toBe(`file://${remote}`);
      expect(typeof body.scanId).toBe("string");
      // Frontmatter description wins over the manifest's.
      expect(body.skills).toEqual([
        {
          name: "demo-skill",
          skillPath: "skills/demo-skill/SKILL.md",
          skillId: "demo-skill",
          description: "A demo skill.",
          category: "productivity",
          installs: 42,
          installed: false,
          updateAvailable: false,
        },
      ]);
    });

    it("works without a marketplace.json (bare discovered list)", async () => {
      const remote = await makeRemoteRepo();
      temps.push(remote);
      process.env.MARKETPLACE_SOURCE = `file://${remote}`;

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/skills/marketplace",
        cookies: auth(),
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().skills).toEqual([
        {
          name: "demo-skill",
          skillPath: "skills/demo-skill/SKILL.md",
          description: "A demo skill.",
          installed: false,
          updateAvailable: false,
        },
      ]);
    });

    it("derives category from the authoritative catalog directory", async () => {
      const remote = await makeRemoteRepo(undefined, undefined, "productivity");
      temps.push(remote);
      process.env.MARKETPLACE_SOURCE = `file://${remote}`;

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/skills/marketplace",
        cookies: auth(),
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().skills).toEqual([
        {
          name: "demo-skill",
          skillPath: "productivity/demo-skill/SKILL.md",
          description: "A demo skill.",
          category: "productivity",
          installed: false,
          updateAvailable: false,
        },
      ]);
    });

    it("caches the catalog: repeated GETs reuse the same scanId without re-cloning", async () => {
      const remote = await makeRemoteRepo();
      process.env.MARKETPLACE_SOURCE = `file://${remote}`;

      const first = await app.inject({
        method: "GET",
        url: "/api/v1/skills/marketplace",
        cookies: auth(),
        headers,
      });
      expect(first.statusCode).toBe(200);

      // Remove the remote — a second GET can only succeed if it is served from the cache.
      await rm(remote, { recursive: true, force: true });
      const second = await app.inject({
        method: "GET",
        url: "/api/v1/skills/marketplace",
        cookies: auth(),
        headers,
      });
      expect(second.statusCode).toBe(200);
      expect(second.json().scanId).toBe(first.json().scanId);
    });

    it("returns 502 when the marketplace repo cannot be cloned", async () => {
      process.env.MARKETPLACE_SOURCE = `file://${join(tmpdir(), "no-such-marketplace-xyz")}`;
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/skills/marketplace",
        cookies: auth(),
        headers,
      });
      expect(res.statusCode).toBe(502);
    });

    it("keeps the audit gate: install via the marketplace scanId still requires audit", async () => {
      const remote = await makeRemoteRepo();
      temps.push(remote);
      process.env.MARKETPLACE_SOURCE = `file://${remote}`;

      const catalog = await app.inject({
        method: "GET",
        url: "/api/v1/skills/marketplace",
        cookies: auth(),
        headers,
      });
      const { scanId } = catalog.json();

      const blocked = await app.inject({
        method: "POST",
        url: "/api/v1/skills/install",
        cookies: auth(),
        headers,
        payload: { scanId, names: ["demo-skill"] },
      });
      expect(blocked.statusCode).toBe(409);

      buildAudit.mockResolvedValue({
        riskRating: "low",
        summary: "Benign.",
        toolsReach: [],
        findings: [],
        deterministicScan: CLEAN_DETERMINISTIC_SCAN,
      });
      await app.inject({
        method: "POST",
        url: "/api/v1/skills/audit",
        cookies: auth(),
        headers,
        payload: { scanId, name: "demo-skill" },
      });

      const installed = await app.inject({
        method: "POST",
        url: "/api/v1/skills/install",
        cookies: auth(),
        headers,
        payload: { scanId, names: ["demo-skill"] },
      });
      expect(installed.statusCode).toBe(200);
      const lock = JSON.parse(await readFile(join(soulPath, "skills-lock.json"), "utf8"));
      expect(lock.skills["demo-skill"].sourceUrl).toBe(`file://${remote}`);
    });
  });

  describe("GET /api/v1/skills/updates", () => {
    afterEach(() => {
      delete process.env.MARKETPLACE_SOURCE;
    });

    it("returns 401 without auth", async () => {
      const res = await app.inject({ method: "GET", url: "/api/v1/skills/updates" });
      expect(res.statusCode).toBe(401);
    });

    it("lists catalog drift and sends reinstall through audit and operator confirm", async () => {
      const remote = await makeRemoteRepo({
        version: 1,
        skills: [
          {
            id: "tulipfarm/skills/productivity/demo-skill",
            skillId: "demo-skill",
            name: "demo-skill",
            description: "A demo skill.",
            category: "productivity",
            installs: 42,
            source: "tulipfarm/skills",
          },
        ],
      });
      temps.push(remote);
      const source = `file://${remote}`;
      process.env.MARKETPLACE_SOURCE = source;
      soulLoader.skills.set("demo-skill", skill("demo-skill", "A demo skill."));
      await writeFile(
        join(soulPath, "skills-lock.json"),
        JSON.stringify({
          version: 1,
          skills: {
            "demo-skill": {
              sourceUrl: source,
              sourceType: "git",
              hash: "0".repeat(64),
            },
          },
        }),
        "utf8"
      );

      const updates = await app.inject({
        method: "GET",
        url: "/api/v1/skills/updates",
        cookies: auth(),
        headers,
      });
      expect(updates.statusCode).toBe(200);
      expect(updates.json().skills).toEqual([
        {
          name: "demo-skill",
          skillPath: "skills/demo-skill/SKILL.md",
          skillId: "demo-skill",
          description: "A demo skill.",
          category: "productivity",
          installs: 42,
          installed: true,
          updateAvailable: true,
        },
      ]);

      const { scanId } = updates.json();
      const blocked = await app.inject({
        method: "POST",
        url: "/api/v1/skills/install",
        cookies: auth(),
        headers,
        payload: { scanId, names: ["demo-skill"] },
      });
      expect(blocked.statusCode).toBe(409);

      buildAudit.mockResolvedValue({
        riskRating: "low",
        summary: "Benign.",
        toolsReach: [],
        findings: [],
        deterministicScan: CLEAN_DETERMINISTIC_SCAN,
      });
      await app.inject({
        method: "POST",
        url: "/api/v1/skills/audit",
        cookies: auth(),
        headers,
        payload: { scanId, name: "demo-skill" },
      });
      const installed = await app.inject({
        method: "POST",
        url: "/api/v1/skills/install",
        cookies: auth(),
        headers,
        payload: { scanId, names: ["demo-skill"] },
      });
      expect(installed.statusCode).toBe(200);
    });

    it("does not report a same-name Skill installed from another source", async () => {
      const remote = await makeRemoteRepo();
      temps.push(remote);
      process.env.MARKETPLACE_SOURCE = `file://${remote}`;
      soulLoader.skills.set("demo-skill", skill("demo-skill", "A demo skill."));
      await writeFile(
        join(soulPath, "skills-lock.json"),
        JSON.stringify({
          version: 1,
          skills: {
            "demo-skill": {
              sourceUrl: "owner/other-catalog",
              sourceType: "github",
              hash: "0".repeat(64),
            },
          },
        }),
        "utf8"
      );

      const updates = await app.inject({
        method: "GET",
        url: "/api/v1/skills/updates",
        cookies: auth(),
        headers,
      });
      expect(updates.statusCode).toBe(200);
      expect(updates.json().skills).toEqual([]);
    });
  });
});
