import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  GitSyncService,
  IntegrationManifest,
  SoulIntegration,
  SoulLoader,
} from "@tulipfarm/soul";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../app";
import type { TokenDoc, TokenRepo } from "../../auth/api-tokens";
import { CSRF_COOKIE, CSRF_HEADER } from "../../auth/csrf";
import { SESSION_COOKIE } from "../../auth/middleware";
import { MemorySessionStore } from "../../auth/session-store";
import { createUser, type UserDoc, type UserRepo } from "../../auth/users";
import type { McpClientService } from "../../integrations/mcp-client-service";
import type { PaginatedResult } from "../../pagination";
import type { RateLimiter, RateLimitResult } from "../../rate-limit";

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

const MANIFEST: IntegrationManifest = {
  name: "demo-integration",
  egress: { type: "mcp", entry: { transport: "stdio", command: "demo-mcp" } },
};

function makeIntegration(env: Record<string, string>): SoulIntegration {
  return {
    slug: "demo-integration",
    sourceIntegration: "demo-integration",
    manifest: MANIFEST,
    connection: { enabled: true, env },
  };
}

describe("POST /api/v1/integrations/:name/connect", () => {
  let app: FastifyInstance;
  let store: MemorySessionStore;
  let sid: string;
  let soulPath: string;
  const mcpConnect = vi.fn().mockResolvedValue(undefined);

  const auth = () => ({ [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF });
  const headers = { [CSRF_HEADER]: TEST_CSRF };

  beforeEach(async () => {
    mcpConnect.mockClear();
    store = new MemorySessionStore();
    const userRepo = new FakeUserRepo();
    const tokenRepo = new FakeTokenRepo();
    const user = await createUser(userRepo, "user@example.com", "pass", "member");
    sid = await store.create(user._id);

    soulPath = await mkdtemp(join(tmpdir(), "soul-integrations-"));
    await mkdir(join(soulPath, "integrations", "demo-integration"), { recursive: true });

    const gitSync = {
      path: soulPath,
      withSync: vi.fn().mockResolvedValue({ sha: "abc1234", filesChanged: 1 }),
    } as unknown as GitSyncService;

    const soulLoader = {
      integrations: new Map([
        ["demo-integration", makeIntegration({ TOKEN: "existing-secret", NAME: "foo" })],
      ]),
      reload: vi.fn().mockResolvedValue(undefined),
    } as unknown as SoulLoader;

    const mcpClient = {
      connect: mcpConnect,
      disconnect: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn().mockReturnValue("connected"),
      getToolNames: vi.fn().mockReturnValue([]),
    } as unknown as McpClientService;

    app = await buildApp({
      sessionStore: store,
      userRepo,
      tokenRepo,
      gitSync,
      soulLoader,
      mcpClient,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it("preserves existing stored env when the connect body carries no env (bare reconnect)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/demo-integration/connect",
      cookies: auth(),
      headers,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(mcpConnect).toHaveBeenCalledTimes(1);
    const connection = mcpConnect.mock.calls[0][2];
    expect(connection.env).toEqual({ TOKEN: "existing-secret", NAME: "foo" });
  });

  it("merges body env over existing stored env instead of replacing it", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/demo-integration/connect",
      cookies: auth(),
      headers,
      payload: { env: { NAME: "bar" } },
    });
    expect(res.statusCode).toBe(200);
    const connection = mcpConnect.mock.calls[0][2];
    expect(connection.env).toEqual({ TOKEN: "existing-secret", NAME: "bar" });
  });
});

describe("rate limiting on integrations write routes", () => {
  let app: FastifyInstance;
  let store: MemorySessionStore;
  let sid: string;

  class DenyingRateLimiter implements RateLimiter {
    async check(): Promise<RateLimitResult> {
      return { allowed: false, limit: 30, remaining: 0, resetAt: Date.now() + 60_000 };
    }
  }

  const auth = () => ({ [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF });
  const headers = { [CSRF_HEADER]: TEST_CSRF };

  beforeEach(async () => {
    store = new MemorySessionStore();
    const userRepo = new FakeUserRepo();
    const tokenRepo = new FakeTokenRepo();
    const user = await createUser(userRepo, "user@example.com", "pass", "member");
    sid = await store.create(user._id);

    const soulPath = await mkdtemp(join(tmpdir(), "soul-integrations-"));
    const gitSync = {
      path: soulPath,
      withSync: vi.fn().mockResolvedValue({ sha: "abc1234", filesChanged: 1 }),
    } as unknown as GitSyncService;

    const soulLoader = {
      integrations: new Map([
        ["demo-integration", makeIntegration({ TOKEN: "existing-secret", NAME: "foo" })],
      ]),
      reload: vi.fn().mockResolvedValue(undefined),
    } as unknown as SoulLoader;

    const mcpClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn().mockReturnValue("connected"),
      getToolNames: vi.fn().mockReturnValue([]),
    } as unknown as McpClientService;

    app = await buildApp({
      sessionStore: store,
      userRepo,
      tokenRepo,
      gitSync,
      soulLoader,
      mcpClient,
      rateLimiter: new DenyingRateLimiter(),
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it("rejects connect with 429 once the rate limiter denies the request", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/demo-integration/connect",
      cookies: auth(),
      headers,
      payload: {},
    });
    expect(res.statusCode).toBe(429);
  });

  it("rejects scan with 429 once the rate limiter denies the request", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/scan",
      cookies: auth(),
      headers,
      payload: { source: "tulipfarm/integrations" },
    });
    expect(res.statusCode).toBe(429);
  });
});
