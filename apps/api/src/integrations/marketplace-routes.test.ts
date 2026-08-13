import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { GitSyncService, SoulIntegration, SoulLoader } from "@tulipfarm/soul";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { buildApp } from "../app";
import type { TokenDoc, TokenRepo } from "../auth/api-tokens";
import { CSRF_COOKIE, CSRF_HEADER } from "../auth/csrf";
import { SESSION_COOKIE } from "../auth/middleware";
import { MemorySessionStore } from "../auth/session-store";
import { createUser, type UserDoc, type UserRepo } from "../auth/users";
import type { PaginatedResult } from "../pagination";
import type { BundledIntegration } from "../soul/integrations/bundled";

/*
 * Browse + install-from-git. Every test clones a real local git repo (`git clone <path>` works
 * offline), so the clone/discover/validate/write path is exercised end to end rather than mocked —
 * the point of this feature is what actually lands in the soul repo.
 */

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

class FakeSecretsService {
  private store = new Map<string, string>();
  async get(key: string): Promise<string> {
    const value = this.store.get(key);
    if (value === undefined) throw new Error(`secret not found: ${key}`);
    return value;
  }
  async set(key: string, plaintext: string): Promise<void> {
    this.store.set(key, plaintext);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
  async list(): Promise<Array<{ key: string }>> {
    return [...this.store.keys()].map((key) => ({ key }));
  }
}

// A purely declarative integration: a provider URL, a token field, nothing executable.
function declarativeManifest(name: string): Record<string, unknown> {
  return {
    name,
    version: "1.0.0",
    description: `${name} integration`,
    maintainer: "acme",
    egress: { type: "none" },
    auth: [
      {
        kind: "fields",
        fields: [{ name: `${name.toUpperCase()}_TOKEN`, label: "API token", secret: true }],
      },
    ],
  };
}

async function makeRemoteRepo(
  integrations: Record<string, Record<string, unknown>>,
  extras: Record<string, string> = {}
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "integration-remote-"));
  for (const [name, manifest] of Object.entries(integrations)) {
    const target = join(dir, "integrations", name);
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "manifest.yml"), stringifyYaml(manifest), "utf8");
  }
  for (const [path, content] of Object.entries(extras)) {
    const full = join(dir, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content, "utf8");
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

describe("integration marketplace routes", () => {
  let app: FastifyInstance;
  let sid: string;
  let soulPath: string;
  let registryDir: string;
  let soulIntegrations: Map<string, SoulIntegration>;
  let soulLoader: SoulLoader;
  let bundledIntegrations: Map<string, BundledIntegration>;
  let withSync: ReturnType<typeof vi.fn>;
  const temps: string[] = [];

  beforeEach(async () => {
    const store = new MemorySessionStore();
    const userRepo = new FakeUserRepo();
    const tokenRepo = new FakeTokenRepo();
    // `DELETE /:name` removes the deployment-wide connection, so it takes the operator gate that
    // `integrations/routes.ts` applies alongside connect and disconnect.
    const user = await createUser(userRepo, "user@example.com", "pass", "admin");
    sid = await store.create(user._id);

    soulPath = await mkdtemp(join(tmpdir(), "integrations-soul-"));
    temps.push(soulPath);

    // A curated registry that is NOT the repo's own, so these assertions never drift when the
    // shipped catalog gains entries.
    registryDir = await mkdtemp(join(tmpdir(), "integrations-registry-"));
    temps.push(registryDir);
    await writeFile(
      join(registryDir, "registry.yml"),
      stringifyYaml({
        version: 1,
        integrations: [
          { name: "slack", title: "Slack", category: "chat", homepage: "https://slack.com" },
          {
            name: "linear",
            title: "Linear",
            category: "productivity",
            source: "acme/tulipfarm-linear",
            description: "Track issues.",
          },
        ],
      }),
      "utf8"
    );
    process.env.BUNDLED_INTEGRATIONS_DIR = registryDir;

    soulIntegrations = new Map();
    async function reloadFromDisk(): Promise<Map<string, SoulIntegration>> {
      const map = new Map<string, SoulIntegration>();
      let names: string[];
      try {
        const { readdir } = await import("node:fs/promises");
        names = (await readdir(join(soulPath, "integrations"), { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name);
      } catch {
        return map;
      }
      for (const name of names) {
        const dir = join(soulPath, "integrations", name);
        try {
          const manifest = parseYaml(await readFile(join(dir, "manifest.yml"), "utf8"));
          map.set(name, { slug: name, sourceIntegration: manifest.name, manifest });
        } catch {
          // not a readable integration
        }
      }
      return map;
    }
    withSync = vi.fn().mockImplementation(async () => {
      soulLoader.integrations = await reloadFromDisk();
      return { sha: "abc1234", filesChanged: 1 };
    });
    const reload = vi.fn().mockImplementation(async () => {
      soulLoader.integrations = await reloadFromDisk();
    });
    soulLoader = {
      integrations: soulIntegrations,
      agents: new Map(),
      reload,
    } as unknown as SoulLoader;

    const gitSync = {
      path: soulPath,
      withSync,
      commit: vi.fn(),
      push: vi.fn(),
    } as unknown as GitSyncService;

    bundledIntegrations = new Map([
      ["slack", { manifest: { name: "slack", egress: { type: "none" } } }],
      ["github", { manifest: { name: "github", egress: { type: "none" } } }],
    ]);

    app = await buildApp({
      sessionStore: store,
      userRepo,
      tokenRepo,
      gitSync,
      soulLoader,
      secretsService: new FakeSecretsService() as never,
      bundledIntegrations,
    });
  });

  afterEach(async () => {
    // Assigning `undefined` would set the literal string "undefined", which resolves to a bogus
    // directory for any later test that reads it.
    delete process.env.BUNDLED_INTEGRATIONS_DIR;
    await app.close();
    for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  const auth = () => ({ [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF });
  const headers = { [CSRF_HEADER]: TEST_CSRF };

  async function makeTemp(
    integrations: Record<string, Record<string, unknown>>,
    extras?: Record<string, string>
  ): Promise<string> {
    const dir = await makeRemoteRepo(integrations, extras);
    temps.push(dir);
    return dir;
  }

  describe("GET /api/v1/integrations (catalog)", () => {
    // Per apps/api/AGENTS.md every route carries a schema, and the published spec is generated
    // from them — an endpoint missing here is invisible to the docs and to generated clients.
    it("publishes the install endpoints in the OpenAPI spec", async () => {
      const res = await app.inject({ method: "GET", url: "/api/v1/openapi.json" });
      const paths = Object.keys(res.json().paths ?? {});
      expect(paths).toContain("/api/v1/integrations/inspect");
      expect(paths).toContain("/api/v1/integrations/install");
    });

    it("merges curated metadata onto integrations present in the deployment", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/integrations",
        cookies: auth(),
      });
      const byName = new Map(
        res.json().integrations.map((entry: { name: string }) => [entry.name, entry])
      );
      expect(byName.get("slack")).toMatchObject({
        title: "Slack",
        category: "chat",
        homepage: "https://slack.com",
        installed: true,
      });
    });

    // Discovery is authoritative for what exists: github ships in the image but is absent from
    // this registry, and must still be listed.
    it("lists a bundled integration the registry does not mention", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/integrations",
        cookies: auth(),
      });
      const github = res
        .json()
        .integrations.find((entry: { name: string }) => entry.name === "github");
      expect(github).toMatchObject({ installed: true });
    });

    // The whole point of one catalog instead of two tabs: something an operator can install is
    // listed beside what they already have, rather than hidden behind a second page.
    it("lists a curated third-party entry as not installed until it is cloned", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/integrations",
        cookies: auth(),
      });
      const linear = res
        .json()
        .integrations.find((entry: { name: string }) => entry.name === "linear");
      expect(linear).toMatchObject({
        title: "Linear",
        description: "Track issues.",
        source: "acme/tulipfarm-linear",
        installed: false,
        status: "disconnected",
      });
    });
  });

  describe("POST /api/v1/integrations/inspect", () => {
    it("rejects a source we will not hand to git clone", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/integrations/inspect",
        cookies: auth(),
        headers,
        payload: { source: "git@internal.example.com:secrets/repo.git" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain("owner/repo slug");
    });

    it("reports what a repo offers without writing anything", async () => {
      const repo = await makeTemp({ linear: declarativeManifest("linear") });
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/integrations/inspect",
        cookies: auth(),
        headers,
        payload: { source: `file://${repo}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().ref).toBe(await headOf(repo));
      expect(res.json().integrations).toEqual([
        {
          name: "linear",
          description: "linear integration",
          version: "1.0.0",
          maintainer: "acme",
          installed: false,
          installable: true,
          issues: [],
        },
      ]);
      expect(withSync).not.toHaveBeenCalled();
    });

    it("reports why a code-bearing integration is not installable instead of hiding it", async () => {
      const repo = await makeTemp({
        sneaky: {
          ...declarativeManifest("sneaky"),
          egress: { type: "ts-code", handler: "h.ts", toolsSpec: "t.json" },
        },
      });
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/integrations/inspect",
        cookies: auth(),
        headers,
        payload: { source: `file://${repo}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().integrations[0]).toMatchObject({ name: "sneaky", installable: false });
      expect(res.json().integrations[0].issues[0]).toContain("ts-code");
    });

    it("400s a repo with no manifests", async () => {
      const repo = await makeTemp({}, { "README.md": "nothing here" });
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/integrations/inspect",
        cookies: auth(),
        headers,
        payload: { source: `file://${repo}` },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain("no manifest.yml");
    });
  });

  describe("POST /api/v1/integrations/install", () => {
    it("installs a declarative integration and records its provenance", async () => {
      const repo = await makeTemp({ linear: declarativeManifest("linear") });
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/integrations/install",
        cookies: auth(),
        headers,
        payload: { source: `file://${repo}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ name: "linear", ref: await headOf(repo) });

      const written = parseYaml(
        await readFile(join(soulPath, "integrations", "linear", "manifest.yml"), "utf8")
      );
      expect(written.name).toBe("linear");

      const lock = JSON.parse(await readFile(join(soulPath, "integrations-lock.json"), "utf8"));
      expect(lock.integrations.linear).toMatchObject({
        sourceUrl: `file://${repo}`,
        sourceType: "git",
        manifestPath: join("integrations", "linear", "manifest.yml"),
        ref: await headOf(repo),
      });
      expect(lock.integrations.linear.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(withSync).toHaveBeenCalledWith("soul: install integration linear", expect.any(Object));
    });

    it("copies a setup guide when the repo ships one", async () => {
      const repo = await makeTemp(
        { linear: declarativeManifest("linear") },
        { "integrations/linear/setup-guide.md": "# Connect Linear" }
      );
      await app.inject({
        method: "POST",
        url: "/api/v1/integrations/install",
        cookies: auth(),
        headers,
        payload: { source: `file://${repo}` },
      });
      expect(
        await readFile(join(soulPath, "integrations", "linear", "setup-guide.md"), "utf8")
      ).toBe("# Connect Linear");
    });

    it("makes the installed integration visible to the rest of the API", async () => {
      const repo = await makeTemp({ linear: declarativeManifest("linear") });
      await app.inject({
        method: "POST",
        url: "/api/v1/integrations/install",
        cookies: auth(),
        headers,
        payload: { source: `file://${repo}` },
      });
      const detail = await app.inject({
        method: "GET",
        url: "/api/v1/integrations/linear",
        cookies: auth(),
      });
      expect(detail.statusCode).toBe(200);
      expect(detail.json()).toMatchObject({ name: "linear", status: "disconnected" });
      expect(detail.json().auth[0]).toMatchObject({ kind: "fields", satisfied: false });
    });

    describe("refuses to install code", () => {
      const cases: Array<[string, Record<string, unknown>, string]> = [
        [
          "a ts-code handler",
          { egress: { type: "ts-code", handler: "h.ts", toolsSpec: "t.json" } },
          "ts-code",
        ],
        [
          "a stdio MCP server",
          { egress: { type: "mcp", entry: { transport: "stdio", command: "npx" } } },
          "stdio",
        ],
        [
          "an ingress classifier",
          {
            ingress: {
              handler: "classify.js",
              webhook: {
                security: { type: "hmac_sha256", header: "X-Sig", secret_env: "ACME_SECRET" },
              },
            },
          },
          "ingress.handler",
        ],
      ];

      for (const [label, overrides, expected] of cases) {
        it(`rejects ${label} and writes nothing`, async () => {
          const repo = await makeTemp({
            sneaky: { ...declarativeManifest("sneaky"), ...overrides },
          });
          const res = await app.inject({
            method: "POST",
            url: "/api/v1/integrations/install",
            cookies: auth(),
            headers,
            payload: { source: `file://${repo}` },
          });
          expect(res.statusCode).toBe(400);
          expect(res.json().error).toContain(expected);
          await expect(
            readFile(join(soulPath, "integrations", "sneaky", "manifest.yml"), "utf8")
          ).rejects.toThrow();
          expect(withSync).not.toHaveBeenCalled();
        });
      }
    });

    it("rejects a plaintext token endpoint, which would leak credentials in transit", async () => {
      const repo = await makeTemp({
        sneaky: {
          ...declarativeManifest("sneaky"),
          auth: [
            {
              kind: "oauth2",
              authorization_url: "https://acme.com/authorize",
              token_url: "http://acme.com/token",
              client_id_env: "ACME_CLIENT_ID",
              client_secret_env: "ACME_CLIENT_SECRET",
              token_env: "ACME_TOKEN",
            },
          ],
        },
      });
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/integrations/install",
        cookies: auth(),
        headers,
        payload: { source: `file://${repo}` },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain("https://");
    });

    it("rejects an unsatisfiable connect flow before it reaches disk", async () => {
      const repo = await makeTemp({
        broken: {
          ...declarativeManifest("broken"),
          auth: [
            {
              kind: "oauth2",
              authorization_url: "https://acme.com/authorize",
              token_url: "https://acme.com/token",
              client_id_env: "ACME_CLIENT_ID",
              client_secret_env: "ACME_CLIENT_SECRET",
              token_env: "ACME_TOKEN",
            },
          ],
        },
      });
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/integrations/install",
        cookies: auth(),
        headers,
        payload: { source: `file://${repo}` },
      });
      // ACME_CLIENT_ID/SECRET are never supplied by an earlier step, so the flow can never finish.
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain("no earlier step supplies");
      expect(withSync).not.toHaveBeenCalled();
    });

    it("names the choices when a repo offers several integrations", async () => {
      const repo = await makeTemp({
        linear: declarativeManifest("linear"),
        asana: declarativeManifest("asana"),
      });
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/integrations/install",
        cookies: auth(),
        headers,
        payload: { source: `file://${repo}` },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain("asana, linear");
    });

    it("installs the named one from a multi-integration repo", async () => {
      const repo = await makeTemp({
        linear: declarativeManifest("linear"),
        asana: declarativeManifest("asana"),
      });
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/integrations/install",
        cookies: auth(),
        headers,
        payload: { source: `file://${repo}`, name: "asana" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().name).toBe("asana");
      await expect(
        readFile(join(soulPath, "integrations", "linear", "manifest.yml"), "utf8")
      ).rejects.toThrow();
    });

    it("404s a name the repo does not offer", async () => {
      const repo = await makeTemp({ linear: declarativeManifest("linear") });
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/integrations/install",
        cookies: auth(),
        headers,
        payload: { source: `file://${repo}`, name: "nope" },
      });
      expect(res.statusCode).toBe(404);
    });

    // A bundled manifest wins over the soul copy in mergeIntegrations, so an install under a
    // bundled slug would appear to succeed while changing nothing.
    it("refuses to shadow a bundled integration", async () => {
      const repo = await makeTemp({ slack: declarativeManifest("slack") });
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/integrations/install",
        cookies: auth(),
        headers,
        payload: { source: `file://${repo}` },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toContain("already installed");
    });

    it("refuses to overwrite an already-installed integration", async () => {
      const repo = await makeTemp({ linear: declarativeManifest("linear") });
      const first = await app.inject({
        method: "POST",
        url: "/api/v1/integrations/install",
        cookies: auth(),
        headers,
        payload: { source: `file://${repo}` },
      });
      expect(first.statusCode).toBe(200);
      const second = await app.inject({
        method: "POST",
        url: "/api/v1/integrations/install",
        cookies: auth(),
        headers,
        payload: { source: `file://${repo}` },
      });
      expect(second.statusCode).toBe(409);
    });

    // A guide is committed and pushed to the operator's own git remote, so following a symlink
    // out of the clone would publish host files to their git host.
    it("does not follow a symlinked setup guide out of the clone", async () => {
      const secretFile = join(tmpdir(), `host-secret-${Date.now()}.txt`);
      await writeFile(secretFile, "TOP SECRET HOST FILE", "utf8");
      temps.push(secretFile);
      const repo = await makeTemp({ linear: declarativeManifest("linear") });
      await symlink(secretFile, join(repo, "integrations", "linear", "setup-guide.md"));
      await execFileP("git", ["add", "-A"], { cwd: repo });
      await execFileP("git", ["commit", "-q", "-m", "guide"], { cwd: repo });

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/integrations/install",
        cookies: auth(),
        headers,
        payload: { source: `file://${repo}` },
      });
      expect(res.statusCode).toBe(200);
      await expect(
        readFile(join(soulPath, "integrations", "linear", "setup-guide.md"), "utf8")
      ).rejects.toThrow();
    });

    // The loader reads the integrations directory and never consults the lock, so anything left
    // behind by a failed install would be loaded and trusted on the next boot.
    it("leaves nothing behind when the commit fails", async () => {
      const repo = await makeTemp({ linear: declarativeManifest("linear") });
      withSync.mockRejectedValueOnce(new Error("git push rejected"));
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/integrations/install",
        cookies: auth(),
        headers,
        payload: { source: `file://${repo}` },
      });
      expect(res.statusCode).toBe(500);
      await expect(
        readFile(join(soulPath, "integrations", "linear", "manifest.yml"), "utf8")
      ).rejects.toThrow();
    });

    it("400s an unreachable repo", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/integrations/install",
        cookies: auth(),
        headers,
        payload: { source: `file://${join(tmpdir(), "does-not-exist-repo")}` },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain("clone failed");
    });
  });

  describe("DELETE /api/v1/integrations/:name", () => {
    it("drops the provenance record so a later reinstall is not misattributed", async () => {
      const repo = await makeTemp({ linear: declarativeManifest("linear") });
      await app.inject({
        method: "POST",
        url: "/api/v1/integrations/install",
        cookies: auth(),
        headers,
        payload: { source: `file://${repo}` },
      });
      const res = await app.inject({
        method: "DELETE",
        url: "/api/v1/integrations/linear",
        cookies: auth(),
        headers,
      });
      expect(res.statusCode).toBe(204);
      const lock = JSON.parse(await readFile(join(soulPath, "integrations-lock.json"), "utf8"));
      expect(lock.integrations).toEqual({});
    });
  });
});
