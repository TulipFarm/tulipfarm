import { randomBytes, randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { infrastructureOwnershipLayer } from "@tulipfarm/authz";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import { PublicOriginsService } from "@tulipfarm/integrations";
import { ArtifactService, TypedOutputValidator } from "@tulipfarm/run-kernel";
import { PgSecretRepo, SecretsService } from "@tulipfarm/secrets";
import { GitSyncService, makeSoulWriterDouble } from "@tulipfarm/soul";
import {
  IntegrationStore,
  initializeRuntimeDeployment,
  MemoryArtifactStore,
  PublicOriginStore,
  SoulRepositoryStore,
} from "@tulipfarm/storage";
import {
  InMemoryToolCatalog,
  LiveToolGate,
  RegistryToolDispatcher,
  toToolDef,
} from "@tulipfarm/tool-host";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app";
import { PgTokenRepo } from "../auth/api-tokens";
import { CSRF_COOKIE, CSRF_HEADER } from "../auth/csrf";
import { SESSION_COOKIE } from "../auth/middleware";
import { MemorySessionStore } from "../auth/session-store";
import { createUser, PgUserRepo } from "../auth/users";
import { LiveRouteAuthorizer } from "../authz/route-gate";
import { transactionPort } from "../db";
import { buildApiAuthorityLayerResolver } from "../identity/authority-layers";
import { soulRepoPushTool } from "../platform/tools";
import { makeMigratedPglite } from "../test/pglite";

const CSRF = "a".repeat(64);
const ORIGINS = "/api/v1/system/public-origins";
const OPERATOR_SECRET = "soul-bundle.ed25519.private-key";

describe("infrastructure ownership through the assembled runtime", () => {
  let db: PGlite;
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    await db?.close();
    vi.restoreAllMocks();
  });

  it.each([
    ["independent", "enforcing"],
    ["tulipfarm", "enforcing"],
    ["independent", "shadow"],
    ["tulipfarm", "shadow"],
  ] as const)(
    "%s under %s preserves business configuration and applies infrastructure ownership",
    async (hostingAuthority, mode) => {
      db = await makeMigratedPglite();
      const hosted = hostingAuthority === "tulipfarm";
      const deployment = await initializeRuntimeDeployment(
        db,
        { businessId: DEPLOYMENT_BUSINESS_ID, installationId: randomUUID(), hostingAuthority },
        { async verifyIdentity() {} }
      );
      const users = new PgUserRepo(db);
      const sessions = new MemorySessionStore();
      const user = await createUser(users, "muskan@example.test", "test-password", "admin");
      const sid = await sessions.create(user._id);
      const auth = {
        cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: CSRF },
        headers: { [CSRF_HEADER]: CSRF },
      };
      const resolver = buildApiAuthorityLayerResolver(db);
      const originsStore = new PublicOriginStore(db);
      const stale = { webOrigin: "https://stale.example.test", apiOrigin: null };
      await originsStore.put(deployment.businessId, stale);
      const environment = {
        PUBLIC_URL: "https://web.operator.test",
        PUBLIC_API_URL: "https://api.operator.test",
      };
      const publicOrigins = new PublicOriginsService(
        originsStore,
        deployment.businessId,
        environment,
        deployment
      );
      await publicOrigins.initialize();
      if (hosted) {
        await expect(
          publicOrigins.save({ webOrigin: "https://forged.example.test" })
        ).rejects.toThrow("hosting operator");
        await expect(publicOrigins.reset()).rejects.toThrow("hosting operator");
        expect(await originsStore.get(deployment.businessId)).toEqual(stale);
        expect(
          () =>
            new PublicOriginsService(
              originsStore,
              deployment.businessId,
              {
                PUBLIC_URL: "https://web.operator.test",
              },
              deployment
            )
        ).toThrow();
      }
      const secrets = new SecretsService(new PgSecretRepo(db), {
        dekId: randomUUID(),
        key: randomBytes(32),
      });
      await secrets.set(OPERATOR_SECRET, "operator-key-sentinel", "auto-generated");
      const soul = makeSoulWriterDouble();
      soul.put("Settings", undefined, "gitRemoteUrl: https://stale.example.test/soul.git\n");
      const git = new GitSyncService(
        "unused-infrastructure-fixture",
        "https://operator.example.test/soul.git",
        async () => "operator-credential-sentinel",
        { info() {}, warn() {}, error() {} }
      );
      const push = vi.spyOn(git, "push").mockResolvedValue(true);
      const configure = vi.spyOn(git, "configureRemote").mockResolvedValue();
      const sync = vi.spyOn(git, "syncNow").mockResolvedValue();
      vi.spyOn(git, "getStatus").mockResolvedValue({
        remoteConfigured: true,
        ahead: 0,
        behind: 0,
        headSha: null,
        lastSyncError: "operator-credential-sentinel",
        lastSyncAt: null,
      });
      const transactions = transactionPort(db);
      const soulRepositories = new SoulRepositoryStore(transactions);
      app = await buildApp({
        deployment,
        sessionStore: sessions,
        userRepo: users,
        tokenRepo: new PgTokenRepo(db),
        routeAuthorizer: new LiveRouteAuthorizer(resolver),
        authorizationGate: { mode },
        publicOrigins,
        secretsService: secrets,
        gitSync: git,
        soulWriter: soul.writer,
        githubInstall: {
          integrations: new IntegrationStore(transactions),
          secretsService: secrets,
          businessId: deployment.businessId,
          soulRepositories,
        },
      });

      const read = await app.inject({ url: ORIGINS, ...auth });
      expect(read.statusCode, read.body).toBe(200);
      expect(read.json()).toMatchObject({
        locked: hosted,
        canWrite: !hosted,
        lockReason: hosted ? "hosting_operator" : null,
        webOrigin: hosted ? environment.PUBLIC_URL : stale.webOrigin,
      });
      for (const method of ["PUT", "DELETE"] as const) {
        const response = await app.inject({
          method,
          url: ORIGINS,
          ...auth,
          ...(method === "PUT"
            ? {
                payload: {
                  webOrigin: "https://forged.example.test",
                  apiOrigin: "https://forged-api.example.test",
                  hostingAuthority: "independent",
                  locked: false,
                },
              }
            : {}),
        });
        expect(response.statusCode, response.body).toBe(hosted ? 403 : 200);
      }
      expect(await originsStore.get(deployment.businessId)).toEqual(hosted ? stale : null);
      expect(await publicOrigins.authEndpoints()).toEqual({
        webUrl: "https://web.operator.test",
        apiUrl: "https://api.operator.test",
        callbackUrl: "https://api.operator.test/api/v1/integrations/auth/callback",
      });
      const restart = new PublicOriginsService(
        originsStore,
        deployment.businessId,
        {
          PUBLIC_URL: "https://web.operator.test",
          PUBLIC_API_URL: "https://api.operator.test",
        },
        deployment
      );
      await restart.initialize();
      expect(restart.current().apiOrigin).toBe("https://api.operator.test");

      const before = soul.writer.read("Settings");
      const gitWrite = await app.inject({
        method: "PUT",
        url: "/api/v1/soul/git-config",
        ...auth,
        payload: { remoteUrl: "https://forged.example.test/soul.git", credential: "forged" },
      });
      expect(gitWrite.statusCode, gitWrite.body).toBe(hosted ? 403 : 204);
      expect(configure).toHaveBeenCalledTimes(hosted ? 0 : 1);
      if (hosted) expect(soul.writer.read("Settings")).toBe(before);
      const gitSync = await app.inject({ method: "POST", url: "/api/v1/soul/sync", ...auth });
      expect(gitSync.statusCode).toBe(hosted ? 403 : 204);
      expect(sync).toHaveBeenCalledTimes(hosted ? 0 : 1);
      const gitRead = await app.inject({ url: "/api/v1/soul/git-config", ...auth });
      expect(gitRead.json()).toMatchObject({ locked: hosted, canWrite: !hosted, canSync: !hosted });
      if (hosted) expect(gitRead.body).not.toContain("operator-credential-sentinel");
      if (hosted) {
        for (const suffix of ["", "/create"]) {
          const response = await app.inject({
            method: "POST",
            url: `/api/v1/integrations/github/soul-repo${suffix}`,
            ...auth,
            payload: { installationId: "123", owner: "forged", repo: "soul" },
          });
          expect(response.statusCode, response.body).toBe(403);
        }
        expect(await soulRepositories.get(deployment.businessId)).toBeUndefined();
      }
      const business = await app.inject({
        method: "PUT",
        url: "/api/v1/business",
        ...auth,
        payload: { name: "Muskan Vijayvargiya", description: "Customer business" },
      });
      expect(business.statusCode, business.body).toBe(200);
      expect(soul.writer.read("Settings")).toContain("Muskan Vijayvargiya");
      for (const key of [OPERATOR_SECRET, "openai-api-key", "openai-compatible-base-url"]) {
        const response = await app.inject({
          method: "PUT",
          url: `/api/v1/secrets/${key}`,
          ...auth,
          payload: { value: "new-value" },
        });
        expect(response.statusCode, response.body).toBe(
          hosted && key === OPERATOR_SECRET ? 403 : 200
        );
      }
      expect(await secrets.get(OPERATOR_SECRET)).toBe(
        hosted ? "operator-key-sentinel" : "new-value"
      );
      expect(await secrets.get("openai-api-key")).toBe("new-value");
      const secretDelete = await app.inject({
        method: "DELETE",
        url: `/api/v1/secrets/${OPERATOR_SECRET}`,
        ...auth,
      });
      expect(secretDelete.statusCode).toBe(hosted ? 403 : 204);
      if (hosted) {
        expect(await secrets.get(OPERATOR_SECRET)).toBe("operator-key-sentinel");
        const listing = await app.inject({ url: "/api/v1/secrets/status", ...auth });
        expect(listing.body).not.toContain(OPERATOR_SECRET);
        expect(listing.body).toContain("openai-api-key");
      }

      const registry = new InMemoryToolCatalog();
      registry.register(
        toToolDef(soulRepoPushTool, () => ({ gitSync: git, soulWriter: soul.writer }))
      );
      const dispatcher = new RegistryToolDispatcher({
        registry,
        authorityLayers: resolver,
        artifacts: new ArtifactService(new MemoryArtifactStore(), new TypedOutputValidator([])),
        gate: new LiveToolGate([infrastructureOwnershipLayer(deployment.hostingAuthority)]),
      });
      const result = await dispatcher.dispatch(
        {
          businessId: deployment.businessId,
          runId: randomUUID(),
          source: "routine",
          bundleDigest: "fixture",
          subject: { kind: "user", id: user._id },
          agent: { name: "assistant", autonomy: "full" },
        },
        { name: "soul_repo_push", callId: "push", arguments: {} }
      );
      expect(result).toMatchObject({ status: hosted ? "denied" : "succeeded" });
      expect(push).toHaveBeenCalledTimes(hosted ? 0 : 1);
    }
  );
});
