import type { OimManifest } from "@tulipfarm/schema";
import type { SecretsService } from "@tulipfarm/secrets";
import type { SoulLoader } from "@tulipfarm/soul";
import type { ConnectionStore, PersistedConnection } from "@tulipfarm/storage";
import { describe, expect, it, vi } from "vitest";
import { refreshOimOAuthCredentials } from "./oim-oauth-refresh-schedule";

const NOW = new Date("2026-09-05T12:00:00.000Z");

function manifest(): OimManifest {
  return {
    oimVersion: "1.0",
    kind: "Integration",
    metadata: {
      id: "acme",
      name: "Acme",
      version: "1.0.0",
      description: "Acme integration.",
      license: "Apache-2.0",
    },
    profiles: { core: "1.0", auth: "1.0" },
    auth: {
      credentialSlots: [
        { id: "client_id", label: "Client ID", kind: "api_key" },
        { id: "client_secret", label: "Client secret", kind: "client_secret" },
        { id: "access_token", label: "Access token", kind: "oauth2_access_token" },
        { id: "refresh_token", label: "Refresh token", kind: "oauth2_refresh_token" },
      ],
      steps: [
        {
          id: "consent",
          type: "oauth2",
          title: "Authorize Acme",
          authorizationUrl: "https://acme.test/authorize",
          tokenUrl: "https://acme.test/token",
          scopes: ["read"],
          clientId: { type: "credential", slot: "client_id" },
          clientSecret: { type: "credential", slot: "client_secret" },
          bindings: [
            { sourcePath: "/access_token", target: { type: "credential", slot: "access_token" } },
            { sourcePath: "/refresh_token", target: { type: "credential", slot: "refresh_token" } },
          ],
        },
      ],
    },
    operations: [],
  } as OimManifest;
}

function connection(): PersistedConnection {
  return {
    businessId: "business-1",
    id: "connection-1",
    integration: { id: "acme", majorVersion: 1 },
    label: "Acme",
    owner: { scope: "organization" },
    status: "active",
    isDefault: true,
    configuration: {},
    agentVisibleConfiguration: [],
    secretBindings: {
      client_id: "secret://client-id",
      client_secret: "secret://client-secret",
      access_token: "secret://access-token",
      refresh_token: "secret://refresh-token",
    },
    health: { status: "healthy", checkedAt: "2026-09-05T11:00:00.000Z" },
    expiresAt: "2026-09-05T12:05:00.000Z",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function harness() {
  const candidate = connection();
  const updates: {
    status: PersistedConnection["health"]["status"];
    expiresAt: string | null;
  }[] = [];
  const rotations: Record<string, string>[] = [];
  const secrets = new Map([
    ["client-id", "client-1"],
    ["client-secret", "secret-1"],
    ["access-token", "old-access"],
    ["refresh-token", "old-refresh"],
  ]);
  const connections = {
    listExpiring: vi.fn(async () => [candidate]),
    updateHealth: vi.fn(async (_businessId, _id, health, expiresAt) => {
      updates.push({ status: health.status, expiresAt });
      return true;
    }),
  } as unknown as Pick<ConnectionStore, "listExpiring" | "updateHealth">;
  const service = {
    get: async (key: string) => {
      const value = secrets.get(key);
      if (value === undefined) throw new Error(`missing ${key}`);
      return value;
    },
    setMany: async (values: Record<string, string>) => {
      rotations.push(values);
      for (const [key, value] of Object.entries(values)) secrets.set(key, value);
    },
  } as unknown as Pick<SecretsService, "get" | "setMany">;
  const soulLoader = {
    integrations: new Map([["acme", { oimManifest: manifest() }]]),
  } as unknown as SoulLoader;
  return { candidate, connections, rotations, secrets, soulLoader, updates, service };
}

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe("refreshOimOAuthCredentials", () => {
  it("marks an expiring Connection, then atomically rotates OAuth secrets and extends its expiry", async () => {
    const { connections, rotations, secrets, soulLoader, updates, service } = harness();

    await expect(
      refreshOimOAuthCredentials({
        businessId: "business-1",
        connections,
        secrets: service,
        soulLoader,
        now: () => NOW,
        fetchImpl: vi.fn(async () =>
          response(200, {
            access_token: "new-access",
            refresh_token: "new-refresh",
            expires_in: 3600,
          })
        ) as never,
      })
    ).resolves.toEqual([{ connectionId: "connection-1", status: "renewed" }]);

    expect(updates).toEqual([
      { status: "expiring", expiresAt: "2026-09-05T12:05:00.000Z" },
      { status: "healthy", expiresAt: "2026-09-05T13:00:00.000Z" },
    ]);
    expect(rotations).toEqual([{ "access-token": "new-access", "refresh-token": "new-refresh" }]);
    expect(secrets.get("access-token")).toBe("new-access");
    expect(secrets.get("refresh-token")).toBe("new-refresh");
  });

  it("requires reconnection after a refresh failure without revoking the Connection", async () => {
    const { candidate, connections, rotations, soulLoader, updates, service } = harness();

    await expect(
      refreshOimOAuthCredentials({
        businessId: "business-1",
        connections,
        secrets: service,
        soulLoader,
        now: () => NOW,
        fetchImpl: vi.fn(async () => response(400, { error: "invalid_grant" })) as never,
      })
    ).resolves.toEqual([{ connectionId: "connection-1", status: "action_required" }]);

    expect(updates).toEqual([
      { status: "expiring", expiresAt: "2026-09-05T12:05:00.000Z" },
      { status: "action_required", expiresAt: "2026-09-05T12:05:00.000Z" },
    ]);
    expect(rotations).toEqual([]);
    expect(candidate.status).toBe("active");
  });
});
