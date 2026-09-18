import {
  emptyMcpReview,
  type McpAccountAccess,
  type McpIntegrationDefinition,
  McpIntegrationError,
  McpIntegrationService,
  type McpSession,
} from "@tulipfarm/integrations";
import { GITHUB_KNOWLEDGE_IMAGE } from "@tulipfarm/knowledge";
import { MCP_CATALOG, type McpCatalogEntry } from "@tulipfarm/mcp";
import { GITHUB_KNOWLEDGE_PRESET } from "@tulipfarm/schema";
import type { CommitActor } from "@tulipfarm/soul";
import type { PaginatedResult } from "@tulipfarm/storage";
import type { FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../app";
import type { TokenDoc, TokenRepo } from "../auth/api-tokens";
import { CSRF_COOKIE, CSRF_HEADER } from "../auth/csrf";
import { SESSION_COOKIE } from "../auth/middleware";
import { MemorySessionStore } from "../auth/session-store";
import { createUser, type UserDoc, type UserRepo } from "../auth/users";
import type { McpIntegrationRouteDeps } from "./mcp-routes";

class Users implements UserRepo {
  private readonly rows: UserDoc[] = [];
  async findByEmail(email: string) {
    return this.rows.find((row) => row.email === email) ?? null;
  }
  async findById(id: string) {
    return this.rows.find((row) => row._id === id) ?? null;
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
  async findByUserId(_userId: string): Promise<TokenDoc[]> {
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

async function setup(
  role: "admin" | "member" = "admin",
  accountConfiguration?: McpIntegrationRouteDeps["accountConfiguration"]
) {
  const userRepo = new Users();
  const user = await createUser(userRepo, "muskan@example.com", "test-password", role);
  const sessionStore = new MemorySessionStore();
  const session = await sessionStore.issue({ userId: user._id, authMethods: ["password"] });
  const definitions = new Map<string, McpIntegrationDefinition>();
  const put = vi.fn(async (definition: McpIntegrationDefinition) => {
    definitions.set(definition.server.id, definition);
  });
  const accounts: McpAccountAccess = {
    bind: async () => {
      throw new McpIntegrationError("consent_required", "Confirm the shared account first.");
    },
    revalidate: async () => {},
    use: async () => {
      throw new Error("No session should open.");
    },
  };
  const service = new McpIntegrationService<CommitActor>(
    {
      list: () => [...definitions.values()],
      get: (id) => definitions.get(id),
      put,
      remove: async (id) => {
        definitions.delete(id);
      },
    },
    accounts,
    { record: async () => {} }
  );
  const caller = vi.fn(async (_request: FastifyRequest, chatId?: string) => ({
    principal: { kind: "user", id: user._id },
    ...(chatId === undefined ? {} : { conversationId: chatId }),
  }));
  const app = await buildApp({
    userRepo,
    tokenRepo: new Tokens(),
    sessionStore,
    mcpIntegrations: {
      service,
      catalog: MCP_CATALOG.map((entry) => ({ ...entry })),
      caller,
      accountConfiguration,
    },
  });
  const headers = {
    cookie: `${SESSION_COOKIE}=${session.sid}; ${CSRF_COOKIE}=${session.csrfToken}`,
    [CSRF_HEADER]: session.csrfToken,
  };
  return { app, headers, definitions, put, caller, accounts };
}

const configure = {
  server: {
    id: "example",
    label: "Example",
    transport: { type: "streamable-http", url: "https://mcp.example.com" },
  },
  enabled: true,
};

describe("MCP Integration routes", () => {
  it("serializes the canonical local Knowledge preset without granting or configuring anything", async () => {
    const { app, headers, put } = await setup("member");
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/integrations/catalog",
        headers,
      });
      expect(response.statusCode).toBe(200);
      const github = response
        .json<{ entries: McpCatalogEntry[] }>()
        .entries.find((entry) => entry.id === "github");
      expect(github?.localPreset).toEqual(GITHUB_KNOWLEDGE_PRESET);
      expect(github?.localPreset?.transport).toMatchObject({
        type: "stdio",
        image: GITHUB_KNOWLEDGE_IMAGE,
        command: "/server/github-mcp-server",
        args: ["stdio"],
      });
      expect(github?.localPreset?.authentication).toEqual({
        type: "token",
        environment: ["GITHUB_PERSONAL_ACCESS_TOKEN"],
        sharedAllowed: false,
      });
      expect(put).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it.each(["github", "slack"])(
    "rejects reserved native slug %s without writing or renaming it",
    async (slug) => {
      const { app, headers, definitions, put } = await setup();
      try {
        const response = await app.inject({
          method: "PUT",
          url: `/api/v1/integrations/${slug}`,
          headers,
          payload: { ...configure, server: { ...configure.server, id: slug } },
        });
        expect(response.statusCode).toBe(422);
        expect(response.json()).toMatchObject({
          error: "invalid_definition",
          message: "The Integration slug is reserved for a native channel.",
        });
        expect(put).not.toHaveBeenCalled();
        expect(definitions.size).toBe(0);
      } finally {
        await app.close();
      }
    }
  );

  it.each(["personal-selected", "shared-selected"])(
    "preserves explicit %s for discovery and capability review",
    async (accountId) => {
      const { app, headers, caller, accounts } = await setup();
      const client: McpSession = {
        connect: async () => ({
          protocolVersion: "2025-11-25",
          name: "example",
          version: "1",
          capabilities: { tools: true, resources: false, prompts: false },
        }),
        discover: vi.fn(async () => ({
          tools: [],
          resources: [],
          resourceTemplates: [],
          prompts: [],
        })),
        callTool: async () => {
          throw new Error("Discovery must not execute a Tool.");
        },
        readResource: async () => {
          throw new Error("Discovery must not read a resource.");
        },
        getPrompt: async () => {
          throw new Error("Discovery must not render a prompt.");
        },
        close: vi.fn(async () => {}),
      };
      const bind = vi.spyOn(accounts, "bind").mockImplementation(async (input) => {
        if (input.caller.accountId === undefined) {
          throw new Error("The route lost its explicit account selection.");
        }
        return {
          serverId: input.server.id,
          serverRevision: input.serverRevision,
          accountId: input.caller.accountId,
          accountRevision: "1",
          subjectId: input.caller.principal.id,
          authorizationId: "interactive-discovery",
        };
      });
      accounts.use = async (_binding, _server, callback) => callback(client);
      const use = vi.spyOn(accounts, "use");
      try {
        await app.inject({
          method: "PUT",
          url: "/api/v1/integrations/example",
          headers,
          payload: configure,
        });
        const discovery = await app.inject({
          method: "POST",
          url: "/api/v1/integrations/example/discover",
          headers,
          payload: { accountId },
        });
        expect(discovery.statusCode).toBe(200);
        const review = await app.inject({
          method: "PUT",
          url: `/api/v1/integrations/example/capabilities?accountId=${accountId}`,
          headers,
          payload: discovery.json().capabilities,
        });
        expect(review.statusCode).toBe(200);
        expect(caller).toHaveBeenCalledTimes(2);
        expect(caller).toHaveBeenLastCalledWith(expect.anything(), undefined);
        expect(bind.mock.calls.map(([input]) => input.caller.accountId)).toEqual([
          accountId,
          accountId,
        ]);
        expect(bind.mock.calls.every(([input]) => input.caller.conversationId === undefined)).toBe(
          true
        );
        expect(use.mock.calls.map(([binding]) => binding.accountId)).toEqual([
          accountId,
          accountId,
        ]);
        expect(client.discover).toHaveBeenCalledTimes(2);
        expect(client.close).toHaveBeenCalledTimes(2);
      } finally {
        await app.close();
      }
    }
  );

  it.each([
    {
      method: "POST" as const,
      suffix: "/discover",
      payload: { chatId: "chat-selected", accountId: "another-account" },
    },
    {
      method: "PUT" as const,
      suffix: "/capabilities?chatId=chat-selected&accountId=another-account",
      payload: emptyMcpReview(),
    },
    {
      method: "POST" as const,
      suffix: "/resources/read",
      payload: { uri: "docs://welcome", chatId: "chat-selected", accountId: "another-account" },
    },
    {
      method: "POST" as const,
      suffix: "/prompts/render",
      payload: { name: "summarize", chatId: "chat-selected", accountId: "another-account" },
    },
  ])(
    "refuses an account override of Chat selection at $suffix",
    async ({ method, suffix, payload }) => {
      const { app, headers, caller, accounts } = await setup();
      const bind = vi.spyOn(accounts, "bind");
      const use = vi.spyOn(accounts, "use");
      try {
        await app.inject({
          method: "PUT",
          url: "/api/v1/integrations/example",
          headers,
          payload: configure,
        });
        const response = await app.inject({
          method,
          url: `/api/v1/integrations/example${suffix}`,
          headers,
          payload,
        });
        expect(response.statusCode).toBe(403);
        expect(caller).not.toHaveBeenCalled();
        expect(bind).not.toHaveBeenCalled();
        expect(use).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    }
  );

  it("returns only canonical non-secret account configuration fields", async () => {
    const metadata = vi.fn(async () => ({
      authentication: "token" as const,
      requiredSlots: ["accessToken"],
      sharedAllowed: false,
      credentialValue: "must-not-be-returned",
    }));
    const { app, headers, definitions } = await setup("admin", metadata);
    definitions.set("example", {
      server: {
        id: "example",
        label: "Example",
        transport: { type: "streamable-http", url: "https://mcp.example.com" },
      },
      enabled: true,
      reviewed: emptyMcpReview(),
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/integrations/example/accounts/configuration",
        headers,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        authentication: "token",
        requiredSlots: ["accessToken"],
        sharedAllowed: false,
      });
      expect(metadata).toHaveBeenCalledWith("example");
    } finally {
      await app.close();
    }
  });

  it("does not guess account requirements when the canonical configuration host is missing", async () => {
    const { app, headers, definitions } = await setup();
    definitions.set("example", {
      server: {
        id: "example",
        label: "Example",
        transport: { type: "streamable-http", url: "https://mcp.example.com" },
      },
      enabled: true,
      reviewed: emptyMcpReview(),
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/integrations/example/accounts/configuration",
        headers,
      });
      expect(response.statusCode).toBe(503);
    } finally {
      await app.close();
    }
  });
  it("carries the selected Chat context from discovery into capability review", async () => {
    const { app, headers, caller } = await setup();
    try {
      await app.inject({
        method: "PUT",
        url: "/api/v1/integrations/example",
        headers,
        payload: configure,
      });
      const response = await app.inject({
        method: "PUT",
        url: "/api/v1/integrations/example/capabilities?chatId=chat-selected",
        headers,
        payload: emptyMcpReview(),
      });
      expect(response.statusCode).toBe(409);
      expect(caller).toHaveBeenLastCalledWith(expect.anything(), "chat-selected");
    } finally {
      await app.close();
    }
  });

  it("requires authorization to configure servers", async () => {
    const { app, headers, put } = await setup("member");
    try {
      const response = await app.inject({
        method: "PUT",
        url: "/api/v1/integrations/example",
        headers,
        payload: configure,
      });
      expect(response.statusCode).toBe(403);
      expect(put).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("publishes setup through the injected Soul-backed store", async () => {
    const { app, headers, put } = await setup();
    try {
      const response = await app.inject({
        method: "PUT",
        url: "/api/v1/integrations/example",
        headers,
        payload: configure,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ server: { ...configure, reviewed: emptyMcpReview() } });
      expect(put).toHaveBeenCalledOnce();
      const listed = await app.inject({ method: "GET", url: "/api/v1/integrations", headers });
      expect(listed.json().servers).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("surfaces shared account consent distinctly, without a success-shaped discovery", async () => {
    const { app, headers, definitions } = await setup();
    definitions.set("example", {
      server: {
        id: "example",
        label: "Example",
        transport: { type: "streamable-http", url: "https://mcp.example.com" },
      },
      enabled: true,
      reviewed: emptyMcpReview(),
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/integrations/example/discover",
        headers,
        payload: {},
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: "consent_required" });
      expect(response.json()).not.toHaveProperty("capabilities");
    } finally {
      await app.close();
    }
  });

  it("declares the MCP surface in OpenAPI", async () => {
    const { app } = await setup();
    try {
      const response = await app.inject({ method: "GET", url: "/api/v1/openapi.json" });
      const paths = response.json().paths;
      for (const suffix of [
        "",
        "/catalog",
        "/{slug}",
        "/{slug}/discover",
        "/{slug}/capabilities",
        "/{slug}/resources/read",
        "/{slug}/prompts/render",
      ]) {
        expect(paths).toHaveProperty(`/api/v1/integrations${suffix}`);
      }
    } finally {
      await app.close();
    }
  });
});
