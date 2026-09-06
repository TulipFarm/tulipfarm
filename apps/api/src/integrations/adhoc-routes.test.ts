import type { SecretsService } from "@tulipfarm/secrets";
import type { ConnectionStore, PersistedConnection } from "@tulipfarm/storage";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestPrincipal } from "../identity/principal";
import { adhocIntegrationId } from "./adhoc-connections";
import { registerAdhocConnectionRoutes } from "./adhoc-routes";

const ORIGIN = "https://api.example.com";
const USER: RequestPrincipal = {
  kind: "user",
  id: "user-1",
  businessId: "biz-1",
  role: "member",
} as RequestPrincipal;

const VALID = {
  origin: ORIGIN,
  rule: { location: "header", name: "x-api-key", valuePrefix: "" },
  secretValue: "k-live",
  label: "Example API",
};

class FakeConnections {
  readonly rows: PersistedConnection[] = [];
  async put(_businessId: string, connection: unknown) {
    this.rows.push(connection as PersistedConnection);
  }
  async listForOwner(
    _businessId: string,
    integration: { id: string },
    owner: { scope: string; principalId?: string }
  ) {
    return this.rows.filter(
      (row) =>
        row.integration.id === integration.id &&
        row.owner.scope === owner.scope &&
        (row.owner.scope !== "personal" || row.owner.principalId === owner.principalId)
    );
  }
}

let app: FastifyInstance;
let connections: FakeConnections;
let written: Map<string, string>;
let authorize: ReturnType<typeof vi.fn>;
let principal: RequestPrincipal | undefined;

beforeEach(async () => {
  connections = new FakeConnections();
  written = new Map();
  authorize = vi.fn(async () => true);
  principal = USER;
  app = Fastify();
  registerAdhocConnectionRoutes(app, {
    connections: connections as unknown as ConnectionStore,
    secrets: {
      set: async (key: string, value: string) => {
        written.set(key, value);
      },
    } as unknown as SecretsService,
    requireAuth: async (req) => {
      (req as { principal?: RequestPrincipal }).principal = principal;
    },
    authorizationCheck: authorize as never,
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

const post = (payload: Record<string, unknown>) =>
  app.inject({ method: "POST", url: "/api/v1/connections/adhoc", payload });

describe("POST /connections/adhoc", () => {
  it("stores a personal Connection bound to the confirmed origin", async () => {
    const response = await post(VALID);
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ origin: ORIGIN, scope: "personal" });

    const [row] = connections.rows;
    expect(row?.integration.id).toBe(adhocIntegrationId(ORIGIN));
    expect(row?.owner).toEqual({ scope: "personal", principalKind: "user", principalId: "user-1" });
    expect([...written.values()]).toEqual(["k-live"]);
  });

  it("defaults to personal so a Credential is never shared by omission", async () => {
    await post(VALID);
    expect(connections.rows[0]?.owner.scope).toBe("personal");
    expect(authorize).not.toHaveBeenCalled();
  });

  it("refuses an organization Connection the caller may not create", async () => {
    authorize.mockResolvedValue(false);
    const response = await post({ ...VALID, scope: "organization" });
    expect(response.statusCode).toBe(403);
    expect(connections.rows).toHaveLength(0);
    expect(written.size).toBe(0);
  });

  it("creates an organization Connection for a caller who may", async () => {
    const response = await post({ ...VALID, scope: "organization" });
    expect(response.statusCode).toBe(201);
    expect(authorize).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({ action: "connection.create", fallback: "admin" })
    );
    expect(connections.rows[0]?.owner).toEqual({ scope: "organization" });
  });

  it("refuses a copied browser session with a reason a person can act on", async () => {
    const response = await post({
      ...VALID,
      rule: { location: "header", name: "cookie", valuePrefix: "" },
      secretValue: "session=abc",
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error).toMatch(/browser session/i);
    expect(written.size).toBe(0);
  });

  it("refuses an origin that is not a reachable destination", async () => {
    const response = await post({ ...VALID, origin: "not a url" });
    expect(response.statusCode).toBe(422);
    expect(connections.rows).toHaveLength(0);
  });

  it("refuses an unauthenticated caller before touching the store", async () => {
    principal = undefined;
    const response = await post(VALID);
    expect(response.statusCode).toBe(403);
    expect(written.size).toBe(0);
  });

  it("rejects a body with no Credential value", async () => {
    const response = await post({ ...VALID, secretValue: "" });
    expect(response.statusCode).toBe(400);
  });

  it("rejects an injection location the Tool cannot apply", async () => {
    const response = await post({
      ...VALID,
      rule: { location: "body", name: "token", valuePrefix: "" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("keeps the Credential value out of the audit record", async () => {
    const audit = vi.fn(
      async (
        _req: unknown,
        _action: string,
        _subject: string,
        _detail: Record<string, unknown>
      ) => {}
    );
    const auditApp = Fastify();
    registerAdhocConnectionRoutes(auditApp, {
      connections: connections as unknown as ConnectionStore,
      secrets: { set: async () => {} } as unknown as SecretsService,
      requireAuth: async (req) => {
        (req as { principal?: RequestPrincipal }).principal = USER;
      },
      authorizationCheck: authorize as never,
      audit,
    });
    await auditApp.ready();
    await auditApp.inject({ method: "POST", url: "/api/v1/connections/adhoc", payload: VALID });
    expect(JSON.stringify(audit.mock.calls[0]?.[3])).not.toContain("k-live");
    expect(audit).toHaveBeenCalledWith(
      expect.anything(),
      "connection.create",
      expect.stringMatching(/^connection:/),
      expect.objectContaining({ origin: ORIGIN, scope: "personal" })
    );
    await auditApp.close();
  });
});

describe("GET /connections/adhoc", () => {
  const get = (origin: string) =>
    app.inject({
      method: "GET",
      url: `/api/v1/connections/adhoc?origin=${encodeURIComponent(origin)}`,
    });

  it("reports nothing for an origin the caller has not confirmed", async () => {
    expect((await get(ORIGIN)).json()).toEqual({ origin: ORIGIN, state: "none" });
  });

  it("names the Connection but never how it is attached", async () => {
    await post(VALID);
    const body = (await get(ORIGIN)).json();
    expect(body).toEqual({ origin: ORIGIN, state: "match", label: "Example API" });
    // Naming the header would invite a caller to rebuild the request outside the governed Tool.
    expect(JSON.stringify(body)).not.toContain("x-api-key");
  });

  it("reports ambiguity rather than picking one", async () => {
    await post(VALID);
    await post({ ...VALID, scope: "organization" });
    expect((await get(ORIGIN)).json()).toEqual({ origin: ORIGIN, state: "ambiguous", count: 2 });
  });

  it("does not report a Connection confirmed for a different origin", async () => {
    await post(VALID);
    const body = (await get("https://api.example.com:8443")).json();
    expect(body.state).toBe("none");
  });
});
