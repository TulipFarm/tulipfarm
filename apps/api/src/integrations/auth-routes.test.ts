import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitSyncService, SoulIntegration, SoulLoader } from "@tulipfarm/soul";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { buildApp } from "../app";
import type { TokenDoc, TokenRepo } from "../auth/api-tokens";
import { CSRF_COOKIE, CSRF_HEADER } from "../auth/csrf";
import { SESSION_COOKIE } from "../auth/middleware";
import { MemorySessionStore } from "../auth/session-store";
import { createUser, type UserDoc, type UserRepo } from "../auth/users";
import type { PaginatedResult } from "../pagination";
import type { BundledIntegration } from "../soul/integrations/bundled";
import type { IntegrationAuthRequestDoc, IntegrationAuthRequestRepo } from "./auth-broker";
import { InMemoryPrincipalProviderTokenRepo } from "./principal-tokens";

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
  async create(_token: TokenDoc) {}
  async findByHash() {
    return null;
  }
  async findByUserId() {
    return [];
  }
  async findAll() {
    return [];
  }
  async findById() {
    return null;
  }
  async deleteById() {}
  async findAllPaginated(): Promise<PaginatedResult<TokenDoc>> {
    return { items: [], nextCursor: null };
  }
  async findByUserIdPaginated(): Promise<PaginatedResult<TokenDoc>> {
    return { items: [], nextCursor: null };
  }
}

class FakeSecretsService {
  store = new Map<string, string>();
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

class MemoryAuthRequestRepo implements IntegrationAuthRequestRepo {
  requests: IntegrationAuthRequestDoc[] = [];
  async create(request: IntegrationAuthRequestDoc): Promise<void> {
    this.requests.push({ ...request });
  }
  async consume(state: string): Promise<IntegrationAuthRequestDoc | null> {
    const request = this.requests.find(
      (r) => r.state === state && r.consumedAt === null && r.expiresAt > new Date()
    );
    if (!request) return null;
    request.consumedAt = new Date();
    return { ...request };
  }
}

const NOTION_MANIFEST: BundledIntegration["manifest"] = {
  name: "notion",
  egress: { type: "none" },
  auth: [
    {
      kind: "fields",
      fields: [
        { name: "NOTION_CLIENT_ID", label: "Client ID" },
        { name: "NOTION_CLIENT_SECRET", label: "Client Secret", secret: true },
      ],
    },
    {
      kind: "oauth2",
      // Notion's authorize URL takes `owner=user`, so this exchange really does return the
      // authorizing person's own token — the declaration Slack's install step must not carry.
      personal: true,
      authorization_url: "https://notion.test/authorize",
      token_url: "https://notion.test/token",
      client_id_env: "NOTION_CLIENT_ID",
      client_secret_env: "NOTION_CLIENT_SECRET",
      token_env: "NOTION_ACCESS_TOKEN",
    },
  ],
};

describe("integration auth routes", () => {
  let app: FastifyInstance;
  let sid: string;
  let soulPath: string;
  let soulLoader: SoulLoader;
  let secretsService: FakeSecretsService;
  let repo: MemoryAuthRequestRepo;
  let principalTokens: InMemoryPrincipalProviderTokenRepo;
  let memberSid: string;
  let fetchImpl: ReturnType<typeof vi.fn>;
  const temps: string[] = [];

  beforeEach(async () => {
    const store = new MemorySessionStore();
    const userRepo = new FakeUserRepo();
    // Connecting the *deployment's* shared credential is an operator act — these flows all
    // exercise `scope: "business"`, so the fixture must be an administrator. A `member` here
    // would assert a reach the deployment does not grant.
    const user = await createUser(userRepo, "user@example.com", "pass", "admin");
    sid = await store.create(user._id);
    const memberUser = await createUser(userRepo, "member@example.com", "pass", "member");
    memberSid = await store.create(memberUser._id);

    soulPath = await mkdtemp(join(tmpdir(), "integration-auth-soul-"));
    temps.push(soulPath);

    async function reloadFromDisk(): Promise<Map<string, SoulIntegration>> {
      const map = new Map<string, SoulIntegration>();
      const dir = join(soulPath, "integrations", "notion");
      try {
        const connection = parseYaml(await readFile(join(dir, "connection.yaml"), "utf8"));
        map.set("notion", {
          slug: "notion",
          sourceIntegration: "notion",
          manifest: NOTION_MANIFEST,
          connection,
        });
      } catch {
        // not materialized yet
      }
      return map;
    }

    const reload = vi.fn().mockImplementation(async () => {
      soulLoader.integrations = await reloadFromDisk();
    });
    soulLoader = {
      integrations: new Map<string, SoulIntegration>(),
      agents: new Map(),
      reload,
    } as unknown as SoulLoader;

    const gitSync = {
      path: soulPath,
      withSync: vi.fn().mockImplementation(async () => {
        soulLoader.integrations = await reloadFromDisk();
        return { sha: "abc1234", filesChanged: 1 };
      }),
      commit: vi.fn(),
      push: vi.fn(),
    } as unknown as GitSyncService;

    secretsService = new FakeSecretsService();
    repo = new MemoryAuthRequestRepo();
    principalTokens = new InMemoryPrincipalProviderTokenRepo();
    fetchImpl = vi.fn();

    app = await buildApp({
      sessionStore: store,
      userRepo,
      tokenRepo: new FakeTokenRepo(),
      gitSync,
      soulLoader,
      secretsService: secretsService as never,
      bundledIntegrations: new Map([["notion", { manifest: NOTION_MANIFEST }]]),
      integrationAuth: {
        repo,
        fetchImpl: fetchImpl as never,
        tokens: principalTokens,
      },
    });
  });

  afterEach(async () => {
    await app.close();
    for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  const auth = () => ({ [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF });
  const headers = { [CSRF_HEADER]: TEST_CSRF };

  const start = (step: number) =>
    app.inject({
      method: "POST",
      url: `/api/v1/integrations/notion/auth/start/${step}`,
      cookies: auth(),
      headers,
    });

  /** Seeds the client credentials the oauth2 step reads, as the fields step would. */
  async function connectFields(): Promise<void> {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/notion/connect",
      cookies: auth(),
      headers,
      payload: { env: { NOTION_CLIENT_ID: "cid", NOTION_CLIENT_SECRET: "shh" } },
    });
    expect(res.statusCode).toBe(200);
  }

  describe("POST /:name/auth/start/:step", () => {
    it("returns 401 without auth", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/integrations/notion/auth/start/0",
      });
      expect(res.statusCode).toBe(401);
    });

    it("returns the fields to collect for a fields step", async () => {
      const res = await start(0);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        action: "collect_fields",
        fields: [
          { name: "NOTION_CLIENT_ID", label: "Client ID" },
          { name: "NOTION_CLIENT_SECRET", label: "Client Secret", secret: true },
        ],
      });
    });

    it("404s for an unknown integration", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/integrations/nope/auth/start/0",
        cookies: auth(),
        headers,
      });
      expect(res.statusCode).toBe(404);
    });

    /**
     * The two halves of the personal-credential protocol are one feature, not two. The resolver
     * refuses a human's user-mode call with "connect it from Settings, Integrations"; if this route
     * cannot store what that connect produces, the person following that instruction walks into a
     * 409 and the Tool is permanently unreachable — a prompt pointing at a dead end. This pins the
     * halves together so neither can ship without the other.
     */
    it("completes a user-scoped connect rather than refusing for want of a token store", async () => {
      await connectFields();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/integrations/notion/auth/start/1",
        cookies: auth(),
        headers,
        payload: { scope: "user" },
      });
      expect(res.statusCode).toBe(200);
      expect(new URL(res.json().url).searchParams.get("state")).toBeTruthy();
    });

    /**
     * `business` scope re-points the credential every unattended Run and every service-mode Tool
     * then spends, so any member completing it would redirect the whole deployment's provider
     * identity. It takes the same fail-closed operator gate as the authorization admin API. `user`
     * scope stays self-service: it mints a credential bounded by what the provider already grants
     * that person, and requiring an operator there would make personal credentials unusable and
     * push every Tool back onto the shared bot.
     */
    it("refuses a business-scoped connect from a non-operator", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/integrations/notion/auth/start/0",
        cookies: { [SESSION_COOKIE]: memberSid, [CSRF_COOKIE]: TEST_CSRF },
        headers,
      });
      expect(res.statusCode).toBe(403);
    });

    it("lets that same non-operator connect their own credential", async () => {
      await connectFields();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/integrations/notion/auth/start/1",
        cookies: { [SESSION_COOKIE]: memberSid, [CSRF_COOKIE]: TEST_CSRF },
        headers,
        payload: { scope: "user" },
      });
      expect(res.statusCode).toBe(200);
    });

    it("404s for a step the manifest does not declare", async () => {
      expect((await start(9)).statusCode).toBe(404);
    });

    it("409s when an earlier step has not supplied the client id", async () => {
      const res = await start(1);
      expect(res.statusCode).toBe(409);
    });

    it("redirects to the provider once credentials exist", async () => {
      await connectFields();
      const res = await start(1);
      expect(res.statusCode).toBe(200);
      const url = new URL(res.json().url);
      expect(url.origin + url.pathname).toBe("https://notion.test/authorize");
      expect(url.searchParams.get("client_id")).toBe("cid");
      expect(url.searchParams.get("redirect_uri")).toBe(
        "http://localhost:4010/api/v1/integrations/auth/callback"
      );
      expect(repo.requests).toHaveLength(1);
    });
  });

  describe("GET /integrations/auth/callback", () => {
    async function startedState(): Promise<string> {
      await connectFields();
      const res = await start(1);
      return new URL(res.json().url).searchParams.get("state") as string;
    }

    it("needs no session cookie, since the provider redirect never carries one", async () => {
      const state = await startedState();
      fetchImpl.mockResolvedValue(
        new Response(JSON.stringify({ access_token: "tok" }), {
          headers: { "content-type": "application/json" },
        })
      );
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/integrations/auth/callback?state=${state}&code=abc`,
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe(
        "http://localhost:4000/integrations/notion?step=1&status=ok"
      );
    });

    it("seals the access token and leaves only a reference in the committed file", async () => {
      const state = await startedState();
      fetchImpl.mockResolvedValue(
        new Response(JSON.stringify({ access_token: "tok" }), {
          headers: { "content-type": "application/json" },
        })
      );
      await app.inject({
        method: "GET",
        url: `/api/v1/integrations/auth/callback?state=${state}&code=abc`,
      });

      const raw = await readFile(
        join(soulPath, "integrations", "notion", "connection.yaml"),
        "utf8"
      );
      // The file is committed and pushed to the user's soul git repo, so it must never hold the
      // token itself.
      expect(raw).not.toContain("tok");
      const parsed = parseYaml(raw);
      expect(parsed.env.NOTION_ACCESS_TOKEN).toMatch(/^secret:\/\//);
      expect([...secretsService.store.values()]).toContain("tok");
    });

    it("preserves what earlier steps wrote", async () => {
      const state = await startedState();
      fetchImpl.mockResolvedValue(
        new Response(JSON.stringify({ access_token: "tok" }), {
          headers: { "content-type": "application/json" },
        })
      );
      await app.inject({
        method: "GET",
        url: `/api/v1/integrations/auth/callback?state=${state}&code=abc`,
      });

      const parsed = parseYaml(
        await readFile(join(soulPath, "integrations", "notion", "connection.yaml"), "utf8")
      );
      expect(parsed.env.NOTION_CLIENT_ID).toBe("cid");
      expect(parsed.env.NOTION_CLIENT_SECRET).toMatch(/^secret:\/\//);
      // The fields step already connected this integration; a later step must not undo that.
      expect(parsed.enabled).toBe(true);
    });

    it("sends a replayed callback back to the integration page with a reason", async () => {
      const state = await startedState();
      fetchImpl.mockResolvedValue(
        new Response(JSON.stringify({ access_token: "tok" }), {
          headers: { "content-type": "application/json" },
        })
      );
      const url = `/api/v1/integrations/auth/callback?state=${state}&code=abc`;
      await app.inject({ method: "GET", url });

      const replay = await app.inject({ method: "GET", url });
      expect(replay.statusCode).toBe(302);
      expect(replay.headers.location).toBe(
        "http://localhost:4000/integrations/?status=error&reason=invalid_state"
      );
      // The provider was called exactly once, so the replay bought the attacker nothing.
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("names the integration when a failure happens after the state is consumed", async () => {
      const state = await startedState();
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/integrations/auth/callback?state=${state}&error=access_denied`,
      });
      expect(res.headers.location).toBe(
        "http://localhost:4000/integrations/notion?status=error&reason=exchange_failed"
      );
    });

    it("writes nothing when the token exchange fails", async () => {
      const state = await startedState();
      const before = await readFile(
        join(soulPath, "integrations", "notion", "connection.yaml"),
        "utf8"
      );
      fetchImpl.mockResolvedValue(
        new Response(JSON.stringify({ error: "bad_verification_code" }), {
          headers: { "content-type": "application/json" },
        })
      );
      await app.inject({
        method: "GET",
        url: `/api/v1/integrations/auth/callback?state=${state}&code=abc`,
      });
      expect(
        await readFile(join(soulPath, "integrations", "notion", "connection.yaml"), "utf8")
      ).toBe(before);
    });
  });
});
