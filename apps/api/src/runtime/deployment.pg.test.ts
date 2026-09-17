import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import { checkModelReachability, createModel } from "@tulipfarm/llm";
import { PgSecretRepo, SecretsService } from "@tulipfarm/secrets";
import { GitSyncService } from "@tulipfarm/soul";
import {
  initializeRuntimeDeployment,
  PgRoleRepo,
  RuntimeDeploymentConfigError,
  RuntimeDeploymentTrustUnavailableError,
  RuntimeIdentityMismatchError,
  runtimeDeploymentConfigFromEnv,
} from "@tulipfarm/storage";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app";
import { PgTokenRepo } from "../auth/api-tokens";
import { CSRF_COOKIE, CSRF_HEADER } from "../auth/csrf";
import { SESSION_COOKIE } from "../auth/middleware";
import { PgSessionStore } from "../auth/session-store";
import { createUser, PgUserRepo } from "../auth/users";
import { LiveRouteAuthorizer } from "../authz/route-gate";
import { transactionPort } from "../db";
import { buildApiAuthorityLayerResolver } from "../identity/authority-layers";
import { syncDeploymentRoles } from "../identity/roles";
import { PG_MIGRATIONS } from "../pg-migrations";
import { bootstrapFromEnv } from "../setup/bootstrap";
import { PgSetupAdminCreator } from "../setup/first-admin";
import { makeMigratedPglite, makePglite } from "../test/pglite";
import { initializeApiDeployment } from "./deployment";

const businessId = DEPLOYMENT_BUSINESS_ID;
const databases: PGlite[] = [];
const apps: FastifyInstance[] = [];

async function database() {
  const db = await makeMigratedPglite();
  databases.push(db);
  return db;
}

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const db of databases.splice(0)) await db.close();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("durable runtime deployment startup", () => {
  it("preserves independent setup on a new store without creating users or service links", async () => {
    const db = await database();
    vi.stubEnv("RUNTIME_HOSTING_AUTHORITY", "");
    const deployment = await initializeApiDeployment(
      db,
      runtimeDeploymentConfigFromEnv(businessId)
    );
    const users = new PgUserRepo(db);
    const app = await buildApp({
      deployment,
      readiness: db,
      userRepo: users,
      sessionStore: new PgSessionStore(db, 3600),
      tokenRepo: new PgTokenRepo(db),
      gitSync: new GitSyncService(
        resolve(__dirname, `../test/fixtures/uninitialized-${randomUUID()}`),
        undefined,
        async () => undefined,
        { info() {}, warn() {}, error() {} }
      ),
    });
    apps.push(app);
    expect(deployment.hostingAuthority).toBe("independent");
    expect(await users.count()).toBe(0);
    const response = await app.inject({ url: "/api/v1/setup/status" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ needsSetup: true });
    expect((await app.inject({ url: "/readyz" })).statusCode).toBe(200);
  });

  it("composes test-hosted readiness but never exposes independent setup or seeds a local admin", async () => {
    const db = await database();
    vi.stubEnv("RUNTIME_HOSTING_AUTHORITY", "tulipfarm");
    vi.stubEnv("RUNTIME_INSTALLATION_ID", randomUUID());
    vi.stubEnv("ADMIN_EMAIL", "muskan@example.com");
    vi.stubEnv("ADMIN_PASSWORD", "test-password");
    const config = runtimeDeploymentConfigFromEnv(businessId);
    const verifyIdentity = vi.fn(async () => undefined);
    const deployment = await initializeApiDeployment(db, config, { verifyIdentity });
    expect(Object.isFrozen(deployment)).toBe(true);
    expect(verifyIdentity).toHaveBeenCalledWith({
      businessId,
      installationId: deployment.installationId,
    });
    const users = new PgUserRepo(db);
    const secretsService = new SecretsService(new PgSecretRepo(db), {
      dekId: randomUUID(),
      key: randomBytes(32),
    });
    const gitSync = new GitSyncService(
      resolve(__dirname, `../test/fixtures/uninitialized-${randomUUID()}`),
      undefined,
      async () => undefined,
      { info() {}, warn() {}, error() {} }
    );
    const app = await buildApp({
      deployment,
      readiness: db,
      userRepo: users,
      sessionStore: new PgSessionStore(db, 3600),
      tokenRepo: new PgTokenRepo(db),
      secretsService,
      gitSync,
    });
    apps.push(app);
    expect((await app.inject({ url: "/readyz" })).statusCode).toBe(200);
    expect((await app.inject({ url: "/health" })).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/v1/setup/status" })).json()).toMatchObject({
      needsSetup: false,
    });
    for (const step of ["admin", "business", "llm", "git", "complete"]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/setup/${step}`,
        payload: {},
      });
      expect(response.statusCode).toBe(404);
    }
    const bootstrap = { deployment, userRepo: users, secretsService };
    await bootstrapFromEnv({
      ...bootstrap,
      get soulWriter(): never {
        throw new Error("Hosted startup must not touch the independent Soul seed");
      },
    });
    expect(await users.count()).toBe(0);
    expect(await initializeRuntimeDeployment(db, config, { verifyIdentity })).toEqual(deployment);
    await expect(initializeRuntimeDeployment(db, { businessId })).rejects.toThrow(
      "RUNTIME_HOSTING_AUTHORITY conflicts"
    );
    await expect(
      initializeApiDeployment(db, { ...config, installationId: randomUUID() }, { verifyIdentity })
    ).rejects.toThrow("RUNTIME_INSTALLATION_ID conflicts");
    await expect(
      initializeApiDeployment(db, { ...config, businessId: "another-business" }, { verifyIdentity })
    ).rejects.toThrow("BUSINESS_ID conflicts");
    const unavailableApp = await buildApp({
      deployment,
      readiness: {
        query: async () => {
          throw new Error("datastore unavailable");
        },
      },
    });
    apps.push(unavailableApp);
    expect((await unavailableApp.inject({ url: "/readyz" })).statusCode).toBe(503);
  });

  it("rejects invalid hosted composition before serving readiness or independent setup", async () => {
    const db = await database();
    for (const authority of ["hosted-secret-sentinel", "tulipfarm"]) {
      vi.stubEnv("RUNTIME_HOSTING_AUTHORITY", authority);
      await expect(buildApp({ readiness: db })).rejects.toBeInstanceOf(
        RuntimeDeploymentConfigError
      );
    }
    const installationId = randomUUID();
    const hosted = { businessId, installationId, hostingAuthority: "tulipfarm" };
    for (const config of [
      { ...hosted, hostingAuthority: "malformed-secret-sentinel" },
      { ...hosted, installationId: undefined },
      { ...hosted, installationId: "malformed-secret-sentinel" },
      { ...hosted, businessId: "" },
      hosted,
    ]) {
      await expect(initializeApiDeployment(db, config)).rejects.toBeInstanceOf(
        RuntimeDeploymentConfigError
      );
    }
    await expect(
      buildApp({
        deployment: { hostingAuthority: "tulipfarm", businessId, installationId },
      })
    ).rejects.toThrow("context has not been initialized");
    const trust = { verifyIdentity: vi.fn(async () => undefined) };
    vi.stubEnv("NODE_ENV", "production");
    await expect(initializeApiDeployment(db, hosted, trust)).rejects.toThrow(
      "no production hosted identity protocol"
    );
    expect(trust.verifyIdentity).not.toHaveBeenCalled();
    vi.stubEnv("NODE_ENV", "test");
    await expect(
      initializeApiDeployment(db, hosted, {
        verifyIdentity: async () => {
          throw new Error("upstream-credential-sentinel");
        },
      })
    ).rejects.toEqual(new RuntimeDeploymentTrustUnavailableError());
    expect((await db.query("SELECT * FROM deployment_runtime_identity")).rows).toHaveLength(0);
  });

  it("upgrades legacy state, preserves login and BYOK, and restarts with the same identity", async () => {
    const db = await makePglite();
    databases.push(db);
    for (const migration of PG_MIGRATIONS.filter(({ version }) => version <= 124)) {
      if (migration.concurrent) await migration.up(db);
      else await db.transaction((tx) => migration.up(tx));
    }
    await db.exec(`
      CREATE TABLE schema_version (
        id boolean PRIMARY KEY DEFAULT true CHECK (id),
        version integer NOT NULL
      );
      INSERT INTO schema_version (id, version) VALUES (true, 124);
    `);
    expect(
      (
        await db.query(
          `SELECT to_regclass('deployment_runtime_identity') AS runtime_identity,
                  EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'api_clients' AND column_name = 'operational_scope'
                  ) AS operational_scope`
        )
      ).rows
    ).toEqual([{ runtime_identity: null, operational_scope: false }]);
    const users = new PgUserRepo(db);
    const adminCreator = new PgSetupAdminCreator(db, businessId);
    const admin = await createUser(users, "muskan@example.com", "test-password", "admin", {
      name: "Muskan Vijayvargiya",
      insert: (user) => adminCreator.create(user),
    });
    const member = await createUser(users, "member@example.com", "test-password", "member");
    await syncDeploymentRoles(new PgRoleRepo(transactionPort(db)));
    const authorityBefore = await db.query(
      "SELECT * FROM role_assignments ORDER BY business_id, principal_id, role_id"
    );
    const usersBefore = await db.query("SELECT * FROM users ORDER BY id");
    const activeKey = { dekId: randomUUID(), key: randomBytes(32) };
    const secretValue = "direct-provider-test-sentinel";
    await new SecretsService(new PgSecretRepo(db), activeKey).set(
      "anthropic-api-key",
      secretValue,
      "user-provided"
    );
    vi.stubGlobal("fetch", async () => {
      throw new Error("No managed service is available");
    });

    const boot = async () => {
      const deployment = await initializeApiDeployment(db, { businessId });
      const secretsService = new SecretsService(new PgSecretRepo(db), activeKey);
      const app = await buildApp({
        readiness: db,
        sessionStore: new PgSessionStore(db, 3600),
        userRepo: new PgUserRepo(db),
        tokenRepo: new PgTokenRepo(db),
        secretsService,
        routeAuthorizer: new LiveRouteAuthorizer(buildApiAuthorityLayerResolver(db)),
      });
      apps.push(app);
      return { deployment, app, secretsService };
    };
    const first = await boot();
    expect(first.deployment).toMatchObject({ businessId, hostingAuthority: "independent" });
    expect((await first.app.inject({ url: "/readyz" })).statusCode).toBe(200);
    const login = await first.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: admin.email, password: "test-password" },
    });
    expect(login.statusCode).toBe(200);
    const cookies = Object.fromEntries(login.cookies.map(({ name, value }) => [name, value]));
    expect(cookies[SESSION_COOKIE]).toBeTruthy();

    await first.app.close();
    const restarted = await boot();
    expect(restarted.deployment).toEqual(first.deployment);
    expect(await db.query("SELECT * FROM users ORDER BY id")).toEqual(usersBefore);
    expect(
      await db.query("SELECT * FROM role_assignments ORDER BY business_id, principal_id, role_id")
    ).toEqual(authorityBefore);
    const status = await restarted.app.inject({
      url: "/api/v1/secrets/status",
      cookies,
    });
    expect(status.statusCode).toBe(200);
    expect(status.json().secrets).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: "anthropic-api-key" })])
    );
    expect(status.body).not.toContain(secretValue);
    expect(status.body).not.toContain(restarted.deployment.installationId);
    expect(await restarted.secretsService.get("anthropic-api-key")).toBe(secretValue);
    expect(
      (
        await restarted.app.inject({
          method: "PUT",
          url: "/api/v1/secrets/anthropic-api-key",
          cookies,
          headers: { [CSRF_HEADER]: cookies[CSRF_COOKIE] },
          payload: { value: "rotated-direct-provider-sentinel" },
        })
      ).statusCode
    ).toBe(200);
    const memberLogin = await restarted.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: member.email, password: "test-password" },
    });
    expect(memberLogin.statusCode).toBe(200);
    const memberCookies = Object.fromEntries(
      memberLogin.cookies.map(({ name, value }) => [name, value])
    );
    expect(
      (
        await restarted.app.inject({
          method: "PUT",
          url: "/api/v1/secrets/anthropic-api-key",
          cookies: memberCookies,
          headers: { [CSRF_HEADER]: memberCookies[CSRF_COOKIE] },
          payload: { value: "unauthorized-replacement" },
        })
      ).statusCode
    ).toBe(403);
    expect(await restarted.secretsService.get("anthropic-api-key")).toBe(
      "rotated-direct-provider-sentinel"
    );
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) !== "https://api.anthropic.com/v1/messages") {
        throw new Error("No managed service is available");
      }
      expect(new Headers(init?.headers).get("x-api-key")).toBe("rotated-direct-provider-sentinel");
      return Response.json({
        id: "msg_direct_provider",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "pong" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 8, output_tokens: 1 },
      });
    });
    const model = await createModel(
      { provider: "anthropic", model: "claude-sonnet-4-6", api_key_ref: "anthropic-api-key" },
      restarted.secretsService
    );
    expect(await checkModelReachability(model, 1000)).toMatchObject({
      verdict: "reachable",
      reply: "pong",
      answeredAsAsked: true,
    });
  });

  it("atomically initializes concurrent processes and distinguishes independent stores", async () => {
    const first = await database();
    const second = await database();
    const contexts = await Promise.all(
      Array.from({ length: 12 }, () => initializeRuntimeDeployment(first, { businessId }))
    );
    expect(new Set(contexts.map((context) => context.installationId)).size).toBe(1);
    expect((await first.query("SELECT * FROM deployment_runtime_identity")).rows).toHaveLength(1);
    const other = await initializeApiDeployment(second, { businessId });
    expect(other.businessId).toBe(contexts[0]?.businessId);
    expect(other.installationId).not.toBe(contexts[0]?.installationId);
  });

  it("rejects conflicting startup identities without replacing the durable association", async () => {
    const db = await database();
    const installationId = randomUUID();
    const initialized = await initializeApiDeployment(db, { businessId, installationId });
    const before = await db.query("SELECT * FROM deployment_runtime_identity");
    await expect(
      initializeApiDeployment(db, { businessId, installationId: randomUUID() })
    ).rejects.toThrow(RuntimeIdentityMismatchError);
    await expect(
      initializeApiDeployment(db, { businessId: "another-business", installationId })
    ).rejects.toThrow("BUSINESS_ID conflicts");
    expect(await initializeApiDeployment(db, { businessId })).toEqual(initialized);
    expect(
      await initializeRuntimeDeployment(db, {
        businessId,
        installationId: installationId.toUpperCase(),
      })
    ).toEqual(initialized);
    expect(await db.query("SELECT * FROM deployment_runtime_identity")).toEqual(before);
  });

  it("validates overrides before initialization and never echoes configured values in errors", async () => {
    const db = await database();
    for (const installationId of ["", "not-a-uuid", "operator-secret-sentinel"]) {
      await expect(initializeRuntimeDeployment(db, { businessId, installationId })).rejects.toThrow(
        RuntimeDeploymentConfigError
      );
    }
    await expect(initializeRuntimeDeployment(db, { businessId: "" })).rejects.toThrow(
      "BUSINESS_ID must be non-empty"
    );
    expect((await db.query("SELECT * FROM deployment_runtime_identity")).rows).toHaveLength(0);
  });

  it("accepts only one of two competing explicit identities", async () => {
    const db = await database();
    const identities = [randomUUID(), randomUUID()];
    const results = await Promise.allSettled(
      identities.map((installationId) =>
        initializeRuntimeDeployment(db, { businessId, installationId })
      )
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const failure = results.find((result) => result.status === "rejected");
    expect(failure?.status === "rejected" && failure.reason).toBeInstanceOf(
      RuntimeIdentityMismatchError
    );
    const restarted = await initializeRuntimeDeployment(db, { businessId });
    expect(identities).toContain(restarted.installationId);
  });
});
