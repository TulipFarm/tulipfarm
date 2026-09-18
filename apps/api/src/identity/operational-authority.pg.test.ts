import { randomBytes, randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { OPERATIONAL_UPDATE_READ, type OperationalScope } from "@tulipfarm/authz";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import { KvService, kvSetTool, PgKvRepo } from "@tulipfarm/kv";
import { LlmService } from "@tulipfarm/llm";
import { BatchingLogSink } from "@tulipfarm/observability";
import { ArtifactService, TypedOutputValidator } from "@tulipfarm/run-kernel";
import { PgSecretRepo, SecretsService } from "@tulipfarm/secrets";
import { SoulLoader } from "@tulipfarm/soul";
import {
  initializeRuntimeDeployment,
  MemoryArtifactStore,
  PgPrincipalRepo,
  PgRoleRepo,
} from "@tulipfarm/storage";
import {
  InMemoryToolCatalog,
  LiveToolGate,
  RegistryToolDispatcher,
  toToolDef,
} from "@tulipfarm/tool-host";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app";
import { PgTokenRepo } from "../auth/api-tokens";
import { CSRF_COOKIE, CSRF_HEADER } from "../auth/csrf";
import { SESSION_COOKIE } from "../auth/middleware";
import { MemorySessionStore } from "../auth/session-store";
import { createUser, PgUserRepo } from "../auth/users";
import { LiveRouteAuthorizer } from "../authz/route-gate";
import { PgConversationRepo } from "../chat/conversations";
import { PgMessageRepo } from "../chat/messages";
import { transactionPort } from "../db";
import { InternalTurnHost } from "../internal/turn-host";
import { LiveRecordAuthorizer } from "../resources/authorize";
import { PgCounterStore, PgResourceRepoFactory } from "../resources/repo";
import { createHistoryTableSql, createResourceTableSql } from "../resources/schema";
import { makeMigratedPglite } from "../test/pglite";
import { FakeConversationStore, fakeRuns } from "../test/turn-host-fixtures";
import {
  createApiClient,
  formatApiClientCredential,
  PgApiClientRepo,
  parseApiClientCredential,
  rotateApiClientSecret,
} from "./api-clients";
import { buildApiAuthorityLayerResolver } from "./authority-layers";

const SENTINELS = {
  chat: "PRIVATE_CHAT_61dd528c",
  record: "PRIVATE_RECORD_67b88631",
  secret: "PRIVATE_PROVIDER_KEY_752add80",
  config: "PRIVATE_LLM_CONFIG_b25def04",
  error: "PRIVATE_STORAGE_ERROR_8c3c9a45",
};
const CSRF = "a".repeat(64);
const UPDATE = "/api/v1/system/update-check";
const RECORD_ID = "10000000-0000-4000-8000-000000000001";

describe("operational authority through the assembled application", () => {
  let db: PGlite;
  let app: FastifyInstance;
  let deployment: OperationalScope;
  let clients: PgApiClientRepo;
  let roles: PgRoleRepo;
  let principals: PgPrincipalRepo;
  let clientId: string;
  let credential: string;
  let adminId: string;
  let adminSid: string;
  let conversationId: string;
  let kv: KvService;
  let fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>;
  let resolver: ReturnType<typeof buildApiAuthorityLayerResolver>;
  let scopeOverride: OperationalScope | undefined;

  const headers = () => ({ authorization: `Bearer ${credential}` });
  const admin = () => ({
    cookies: { [SESSION_COOKIE]: adminSid, [CSRF_COOKIE]: CSRF },
    headers: { [CSRF_HEADER]: CSRF },
  });

  async function grant(conditions = deployment) {
    await roles.putRole({
      businessId: deployment.businessId,
      id: "operational-release-reader",
      assignableTo: ["service"],
      parentRoleIds: [],
      grants: [
        {
          ...OPERATIONAL_UPDATE_READ,
          conditions: {
            businessId: conditions.businessId,
            installationId: conditions.installationId,
          },
          effect: "allow",
        },
      ],
    });
    await roles.assign({
      businessId: deployment.businessId,
      principalId: clientId,
      roleId: "operational-release-reader",
    });
  }

  beforeEach(async () => {
    db = await makeMigratedPglite();
    deployment = await initializeRuntimeDeployment(db, { businessId: DEPLOYMENT_BUSINESS_ID });
    scopeOverride = deployment;
    clients = new PgApiClientRepo(db);
    roles = new PgRoleRepo(transactionPort(db));
    principals = new PgPrincipalRepo(transactionPort(db));
    resolver = buildApiAuthorityLayerResolver(db);
    const sessions = new MemorySessionStore();
    const users = new PgUserRepo(db);
    const user = await createUser(users, "muskan@example.test", "not-a-real-password", "admin");
    adminId = user._id;
    adminSid = await sessions.create(user._id);
    const conversations = new PgConversationRepo(db);
    const messages = new PgMessageRepo(db);
    conversationId = randomUUID();
    const now = new Date();
    await conversations.create({
      _id: conversationId,
      userId: adminId,
      title: SENTINELS.chat,
      createdAt: now,
      updatedAt: now,
    });
    await messages.create({
      _id: randomUUID(),
      conversationId,
      role: "user",
      content: SENTINELS.chat,
      createdAt: now,
    });
    const soul = new SoulLoader("unused-operational-fixture", { info() {}, warn() {}, error() {} });
    soul.resources.set("ticket", {
      name: "ticket",
      hasHooks: false,
      hooksEnabled: false,
      schema: { type: "object", properties: { title: { type: "string" } } },
    });
    await db.exec(createResourceTableSql("ticket"));
    await db.exec(createHistoryTableSql("ticket"));
    const records = new PgResourceRepoFactory(db);
    await records.forType("ticket").insert({
      _id: RECORD_ID,
      version: 1,
      title: SENTINELS.record,
      createdAt: now,
      updatedAt: now,
    });
    const secrets = new SecretsService(new PgSecretRepo(db), {
      dekId: randomUUID(),
      key: randomBytes(32),
    });
    await secrets.set("provider-test", SENTINELS.secret);
    kv = new KvService(new PgKvRepo(db));
    fetchImpl = vi.fn(async () => new Response(JSON.stringify({ tag_name: "v9.9.9" })));
    const identity = {
      apiClientRepo: clients,
      get deployment() {
        return scopeOverride;
      },
    };
    app = await buildApp({
      logSink: new BatchingLogSink({ service: "api", writer: { async insertMany() {} } }),
      sessionStore: sessions,
      userRepo: users,
      tokenRepo: new PgTokenRepo(db),
      identity,
      routeAuthorizer: new LiveRouteAuthorizer(resolver),
      authorizationGate: { mode: "shadow" },
      systemRoutes: { fetchImpl, kv },
      kvService: kv,
      secretsService: secrets,
      soulLoader: soul,
      llmService: new LlmService(),
      conversationRepo: conversations,
      messageRepo: messages,
      resourceRepoFactory: records,
      counterStore: new PgCounterStore(db),
      recordAuthorizer: new LiveRecordAuthorizer(soul, resolver),
      internalTurns: {
        host: new InternalTurnHost({
          runs: fakeRuns(),
          store: new FakeConversationStore(),
          context: {
            async resolve() {
              throw new Error(SENTINELS.chat);
            },
          },
          tools: {
            async dispatch() {
              throw new Error(SENTINELS.record);
            },
          },
        }),
        llmConfig: () => ({ sentinel: SENTINELS.config }),
        pricingOverrides: () => ({}),
      },
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/identity/api-clients",
      ...admin(),
      payload: { name: "runtime-release-reader", operational: true },
    });
    expect(created.statusCode, created.body).toBe(201);
    credential = created.json().credential;
    clientId = created.json().client.id;
    expect(created.json().client.operationalScope).toEqual({
      businessId: deployment.businessId,
      installationId: deployment.installationId,
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app?.close();
    await db?.close();
  });

  it("requires an explicit scoped grant, and records the client as itself rather than its owner", async () => {
    expect((await app.inject({ url: UPDATE, headers: headers() })).statusCode).toBe(403);
    await grant();
    const response = await app.inject({ url: UPDATE, headers: headers() });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ latest: "9.9.9" });
    expect(await principals.get(deployment.businessId, clientId)).toMatchObject({
      id: clientId,
      kind: "service",
      operationalScope: {
        businessId: deployment.businessId,
        installationId: deployment.installationId,
      },
    });
    expect(clientId).not.toBe(adminId);
  });

  it("denies content, credentials, business mutations and Worker callbacks despite a wildcard Role", async () => {
    await grant();
    await roles.putRole({
      businessId: deployment.businessId,
      id: "broad",
      assignableTo: ["service"],
      parentRoleIds: [],
      grants: [{ action: "*", resourceType: "*", effect: "allow" }],
    });
    await roles.assign({
      businessId: deployment.businessId,
      principalId: clientId,
      roleId: "broad",
    });
    const requests = [
      { method: "GET" as const, url: `/api/v1/chats/${conversationId}` },
      { method: "GET" as const, url: "/api/v1/resources/ticket" },
      { method: "POST" as const, url: "/api/v1/resources/ticket", payload: { title: "forbidden" } },
      { method: "GET" as const, url: "/api/v1/secrets/status" },
      { method: "GET" as const, url: "/api/v1/identity/api-clients" },
      { method: "POST" as const, url: `/api/v1/identity/api-clients/${clientId}/rotate` },
      { method: "GET" as const, url: "/api/v1/internal/llm/config" },
      { method: "POST" as const, url: "/api/v1/internal/turns/run-1/context", payload: {} },
      {
        method: "POST" as const,
        url: "/api/v1/internal/turns/run-1/tools",
        payload: { callId: "call-1", name: "kv_set", arguments: {} },
      },
    ];
    for (const request of requests) {
      const response = await app.inject({
        ...request,
        headers: { ...headers(), "x-user-id": adminId },
      });
      expect(response.statusCode, `${request.url}: ${response.body}`).toBe(403);
      for (const sentinel of Object.values(SENTINELS))
        expect(response.body).not.toContain(sentinel);
    }
    expect(await new PgResourceRepoFactory(db).forType("ticket").findById(RECORD_ID)).toMatchObject(
      {
        title: SENTINELS.record,
        version: 1,
      }
    );
    expect((await app.inject({ url: UPDATE, headers: headers() })).statusCode).toBe(200);
  });

  it("retains existing Worker access without turning an operational client into a Worker", async () => {
    const worker = await createApiClient(clients, { name: "run-executor", ownerUserId: null });
    const response = await app.inject({
      url: "/api/v1/internal/llm/config",
      headers: {
        authorization: `Bearer ${formatApiClientCredential(worker.doc.clientId, worker.secret)}`,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(SENTINELS.config);
    await grant();
    expect(
      (await app.inject({ url: "/api/v1/internal/llm/config", headers: headers() })).statusCode
    ).toBe(403);
  });

  it("checks rotation, disable and expiry without changing scope or owner", async () => {
    await grant();
    const rotated = await rotateApiClientSecret(clients, clientId);
    expect(rotated).not.toBeNull();
    expect((await app.inject({ url: UPDATE, headers: headers() })).statusCode).toBe(401);
    credential = rotated?.credential ?? "";
    expect((await app.inject({ url: UPDATE, headers: headers() })).statusCode).toBe(200);
    await clients.updateStatus(clientId, "disabled");
    expect((await app.inject({ url: UPDATE, headers: headers() })).statusCode).toBe(401);
    expect(await principals.get(deployment.businessId, clientId)).toMatchObject({
      status: "disabled",
    });

    await principals.put({
      id: clientId,
      businessId: deployment.businessId,
      kind: "service",
      status: "active",
    });
    expect(await principals.get(deployment.businessId, clientId)).toMatchObject({
      status: "disabled",
    });
    await clients.updateStatus(clientId, "active");
    await db.query("UPDATE api_clients SET expires_at = $2 WHERE id = $1", [clientId, new Date(0)]);
    expect((await app.inject({ url: UPDATE, headers: headers() })).statusCode).toBe(401);
    expect(
      (
        await resolver.resolvePrincipalLayer("service", {
          businessId: deployment.businessId,
          id: clientId,
          kind: "service",
        })
      ).grants
    ).toEqual([]);
    await expect(
      db.query("UPDATE api_clients SET operational_scope = NULL WHERE id = $1", [clientId])
    ).rejects.toThrow("operational client scope is immutable");
  });

  it("refuses substituted client secrets and credentials bound to another business or installation", async () => {
    await grant();
    expect((await app.inject({ url: UPDATE, headers: headers() })).statusCode).toBe(200);
    for (const scope of [
      { ...deployment, businessId: "other-business" },
      { ...deployment, installationId: randomUUID() },
    ]) {
      const foreign = await createApiClient(clients, {
        name: "foreign-operational",
        ownerUserId: null,
        operationalScope: scope,
      });
      const foreignCredential = formatApiClientCredential(foreign.doc.clientId, foreign.secret);
      expect(
        (
          await app.inject({
            url: UPDATE,
            headers: { authorization: `Bearer ${foreignCredential}` },
          })
        ).statusCode
      ).toBe(403);
      const substituted = formatApiClientCredential(
        foreign.doc.clientId,
        parseApiClientCredential(credential)?.secret ?? ""
      );
      expect(
        (
          await app.inject({
            url: UPDATE,
            headers: { authorization: `Bearer ${substituted}` },
          })
        ).statusCode
      ).toBe(401);
    }
  });

  it("rejects wrong installation and business grants, expired grants and principal substitution", async () => {
    await grant({ ...deployment, installationId: randomUUID() });
    expect((await app.inject({ url: UPDATE, headers: headers() })).statusCode).toBe(403);
    await grant({ ...deployment, businessId: "other-business" });
    expect((await app.inject({ url: UPDATE, headers: headers() })).statusCode).toBe(403);
    await grant();
    await roles.assign({
      businessId: deployment.businessId,
      principalId: clientId,
      roleId: "operational-release-reader",
      expiresAt: new Date(0),
    });
    expect((await app.inject({ url: UPDATE, headers: headers() })).statusCode).toBe(403);
    await grant();
    await db.query("UPDATE principals SET kind = 'user' WHERE business_id = $1 AND id = $2", [
      deployment.businessId,
      clientId,
    ]);
    expect((await app.inject({ url: UPDATE, headers: headers() })).statusCode).toBe(403);
    expect(
      (
        await resolver.resolvePrincipalLayer("service", {
          id: clientId,
          businessId: "other-business",
          kind: "service",
        })
      ).grants
    ).toEqual([]);
  });

  it("denies missing or mismatched runtime context and a missing authorizer", async () => {
    await grant();
    for (const context of [
      undefined,
      { ...deployment, businessId: "other" },
      { ...deployment, installationId: randomUUID() },
      deployment,
    ]) {
      await app.close();
      app = await buildApp({
        sessionStore: new MemorySessionStore(),
        userRepo: new PgUserRepo(db),
        tokenRepo: new PgTokenRepo(db),
        identity: { apiClientRepo: clients, deployment: context },
        ...(context === deployment ? {} : { routeAuthorizer: new LiveRouteAuthorizer(resolver) }),
        authorizationGate: { mode: "shadow" },
        systemRoutes: { fetchImpl },
      });
      expect((await app.inject({ url: UPDATE, headers: headers() })).statusCode).toBe(403);
    }
  });

  it("refuses business Tool execution with the same live ceiling, but not an authorized business user", async () => {
    await grant();
    await roles.putRole({
      businessId: deployment.businessId,
      id: "overbroad",
      assignableTo: ["service"],
      parentRoleIds: [],
      grants: [{ action: "*", resourceType: "*", effect: "allow" }],
    });
    await roles.assign({
      businessId: deployment.businessId,
      principalId: clientId,
      roleId: "overbroad",
    });
    const registry = new InMemoryToolCatalog();
    registry.register(
      toToolDef(kvSetTool, () => ({
        userId: adminId,
        agentId: "assistant",
        service: kv,
      }))
    );
    const dispatcher = new RegistryToolDispatcher({
      registry,
      artifacts: new ArtifactService(new MemoryArtifactStore(), new TypedOutputValidator([])),
      gate: new LiveToolGate(),
      authorityLayers: resolver,
    });
    const authority = {
      businessId: deployment.businessId,
      runId: randomUUID(),
      source: "routine",
      bundleDigest: "fixture",
      subject: { kind: "service", id: clientId },
      agent: { name: "assistant", autonomy: "full" as const },
    };
    const call = {
      callId: "call-1",
      name: "kv_set",
      arguments: { namespace: "ops-test", key: "effect", value: "must-not-be-written" },
    };
    expect(await dispatcher.dispatch(authority, call)).toMatchObject({ status: "denied" });
    expect(await kv.get("agent", "assistant", "ops-test", "effect")).toBeNull();
    expect(
      await dispatcher.dispatch(
        {
          ...authority,
          subject: { kind: "user", id: adminId },
        },
        call
      )
    ).toMatchObject({ status: "succeeded" });
    expect(await kv.get("agent", "assistant", "ops-test", "effect")).not.toBeNull();
  });

  it("fails closed with a sanitized denial when live authorization is unavailable", async () => {
    await grant();
    vi.spyOn(resolver, "resolvePrincipalLayer").mockRejectedValueOnce(new Error(SENTINELS.error));
    const response = await app.inject({ url: UPDATE, headers: headers() });
    expect(response.statusCode).toBe(403);
    expect(response.body).toBe('{"error":"forbidden"}');
  });

  it("projects only typed version metadata and emits no sensitive provider error diagnostics", async () => {
    await grant();
    const diagnostics: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      diagnostics.push(String(chunk));
      return true;
    });
    fetchImpl.mockRejectedValue(new Error(Object.values(SENTINELS).join(" ")));
    const response = await app.inject({ url: UPDATE, headers: headers() });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ latest: null, updateAvailable: false });
    expect(diagnostics.join("")).toContain("system.update_check.unavailable");
    for (const sentinel of Object.values(SENTINELS)) {
      expect(JSON.stringify({ response: response.json(), diagnostics })).not.toContain(sentinel);
    }
    expect(diagnostics.join("")).not.toContain(credential);
    await kv.set("system", undefined, "system", "latest-release", {
      latest: SENTINELS.secret,
      checkedAt: new Date().toISOString(),
      chat: SENTINELS.chat,
    });
    const cached = await app.inject({ url: UPDATE, headers: headers() });
    expect(cached.json()).toMatchObject({ latest: null, updateAvailable: false });
    for (const sentinel of Object.values(SENTINELS)) expect(cached.body).not.toContain(sentinel);
  });
});
