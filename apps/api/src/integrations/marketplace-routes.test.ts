import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { knowledgeManifestFixture } from "@tulipfarm/integrations/src/knowledge/oim-manifest.fixture";
import { type OimManifest, oimFileDigest, oimPackageDigest } from "@tulipfarm/schema";
import type {
  BundledIntegration,
  GitSyncService,
  SoulIntegration,
  SoulLoader,
} from "@tulipfarm/soul";
import { makeSoulWriterDouble } from "@tulipfarm/soul";
import type { PaginatedResult } from "@tulipfarm/storage";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { buildApp } from "../app";
import type { TokenDoc, TokenRepo } from "../auth/api-tokens";
import { CSRF_COOKIE, CSRF_HEADER } from "../auth/csrf";
import { SESSION_COOKIE } from "../auth/middleware";
import { MemorySessionStore } from "../auth/session-store";
import { createUser, type UserDoc, type UserRepo } from "../auth/users";

/** Exercises browse and install through real local git clones, offline. */

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
  let memberSid: string;
  let soul: ReturnType<typeof makeSoulWriterDouble>;
  let registryDir: string;
  let soulIntegrations: Map<string, SoulIntegration>;
  let soulLoader: SoulLoader;
  let bundledIntegrations: Map<string, BundledIntegration>;
  const temps: string[] = [];

  beforeEach(async () => {
    // Browse and install are exercised against local git repos, which the clone policy denies
    // unless the deployment opted in.
    process.env.GIT_SOURCE_ALLOW_LOCAL_PATHS = "1";
    const store = new MemorySessionStore();
    const userRepo = new FakeUserRepo();
    const tokenRepo = new FakeTokenRepo();
    // Deployment-wide connection deletion requires the operator gate.
    const user = await createUser(userRepo, "user@example.com", "pass", "admin");
    sid = await store.create(user._id);
    const member = await createUser(userRepo, "member@example.com", "pass", "member");
    memberSid = await store.create(member._id);

    soul = makeSoulWriterDouble();

    // Use a curated registry so tests do not drift with the shipped catalog.
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
    function reloadFromTree(): Map<string, SoulIntegration> {
      const map = new Map<string, SoulIntegration>();
      for (const name of ["asana", "broken", "linear", "slack", "sneaky"]) {
        const manifestRaw = soul.writer.read("Integration", name);
        if (manifestRaw === null) continue;
        const manifest = parseYaml(manifestRaw);
        const setupGuide =
          soul.writer.readCompanion("Integration", name, "setup-guide.md") ?? undefined;
        map.set(name, { slug: name, sourceIntegration: manifest.name, manifest, setupGuide });
      }
      return map;
    }
    const reload = vi.fn().mockImplementation(async () => {
      soulLoader.integrations = reloadFromTree();
    });
    soulLoader = {
      integrations: soulIntegrations,
      agents: new Map(),
      reload,
    } as unknown as SoulLoader;

    const gitSync = {
      path: "/soul",
      withSync: vi.fn(),
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
      soulWriter: soul.writer,
      soulLoader,
      secretsService: new FakeSecretsService() as never,
      bundledIntegrations,
    });
  });

  afterEach(async () => {
    // Avoid leaking literal `undefined` into later path resolution.
    delete process.env.BUNDLED_INTEGRATIONS_DIR;
    delete process.env.GIT_SOURCE_ALLOW_LOCAL_PATHS;
    await app.close();
    for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  const auth = () => ({ [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF });
  const memberAuth = () => ({ [SESSION_COOKIE]: memberSid, [CSRF_COOKIE]: TEST_CSRF });
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
    // Every route must appear in the generated OpenAPI spec.
    it("publishes the install endpoints in the OpenAPI spec", async () => {
      const res = await app.inject({ method: "GET", url: "/api/v1/openapi.json" });
      const document = res.json();
      const paths = Object.keys(document.paths ?? {});
      expect(paths).toContain("/api/v1/integrations/inspect");
      expect(paths).toContain("/api/v1/integrations/install");
      expect(
        document.paths["/api/v1/integrations/inspect"].post.requestBody.content["application/json"]
          .schema.properties
      ).toHaveProperty("signed_release");
      expect(
        document.paths["/api/v1/integrations/install"].post.requestBody.content["application/json"]
          .schema.properties
      ).toMatchObject({
        approve_digest: expect.any(Object),
        signed_release: expect.any(Object),
        auto_patch_opt_in: expect.any(Object),
      });
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

    // Discovery, not the registry, is authoritative for installed bundled integrations.
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

    // Installable and installed items share one catalog.
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

  describe("POST /api/v1/integrations/:name/fixtures", () => {
    it("runs an installed OIM package's fixtures through the authenticated API", async () => {
      const fixture = `version: 1
cases:
  - name: gets-weather
    operationId: get-weather
    request: { city: London }
    response:
      status: 200
      body: { temperature: 18 }
    expect:
      request:
        method: GET
        url: https://api.weather.example/weather?city=London
      result: { temperature: 18 }
`;
      const manifest: OimManifest = {
        oimVersion: "1.0",
        kind: "Integration",
        metadata: {
          id: "weather",
          name: "Weather",
          version: "1.0.0",
          description: "Weather.",
          license: "Apache-2.0",
        },
        profiles: { core: "1.0" },
        files: [{ path: "fixtures.yml", role: "fixture", sha256: oimFileDigest(fixture) }],
        operations: [
          {
            id: "get-weather",
            name: "get_weather",
            description: "Get weather.",
            effect: "read",
            identityMode: "shared_only",
            source: {
              type: "http",
              method: "GET",
              baseUrl: "https://api.weather.example",
              path: "/weather",
              parameters: [{ name: "city", in: "query", schema: { type: "string" } }],
            },
            response: { maxBytes: 1024, schema: { type: "object" } },
          },
        ],
      } as OimManifest;
      soulIntegrations.set("weather", {
        slug: "weather",
        sourceIntegration: "weather",
        oimManifest: manifest,
        oimFixtures: { "fixtures.yml": fixture },
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/integrations/weather/fixtures",
        cookies: auth(),
        headers,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        fixtures: [{ name: "gets-weather", fixture: "fixtures.yml", passed: true }],
      });
    });
  });

  describe("POST /api/v1/integrations/inspect", () => {
    it("rejects signed release envelopes with undeclared fields", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/integrations/inspect",
        cookies: auth(),
        headers,
        payload: {
          source: "owner/repo",
          signed_release: {
            envelopeVersion: 1,
            release: {
              integrationId: "wiki",
              version: "2.1.0",
              packageDigest: "a".repeat(64),
              publicKey: "not allowed",
            },
            signature: { algorithm: "Ed25519", keyId: "release-key", value: "c2lnbmF0dXJl" },
          },
        },
      });

      expect(res.statusCode).toBe(400);
    });

    it("rejects a source we will not hand to git clone", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/integrations/inspect",
        cookies: auth(),
        headers,
        payload: { source: "git@internal.example.com:secrets/repo.git" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('"owner/repo" slug');
    });

    // Issue #183: the same cage guards this route, and it is applied before git is started.
    it.each([
      ["a local filesystem repository", "file:///srv/secrets/repo"],
      ["plain HTTP", "http://github.com/owner/repo.git"],
      ["embedded credentials", "https://user:pass@github.com/owner/repo.git"],
      ["IPv4 loopback", "https://127.0.0.1/owner/repo.git"],
      ["the cloud metadata address", "https://169.254.169.254/owner/repo.git"],
      ["an unapproved host", "https://git.internal.example/owner/repo.git"],
    ])("rejects %s", async (_label, source) => {
      delete process.env.GIT_SOURCE_ALLOW_LOCAL_PATHS;
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/integrations/inspect",
        cookies: auth(),
        headers,
        payload: { source },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).not.toContain("git clone");
    });

    // Issue #437: a failing clone reports a verdict, not git's stderr or a server path.
    it("reports a clone failure without leaking the command or temp paths", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/integrations/inspect",
        cookies: auth(),
        headers,
        payload: { source: `file://${join(tmpdir(), "no-such-integration-repo-xyz")}` },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("Repository not found or not accessible.");
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
      expect(res.json().source_type).toBe("git");
      expect(res.json().integrations).toEqual([
        {
          name: "linear",
          description: "linear integration",
          version: "1.0.0",
          maintainer: "acme",
          installed: false,
          installable: true,
          issues: [],
          definition: "legacy",
        },
      ]);
      expect(soul.applied).toHaveLength(0);
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
      expect(res.json().error).toContain("no integration manifest");
    });
  });

  describe("integration package mutations", () => {
    it("requires integration management authority to install a package", async () => {
      const repo = await makeTemp({ linear: declarativeManifest("linear") });

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/integrations/install",
        cookies: memberAuth(),
        headers,
        payload: { source: `file://${repo}` },
      });

      expect(res.statusCode).toBe(403);
    });
  });

  describe("POST /api/v1/integrations/install", () => {
    it("installs only the exact OIM commit and digest returned by review", async () => {
      const manifest = knowledgeManifestFixture();
      const repo = await makeTemp({}, { "oim.yml": stringifyYaml(manifest) });
      const review = await app.inject({
        method: "POST",
        url: "/api/v1/integrations/inspect",
        cookies: auth(),
        headers,
        payload: { source: `file://${repo}` },
      });
      const reviewed = review.json();
      expect(reviewed.integrations[0]).toMatchObject({
        definition: "oim",
        support: "community",
        hooks_allowed: false,
        auto_patch_eligible: false,
        license: "Apache-2.0",
        major_version: 2,
        package_digest: oimPackageDigest(manifest),
        review: {
          integrationId: "wiki",
          packageDigest: oimPackageDigest(manifest),
          destinations: ["wiki.example"],
        },
      });
      const refused = await app.inject({
        method: "POST",
        url: "/api/v1/integrations/install",
        cookies: auth(),
        headers,
        payload: { source: `file://${repo}`, name: "wiki" },
      });
      expect(refused.statusCode).toBe(409);

      const installed = await app.inject({
        method: "POST",
        url: "/api/v1/integrations/install",
        cookies: auth(),
        headers,
        payload: {
          source: `file://${repo}`,
          name: "wiki",
          ref: reviewed.ref,
          approve_digest: reviewed.integrations[0].package_digest,
        },
      });
      expect(installed.statusCode).toBe(200);
      expect(installed.json()).toMatchObject({
        name: "wiki",
        ref: reviewed.ref,
        package_digest: reviewed.integrations[0].package_digest,
      });

      soulLoader.integrations.set("wiki", {
        slug: "wiki",
        sourceIntegration: "wiki",
        oimManifest: manifest,
      });
      const next = {
        ...manifest,
        metadata: { ...manifest.metadata, version: "2.2.0" },
      };
      await writeFile(join(repo, "oim.yml"), stringifyYaml(next), "utf8");
      await execFileP("git", ["add", "-A"], { cwd: repo });
      await execFileP("git", ["commit", "-q", "-m", "update package"], { cwd: repo });
      const updateReview = await app.inject({
        method: "POST",
        url: "/api/v1/integrations/inspect",
        cookies: auth(),
        headers,
        payload: { source: `file://${repo}` },
      });
      const reviewedUpdate = updateReview.json();
      const updated = await app.inject({
        method: "POST",
        url: "/api/v1/integrations/wiki/update",
        cookies: auth(),
        headers,
        payload: {
          source: `file://${repo}`,
          ref: reviewedUpdate.ref,
          approve_digest: reviewedUpdate.integrations[0].package_digest,
        },
      });
      expect(updated.statusCode).toBe(200);
      expect(updated.json().package_digest).toBe(oimPackageDigest(next));

      const sameMajor = {
        ...next,
        metadata: { ...next.metadata, version: "2.3.0" },
      };
      soulLoader.integrations.set("wiki", {
        slug: "wiki",
        sourceIntegration: "wiki",
        oimManifest: next,
      });
      await writeFile(join(repo, "oim.yml"), stringifyYaml(sameMajor), "utf8");
      await execFileP("git", ["add", "-A"], { cwd: repo });
      await execFileP("git", ["commit", "-q", "-m", "same major install"], { cwd: repo });
      const sameMajorReview = await app.inject({
        method: "POST",
        url: "/api/v1/integrations/inspect",
        cookies: auth(),
        headers,
        payload: { source: `file://${repo}` },
      });
      const reviewedSameMajor = sameMajorReview.json();
      const installedSameMajor = await app.inject({
        method: "POST",
        url: "/api/v1/integrations/install",
        cookies: auth(),
        headers,
        payload: {
          source: `file://${repo}`,
          ref: reviewedSameMajor.ref,
          approve_digest: reviewedSameMajor.integrations[0].package_digest,
        },
      });
      expect(installedSameMajor.statusCode).toBe(200);
      expect(installedSameMajor.json()).toMatchObject({
        name: "wiki",
        integration_id: "wiki",
        major_version: 2,
        package_digest: oimPackageDigest(sameMajor),
      });

      soulLoader.integrations.set("wiki", {
        slug: "wiki",
        sourceIntegration: "wiki",
        oimManifest: sameMajor,
      });
      const nextMajor = {
        ...sameMajor,
        metadata: { ...sameMajor.metadata, version: "3.0.0" },
      };
      await writeFile(join(repo, "oim.yml"), stringifyYaml(nextMajor), "utf8");
      await execFileP("git", ["add", "-A"], { cwd: repo });
      await execFileP("git", ["commit", "-q", "-m", "new major"], { cwd: repo });
      const majorReview = await app.inject({
        method: "POST",
        url: "/api/v1/integrations/inspect",
        cookies: auth(),
        headers,
        payload: { source: `file://${repo}` },
      });
      const reviewedMajor = majorReview.json();
      expect(reviewedMajor.integrations[0]).toMatchObject({
        installed: false,
        major_version: 3,
      });
      const majorPayload = {
        source: `file://${repo}`,
        name: "wiki",
        ref: reviewedMajor.ref,
        approve_digest: reviewedMajor.integrations[0].package_digest,
      };
      const deniedMajor = await app.inject({
        method: "POST",
        url: "/api/v1/integrations/install",
        cookies: memberAuth(),
        headers,
        payload: majorPayload,
      });
      expect(deniedMajor.statusCode).toBe(403);

      const installedMajor = await app.inject({
        method: "POST",
        url: "/api/v1/integrations/install",
        cookies: auth(),
        headers,
        payload: majorPayload,
      });
      expect(installedMajor.statusCode).toBe(200);
      expect(installedMajor.json()).toMatchObject({
        name: "wiki-v3",
        integration_id: "wiki",
        major_version: 3,
        package_digest: oimPackageDigest(nextMajor),
      });
      soulLoader.integrations.set("wiki-v3", {
        slug: "wiki-v3",
        sourceIntegration: "wiki",
        oimManifest: nextMajor,
      });

      const removedMajor = await app.inject({
        method: "DELETE",
        url: "/api/v1/integrations/wiki-v3",
        cookies: auth(),
        headers,
      });
      expect(removedMajor.statusCode).toBe(204);
      expect(soul.writer.readCompanion("Integration", "wiki", "oim.yml")).not.toBeNull();
      expect(soul.writer.readCompanion("Integration", "wiki-v3", "oim.yml")).toBeNull();
      const remainingLock = JSON.parse(soul.writer.read("IntegrationsLock") ?? "{}");
      expect(remainingLock.integrations.wiki).toBeDefined();
      expect(remainingLock.integrations["wiki-v3"]).toBeUndefined();
    });

    it("refuses OIM bytes that changed after review", async () => {
      const manifest = knowledgeManifestFixture();
      const repo = await makeTemp({}, { "oim.yml": stringifyYaml(manifest) });
      const review = await app.inject({
        method: "POST",
        url: "/api/v1/integrations/inspect",
        cookies: auth(),
        headers,
        payload: { source: `file://${repo}` },
      });
      const reviewed = review.json();

      await writeFile(
        join(repo, "oim.yml"),
        stringifyYaml({
          ...manifest,
          metadata: { ...manifest.metadata, version: "2.2.0" },
        }),
        "utf8"
      );
      await execFileP("git", ["add", "-A"], { cwd: repo });
      await execFileP("git", ["commit", "-q", "-m", "change package"], { cwd: repo });

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/integrations/install",
        cookies: auth(),
        headers,
        payload: {
          source: `file://${repo}`,
          name: "wiki",
          ref: reviewed.ref,
          approve_digest: reviewed.integrations[0].package_digest,
        },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toContain("changed since it was reviewed");
      expect(soul.applied).toHaveLength(0);
    });

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

      const written = parseYaml(soul.writer.read("Integration", "linear") ?? "");
      expect(written.name).toBe("linear");

      const lock = JSON.parse(soul.writer.read("IntegrationsLock") ?? "{}");
      expect(lock.integrations.linear).toMatchObject({
        sourceUrl: `file://${repo}`,
        sourceType: "git",
        manifestPath: join("integrations", "linear", "manifest.yml"),
        ref: await headOf(repo),
      });
      expect(lock.integrations.linear.hash).toMatch(/^[0-9a-f]{64}$/);
      const installWrite = soul.applied.at(-1);
      expect(installWrite?.subject).toBe("soul: install integration linear");
      expect(installWrite?.source).toBe("api");
      expect(installWrite?.changes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            op: "put",
            target: expect.objectContaining({ kind: "Integration", slug: "linear" }),
          }),
        ])
      );
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
      expect(soul.writer.readCompanion("Integration", "linear", "setup-guide.md")).toBe(
        "# Connect Linear"
      );
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
          expect(soul.writer.read("Integration", "sneaky")).toBeNull();
          expect(soul.applied).toHaveLength(0);
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
      expect(soul.applied).toHaveLength(0);
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
      expect(soul.writer.read("Integration", "linear")).toBeNull();
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

    // Bundled manifests win over Soul copies, so bundled slugs must be refused.
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

    // Guide symlinks could publish host files to the operator's git remote.
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
      expect(soul.writer.readCompanion("Integration", "linear", "setup-guide.md")).toBeNull();
    });

    // Failed partial installs must not be loadable on the next boot.
    it("leaves nothing behind when the commit fails", async () => {
      const repo = await makeTemp({ linear: declarativeManifest("linear") });
      soul.failNextWith(new Error("git push rejected"));
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/integrations/install",
        cookies: auth(),
        headers,
        payload: { source: `file://${repo}` },
      });
      expect(res.statusCode).toBe(500);
      expect(soul.writer.read("Integration", "linear")).toBeNull();
      expect(soul.applied).toHaveLength(0);
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
      expect(res.json().error).toBe("Repository not found or not accessible.");
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
      const lock = JSON.parse(soul.writer.read("IntegrationsLock") ?? "{}");
      expect(lock.integrations).toEqual({});
    });
  });

  describe("POST /api/v1/integrations/:name/update", () => {
    it("updates an installed integration from its source repository", async () => {
      const repo = await makeTemp({ linear: declarativeManifest("linear") });
      await app.inject({
        method: "POST",
        url: "/api/v1/integrations/install",
        cookies: auth(),
        headers,
        payload: { source: `file://${repo}` },
      });

      // Update repo manifest
      const updatedManifest = {
        ...declarativeManifest("linear"),
        description: "updated linear integration",
      };
      const fsP = require("node:fs/promises");
      const yaml = require("yaml");
      await fsP.writeFile(
        require("node:path").join(repo, "integrations", "linear", "manifest.yml"),
        yaml.stringify(updatedManifest),
        "utf8"
      );
      const cp = require("node:child_process");
      const { promisify } = require("node:util");
      const execP = promisify(cp.execFile);
      await execP("git", ["add", "-A"], { cwd: repo });
      await execP("git", ["commit", "-q", "-m", "update linear"], { cwd: repo });

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/integrations/linear/update",
        cookies: auth(),
        headers,
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().name).toBe("linear");

      const written = yaml.parse(soul.writer.read("Integration", "linear") ?? "");
      expect(written.description).toBe("updated linear integration");
    });
  });
});
