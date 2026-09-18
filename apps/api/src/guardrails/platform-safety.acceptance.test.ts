import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { GuardrailsService, platformGuardrailsFor } from "@tulipfarm/agent-runtime";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import { KvService, kvSetTool, PgKvRepo } from "@tulipfarm/kv";
import { BatchingLogSink } from "@tulipfarm/observability";
import { ArtifactService, TypedOutputValidator } from "@tulipfarm/run-kernel";
import { canonicalHash } from "@tulipfarm/schema";
import { createHmacCommitSigner, SoulGitStore, SoulLoader, SoulWriter } from "@tulipfarm/soul";
import { initializeRuntimeDeployment, MemoryArtifactStore } from "@tulipfarm/storage";
import {
  InMemoryToolCatalog,
  LiveToolGate,
  RegistryToolDispatcher,
  toToolDef,
} from "@tulipfarm/tool-host";
import { TurnEventWriter, TurnGuardrails } from "@tulipfarm/turn-executor";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRuntimeOperationalApi } from "../admin/runtime";
import { buildApp } from "../app";
import { PgTokenRepo } from "../auth/api-tokens";
import { CSRF_COOKIE, CSRF_HEADER } from "../auth/csrf";
import { SESSION_COOKIE } from "../auth/middleware";
import { MemorySessionStore } from "../auth/session-store";
import { createUser, PgUserRepo } from "../auth/users";
import { LiveRouteAuthorizer, makeAuthorizationCheck } from "../authz/route-gate";
import { buildApiAuthorityLayerResolver } from "../identity/authority-layers";
import { guardrailForgeTool } from "../platform/guardrail-tool";
import { makeMigratedPglite } from "../test/pglite";

const log = { info() {}, warn() {}, error() {}, debug() {} };
const CSRF = "a".repeat(64);

describe.each(["independent", "tulipfarm"] as const)(
  "%s saved safety enforcement",
  (hostingAuthority) => {
    let db: PGlite;
    let app: FastifyInstance;
    let path: string;
    let userId: string;
    let sid: string;
    let service: GuardrailsService;
    let loader: SoulLoader;
    let writer: SoulWriter;
    let kv: KvService;
    let dispatcher: RegistryToolDispatcher;
    let deniedUserId: string;

    const auth = () => ({
      cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: CSRF },
      headers: { [CSRF_HEADER]: CSRF },
    });
    const authority = (id = userId) => ({
      businessId: DEPLOYMENT_BUSINESS_ID,
      runId: randomUUID(),
      source: "routine",
      bundleDigest: "fixture",
      subject: { kind: "user", id },
      agent: { name: "assistant", autonomy: "full" as const },
    });

    beforeEach(async () => {
      db = await makeMigratedPglite();
      const deployment = await initializeRuntimeDeployment(
        db,
        { businessId: DEPLOYMENT_BUSINESS_ID, hostingAuthority, installationId: randomUUID() },
        { async verifyIdentity() {} }
      );
      path = resolve(".test-artifacts", `platform-safety-${randomUUID()}`);
      mkdirSync(path, { recursive: true });
      execFileSync("git", ["init", "--quiet", "--initial-branch=main", path]);
      execFileSync(
        "git",
        [
          "-c",
          "user.name=Muskan Vijayvargiya",
          "-c",
          "user.email=muskan@example.test",
          "commit",
          "--quiet",
          "--allow-empty",
          "--no-gpg-sign",
          "-m",
          "fixture",
        ],
        { cwd: path }
      );
      loader = new SoulLoader(path, log);
      await loader.reload();
      service = new GuardrailsService(platformGuardrailsFor(deployment.hostingAuthority));
      service.init(loader.guardrailsConfig, log);
      writer = new SoulWriter(
        new SoulGitStore(path, createHmacCommitSigner("test", "fixture-only"), log),
        log,
        undefined,
        { reload: () => loader.reload() }
      );
      const users = new PgUserRepo(db);
      const sessions = new MemorySessionStore();
      const user = await createUser(users, "muskan@example.test", "fixture-password", "admin");
      userId = user._id;
      deniedUserId = randomUUID();
      sid = await sessions.create(userId);
      const layers = buildApiAuthorityLayerResolver(db);
      const authorizer = new LiveRouteAuthorizer(layers);
      kv = new KvService(new PgKvRepo(db));
      const registry = new InMemoryToolCatalog();
      registry.register(
        toToolDef(guardrailForgeTool, () => ({
          soulWriter: writer,
          onGuardrailsChanged: async () => service.init(loader.guardrailsConfig, log),
        }))
      );
      registry.register(
        toToolDef(kvSetTool, () => ({
          userId,
          agentId: "assistant",
          service: kv,
        }))
      );
      dispatcher = new RegistryToolDispatcher({
        registry,
        artifacts: new ArtifactService(new MemoryArtifactStore(), new TypedOutputValidator([])),
        gate: new LiveToolGate(),
        authorityLayers: layers,
        guardrails: service,
      });
      app = await buildApp({
        deployment,
        logSink: new BatchingLogSink({ service: "api", writer: { async insertMany() {} } }),
        sessionStore: sessions,
        userRepo: users,
        tokenRepo: new PgTokenRepo(db),
        routeAuthorizer: authorizer,
        operationalApi: createRuntimeOperationalApi({
          activity: {
            async list() {
              return { items: [], nextCursor: null };
            },
          },
          approvals: {
            async findById() {
              return null;
            },
            async listPending() {
              return [];
            },
          },
          runs: {
            async list() {
              return { items: [], nextCursor: null };
            },
            async get() {
              return null;
            },
            async budgets() {
              return null;
            },
          },
          healthProbes: [],
          guardrailsConfig: () => service.config,
          guardrailsSource: () => service.source,
          platformConstrained: () => service.platformConstrained,
          authorizationCheck: makeAuthorizationCheck(authorizer),
        }),
      });
    });

    afterEach(async () => {
      await app?.close();
      await db?.close();
      if (path) rmSync(path, { recursive: true, force: true });
    });

    it("saves through the real Tool gate, reloads persisted policy, and prevents a Worker-side KV effect", async () => {
      const before = await dispatcher.dispatch(authority(), {
        callId: "before",
        name: "kv_set",
        arguments: { namespace: "safety", key: "before", value: true },
      });
      expect(before).toMatchObject({ status: "succeeded" });
      expect(await kv.get("agent", "assistant", "safety", "before")).not.toBeNull();

      expect(
        await dispatcher.dispatch(authority(), {
          callId: "tighten",
          name: "guardrail_forge",
          arguments: { guard: { guard: "tool_blocklist", block: ["kv_set"] } },
        })
      ).toMatchObject({ status: "succeeded" });
      const restartedLoader = new SoulLoader(path, log);
      await restartedLoader.reload();
      const restarted = new GuardrailsService(platformGuardrailsFor(hostingAuthority));
      restarted.init(restartedLoader.guardrailsConfig, log);
      expect(restarted.revision).toBe(service.revision);
      expect(await writer.read("GuardrailsPolicy")).toContain("kv_set");

      const response = await app.inject({ url: "/api/v1/guardrails", ...auth() });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        revision: restarted.revision,
        platformConstrained: hostingAuthority === "tulipfarm",
      });
      expect(response.body).toContain("kv_set");
      if (hostingAuthority === "tulipfarm") expect(response.body).toContain("run_command");

      const worker = new TurnGuardrails(log);
      const policy = JSON.parse(JSON.stringify(restarted.config));
      worker.configure({
        policy,
        digest: canonicalHash(policy),
        context: { userId, conversationId: "chat" },
        toolTiers: new Map([["kv_set", "platform"]]),
      });
      const events = new TurnEventWriter({
        businessId: DEPLOYMENT_BUSINESS_ID,
        runId: "run",
        turnId: "turn",
        attempt: 1,
        events: {
          async append() {
            return { sequence: 1 };
          },
        },
      });
      const guarded = worker.guard(
        {
          dispatch: async (call) => ({
            ...(await dispatcher.dispatch(authority(), { ...call, arguments: call.arguments })),
            callId: call.callId,
          }),
        },
        events
      );
      expect(
        await guarded.dispatch({
          businessId: DEPLOYMENT_BUSINESS_ID,
          runId: "run",
          stateId: "invoke",
          callId: "after",
          name: "kv_set",
          arguments: { namespace: "safety", key: "after", value: true },
        })
      ).toMatchObject({ status: "denied" });
      expect(await kv.get("agent", "assistant", "safety", "after")).toBeNull();
    });

    it("rejects direct policy replacement and unauthorized or unsupported Tool attempts", async () => {
      const revision = service.revision;
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/guardrails/changesets",
        ...auth(),
        headers: { ...auth().headers, "idempotency-key": randomUUID() },
        payload: {
          baseRevision: revision,
          changes: [{ op: "replace", path: "/tool-call", value: [] }],
        },
      });
      expect(response.statusCode, response.body).toBe(501);
      expect(response.body).toContain("unsupported");
      expect((await app.inject({ url: "/api/v1/guardrails" })).statusCode).toBe(401);
      const call = {
        callId: "unauthorized",
        name: "guardrail_forge",
        arguments: { guard: { guard: "tool_blocklist", block: ["kv_set"] } },
      };
      expect(await dispatcher.dispatch(authority(deniedUserId), call)).toMatchObject({
        status: "denied",
      });
      for (const guard of [
        { guard: "tool_blocklist", allow: ["run_command"] },
        { guard: "prompt_injection", sensitivity: "disabled" },
        { guard: "sandbox", isolation: "local" },
      ]) {
        expect(
          await dispatcher.dispatch(authority(), {
            callId: randomUUID(),
            name: "guardrail_forge",
            arguments: { guard },
          })
        ).not.toMatchObject({ status: "succeeded" });
      }
      expect(service.revision).toBe(revision);
      expect(await writer.read("GuardrailsPolicy")).toBeNull();
    });
  }
);
