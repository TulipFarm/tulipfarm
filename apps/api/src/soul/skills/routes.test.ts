import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { LlmNotConfiguredError } from "@tulipfarm/schema";
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
import type { BundledSkill } from "./bundled";

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
  let withSync: ReturnType<typeof vi.fn>;
  let reload: ReturnType<typeof vi.fn>;
  let soulLoader: SoulLoader;
  let bundledSkills: Map<string, BundledSkill>;
  let disabledBundledSkills: Set<string>;
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
        skills: { "installed-skill": { sourceUrl: "owner/repo", sourceType: "github" } },
      }),
      "utf8"
    );

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

    it("rejects a source with an unsafe #ref suffix before cloning", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/skills/scan",
        cookies: auth(),
        headers,
        payload: { source: "owner/repo#--upload-pack=evil" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/owner\/repo|http/);
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
      expect(withSync).not.toHaveBeenCalled();
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
      expect(withSync).not.toHaveBeenCalled();
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
      expect(withSync).not.toHaveBeenCalled();
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
      expect(withSync).not.toHaveBeenCalled();
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
      expect(withSync).toHaveBeenCalledWith(
        "soul: remove skill installed-skill",
        expect.any(Object)
      );
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
      expect(withSync).not.toHaveBeenCalled();
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
