import type { PGlite } from "@electric-sql/pglite";
import type { ConnectionCredentialVault, OimPackageCatalogEntry } from "@tulipfarm/integrations";
import type { OimConnection, OimManifest } from "@tulipfarm/schema";
import {
  ConnectionAuthStepStore,
  ConnectionStore,
  type IntegrationAuthRequestDoc,
  type IntegrationAuthRequestRepo,
  type PaginatedResult,
  transactionPort,
} from "@tulipfarm/storage";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../app";
import type { TokenDoc, TokenRepo } from "../../auth/api-tokens";
import { CSRF_COOKIE, CSRF_HEADER } from "../../auth/csrf";
import { SESSION_COOKIE } from "../../auth/routes";
import { MemorySessionStore } from "../../auth/session-store";
import { createUser, type UserDoc, type UserRepo } from "../../auth/users";
import { makeMigratedPglite } from "../../test/pglite";
import { OimConnectionService, type OimConnectionServiceDeps } from "./service";

const BUSINESS_ID = "business-1";
const CSRF = "a".repeat(64);

class UserRepoMemory implements UserRepo {
  private readonly users: UserDoc[] = [];
  async findByEmail(email: string) {
    return this.users.find((user) => user.email === email.trim().toLowerCase()) ?? null;
  }
  async findById(id: string) {
    return this.users.find((user) => user._id === id) ?? null;
  }
  async count() {
    return this.users.length;
  }
  async insert(user: UserDoc) {
    this.users.push(user);
  }
}

class TokenRepoMemory implements TokenRepo {
  async create(_token: TokenDoc) {}
  async findByHash(_hash: string) {
    return null;
  }
  async findByUserId(_userId: string) {
    return [];
  }
  async findAll() {
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

class AuthRequestsMemory implements IntegrationAuthRequestRepo {
  readonly rows = new Map<string, IntegrationAuthRequestDoc>();
  async create(request: IntegrationAuthRequestDoc) {
    this.rows.set(request.state, request);
  }
  async findActive(state: string) {
    const row = this.rows.get(state);
    return row?.consumedAt === null ? row : null;
  }
  async consume(state: string) {
    const row = await this.findActive(state);
    if (row === null) return null;
    const consumed = { ...row, consumedAt: new Date() };
    this.rows.set(state, consumed);
    return consumed;
  }
}

function catalog(): readonly OimPackageCatalogEntry[] {
  const manifest = (id: string, version: string) =>
    ({
      oimVersion: "1.0",
      kind: "Integration",
      metadata: {
        id,
        name: id,
        version,
        description: "Test Integration",
        license: "Apache-2.0",
      },
      profiles: { core: "1.0", auth: "1.0" },
      auth: {
        credentialSlots: [
          { id: "client_id", label: "Client id", kind: "api_key" },
          { id: "client_secret", label: "Client secret", kind: "client_secret" },
          { id: "account_access", label: "Account access", kind: "oauth2_access_token" },
          { id: "account_refresh", label: "Account refresh", kind: "oauth2_refresh_token" },
          { id: "admin_access", label: "Admin access", kind: "oauth2_access_token" },
          { id: "admin_refresh", label: "Admin refresh", kind: "oauth2_refresh_token" },
        ],
        steps: [
          {
            id: "app",
            title: "Create app",
            type: "app_manifest",
            createUrl: "https://provider.test/apps/new",
            manifest: { callback_url: "{callback_url}", state: "{state}" },
            bindings: [],
          },
          {
            id: "account",
            title: "Account",
            type: "oauth2",
            authorizationUrl: "https://provider.test/account/authorize",
            tokenUrl: "https://provider.test/account/token",
            scopes: [],
            clientId: { type: "credential", slot: "client_id" },
            clientSecret: { type: "credential", slot: "client_secret" },
            bindings: [
              {
                sourcePath: "/access_token",
                target: { type: "credential", slot: "account_access" },
              },
              {
                sourcePath: "/refresh_token",
                target: { type: "credential", slot: "account_refresh" },
              },
            ],
          },
          {
            id: "admin",
            title: "Admin",
            type: "oauth2",
            authorizationUrl: "https://provider.test/admin/authorize",
            tokenUrl: "https://provider.test/admin/token",
            scopes: [],
            clientId: { type: "credential", slot: "client_id" },
            clientSecret: { type: "credential", slot: "client_secret" },
            bindings: [
              {
                sourcePath: "/access_token",
                target: { type: "credential", slot: "admin_access" },
              },
              {
                sourcePath: "/refresh_token",
                target: { type: "credential", slot: "admin_refresh" },
              },
            ],
          },
        ],
      },
      operations: [
        {
          id: "read",
          name: "Health",
          description: "Read health.",
          effect: "read",
          identityMode: "shared_or_personal",
          source: {
            type: "http",
            method: "GET",
            baseUrl: "https://api.example.test",
            path: "/health",
          },
          response: { schema: { type: "object" }, maxBytes: 1_024 },
        },
      ],
    }) as OimManifest;
  return [
    { key: "acme-v1", manifest: manifest("acme", "1.0.0") },
    { key: "acme-v2", manifest: manifest("acme", "2.0.0") },
    { key: "acme-v2-v1", manifest: manifest("acme-v2", "1.0.0") },
  ];
}

function connection(
  id: string,
  integration: { id: string; majorVersion: number },
  principalId: string,
  overrides: Partial<OimConnection> = {}
) {
  return {
    id,
    integration,
    label: id,
    owner: { scope: "personal", principalKind: "user", principalId } as const,
    status: "active" as const,
    isDefault: true,
    configuration: {},
    agentVisibleConfiguration: [],
    secretBindings: {},
    health: { status: "healthy" as const, checkedAt: new Date().toISOString() },
    expiresAt: null,
    ...overrides,
  };
}

describe("OIM Connection routes", () => {
  let app: FastifyInstance;
  let db: PGlite;
  let connections: ConnectionStore;
  let memberId: string;
  let otherId: string;
  let memberSid: string;
  let otherSid: string;
  let revoked: string[];
  let authSteps: ConnectionAuthStepStore;
  let authRequests: AuthRequestsMemory;
  let credentialValues: Map<string, string>;
  let refreshOAuth: OimConnectionServiceDeps["refreshOAuth"];

  beforeEach(async () => {
    db = await makeMigratedPglite();
    connections = new ConnectionStore(transactionPort(db));
    authSteps = new ConnectionAuthStepStore(transactionPort(db));
    const sessionStore = new MemorySessionStore();
    const userRepo = new UserRepoMemory();
    const member = await createUser(userRepo, "member@example.com", "pass", "member");
    const other = await createUser(userRepo, "other@example.com", "pass", "member");
    memberId = member._id;
    otherId = other._id;
    memberSid = await sessionStore.create(memberId);
    otherSid = await sessionStore.create(otherId);
    revoked = [];
    credentialValues = new Map();
    let nextSecret = 100;
    refreshOAuth = async ({ step }) => ({
      credentialValues: {
        [`${step.id}_access`]: `new-${step.id}-access`,
        [`${step.id}_refresh`]: `new-${step.id}-refresh`,
      },
      expiresAt: "2030-01-01T00:00:00.000Z",
      verifiedIdentity: {
        externalTenantId: "tenant-1",
        externalAccountId: "account-1",
        proofDigest: "a".repeat(64),
        verifiedAt: "2026-09-12T12:00:00.000Z",
        verifiedBy: "provider-profile",
      },
    });

    const credentials: ConnectionCredentialVault = {
      async create(_integrationId, _slot, plaintext) {
        const reference =
          `secret://00000000-0000-4000-8000-${String(nextSecret++).padStart(12, "0")}` as const;
        credentialValues.set(reference, plaintext);
        return reference;
      },
      async read(reference) {
        const value = credentialValues.get(reference);
        if (value === undefined) throw new Error("credential missing");
        return value;
      },
      async rotate(reference, plaintext) {
        credentialValues.set(reference, plaintext);
      },
      async revokeReferences(references) {
        for (const reference of references) credentialValues.delete(reference);
      },
      async revokeConnection(connectionId, bindings, persistRevocation) {
        revoked.push(connectionId);
        for (const reference of Object.values(bindings)) credentialValues.delete(reference);
        await persistRevocation();
      },
    };
    authRequests = new AuthRequestsMemory();
    const service = new OimConnectionService({
      businessId: BUSINESS_ID,
      catalog: catalog(),
      connections,
      authSteps,
      credentials,
      authRequests,
      endpoints: {
        callbackUrl: "https://api.example.test/api/v1/integrations/auth/callback",
        webUrl: "https://app.example.test",
        apiUrl: "https://api.example.test",
      },
      refreshOAuth: (request) => refreshOAuth(request),
      verifyAuthorization: async (input) => ({
        identity: {
          externalTenantId: "tenant-1",
          externalAccountId: "account-1",
          proofDigest: "a".repeat(64),
          verifiedAt: "2026-09-12T12:00:00.000Z",
          verifiedBy: "provider-profile",
        },
        credentialValues: input.candidateCredentialValues,
        configuration: input.candidateConfiguration,
        expiresAt: input.candidateExpiresAt,
      }),
    });
    app = await buildApp({
      sessionStore,
      userRepo,
      tokenRepo: new TokenRepoMemory(),
      oimConnections: service,
    });
  });

  afterEach(async () => {
    await app?.close();
    await db?.close();
  });

  const auth = (sid: string) => ({
    cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: CSRF },
    headers: { [CSRF_HEADER]: CSRF },
  });

  it("resolves the catalog key to its exact Integration id and major", async () => {
    await connections.put(BUSINESS_ID, connection("v1", { id: "acme", majorVersion: 1 }, memberId));
    await connections.put(BUSINESS_ID, connection("v2", { id: "acme", majorVersion: 2 }, memberId));
    await connections.put(
      BUSINESS_ID,
      connection("suffix", { id: "acme-v2", majorVersion: 1 }, memberId)
    );
    await connections.put(
      BUSINESS_ID,
      connection("other", { id: "acme", majorVersion: 2 }, otherId)
    );

    const v2 = await app.inject({
      method: "GET",
      url: "/api/v1/integrations/acme-v2/connections",
      cookies: { [SESSION_COOKIE]: memberSid },
    });
    expect(v2.statusCode).toBe(200);
    expect(v2.json().connections.map((row: { id: string }) => row.id)).toEqual(["v2"]);

    const suffix = await app.inject({
      method: "GET",
      url: "/api/v1/integrations/acme-v2-v1/connections",
      cookies: { [SESSION_COOKIE]: memberSid },
    });
    expect(suffix.statusCode).toBe(200);
    expect(suffix.json().connections.map((row: { id: string }) => row.id)).toEqual(["suffix"]);

    const wrongMajor = await app.inject({
      method: "GET",
      url: "/api/v1/integrations/acme-v2/connections/v1",
      cookies: { [SESSION_COOKIE]: memberSid },
    });
    expect(wrongMajor.statusCode).toBe(404);
  });

  it("allows personal creation but denies another owner and Team scope", async () => {
    const own = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/acme-v2/connections",
      ...auth(memberSid),
      payload: { label: "Mine", ownerScope: "personal", values: {} },
    });
    expect(own.statusCode).toBe(201);

    const team = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/acme-v2/connections",
      ...auth(memberSid),
      payload: { label: "Team", ownerScope: "team", ownerId: "team-1", values: {} },
    });
    expect(team.statusCode).toBe(403);

    await connections.put(
      BUSINESS_ID,
      connection("other", { id: "acme", majorVersion: 2 }, otherId)
    );
    const crossOwner = await app.inject({
      method: "GET",
      url: "/api/v1/integrations/acme-v2/connections/other",
      cookies: { [SESSION_COOKIE]: memberSid },
    });
    expect(crossOwner.statusCode).toBe(404);
  });

  it("refreshes every independently expiring OAuth step through the request path", async () => {
    const refs = {
      client_id: "secret://00000000-0000-4000-8000-000000000001",
      client_secret: "secret://00000000-0000-4000-8000-000000000002",
      account_access: "secret://00000000-0000-4000-8000-000000000003",
      account_refresh: "secret://00000000-0000-4000-8000-000000000004",
      admin_access: "secret://00000000-0000-4000-8000-000000000005",
      admin_refresh: "secret://00000000-0000-4000-8000-000000000006",
    } as const;
    for (const [slot, reference] of Object.entries(refs)) {
      credentialValues.set(reference, `old-${slot}`);
    }
    await connections.put(
      BUSINESS_ID,
      connection("refresh-me", { id: "acme", majorVersion: 2 }, memberId, {
        secretBindings: refs,
        health: { status: "expiring", checkedAt: new Date().toISOString() },
        expiresAt: "2020-01-01T00:00:00.000Z",
      })
    );
    for (const stepId of ["account", "admin"]) {
      await authSteps.put({
        businessId: BUSINESS_ID,
        connectionId: "refresh-me",
        stepId,
        status: "active",
        accessSlot: `${stepId}_access`,
        accessSecretRef: refs[`${stepId}_access` as "account_access" | "admin_access"],
        refreshSlot: `${stepId}_refresh`,
        refreshSecretRef: refs[`${stepId}_refresh` as "account_refresh" | "admin_refresh"],
        externalIdentity: null,
        expiresAt: "2020-01-01T00:00:00.000Z",
        healthCheckedAt: new Date().toISOString(),
      });
    }

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/acme-v2/connections/refresh-me/refresh",
      ...auth(memberSid),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().steps).toEqual([
      { stepId: "account", status: "renewed" },
      { stepId: "admin", status: "renewed" },
    ]);
    const refreshed = await connections.findById(BUSINESS_ID, "refresh-me");
    expect(credentialValues.get(refreshed?.secretBindings.account_access as string)).toBe(
      "new-account-access"
    );
    expect(credentialValues.get(refreshed?.secretBindings.admin_access as string)).toBe(
      "new-admin-access"
    );
    expect(credentialValues.has(refs.account_access)).toBe(false);
    expect(credentialValues.has(refs.admin_access)).toBe(false);
  });

  it("prevents an in-flight refresh from publishing after revoke", async () => {
    const refs = {
      account_access: "secret://00000000-0000-4000-8000-000000000031",
      account_refresh: "secret://00000000-0000-4000-8000-000000000032",
      admin_access: "secret://00000000-0000-4000-8000-000000000033",
      admin_refresh: "secret://00000000-0000-4000-8000-000000000034",
    } as const;
    for (const [slot, reference] of Object.entries(refs)) {
      credentialValues.set(reference, `old-${slot}`);
    }
    await connections.put(
      BUSINESS_ID,
      connection("refresh-race", { id: "acme", majorVersion: 2 }, memberId, {
        secretBindings: refs,
        health: { status: "expiring", checkedAt: new Date().toISOString() },
        expiresAt: "2020-01-01T00:00:00.000Z",
      })
    );
    for (const stepId of ["account", "admin"]) {
      await authSteps.put({
        businessId: BUSINESS_ID,
        connectionId: "refresh-race",
        stepId,
        status: "active",
        accessSlot: `${stepId}_access`,
        accessSecretRef: refs[`${stepId}_access` as "account_access" | "admin_access"],
        refreshSlot: `${stepId}_refresh`,
        refreshSecretRef: refs[`${stepId}_refresh` as "account_refresh" | "admin_refresh"],
        externalIdentity: null,
        expiresAt: "2020-01-01T00:00:00.000Z",
        healthCheckedAt: new Date().toISOString(),
      });
    }
    let enteredResolve: (() => void) | undefined;
    let releaseResolve: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseResolve = resolve;
    });
    refreshOAuth = async ({ step }) => {
      if (step.id === "account") {
        enteredResolve?.();
        await release;
      }
      return {
        credentialValues: {
          [`${step.id}_access`]: `new-${step.id}-access`,
          [`${step.id}_refresh`]: `new-${step.id}-refresh`,
        },
        expiresAt: "2030-01-01T00:00:00.000Z",
        verifiedIdentity: {
          externalTenantId: "tenant-1",
          externalAccountId: "account-1",
          proofDigest: "a".repeat(64),
          verifiedAt: "2026-09-12T12:00:00.000Z",
          verifiedBy: "provider-profile",
        },
      };
    };

    const refreshing = app.inject({
      method: "POST",
      url: "/api/v1/integrations/acme-v2/connections/refresh-race/refresh",
      ...auth(memberSid),
    });
    await entered;
    const revokedResponse = await app.inject({
      method: "DELETE",
      url: "/api/v1/integration-connections/refresh-race",
      ...auth(memberSid),
    });
    releaseResolve?.();
    const refreshResponse = await refreshing;

    expect(revokedResponse.statusCode).toBe(200);
    expect(refreshResponse.statusCode).toBe(200);
    expect(refreshResponse.json().steps).toEqual([
      { stepId: "account", status: "conflict", error: "revision_conflict" },
      { stepId: "admin", status: "conflict", error: "revision_conflict" },
    ]);
    expect(await connections.findById(BUSINESS_ID, "refresh-race")).toMatchObject({
      status: "revoked",
      secretBindings: refs,
    });
    expect(await authSteps.list(BUSINESS_ID, "refresh-race")).toMatchObject([
      { stepId: "account", status: "revoked" },
      { stepId: "admin", status: "revoked" },
    ]);
    expect(credentialValues.size).toBe(0);
  });

  it("completes an OIM-only callback with issued state and rejects invalid or replayed state", async () => {
    await connections.put(
      BUSINESS_ID,
      connection("authorize-me", { id: "acme", majorVersion: 2 }, memberId, {
        health: { status: "action_required", checkedAt: new Date().toISOString() },
      })
    );
    await authSteps.put({
      businessId: BUSINESS_ID,
      connectionId: "authorize-me",
      stepId: "app",
      status: "pending",
      accessSlot: null,
      accessSecretRef: null,
      refreshSlot: null,
      refreshSecretRef: null,
      externalIdentity: null,
      expiresAt: null,
      healthCheckedAt: new Date().toISOString(),
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/acme-v2/connections/authorize-me/auth/app",
      ...auth(memberSid),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    const state = [...authRequests.rows.values()][0]?.state;
    const renderedManifest = JSON.parse(body.value);
    expect(new URL(body.url).searchParams.get("state")).toBe(state);
    expect(renderedManifest.state).toBe(state);
    const callbackUrl = new URL(renderedManifest.callback_url);
    expect(callbackUrl.origin).toBe("https://api.example.test");
    callbackUrl.searchParams.set("state", state as string);

    const callback = await app.inject({
      method: "GET",
      url: `${callbackUrl.pathname}${callbackUrl.search}`,
    });
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe(
      "https://app.example.test/integrations/acme-v2?connection=authorize-me&status=ok"
    );
    await expect(authSteps.find(BUSINESS_ID, "authorize-me", "app")).resolves.toMatchObject({
      status: "active",
    });

    for (const rejectedState of [state, "unknown-state"]) {
      const rejected = await app.inject({
        method: "GET",
        url: `/api/v1/integrations/auth/callback?state=${rejectedState}`,
      });
      expect(rejected.statusCode).toBe(302);
      expect(rejected.headers.location).toBe(
        "https://app.example.test/integrations/?status=error&reason=invalid_state"
      );
    }
  });

  it("revokes an owner-bound Connection without a catalog manifest and is repeatable", async () => {
    await connections.put(
      BUSINESS_ID,
      connection("orphan", { id: "removed-provider", majorVersion: 4 }, memberId)
    );

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await app.inject({
        method: "DELETE",
        url: "/api/v1/integration-connections/orphan",
        ...auth(memberSid),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: "revoked" });
    }
    expect(revoked).toEqual(["orphan", "orphan"]);
    expect((await connections.findById(BUSINESS_ID, "orphan"))?.status).toBe("revoked");

    const denied = await app.inject({
      method: "DELETE",
      url: "/api/v1/integration-connections/orphan",
      ...auth(otherSid),
    });
    expect(denied.statusCode).toBe(404);
  });
});
