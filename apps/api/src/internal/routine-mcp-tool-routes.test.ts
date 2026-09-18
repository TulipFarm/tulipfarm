import type { McpExecutionBinding } from "@tulipfarm/schema";
import type { PaginatedResult } from "@tulipfarm/storage";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../app";
import type { TokenDoc, TokenRepo } from "../auth/api-tokens";
import { CSRF_COOKIE, CSRF_HEADER } from "../auth/csrf";
import { SESSION_COOKIE } from "../auth/middleware";
import { MemorySessionStore } from "../auth/session-store";
import { createUser, type UserDoc, type UserRepo } from "../auth/users";
import { createApiClient, formatApiClientCredential } from "../identity/api-clients";
import { MemoryApiClientRepo } from "../identity/fakes";

class Users implements UserRepo {
  readonly rows: UserDoc[] = [];
  async findByEmail(email: string) {
    return this.rows.find((user) => user.email === email) ?? null;
  }
  async findById(id: string) {
    return this.rows.find((user) => user._id === id) ?? null;
  }
  async count() {
    return this.rows.length;
  }
  async insert(user: UserDoc) {
    this.rows.push(user);
  }
}

class Tokens implements TokenRepo {
  async create(_token: TokenDoc) {}
  async findByHash(_hash: string) {
    return null;
  }
  async findByUserId(_id: string): Promise<TokenDoc[]> {
    return [];
  }
  async findAll(): Promise<TokenDoc[]> {
    return [];
  }
  async findById(_id: string) {
    return null;
  }
  async deleteById(_id: string) {}
  async findAllPaginated(): Promise<PaginatedResult<TokenDoc>> {
    return { items: [], nextCursor: null };
  }
  async findByUserIdPaginated(): Promise<PaginatedResult<TokenDoc>> {
    return { items: [], nextCursor: null };
  }
}

const binding: McpExecutionBinding = {
  serverId: "example",
  serverRevision: "a".repeat(64),
  accountId: "personal-account",
  accountRevision: "1",
  subjectId: "muskan",
  authorizationId: "authorization-1",
};
const claim = { leaseOwner: "worker-1", leaseGeneration: 3 };
const resolveUrl = "/api/v1/internal/runs/run-1/routine-states/Search/tool/resolve";

async function setup() {
  const userRepo = new Users();
  const user = await createUser(userRepo, "muskan@example.com", "test-password", "admin");
  const sessionStore = new MemorySessionStore();
  const session = await sessionStore.issue({ userId: user._id, authMethods: ["password"] });
  const apiClientRepo = new MemoryApiClientRepo();
  const { doc, secret } = await createApiClient(apiClientRepo, {
    name: "worker",
    ownerUserId: user._id,
  });
  const host = {
    prepare: vi.fn(async () => ({
      kind: "ready" as const,
      adapter: { kind: "mcp" as const, ref: "example" },
      mcp: binding,
    })),
    reauthorize: vi.fn(async () => ({ kind: "allowed" as const })),
    dispatch: vi.fn(async () => ({ kind: "succeeded" as const, output: { result: "found" } })),
  };
  const app = await buildApp({
    userRepo,
    sessionStore,
    tokenRepo: new Tokens(),
    identity: { apiClientRepo },
    internalRoutineMcp: host,
  });
  return {
    app,
    host,
    workerHeaders: { authorization: `Bearer ${formatApiClientCredential(doc.clientId, secret)}` },
    sessionHeaders: {
      cookie: `${SESSION_COOKIE}=${session.sid}; ${CSRF_COOKIE}=${session.csrfToken}`,
      [CSRF_HEADER]: session.csrfToken,
    },
  };
}

describe("Routine MCP service routes", () => {
  it("passes the exact binding and Run lease from the Worker without credentials", async () => {
    const { app, host, workerHeaders } = await setup();
    try {
      const response = await app.inject({
        method: "POST",
        url: resolveUrl,
        headers: workerHeaders,
        payload: { arguments: { query: "ticket" }, claim, binding },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        kind: "ready",
        adapter: { kind: "mcp", ref: "example" },
        mcp: binding,
      });
      expect(host.prepare).toHaveBeenCalledWith("run-1", {
        stateKey: "Search",
        arguments: { query: "ticket" },
        claim,
        binding,
      });
      const reauthorized = await app.inject({
        method: "POST",
        url: resolveUrl.replace("/resolve", "/reauthorize"),
        headers: workerHeaders,
        payload: { claim, binding },
      });
      expect(reauthorized.json()).toEqual({ kind: "allowed" });
      expect(host.reauthorize).toHaveBeenCalledWith("run-1", {
        stateKey: "Search",
        claim,
        binding,
      });
      const effectId = "11111111-1111-4111-8111-111111111111";
      const dispatched = await app.inject({
        method: "POST",
        url: `/api/v1/internal/runs/run-1/routine-tools/${effectId}/dispatch`,
        headers: workerHeaders,
        payload: { claim, attempt: 1 },
      });
      expect(dispatched.json()).toEqual({ kind: "succeeded", output: { result: "found" } });
      expect(host.dispatch).toHaveBeenCalledWith("run-1", effectId, { claim, attempt: 1 });
    } finally {
      await app.close();
    }
  });

  it("rejects unauthenticated requests and admin user sessions", async () => {
    const { app, host, sessionHeaders } = await setup();
    try {
      for (const headers of [{}, sessionHeaders]) {
        const response = await app.inject({
          method: "POST",
          url: resolveUrl,
          headers,
          payload: { arguments: {}, claim },
        });
        expect([401, 403]).toContain(response.statusCode);
      }
      expect(host.prepare).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("requires complete exact bindings for replay reauthorization", async () => {
    const { app, host, workerHeaders } = await setup();
    try {
      const { authorizationId: _, ...incomplete } = binding;
      const response = await app.inject({
        method: "POST",
        url: resolveUrl.replace("/resolve", "/reauthorize"),
        headers: workerHeaders,
        payload: { claim, binding: incomplete },
      });
      expect(response.statusCode).toBe(400);
      expect(host.reauthorize).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
