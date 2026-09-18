import { readFileSync } from "node:fs";
import type { PGlite } from "@electric-sql/pglite";
import {
  type ConnectionCredentialVault,
  createOimFixturePaginationRuntime,
  type EgressHttpPort,
  OimIngressTeardownService,
  type OimPackageCatalogEntry,
  OimWebhookRegistrationError,
} from "@tulipfarm/integrations";
import { canonicalHash, type OimConnection, type OimManifest } from "@tulipfarm/schema";
import {
  ConnectionAuthStepStore,
  ConnectionStore,
  ConnectionVerificationEvidenceStore,
  IngressTeardownStore,
  type IntegrationAuthRequestDoc,
  type IntegrationAuthRequestRepo,
  type PaginatedResult,
  PollingIngressStore,
  transactionPort,
  WebhookRegistrationStore,
} from "@tulipfarm/storage";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { buildApp } from "../../app";
import type { TokenDoc, TokenRepo } from "../../auth/api-tokens";
import { CSRF_COOKIE, CSRF_HEADER } from "../../auth/csrf";
import { SESSION_COOKIE } from "../../auth/routes";
import { MemorySessionStore } from "../../auth/session-store";
import { createUser, type UserDoc, type UserRepo } from "../../auth/users";
import { captureOimWebhookCleanupPackage } from "../../internal/oim-webhook-cleanup-package";
import { makeMigratedPglite } from "../../test/pglite";
import { createOimVerificationHost } from "../oim-verification-host";
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
        configurationFields: [
          {
            id: "workspace",
            label: "Workspace URL",
            type: "url",
            required: true,
            agentVisible: true,
          },
        ],
        steps: [
          {
            id: "credentials",
            title: "Add credentials",
            description: "Add the reviewed provider application credentials.",
            type: "fields",
            fields: [
              {
                id: "client_id",
                label: "Client ID",
                description: "The provider application client ID.",
                input: "text",
                target: { type: "credential", slot: "client_id" },
                required: true,
              },
              {
                id: "client_secret",
                label: "Client secret",
                input: "password",
                target: { type: "credential", slot: "client_secret" },
                required: true,
              },
              {
                id: "workspace",
                label: "Workspace URL",
                input: "url",
                target: { type: "configuration", field: "workspace" },
                required: true,
              },
            ],
          },
          {
            id: "app",
            title: "Create app",
            type: "app_manifest",
            createUrl: "https://provider.test/apps/new",
            manifest: { callback_url: "{callback_url}", state: "{state}" },
            bindings: [
              {
                sourcePath: "/client_id",
                target: { type: "credential", slot: "client_id" },
              },
            ],
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
          name: "health",
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
  let verifyAuthorization: OimConnectionServiceDeps["verifyAuthorization"];
  let ingressTeardowns: IngressTeardownStore;
  let webhookRegistrations: WebhookRegistrationStore;
  let catalogEntries: OimPackageCatalogEntry[];
  let failWebhookCleanup: boolean;
  let registrationPackagesAvailable: boolean;
  let http: EgressHttpPort;
  let providerCalls: number;
  let beforeCredentialCreate: (plaintext: string) => Promise<void>;

  beforeEach(async () => {
    db = await makeMigratedPglite();
    connections = new ConnectionStore(transactionPort(db));
    authSteps = new ConnectionAuthStepStore(transactionPort(db));
    ingressTeardowns = new IngressTeardownStore(transactionPort(db));
    webhookRegistrations = new WebhookRegistrationStore(transactionPort(db));
    catalogEntries = [...catalog()];
    failWebhookCleanup = false;
    registrationPackagesAvailable = true;
    providerCalls = 0;
    beforeCredentialCreate = async () => {};
    http = {
      async send() {
        providerCalls += 1;
        return {
          status: 200,
          headers: {},
          body: { accountId: "jira-user", displayName: "Muskan Vijayvargiya", active: true },
        };
      },
    };
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
    verifyAuthorization = async (input) => ({
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
    });

    const credentials: ConnectionCredentialVault = {
      async create(_integrationId, _slot, plaintext) {
        await beforeCredentialCreate(plaintext);
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
      catalog: catalogEntries,
      registrationPackages: {
        async packageFor(integrationKey) {
          if (!registrationPackagesAvailable) return null;
          const entry = catalogEntries.find(({ key }) => key === integrationKey);
          return entry === undefined ? null : { manifest: entry.manifest, files: new Map() };
        },
      },
      connections,
      authSteps,
      credentials,
      verification: {
        ...createOimVerificationHost({
          authSteps,
          credentials,
          http: { send: (request) => http.send(request) },
          paginationRuntime: createOimFixturePaginationRuntime(),
        }),
        publish: (evidence) => connections.publishVerification(evidence),
      },
      fetchImpl: async () =>
        Response.json({
          access_token: "fixture-access",
          refresh_token: "fixture-refresh",
          app_id: "A123",
          team: { id: "T123" },
          token_type: "Bearer",
        }),
      authRequests,
      endpoints: {
        callbackUrl: "https://api.example.test/api/v1/integrations/auth/callback",
        webUrl: "https://app.example.test",
        apiUrl: "https://api.example.test",
      },
      refreshOAuth: (request) => refreshOAuth(request),
      verifyAuthorization: (input) => verifyAuthorization(input),
      ingress: {
        isDisabled: (businessId, connectionId) =>
          ingressTeardowns.isDisabled(businessId, connectionId),
        requestWebhookRegistration: (key, target, now) =>
          webhookRegistrations.requestRegistration(key, target, now),
        teardown: (key, now) =>
          new OimIngressTeardownService(
            ingressTeardowns,
            new PollingIngressStore(transactionPort(db)),
            {
              remove: async (registrationKey) => {
                const registration = await webhookRegistrations.requestRemoval(registrationKey);
                if (failWebhookCleanup) {
                  throw new OimWebhookRegistrationError("cleanup_failed");
                }
                return registration;
              },
            }
          ).remove(key, now),
      },
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

  function shipped(key: string): OimManifest {
    const manifest = parse(
      readFileSync(`../../integrations/${key}/oim.yml`, "utf8")
    ) as OimManifest;
    catalogEntries.push({ key, manifest });
    return manifest;
  }

  it.each(["google-workspace", "slack-oim", "linkedin", "reddit", "x"])(
    "completes shipped %s OAuth through the production verification host",
    async (key) => {
      const manifest = shipped(key);
      http = {
        async send() {
          providerCalls += 1;
          return {
            status: 200,
            headers: {},
            body:
              key === "google-workspace" || key === "linkedin"
                ? { sub: "google-user" }
                : key === "reddit"
                  ? { id: "reddit-user", name: "muskan" }
                  : key === "x"
                    ? { data: { id: "x-user", username: "muskan", name: "Muskan Vijayvargiya" } }
                    : { ok: true, user_id: "U123", bot_id: "B123", team_id: "T123" },
          };
        },
      };
      const created = await app.inject({
        method: "POST",
        url: `/api/v1/integrations/${key}/connections`,
        ...auth(memberSid),
        payload: {
          label: key,
          ownerScope: "personal",
          values: {
            client_id: "fixture-client",
            client_secret: "fixture-secret",
            ...(key === "reddit" ? { user_agent: "web:fixture:1.0 (by /u/muskan)" } : {}),
          },
        },
      });
      expect(created.statusCode).toBe(201);
      expect(created.json().verification.status).toBe("pending");
      const id = created.json().connectionId;
      const step = manifest.auth?.steps.find((step) => step.type === "oauth2");
      const started = await app.inject({
        method: "POST",
        url: `/api/v1/integrations/${key}/connections/${id}/auth/${step?.id}`,
        ...auth(memberSid),
      });
      expect(started.statusCode).toBe(200);
      const state = new URL(started.json().url).searchParams.get("state");
      const callback = await app.inject({
        method: "GET",
        url: `/api/v1/integrations/auth/callback?state=${state}&code=fixture-code`,
      });
      expect(callback.statusCode).toBe(302);
      expect(callback.headers.location).not.toContain("status=error");
      expect(providerCalls).toBe(1);
      expect((await connections.findById(BUSINESS_ID, id))?.health.status).toBe("healthy");
      if (key === "google-workspace") {
        const connected = await connections.findById(BUSINESS_ID, id);
        const evidenceStore = new ConnectionVerificationEvidenceStore(transactionPort(db));
        const evidence = await evidenceStore.findCurrentForConnection(
          BUSINESS_ID,
          id,
          canonicalHash(manifest)
        );
        expect(evidence?.binding.authSteps.map((row) => row.stepId)).toEqual([
          "oauth_client",
          "user_consent",
        ]);
        const repaired = await app.inject({
          method: "PATCH",
          url: `/api/v1/integrations/${key}/connections/${id}/credentials`,
          ...auth(memberSid),
          payload: { values: { client_secret: "replacement-client-secret" } },
        });
        expect(repaired.json()).toEqual({ connectionId: id, verification: { status: "pending" } });
        const updated = await connections.findById(BUSINESS_ID, id);
        expect(updated?.secretBindings.access_token).toBeUndefined();
        expect(updated?.secretBindings.refresh_token).toBeUndefined();
        expect(credentialValues.has(connected?.secretBindings.access_token ?? "")).toBe(false);
        expect(
          await evidenceStore.findCurrentForConnection(BUSINESS_ID, id, canonicalHash(manifest))
        ).toBeNull();
      }
    }
  );

  it("persists shipped Jira healthy → failed proof → recovered evidence", async () => {
    const manifest = shipped("jira");
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/jira/connections",
      ...auth(memberSid),
      payload: {
        label: "Jira",
        ownerScope: "personal",
        values: { jira_site: "acme.atlassian.net", api_credential: "fixture:token" },
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().verification.status).toBe("verified");
    const id = created.json().connectionId;
    const evidence = new ConnectionVerificationEvidenceStore(transactionPort(db));
    const currentEvidence = () =>
      evidence.findCurrentForConnection(BUSINESS_ID, id, canonicalHash(manifest));
    expect(await currentEvidence()).not.toBeNull();
    http = {
      async send() {
        return {
          status: 200,
          headers: {},
          body: { accountId: "jira-user", displayName: "Muskan Vijayvargiya", active: false },
        };
      },
    };
    const refresh = () =>
      app.inject({
        method: "POST",
        url: `/api/v1/integrations/jira/connections/${id}/refresh`,
        ...auth(memberSid),
      });
    expect((await refresh()).json().health).toBe("action_required");
    expect((await connections.findById(BUSINESS_ID, id))?.health.status).toBe("action_required");
    expect(await currentEvidence()).toBeNull();
    http = {
      async send() {
        return {
          status: 200,
          headers: {},
          body: { accountId: "jira-user", displayName: "Muskan Vijayvargiya", active: true },
        };
      },
    };
    expect((await refresh()).json().health).toBe("healthy");
    expect(await currentEvidence()).not.toBeNull();
  });

  it("corrects the exact Jira credential without readback or owner changes", async () => {
    shipped("jira");
    http = {
      async send(request) {
        const valid =
          request.headers?.Authorization ===
          `Basic ${Buffer.from("fixture:correct").toString("base64")}`;
        return {
          status: 200,
          headers: {},
          body: valid
            ? { accountId: "jira-user", displayName: "Muskan Vijayvargiya", active: true }
            : { active: false },
        };
      },
    };
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/jira/connections",
      ...auth(memberSid),
      payload: {
        label: "Jira",
        ownerScope: "personal",
        values: { jira_site: "acme.atlassian.net", api_credential: "fixture:typo" },
      },
    });
    const id = created.json().connectionId;
    const before = await connections.findById(BUSINESS_ID, id);
    const replaced = await app.inject({
      method: "PATCH",
      url: `/api/v1/integrations/jira/connections/${id}/credentials`,
      ...auth(memberSid),
      payload: { values: { api_credential: "fixture:correct" } },
    });
    expect(replaced.statusCode).toBe(200);
    expect(replaced.json()).toEqual({ connectionId: id, verification: { status: "verified" } });
    const after = await connections.findById(BUSINESS_ID, id);
    expect(after?.owner).toEqual(before?.owner);
    expect(after?.id).toBe(before?.id);
    expect(after?.configuration).toEqual(before?.configuration);
    expect(credentialValues.has(before?.secretBindings.api_credential ?? "")).toBe(false);
  });

  it("rejects unknown, callback-only and non-string fields, unauthorized owners and inactive Connections", async () => {
    shipped("google-workspace");
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/google-workspace/connections",
      ...auth(memberSid),
      payload: {
        label: "Google",
        ownerScope: "personal",
        values: { client_id: "fixture-client", client_secret: "fixture-secret" },
      },
    });
    const id = created.json().connectionId;
    const url = `/api/v1/integrations/google-workspace/connections/${id}/credentials`;
    const before = await connections.findById(BUSINESS_ID, id);
    for (const values of [
      { unknown: "value" },
      { access_token: "forged" },
      { client_id: {} },
      { client_id: "" },
      {},
    ]) {
      expect(
        (await app.inject({ method: "PATCH", url, ...auth(memberSid), payload: { values } }))
          .statusCode
      ).toBe(400);
    }
    expect(
      (
        await app.inject({
          method: "PATCH",
          url,
          ...auth(otherSid),
          payload: { values: { client_id: "other" } },
        })
      ).statusCode
    ).toBe(404);
    expect(
      (await app.inject({ method: "PATCH", url, payload: { values: { client_id: "other" } } }))
        .statusCode
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url,
          cookies: { [SESSION_COOKIE]: memberSid },
          payload: { values: { client_id: "other" } },
        })
      ).statusCode
    ).toBe(403);
    expect((await connections.findById(BUSINESS_ID, id))?.secretBindings).toEqual(
      before?.secretBindings
    );
    await connections.fenceRevocation(BUSINESS_ID, id);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url,
          ...auth(memberSid),
          payload: { values: { client_id: "other" } },
        })
      ).statusCode
    ).toBe(409);
  });

  it("fences stale OAuth callbacks when application credentials are corrected", async () => {
    shipped("google-workspace");
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/google-workspace/connections",
      ...auth(memberSid),
      payload: {
        label: "Google",
        ownerScope: "personal",
        values: { client_id: "fixture-client", client_secret: "fixture-secret" },
      },
    });
    const id = created.json().connectionId;
    const started = await app.inject({
      method: "POST",
      url: `/api/v1/integrations/google-workspace/connections/${id}/auth/user_consent`,
      ...auth(memberSid),
    });
    const state = new URL(started.json().url).searchParams.get("state");
    const repaired = await app.inject({
      method: "PATCH",
      url: `/api/v1/integrations/google-workspace/connections/${id}/credentials`,
      ...auth(memberSid),
      payload: { values: { client_secret: "fixture-corrected" } },
    });
    expect(repaired.json()).toEqual({ connectionId: id, verification: { status: "pending" } });
    const callback = await app.inject({
      method: "GET",
      url: `/api/v1/integrations/auth/callback?state=${state}&code=stale-code`,
    });
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toContain("status=error");
    expect(
      (await connections.findById(BUSINESS_ID, id))?.secretBindings.access_token
    ).toBeUndefined();
    expect(providerCalls).toBe(0);
  });

  it("returns a conflict and discards staged secrets when concurrent correction wins", async () => {
    shipped("jira");
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/jira/connections",
      ...auth(memberSid),
      payload: {
        label: "Jira",
        ownerScope: "personal",
        values: { jira_site: "acme.atlassian.net", api_credential: "fixture:original" },
      },
    });
    const id = created.json().connectionId;
    let notifyStaged = () => {};
    const staged = new Promise<void>((resolve) => {
      notifyStaged = resolve;
    });
    let releaseStaged = () => {};
    const release = new Promise<void>((resolve) => {
      releaseStaged = resolve;
    });
    beforeCredentialCreate = async (plaintext) => {
      if (plaintext === "fixture:loser") {
        notifyStaged();
        await release;
      }
    };
    const update = (value: string) =>
      app.inject({
        method: "PATCH",
        url: `/api/v1/integrations/jira/connections/${id}/credentials`,
        ...auth(memberSid),
        payload: { values: { api_credential: value } },
      });
    const loser = update("fixture:loser").then((response) => response);
    await staged;
    const winner = await update("fixture:winner");
    releaseStaged();
    expect(winner.statusCode).toBe(200);
    expect((await loser).statusCode).toBe(409);
    expect([...credentialValues.values()]).not.toContain("fixture:loser");
    expect([...credentialValues.values()]).toContain("fixture:winner");
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

  it("returns safe reviewed setup metadata and exact initial authorization step ids", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/integrations/acme-v2/connection-setup",
      cookies: { [SESSION_COOKIE]: memberSid },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      integration: { id: "acme", majorVersion: 2 },
      allowedOwnerScopes: ["personal"],
      configurationFields: [
        {
          id: "workspace",
          label: "Workspace URL",
          type: "url",
          required: true,
          agentVisible: true,
        },
      ],
      fieldSteps: [
        {
          id: "credentials",
          title: "Add credentials",
          description: "Add the reviewed provider application credentials.",
          fields: [
            {
              id: "client_id",
              label: "Client ID",
              description: "The provider application client ID.",
              input: "text",
              required: true,
              secret: true,
            },
            {
              id: "client_secret",
              label: "Client secret",
              input: "password",
              required: true,
              secret: true,
            },
            {
              id: "workspace",
              label: "Workspace URL",
              input: "url",
              required: true,
              secret: false,
            },
          ],
        },
      ],
      initialAuthorizationSteps: [
        { id: "app", title: "Create app", type: "app_manifest" },
        { id: "account", title: "Account", type: "oauth2" },
        { id: "admin", title: "Admin", type: "oauth2" },
      ],
    });
  });

  it("returns only the owner-authorized pending reviewed step ids for a created Connection", async () => {
    const values = {
      client_id: "stored-client-id",
      client_secret: "stored-client-secret",
      workspace: "https://stored-workspace.example.test",
    };
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/acme-v2/connections",
      ...auth(memberSid),
      payload: { label: "Mine", ownerScope: "personal", values },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().verification).toEqual({ status: "not_required" });
    const connectionId = created.json().connectionId as string;

    const initial = await app.inject({
      method: "GET",
      url: `/api/v1/integrations/acme-v2/connection-setup?connectionId=${connectionId}`,
      cookies: { [SESSION_COOKIE]: memberSid },
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json().connectionHealth).toBe("action_required");
    expect(initial.json().pendingAuthorizationStepIds).toEqual(["app", "account", "admin"]);
    expect(initial.body).not.toContain(values.client_id);
    expect(initial.body).not.toContain(values.client_secret);
    expect(initial.body).not.toContain(values.workspace);
    expect(initial.body).not.toContain("secret://");

    const denied = await app.inject({
      method: "GET",
      url: `/api/v1/integrations/acme-v2/connection-setup?connectionId=${connectionId}`,
      cookies: { [SESSION_COOKIE]: otherSid },
    });
    expect(denied.statusCode).toBe(404);

    const handoff = await app.inject({
      method: "POST",
      url: `/api/v1/integrations/acme-v2/connections/${connectionId}/auth/app`,
      ...auth(memberSid),
    });
    const renderedManifest = JSON.parse(handoff.json().value);
    const callbackUrl = new URL(renderedManifest.callback_url);
    callbackUrl.searchParams.set("state", renderedManifest.state);
    const callback = await app.inject({
      method: "GET",
      url: `${callbackUrl.pathname}${callbackUrl.search}`,
    });
    expect(callback.statusCode).toBe(302);

    const remaining = await app.inject({
      method: "GET",
      url: `/api/v1/integrations/acme-v2/connection-setup?connectionId=${connectionId}`,
      cookies: { [SESSION_COOKIE]: memberSid },
    });
    expect(remaining.statusCode).toBe(200);
    expect(remaining.json().pendingAuthorizationStepIds).toEqual(["account", "admin"]);
  });

  it("initializes an exact missing auth step without overwriting existing or unauthorized state", async () => {
    await connections.put(
      BUSINESS_ID,
      connection("missing-step", { id: "acme", majorVersion: 2 }, memberId, {
        health: { status: "action_required", checkedAt: new Date().toISOString() },
        secretBindings: {
          client_id: "secret://00000000-0000-4000-8000-000000000045",
          client_secret: "secret://00000000-0000-4000-8000-000000000046",
        },
      })
    );
    credentialValues.set("secret://00000000-0000-4000-8000-000000000045", "client-id");
    credentialValues.set("secret://00000000-0000-4000-8000-000000000046", "client-secret");

    const started = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/acme-v2/connections/missing-step/auth/app",
      ...auth(memberSid),
    });
    expect(started.statusCode).toBe(200);
    expect(started.json().action).toBe("form_post");
    await expect(authSteps.find(BUSINESS_ID, "missing-step", "app")).resolves.toMatchObject({
      status: "pending",
      accessSecretRef: null,
      refreshSecretRef: null,
      revision: 2,
    });

    await authSteps.put({
      businessId: BUSINESS_ID,
      connectionId: "missing-step",
      stepId: "account",
      status: "active",
      accessSlot: "account_access",
      accessSecretRef: "secret://00000000-0000-4000-8000-000000000041",
      refreshSlot: "account_refresh",
      refreshSecretRef: "secret://00000000-0000-4000-8000-000000000042",
      externalIdentity: { externalAccountId: "account-1" },
      expiresAt: "2030-01-01T00:00:00.000Z",
      healthCheckedAt: "2026-09-13T10:00:00.000Z",
    });
    await authSteps.put({
      businessId: BUSINESS_ID,
      connectionId: "missing-step",
      stepId: "admin",
      status: "active",
      accessSlot: "admin_access",
      accessSecretRef: "secret://00000000-0000-4000-8000-000000000043",
      refreshSlot: "admin_refresh",
      refreshSecretRef: "secret://00000000-0000-4000-8000-000000000044",
      externalIdentity: { externalAccountId: "account-1" },
      expiresAt: "2030-01-01T00:00:00.000Z",
      healthCheckedAt: "2026-09-13T10:00:00.000Z",
    });
    const restarted = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/acme-v2/connections/missing-step/auth/account",
      ...auth(memberSid),
    });
    expect(restarted.statusCode).toBe(200);
    await expect(authSteps.find(BUSINESS_ID, "missing-step", "account")).resolves.toMatchObject({
      status: "pending",
      accessSecretRef: "secret://00000000-0000-4000-8000-000000000041",
      refreshSecretRef: "secret://00000000-0000-4000-8000-000000000042",
      externalIdentity: { externalAccountId: "account-1" },
    });
    await expect(authSteps.find(BUSINESS_ID, "missing-step", "admin")).resolves.toMatchObject({
      status: "active",
      accessSecretRef: "secret://00000000-0000-4000-8000-000000000043",
      refreshSecretRef: "secret://00000000-0000-4000-8000-000000000044",
    });

    await connections.put(
      BUSINESS_ID,
      connection("other-owner-missing", { id: "acme", majorVersion: 2 }, otherId)
    );
    const denied = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/acme-v2/connections/other-owner-missing/auth/app",
      ...auth(memberSid),
    });
    expect(denied.statusCode).toBe(404);
    await expect(authSteps.find(BUSINESS_ID, "other-owner-missing", "app")).resolves.toBeNull();

    await connections.put(
      BUSINESS_ID,
      connection("revoked-missing", { id: "acme", majorVersion: 2 }, memberId, {
        status: "revoked",
        isDefault: false,
      })
    );
    const revokedStart = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/acme-v2/connections/revoked-missing/auth/app",
      ...auth(memberSid),
    });
    expect(revokedStart.statusCode).toBe(409);
    expect(revokedStart.json()).toEqual({ error: "connection_inactive" });
    await expect(authSteps.find(BUSINESS_ID, "revoked-missing", "app")).resolves.toBeNull();
  });

  it("requests webhook registration without translating it through the legacy auth broker", async () => {
    const base = catalogEntries[1]?.manifest;
    if (base === undefined || base.auth === undefined) throw new Error("missing base manifest");
    const webhookManifest = {
      ...base,
      metadata: { ...base.metadata, id: "hooks", version: "1.0.0" },
      profiles: { ...base.profiles, events: "1.0" },
      operations: [
        ...base.operations,
        {
          id: "register-webhook",
          name: "hooks_register_webhook",
          description: "Register a webhook.",
          effect: "create",
          identityMode: "shared_only",
          credentialSlot: "account_access",
          credentialInjection: {
            in: "header",
            name: "Authorization",
            format: "Bearer {token}",
          },
          source: {
            type: "http",
            method: "POST",
            baseUrl: "https://api.example.test",
            path: "/webhooks",
          },
          requestSchema: {
            type: "object",
            properties: {
              callback_url: { type: "string" },
              secret: { type: "string" },
            },
            required: ["callback_url", "secret"],
          },
          response: { schema: { type: "object" }, maxBytes: 1_024 },
        },
        {
          id: "unregister-webhook",
          name: "hooks_unregister_webhook",
          description: "Unregister a webhook.",
          effect: "delete",
          identityMode: "shared_only",
          credentialSlot: "account_access",
          credentialInjection: {
            in: "header",
            name: "Authorization",
            format: "Bearer {token}",
          },
          source: {
            type: "http",
            method: "DELETE",
            baseUrl: "https://api.example.test",
            path: "/webhooks",
          },
          requestSchema: {
            type: "object",
            properties: { subscription_id: { type: "string" } },
            required: ["subscription_id"],
          },
          response: { schema: { type: "object" }, maxBytes: 1_024 },
        },
      ],
      auth: {
        ...base.auth,
        credentialSlots: [
          ...base.auth.credentialSlots,
          { id: "webhook_secret", label: "Webhook secret", kind: "webhook_secret" as const },
        ],
        steps: [
          ...base.auth.steps,
          {
            id: "webhook",
            title: "Register webhook",
            type: "webhook" as const,
            operationId: "register-webhook",
            unregisterOperationId: "unregister-webhook",
            subscriptionIdPath: "/id",
            secretSlot: "webhook_secret",
            registration: {
              callbackUrl: { in: "body" as const, pointer: "/callback_url" },
              secret: { in: "body" as const, pointer: "/secret" },
            },
            unregistration: {
              subscriptionId: { in: "body" as const, pointer: "/subscription_id" },
            },
          },
        ],
      },
      events: {
        path: "/events",
        verification: {
          scheme: "hmac_sha256" as const,
          secretSlot: "webhook_secret",
          signatureHeader: "x-hooks-signature",
        },
        deduplication: { kind: "none" as const },
        eventTypes: [
          {
            type: "ticket.created",
            selector: { pointer: "/type", equals: "ticket_created" },
            schema: { type: "object" },
          },
        ],
      },
    } as OimManifest;
    catalogEntries.push({ key: "hooks-v1", manifest: webhookManifest });
    await connections.put(
      BUSINESS_ID,
      connection("hooks-connection", { id: "hooks", majorVersion: 1 }, memberId)
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/hooks-v1/connections/hooks-connection/auth/webhook",
      ...auth(memberSid),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ action: "pending" });
    await expect(
      webhookRegistrations.requestRegistration(
        {
          businessId: BUSINESS_ID,
          connectionId: "hooks-connection",
          integrationId: "hooks",
          integrationMajorVersion: 1,
        },
        {
          integrationKey: "hooks-v1",
          manifestDigest: canonicalHash(webhookManifest),
          stepId: "webhook",
          callbackUrl:
            "https://api.example.test/api/v1/integrations/hooks-v1/connections/hooks-connection/events",
          operationId: "register-webhook",
          unregisterOperationId: "unregister-webhook",
          secretSlot: "webhook_secret",
          packageSnapshot: captureOimWebhookCleanupPackage({
            manifest: webhookManifest,
            files: new Map(),
          }),
        }
      )
    ).resolves.toMatchObject({
      state: "pending_registration",
      target: {
        stepId: "webhook",
        callbackUrl:
          "https://api.example.test/api/v1/integrations/hooks-v1/connections/hooks-connection/events",
        packageSnapshot: {
          integrationId: "hooks",
          version: "1.0.0",
          majorVersion: 1,
        },
      },
    });
    await expect(authSteps.find(BUSINESS_ID, "hooks-connection", "webhook")).resolves.toMatchObject(
      {
        status: "pending",
      }
    );
    expect(authRequests.rows.size).toBe(0);

    registrationPackagesAvailable = false;
    await connections.put(
      BUSINESS_ID,
      connection("missing-package", { id: "hooks", majorVersion: 1 }, memberId)
    );
    const missingPackage = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/hooks-v1/connections/missing-package/auth/webhook",
      ...auth(memberSid),
    });
    expect(missingPackage.statusCode).toBe(409);
    expect(missingPackage.json()).toEqual({ error: "registration_package_unavailable" });
  });

  it("rejects a setup callback Connection owned by someone else or from another major", async () => {
    await connections.put(
      BUSINESS_ID,
      connection("other-owner-setup", { id: "acme", majorVersion: 2 }, otherId)
    );
    await connections.put(
      BUSINESS_ID,
      connection("wrong-major-setup", { id: "acme", majorVersion: 1 }, memberId)
    );

    for (const connectionId of ["other-owner-setup", "wrong-major-setup"]) {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/integrations/acme-v2/connection-setup?connectionId=${connectionId}`,
        cookies: { [SESSION_COOKIE]: memberSid },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: "connection_not_found" });
    }
  });

  it("allows personal creation but denies another owner and Team scope", async () => {
    const own = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/acme-v2/connections",
      ...auth(memberSid),
      payload: {
        label: "Mine",
        ownerScope: "personal",
        values: {
          client_id: "client-id",
          client_secret: "client-secret",
          workspace: "https://workspace.example.test",
        },
      },
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

  it("preserves the exact Connection in a recoverable OIM callback error", async () => {
    await connections.put(
      BUSINESS_ID,
      connection("retry-authorization", { id: "acme", majorVersion: 2 }, memberId, {
        health: { status: "action_required", checkedAt: new Date().toISOString() },
      })
    );
    await authSteps.put({
      businessId: BUSINESS_ID,
      connectionId: "retry-authorization",
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
    verifyAuthorization = async () => null;

    const started = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/acme-v2/connections/retry-authorization/auth/app",
      ...auth(memberSid),
    });
    const state = [...authRequests.rows.values()][0]?.state;
    const callback = await app.inject({
      method: "GET",
      url: `/api/v1/integrations/auth/callback?state=${state}&connection=forged`,
    });

    expect(started.statusCode).toBe(200);
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe(
      "https://app.example.test/integrations/acme-v2?status=error&reason=invalid_state&connection=retry-authorization"
    );
    await expect(authSteps.find(BUSINESS_ID, "retry-authorization", "app")).resolves.toMatchObject({
      status: "pending",
    });
  });

  it("fences use and retains credentials until durable ingress cleanup completes", async () => {
    const reference = "secret://00000000-0000-4000-8000-000000000099" as const;
    credentialValues.set(reference, "still-needed-for-cleanup");
    await connections.put(
      BUSINESS_ID,
      connection("cleanup-pending", { id: "acme", majorVersion: 2 }, memberId, {
        secretBindings: { account_access: reference },
      })
    );
    await webhookRegistrations.requestRegistration(
      {
        businessId: BUSINESS_ID,
        connectionId: "cleanup-pending",
        integrationId: "acme",
        integrationMajorVersion: 2,
      },
      {
        integrationKey: "acme-v2",
        manifestDigest: "a".repeat(64),
        stepId: "webhook",
        callbackUrl:
          "https://api.example.test/api/v1/integrations/acme-v2/connections/cleanup-pending/events",
        operationId: "register-webhook",
        unregisterOperationId: "unregister-webhook",
        secretSlot: "account_access",
        packageSnapshot: {
          integrationId: "acme",
          version: "2.0.0",
          majorVersion: 2,
          packageDigest: "a".repeat(64),
          manifestText: "{}",
          files: [],
        },
      }
    );
    await db.query(
      `UPDATE oim_webhook_registrations
          SET state = 'active',
              active_registration = $3::jsonb
        WHERE business_id = $1 AND connection_id = $2`,
      [
        BUSINESS_ID,
        "cleanup-pending",
        JSON.stringify({
          subscriptionId: "subscription-1",
          secretRef: reference,
          verifiedIdentity: {
            externalTenantId: "tenant-1",
            externalAccountId: "account-1",
            proofDigest: "a".repeat(64),
            verifiedAt: "2026-09-12T12:00:00.000Z",
            verifiedBy: "provider-registration",
          },
        }),
      ]
    );

    const response = await app.inject({
      method: "DELETE",
      url: "/api/v1/integrations/acme-v2/connections/cleanup-pending",
      ...auth(memberSid),
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ status: "disconnect_pending" });
    expect(await ingressTeardowns.isDisabled(BUSINESS_ID, "cleanup-pending")).toBe(true);
    expect((await connections.findById(BUSINESS_ID, "cleanup-pending"))?.status).toBe("active");
    expect(credentialValues.get(reference)).toBe("still-needed-for-cleanup");
    expect(revoked).toEqual([]);

    const listed = await app.inject({
      method: "GET",
      url: "/api/v1/integrations/acme-v2/connections",
      cookies: { [SESSION_COOKIE]: memberSid },
    });
    expect(
      listed.json().connections.find((row: { id: string }) => row.id === "cleanup-pending")
    ).toMatchObject({ disconnectPending: true });

    const blocked = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/acme-v2/connections/cleanup-pending/refresh",
      ...auth(memberSid),
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toEqual({ error: "connection_disconnecting" });
  });

  it("keeps cleanup credentials and returns an error when remote teardown fails", async () => {
    const reference = "secret://00000000-0000-4000-8000-000000000098" as const;
    credentialValues.set(reference, "cleanup-only");
    await connections.put(
      BUSINESS_ID,
      connection("cleanup-failed", { id: "acme", majorVersion: 2 }, memberId, {
        secretBindings: { account_access: reference },
      })
    );
    failWebhookCleanup = true;

    const response = await app.inject({
      method: "DELETE",
      url: "/api/v1/integration-connections/cleanup-failed",
      ...auth(memberSid),
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "disconnect_cleanup_failed" });
    expect(await ingressTeardowns.isDisabled(BUSINESS_ID, "cleanup-failed")).toBe(true);
    expect(credentialValues.get(reference)).toBe("cleanup-only");
    expect(revoked).toEqual([]);
  });

  it("revokes an owner-bound Connection only after ingress cleanup and is repeatable", async () => {
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
    const listed = await app.inject({
      method: "GET",
      url: "/api/v1/integrations/acme-v2/connections",
      cookies: { [SESSION_COOKIE]: memberSid },
    });
    expect(listed.json().connections.some((row: { id: string }) => row.id === "orphan")).toBe(
      false
    );

    const denied = await app.inject({
      method: "DELETE",
      url: "/api/v1/integration-connections/orphan",
      ...auth(otherSid),
    });
    expect(denied.statusCode).toBe(404);
  });
});
