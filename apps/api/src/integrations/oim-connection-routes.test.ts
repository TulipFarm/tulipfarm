import type { OimManifest } from "@tulipfarm/schema";
import type { SecretsService } from "@tulipfarm/secrets";
import type { ConnectionStore, PersistedConnection } from "@tulipfarm/storage";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestPrincipal } from "../identity/principal";
import { registerOimConnectionRoutes } from "./oim-connection-routes";

const TEAM = "00000000-0000-4000-8000-000000000004";
const OTHER_TEAM = "00000000-0000-4000-8000-000000000005";
const USER: RequestPrincipal = {
  kind: "user",
  id: "user-1",
  businessId: "biz-1",
  role: "member",
} as RequestPrincipal;

const MANIFEST = {
  metadata: { id: "acme", version: "1.0.0" },
  auth: {
    credentialSlots: [{ id: "api_key", label: "API key", kind: "api_key" }],
    steps: [
      {
        id: "credentials",
        type: "fields",
        title: "Connect Acme",
        fields: [
          {
            id: "api_key",
            label: "API key",
            input: "password",
            target: { type: "credential", slot: "api_key" },
          },
        ],
      },
    ],
  },
  operations: [],
} as unknown as OimManifest;

class FakeConnections {
  readonly rows: PersistedConnection[] = [];

  async put(businessId: string, connection: PersistedConnection): Promise<void> {
    const index = this.rows.findIndex((row) => row.id === connection.id);
    const row = { ...connection, businessId };
    if (index === -1) this.rows.push(row);
    else this.rows[index] = row;
  }

  async findById(businessId: string, id: string): Promise<PersistedConnection | null> {
    return this.rows.find((row) => row.businessId === businessId && row.id === id) ?? null;
  }

  async listForOwner(
    businessId: string,
    integration: PersistedConnection["integration"],
    owner: PersistedConnection["owner"]
  ): Promise<PersistedConnection[]> {
    return this.rows.filter(
      (row) =>
        row.businessId === businessId &&
        row.integration.id === integration.id &&
        row.integration.majorVersion === integration.majorVersion &&
        row.owner.scope === owner.scope &&
        (owner.scope !== "personal" ||
          (row.owner.scope === "personal" && row.owner.principalId === owner.principalId))
    );
  }

  async listForIntegration(
    businessId: string,
    integration: PersistedConnection["integration"]
  ): Promise<PersistedConnection[]> {
    return this.rows.filter(
      (row) =>
        row.businessId === businessId &&
        row.integration.id === integration.id &&
        row.integration.majorVersion === integration.majorVersion
    );
  }

  async markRevoked(businessId: string, id: string): Promise<boolean> {
    const connection = await this.findById(businessId, id);
    if (connection?.status !== "active") return false;
    const index = this.rows.findIndex((row) => row.id === id);
    this.rows[index] = { ...connection, status: "revoked", isDefault: false };
    return true;
  }
}

function teamConnection(id: string, teamId: string): PersistedConnection {
  return {
    businessId: USER.businessId,
    id,
    integration: { id: "acme", majorVersion: 1 },
    label: id,
    owner: { scope: "team", teamId },
    status: "active",
    isDefault: true,
    configuration: {},
    agentVisibleConfiguration: [],
    secretBindings: {},
    health: { status: "unknown", checkedAt: null },
    expiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function organizationConnection(id: string): PersistedConnection {
  return {
    ...teamConnection(id, TEAM),
    owner: { scope: "organization" },
  };
}

let app: FastifyInstance;
let connections: FakeConnections;
let authorizationCheck: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  connections = new FakeConnections();
  authorizationCheck = vi.fn(async () => true);
  app = Fastify();
  registerOimConnectionRoutes(app, {
    soulLoader: { integrations: new Map([["acme", { oimManifest: MANIFEST }]]) } as never,
    soulWriter: {} as never,
    connections: connections as unknown as ConnectionStore,
    secrets: {
      set: async () => {},
      delete: async () => {},
    } as unknown as SecretsService,
    requireAuth: async (req) => {
      (req as { principal?: RequestPrincipal }).principal = USER;
    },
    authorizationCheck: authorizationCheck as never,
    authRequests: {} as never,
    endpoints: { apiUrl: "https://api.tulipfarm.test", webUrl: "https://tulipfarm.test" } as never,
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe("OIM Team Connections", () => {
  it("requires install authority before a personal Connection materializes a bundled package", async () => {
    authorizationCheck.mockResolvedValue(false);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/telegram/connections",
      payload: {
        label: "Personal",
        scope: "personal",
        values: { bot_token: "secret" },
      },
    });

    expect(response.statusCode).toBe(403);
    expect(authorizationCheck).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({
        action: "integration.install",
        resourceType: "integration",
        fallback: "admin",
      })
    );
  });

  it("creates a Team Connection only through exact Team authority", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/acme/connections",
      payload: {
        label: "Support",
        scope: "team",
        teamId: TEAM,
        values: { api_key: "secret" },
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ scope: "team", teamId: TEAM });
    expect(connections.rows[0]?.owner).toEqual({ scope: "team", teamId: TEAM });
    expect(authorizationCheck).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({
        action: "team.write",
        resourceType: "team",
        recordId: TEAM,
        fallback: "admin",
      })
    );
  });

  it("denies Team Connection creation without exact Team authority", async () => {
    authorizationCheck.mockResolvedValue(false);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/acme/connections",
      payload: { label: "Support", scope: "team", teamId: TEAM, values: { api_key: "secret" } },
    });

    expect(response.statusCode).toBe(403);
    expect(connections.rows).toEqual([]);
  });

  it("lists only Team Connections the caller can access", async () => {
    await connections.put(USER.businessId, teamConnection("visible", TEAM));
    await connections.put(USER.businessId, teamConnection("hidden", OTHER_TEAM));
    authorizationCheck.mockImplementation(async (_principal, authorization) => {
      return authorization.action === "team.read" && authorization.recordId === TEAM;
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/integrations/acme/connections",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().connections).toMatchObject([
      { id: "visible", scope: "team", teamId: TEAM },
    ]);
  });

  it("denies revocation without authority over the owning Team", async () => {
    await connections.put(USER.businessId, teamConnection("support", TEAM));
    authorizationCheck.mockResolvedValue(false);

    const response = await app.inject({
      method: "DELETE",
      url: "/api/v1/integrations/acme/connections/support",
    });

    expect(response.statusCode).toBe(403);
    expect(connections.rows[0]?.status).toBe("active");
  });

  it("denies testing and authorization without authority over the owning Team", async () => {
    await connections.put(USER.businessId, teamConnection("support", TEAM));
    authorizationCheck.mockResolvedValue(false);

    const [testResponse, authorizeResponse] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/api/v1/integrations/acme/connections/support/test",
      }),
      app.inject({
        method: "POST",
        url: "/api/v1/integrations/acme/connections/support/authorize",
      }),
    ]);

    expect(testResponse.statusCode).toBe(403);
    expect(authorizeResponse.statusCode).toBe(403);
    expect(authorizationCheck).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({ action: "team.write", resourceType: "team", recordId: TEAM })
    );
  });

  it("denies testing and authorization without organization Connection permission", async () => {
    await connections.put(USER.businessId, organizationConnection("shared"));
    authorizationCheck.mockResolvedValue(false);

    const [testResponse, authorizeResponse] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/api/v1/integrations/acme/connections/shared/test",
      }),
      app.inject({
        method: "POST",
        url: "/api/v1/integrations/acme/connections/shared/authorize",
      }),
    ]);

    expect(testResponse.statusCode).toBe(403);
    expect(authorizeResponse.statusCode).toBe(403);
    expect(authorizationCheck).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({
        action: "integration.connect",
        resourceType: "integration",
        fallback: "admin",
      })
    );
  });
});
