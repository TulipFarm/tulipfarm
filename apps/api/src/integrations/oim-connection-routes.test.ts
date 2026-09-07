import type { EgressHttpPort } from "@tulipfarm/integrations";
import type { OimManifest } from "@tulipfarm/schema";
import type { SecretsService } from "@tulipfarm/secrets";
import type {
  ConnectionStore,
  IntegrationAuthRequestDoc,
  IntegrationAuthRequestRepo,
  PersistedConnection,
} from "@tulipfarm/storage";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestPrincipal } from "../identity/principal";
import type {
  ConnectionOriginApproval,
  ConnectionOriginApprovalRepository,
} from "./connection-origin-policy";
import { registerOimConnectionRoutes } from "./oim-connection-routes";
import type { OimWebhookLifecycle } from "./oim-webhook-lifecycle";

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

const OAUTH_MANIFEST = {
  ...MANIFEST,
  auth: {
    credentialSlots: [
      { id: "client_id", label: "Client ID", kind: "api_key" },
      { id: "access_token", label: "Access token", kind: "oauth2_access_token" },
    ],
    steps: [
      {
        id: "client",
        type: "fields",
        title: "OAuth app",
        fields: [
          {
            id: "client_id",
            label: "Client ID",
            input: "password",
            target: { type: "credential", slot: "client_id" },
          },
        ],
      },
      {
        id: "consent",
        title: "Authorize",
        type: "oauth2",
        authorizationUrl: "https://acme.test/authorize",
        tokenUrl: "https://acme.test/token",
        scopes: ["read"],
        clientId: { type: "credential", slot: "client_id" },
        bindings: [
          { sourcePath: "/access_token", target: { type: "credential", slot: "access_token" } },
        ],
      },
    ],
  },
} as unknown as OimManifest;

const ORIGIN_MANIFEST = {
  ...MANIFEST,
  metadata: { id: "selfhost", version: "1.0.0" },
  extensions: {
    "x-tulipfarm-origin-policy": {
      mode: "approved_public_exact",
      fields: ["site"],
    },
  },
  auth: {
    credentialSlots: [{ id: "api_key", label: "API key", kind: "api_key", required: true }],
    configurationFields: [
      { id: "site", label: "Site host", type: "string", required: true, agentVisible: true },
    ],
    allowedOriginHosts: ["service.example.com"],
    steps: [
      {
        id: "credentials",
        type: "fields",
        title: "Connect",
        fields: [
          {
            id: "site",
            label: "Site",
            input: "text",
            target: { type: "configuration", field: "site" },
          },
          {
            id: "api_key",
            label: "API key",
            input: "password",
            target: { type: "credential", slot: "api_key" },
          },
        ],
      },
    ],
    healthCheckOperationId: "current-user",
  },
  operations: [
    {
      id: "current-user",
      name: "selfhost_current_user",
      description: "Read the current user.",
      effect: "read",
      identityMode: "shared_or_personal",
      credentialSlot: "api_key",
      credentialInjection: { in: "header", name: "Authorization", format: "******" },
      source: {
        type: "http",
        method: "GET",
        baseUrl: "https://{site}",
        path: "/api/user",
      },
      response: { schema: { type: "object" }, maxBytes: 4_096 },
    },
  ],
} as unknown as OimManifest;

class MemoryAuthRequests implements IntegrationAuthRequestRepo {
  readonly rows: IntegrationAuthRequestDoc[] = [];

  async create(request: IntegrationAuthRequestDoc): Promise<void> {
    this.rows.push({ ...request });
  }

  async consume(state: string): Promise<IntegrationAuthRequestDoc | null> {
    const row = this.rows.find(
      (candidate) =>
        candidate.state === state &&
        candidate.consumedAt === null &&
        candidate.expiresAt > new Date()
    );
    if (row === undefined) return null;
    row.consumedAt = new Date();
    return { ...row };
  }
}

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

  async findByIdAcrossBusinesses(id: string): Promise<PersistedConnection | null> {
    return this.rows.find((row) => row.id === id) ?? null;
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

  async updateHealth(
    businessId: string,
    id: string,
    health: PersistedConnection["health"],
    expiresAt: string | null
  ): Promise<void> {
    const connection = await this.findById(businessId, id);
    if (connection === null) return;
    const index = this.rows.findIndex((row) => row.id === id);
    this.rows[index] = { ...connection, health, expiresAt };
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
let connectionAccess: ReturnType<
  typeof vi.fn<
    (principal: { kind: string; id: string }, connection: PersistedConnection) => Promise<boolean>
  >
>;
let integrations: Map<string, { oimManifest: OimManifest }>;
let secrets: Map<string, string>;
let rotations: Array<{ ref: string; value: string }>;
let authRequests: MemoryAuthRequests;
let webhookRegister: ReturnType<typeof vi.fn<OimWebhookLifecycle["register"]>>;
let originApprovalRows: ConnectionOriginApproval[];
let originApprovals: ConnectionOriginApprovalRepository;
let httpSend: ReturnType<typeof vi.fn<EgressHttpPort["send"]>>;

beforeEach(async () => {
  connections = new FakeConnections();
  authorizationCheck = vi.fn(async () => true);
  connectionAccess = vi.fn(async () => true);
  integrations = new Map([["acme", { oimManifest: MANIFEST }]]);
  secrets = new Map();
  rotations = [];
  authRequests = new MemoryAuthRequests();
  httpSend = vi.fn<EgressHttpPort["send"]>(async () => ({
    status: 200,
    headers: {},
    body: { id: "user-1" },
  }));
  originApprovalRows = [];
  originApprovals = {
    get: async (businessId, connectionId, configurationField) =>
      originApprovalRows.find(
        (approval) =>
          businessId === USER.businessId &&
          approval.connectionId === connectionId &&
          approval.configurationField === configurationField
      ) ?? null,
    put: async (businessId, approval) => {
      if (businessId !== USER.businessId) throw new Error("wrong business");
      originApprovalRows = originApprovalRows.filter(
        (row) =>
          row.connectionId !== approval.connectionId ||
          row.configurationField !== approval.configurationField
      );
      originApprovalRows.push(approval);
    },
    delete: async (businessId, connectionId, configurationField) => {
      if (businessId !== USER.businessId) throw new Error("wrong business");
      originApprovalRows = originApprovalRows.filter(
        (row) => row.connectionId !== connectionId || row.configurationField !== configurationField
      );
    },
  };
  webhookRegister = vi.fn(async (..._args: Parameters<OimWebhookLifecycle["register"]>) => {});
  app = Fastify();
  registerOimConnectionRoutes(app, {
    soulLoader: { integrations } as never,
    soulWriter: {} as never,
    connections: connections as unknown as ConnectionStore,
    secrets: {
      set: async (key: string, value: string) => {
        secrets.set(key, value);
      },
      setMany: async (values: Record<string, string>) => {
        for (const [key, value] of Object.entries(values)) secrets.set(key, value);
      },
      get: async (key: string) => {
        const value = secrets.get(key);
        if (value === undefined) throw new Error("missing secret");
        return value;
      },
      delete: async (key: string) => {
        secrets.delete(key);
      },
    } as unknown as SecretsService,
    connectionSecrets: {
      rotate: async (ref, value) => {
        rotations.push({ ref, value });
        secrets.set(ref.replace(/^secret:\/\//, ""), value);
      },
      revokeConnection: async (_id, bindings, persist) => {
        for (const ref of Object.values(bindings)) {
          secrets.delete(ref.replace(/^secret:\/\//, ""));
        }
        await persist();
      },
    },
    requireAuth: async (req) => {
      (req as { principal?: RequestPrincipal }).principal = USER;
    },
    authorizationCheck: authorizationCheck as never,
    connectionAccess: { canUse: connectionAccess },
    originApprovals,
    http: { send: httpSend },
    authRequests,
    endpoints: {
      apiUrl: "https://api.tulipfarm.test",
      webUrl: "https://tulipfarm.test",
    } as never,
    fetchImpl: async () =>
      new Response(JSON.stringify({ access_token: "oauth-token" }), {
        headers: { "content-type": "application/json" },
      }),
    webhookLifecycle: {
      register: webhookRegister,
      revoke: vi.fn(async () => {}),
      reconcile: vi.fn(async () => {}),
    } as unknown as OimWebhookLifecycle,
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
    connectionAccess.mockImplementation(async (_principal, connection) => {
      return connection.owner.scope === "team" && connection.owner.teamId === TEAM;
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/integrations/acme/connections",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().connections).toMatchObject([
      { id: "visible", scope: "team", teamId: TEAM },
    ]);
    expect(authorizationCheck).not.toHaveBeenCalled();
  });

  it("returns ordered browser authorization steps in the Connection form", async () => {
    integrations.set("acme", { oimManifest: OAUTH_MANIFEST });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/integrations/acme/connections",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().form.authorizationSteps).toEqual([
      {
        id: "consent",
        type: "oauth2",
        title: "Authorize",
      },
    ]);
  });

  it("fails closed for Team visibility when no live Connection authorizer is wired", async () => {
    await app.close();
    await connections.put(USER.businessId, teamConnection("hidden", TEAM));
    app = Fastify();
    registerOimConnectionRoutes(app, {
      soulLoader: { integrations } as never,
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
    });
    await app.ready();

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/integrations/acme/connections",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().connections).toEqual([]);
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

describe("OIM Connection management", () => {
  it("creates a self-hosted Connection pending exact-origin approval", async () => {
    integrations.set("selfhost", { oimManifest: ORIGIN_MANIFEST });

    const form = await app.inject({
      method: "GET",
      url: "/api/v1/integrations/selfhost/connections",
    });
    expect(form.statusCode).toBe(200);
    expect(form.json().form.steps[0].fields[0]).toMatchObject({
      id: "site",
      requiresOriginApproval: true,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/selfhost/connections",
      payload: {
        label: "Self-hosted",
        scope: "organization",
        values: { site: "tenant.example.com", api_key: "secret" },
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ scope: "organization", status: "pending" });
    const connection = await connections.findById(USER.businessId, response.json().connectionId);
    expect(connection).toMatchObject({
      configuration: { site: "tenant.example.com" },
      health: { status: "action_required" },
    });
    expect(originApprovalRows).toEqual([]);
  });

  it("approves only the exact origin already stored on the live Connection", async () => {
    integrations.set("selfhost", { oimManifest: ORIGIN_MANIFEST });
    await connections.put(USER.businessId, {
      ...organizationConnection("selfhost-1"),
      integration: { id: "selfhost", majorVersion: 1 },
      configuration: { site: "tenant.example.com" },
      agentVisibleConfiguration: ["site"],
      secretBindings: { api_key: "secret://selfhost-token" },
      health: { status: "action_required", checkedAt: null },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/selfhost/connections/selfhost-1/origins/site/approve",
      payload: { origin: "https://attacker.example" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: "selfhost-1",
      status: "active",
      health: "unknown",
      configuration: { site: "tenant.example.com" },
    });
    expect(originApprovalRows).toHaveLength(1);
    expect(originApprovalRows[0]).toMatchObject({
      connectionId: "selfhost-1",
      integrationId: "selfhost",
      integrationMajorVersion: 1,
      configurationField: "site",
      origin: "https://tenant.example.com",
      approvedBy: USER.id,
    });
  });

  it("fails health closed until the stored self-hosted origin is approved", async () => {
    integrations.set("selfhost", { oimManifest: ORIGIN_MANIFEST });
    await connections.put(USER.businessId, {
      ...organizationConnection("selfhost-1"),
      integration: { id: "selfhost", majorVersion: 1 },
      configuration: { site: "tenant.example.com" },
      agentVisibleConfiguration: ["site"],
      secretBindings: { api_key: "secret://selfhost-token" },
      health: { status: "action_required", checkedAt: null },
    });
    secrets.set("selfhost-token", "secret");

    const before = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/selfhost/connections/selfhost-1/test",
    });
    expect(before.statusCode).toBe(200);
    expect(before.json()).toMatchObject({ status: "action_required" });
    expect(httpSend).not.toHaveBeenCalled();

    await app.inject({
      method: "POST",
      url: "/api/v1/integrations/selfhost/connections/selfhost-1/origins/site/approve",
    });
    const after = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/selfhost/connections/selfhost-1/test",
    });

    expect(after.statusCode).toBe(200);
    expect(after.json()).toMatchObject({ status: "healthy" });
    expect(httpSend).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://tenant.example.com/api/user" })
    );
  });

  it("requires fresh approval and invalidates leases after an origin update", async () => {
    integrations.set("selfhost", { oimManifest: ORIGIN_MANIFEST });
    await connections.put(USER.businessId, {
      ...organizationConnection("selfhost-1"),
      integration: { id: "selfhost", majorVersion: 1 },
      configuration: { site: "old.example.com" },
      agentVisibleConfiguration: ["site"],
      secretBindings: { api_key: "secret://selfhost-token" },
      health: { status: "healthy", checkedAt: "2026-01-01T00:00:00.000Z" },
    });
    secrets.set("selfhost-token", "secret");
    originApprovalRows.push({
      connectionId: "selfhost-1",
      integrationId: "selfhost",
      integrationMajorVersion: 1,
      configurationField: "site",
      origin: "https://old.example.com",
      bindingDigest: "stale-after-update",
      approvedBy: USER.id,
      approvedAt: "2026-01-01T00:00:00.000Z",
    });

    const response = await app.inject({
      method: "PATCH",
      url: "/api/v1/integrations/selfhost/connections/selfhost-1",
      payload: { values: { site: "new.example.com" } },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "pending",
      health: "action_required",
      configuration: { site: "new.example.com" },
    });
    expect(originApprovalRows).toEqual([]);
    expect(rotations).toEqual([{ ref: "secret://selfhost-token", value: "secret" }]);
    expect(secrets.get("selfhost-token")).toBe("secret");
  });

  it("requires a new approval when rebinding creates a new Connection identity", async () => {
    integrations.set("selfhost", { oimManifest: ORIGIN_MANIFEST });
    await connections.put(USER.businessId, {
      ...organizationConnection("selfhost-1"),
      integration: { id: "selfhost", majorVersion: 1 },
      configuration: { site: "tenant.example.com" },
      agentVisibleConfiguration: ["site"],
      secretBindings: { api_key: "secret://selfhost-token" },
      health: { status: "healthy", checkedAt: "2026-01-01T00:00:00.000Z" },
    });
    secrets.set("selfhost-token", "secret");
    originApprovalRows.push({
      connectionId: "selfhost-1",
      integrationId: "selfhost",
      integrationMajorVersion: 1,
      configurationField: "site",
      origin: "https://tenant.example.com",
      bindingDigest: "bound-to-old-id",
      approvedBy: USER.id,
      approvedAt: "2026-01-01T00:00:00.000Z",
    });

    const response = await app.inject({
      method: "PATCH",
      url: "/api/v1/integrations/selfhost/connections/selfhost-1",
      payload: { scope: "personal" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      scope: "personal",
      status: "pending",
      health: "action_required",
    });
    expect(response.json().id).not.toBe("selfhost-1");
    expect(originApprovalRows).toEqual([]);
  });

  it("renames, rotates in place, and switches the default with exact Team authority", async () => {
    const connection = {
      ...teamConnection("support", TEAM),
      isDefault: false,
      secretBindings: { api_key: "secret://immutable-id" },
    };
    await connections.put(USER.businessId, connection);
    secrets.set("immutable-id", "old");

    const response = await app.inject({
      method: "PATCH",
      url: "/api/v1/integrations/acme/connections/support",
      payload: {
        label: "Primary support",
        values: { api_key: "new-secret" },
        isDefault: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: "support",
      label: "Primary support",
      isDefault: true,
      status: "active",
    });
    expect(JSON.stringify(response.json())).not.toContain("new-secret");
    expect(JSON.stringify(response.json())).not.toContain("immutable-id");
    expect(rotations).toEqual([{ ref: "secret://immutable-id", value: "new-secret" }]);
    expect(connections.rows[0]?.secretBindings).toEqual({ api_key: "secret://immutable-id" });
    expect(authorizationCheck).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({
        action: "team.write",
        resourceType: "team",
        recordId: TEAM,
      })
    );
  });

  it("rebinds to another Team with new Secret IDs and authority over both Teams", async () => {
    await connections.put(USER.businessId, {
      ...teamConnection("support", TEAM),
      secretBindings: { api_key: "secret://old-secret-id" },
    });
    secrets.set("old-secret-id", "old-secret");

    const response = await app.inject({
      method: "PATCH",
      url: "/api/v1/integrations/acme/connections/support",
      payload: {
        scope: "team",
        teamId: OTHER_TEAM,
        values: { api_key: "new-secret" },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      scope: "team",
      teamId: OTHER_TEAM,
      status: "active",
    });
    expect(response.json().id).not.toBe("support");

    const oldConnection = await connections.findById(USER.businessId, "support");
    const newConnection = await connections.findById(USER.businessId, response.json().id);
    expect(oldConnection?.status).toBe("revoked");
    expect(newConnection?.owner).toEqual({ scope: "team", teamId: OTHER_TEAM });
    expect(newConnection?.secretBindings.api_key).not.toBe("secret://old-secret-id");
    expect(secrets.has("old-secret-id")).toBe(false);
    const newSecret = newConnection?.secretBindings.api_key?.replace(/^secret:\/\//, "");
    expect(newSecret === undefined ? undefined : secrets.get(newSecret)).toBe("new-secret");
    expect(authorizationCheck).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({ action: "team.write", resourceType: "team", recordId: TEAM })
    );
    expect(authorizationCheck).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({ action: "team.write", resourceType: "team", recordId: OTHER_TEAM })
    );
  });

  it("denies a rebind without authority over the target Team", async () => {
    await connections.put(USER.businessId, {
      ...teamConnection("support", TEAM),
      secretBindings: { api_key: "secret://old-secret-id" },
    });
    secrets.set("old-secret-id", "old-secret");
    authorizationCheck.mockImplementation(
      async (_principal, request: { recordId?: string }) => request.recordId !== OTHER_TEAM
    );

    const response = await app.inject({
      method: "PATCH",
      url: "/api/v1/integrations/acme/connections/support",
      payload: { scope: "team", teamId: OTHER_TEAM },
    });

    expect(response.statusCode).toBe(403);
    expect(connections.rows).toHaveLength(1);
    expect(connections.rows[0]?.status).toBe("active");
    expect(connections.rows[0]?.owner).toEqual({ scope: "team", teamId: TEAM });
    expect(secrets.get("old-secret-id")).toBe("old-secret");
  });

  it("reports a Connection awaiting OAuth as pending", async () => {
    integrations.set("acme", { oimManifest: OAUTH_MANIFEST });
    await connections.put(USER.businessId, {
      ...teamConnection("oauth", TEAM),
      secretBindings: { client_id: "secret://client-id" },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/integrations/acme/connections",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().connections[0]).toMatchObject({ id: "oauth", status: "pending" });
  });

  it("hides another person's Connection from management", async () => {
    await connections.put(USER.businessId, {
      ...teamConnection("private", TEAM),
      owner: { scope: "personal", principalKind: "user", principalId: "user-2" },
    });

    const response = await app.inject({
      method: "PATCH",
      url: "/api/v1/integrations/acme/connections/private",
      payload: { label: "Stolen" },
    });

    expect(response.statusCode).toBe(404);
    expect(connections.rows[0]?.label).toBe("private");
  });

  it("stores only an allowlisted local Chat return path in OAuth state", async () => {
    integrations.set("acme", { oimManifest: OAUTH_MANIFEST });
    await connections.put(USER.businessId, {
      ...teamConnection("oauth", TEAM),
      secretBindings: { client_id: "secret://client-id" },
    });
    secrets.set("client-id", "client");

    const safe = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/acme/connections/oauth/authorize",
      payload: { returnTo: "/chat/11111111-1111-4111-8111-111111111111" },
    });

    expect(safe.statusCode).toBe(200);
    expect(safe.json()).toMatchObject({ action: "redirect", stepId: "consent" });
    expect(authRequests.rows[0]?.webUrl).toBe(
      "https://tulipfarm.test/chat/11111111-1111-4111-8111-111111111111"
    );

    const unsafe = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/acme/connections/oauth/authorize",
      payload: { returnTo: "https://evil.test/chat/stolen" },
    });

    expect(unsafe.statusCode).toBe(400);
    expect(authRequests.rows).toHaveLength(1);
  });

  it("registers a webhook only after OAuth has supplied its token", async () => {
    integrations.set("acme", {
      oimManifest: {
        ...OAUTH_MANIFEST,
        auth: {
          ...OAUTH_MANIFEST.auth,
          credentialSlots: [
            ...(OAUTH_MANIFEST.auth?.credentialSlots ?? []),
            { id: "webhook_secret", label: "Webhook secret", kind: "webhook_secret" },
          ],
          steps: [
            ...(OAUTH_MANIFEST.auth?.steps ?? []),
            {
              id: "webhook",
              title: "Register webhook",
              type: "webhook",
              operationId: "register_webhook",
              unregisterOperationId: "unregister_webhook",
              subscriptionIdPath: "/id",
              secretSlot: "webhook_secret",
              registration: { callbackUrl: { in: "body", pointer: "/callback_url" } },
              unregistration: { subscriptionId: { in: "body", pointer: "/id" } },
            },
          ],
        },
      } as OimManifest,
    });

    const create = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/acme/connections",
      payload: {
        label: "OAuth",
        scope: "team",
        teamId: TEAM,
        values: { client_id: "client" },
      },
    });
    expect(create.statusCode).toBe(201);
    expect(webhookRegister).not.toHaveBeenCalled();

    const id = create.json().connectionId as string;
    const authorize = await app.inject({
      method: "POST",
      url: `/api/v1/integrations/acme/connections/${id}/authorize`,
      payload: { returnTo: "/chat/11111111-1111-4111-8111-111111111111" },
    });
    const state = new URL(authorize.json().url).searchParams.get("state");
    const callback = await app.inject({
      method: "GET",
      url: `/api/v1/integrations/oim/auth/callback?state=${state}&code=ok`,
    });

    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toContain("/chat/11111111-1111-4111-8111-111111111111");
    expect(webhookRegister).toHaveBeenCalledOnce();
  });

  it("continues a multi-step OAuth flow with the next declared step", async () => {
    const auth = OAUTH_MANIFEST.auth;
    if (auth === undefined) throw new Error("fixture has auth");
    integrations.set("acme", {
      oimManifest: {
        ...OAUTH_MANIFEST,
        auth: {
          ...auth,
          credentialSlots: [
            ...auth.credentialSlots,
            { id: "second_token", label: "Second token", kind: "oauth2_access_token" },
          ],
          steps: [
            ...auth.steps,
            {
              id: "second-consent",
              title: "Authorize second service",
              type: "oauth2",
              authorizationUrl: "https://second.acme.test/authorize",
              tokenUrl: "https://second.acme.test/token",
              scopes: ["write"],
              clientId: { type: "credential", slot: "client_id" },
              bindings: [
                {
                  sourcePath: "/access_token",
                  target: { type: "credential", slot: "second_token" },
                },
              ],
            },
          ],
        },
      } as OimManifest,
    });
    await connections.put(USER.businessId, {
      ...teamConnection("multi", TEAM),
      secretBindings: { client_id: "secret://client-id" },
    });
    secrets.set("client-id", "client");

    const authorize = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/acme/connections/multi/authorize",
      payload: { returnTo: "/chat/11111111-1111-4111-8111-111111111111" },
    });
    const state = new URL(authorize.json().url).searchParams.get("state");
    const callback = await app.inject({
      method: "GET",
      url: `/api/v1/integrations/oim/auth/callback?state=${state}&code=ok`,
    });

    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toContain("status=pending");
    expect(callback.headers.location).toContain("nextStepId=second-consent");
    expect(connections.rows.find((row) => row.id === "multi")?.health.status).toBe(
      "action_required"
    );

    const next = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/acme/connections/multi/authorize",
      payload: { stepId: "second-consent" },
    });
    expect(next.statusCode).toBe(200);
    expect(next.json()).toMatchObject({ action: "redirect", stepId: "second-consent" });
    expect(new URL(next.json().url).origin).toBe("https://second.acme.test");
  });

  it("never renders an existing credential into app-manifest browser metadata", async () => {
    const auth = OAUTH_MANIFEST.auth;
    if (auth === undefined) throw new Error("fixture has auth");
    integrations.set("acme", {
      oimManifest: {
        ...OAUTH_MANIFEST,
        auth: {
          ...auth,
          steps: [
            auth.steps[0],
            {
              id: "app",
              title: "Create app",
              type: "app_manifest",
              createUrl: "https://acme.test/apps/new",
              manifest: { name: "Tulip", forbidden: "{OIM_CLIENT_ID}" },
              bindings: [
                { sourcePath: "/app_id", target: { type: "credential", slot: "access_token" } },
              ],
            },
          ],
        },
      } as OimManifest,
    });
    await connections.put(USER.businessId, {
      ...teamConnection("app", TEAM),
      secretBindings: { client_id: "secret://client-id" },
    });
    secrets.set("client-id", "must-not-leak");

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/acme/connections/app/authorize",
      payload: { stepId: "app" },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.stringify(response.json())).not.toContain("must-not-leak");
  });
});
