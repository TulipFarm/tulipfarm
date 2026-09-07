import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  ConnectionResolver,
  compileOimHttpOperations,
  type EgressHttpPort,
  type EgressHttpRequest,
  OimOperationConnectionResolver,
} from "@tulipfarm/integrations";
import { canonicalHash, type OimManifest, oimPackageDigest } from "@tulipfarm/schema";
import type { SecretsService } from "@tulipfarm/secrets";
import {
  type CommitSigner,
  type Logger,
  type RuntimeBundle,
  SoulGitStore,
  type SoulIntegration,
  SoulLoader,
  SoulWriter,
} from "@tulipfarm/soul";
import type { PersistedConnection } from "@tulipfarm/storage";
import { MemoryEffectStore } from "@tulipfarm/tool-broker";
import type { RequestContext } from "@tulipfarm/tool-host";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify as stringifyYaml } from "yaml";
import { ToolRegistry } from "../broker/tool-adapter";
import {
  InternalRoutineOimToolHost,
  type RoutineOimRegistration,
} from "../internal/routine-oim-tool-host";
import { DeclarativeToolSync } from "../tools/declarative/sync";
import {
  inspectIntegrationSource,
  installIntegrationFromSource,
  readIntegrationLock,
} from "./install";
import { registerIntegrationRoutes } from "./routes";

const SOURCE = "https://packages.example/acme/oim.yml";
const API_ORIGIN = "https://api.acme.example";
const ACTOR_ID = "lifecycle-test";

function manifest(version: string): OimManifest {
  return {
    oimVersion: "1.0",
    kind: "Integration",
    metadata: {
      id: "acme",
      name: "Acme",
      version,
      description: "Read Acme tickets.",
      license: "Apache-2.0",
    },
    profiles: { core: "1.0", auth: "1.0" },
    auth: {
      credentialSlots: [{ id: "api_token", label: "API token", kind: "api_key", required: true }],
      steps: [
        {
          id: "credentials",
          type: "fields",
          title: "Credentials",
          fields: [
            {
              id: "api_token",
              label: "API token",
              input: "password",
              target: { type: "credential", slot: "api_token" },
            },
          ],
        },
      ],
    },
    operations: [
      {
        id: "tickets-list",
        name: "tickets_list",
        description: "List tickets.",
        effect: "read",
        identityMode: "shared_only",
        credentialSlot: "api_token",
        credentialInjection: {
          in: "header",
          name: "Authorization",
          format: "Token {token}",
        },
        source: {
          type: "http",
          method: "GET",
          baseUrl: API_ORIGIN,
          path: "/tickets",
        },
        response: { schema: { type: "object" }, maxBytes: 16_384 },
      },
    ],
  };
}

class LifecycleHttp implements EgressHttpPort {
  package = manifest("1.4.0");
  readonly providerRequests: EgressHttpRequest[] = [];

  async send(request: EgressHttpRequest) {
    if (request.url === SOURCE) {
      return {
        status: 200,
        headers: { "content-type": "text/yaml" },
        body: stringifyYaml(this.package),
      };
    }
    this.providerRequests.push(request);
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: { tickets: [] },
    };
  }
}

function persistedConnection(
  id: string,
  majorVersion: number,
  secretRef: `secret://${string}`
): PersistedConnection {
  return {
    businessId: "deployment",
    id,
    integration: { id: "acme", majorVersion },
    label: `Acme v${majorVersion}`,
    owner: { scope: "organization" },
    status: "active",
    isDefault: false,
    configuration: {},
    agentVisibleConfiguration: [],
    secretBindings: { api_token: secretRef },
    health: { status: "healthy", checkedAt: null },
    expiresAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function connectionResolver(
  connections: readonly PersistedConnection[]
): OimOperationConnectionResolver {
  return new OimOperationConnectionResolver(
    new ConnectionResolver(
      {
        findById: async (_businessId, id) =>
          connections.find((connection) => connection.id === id) ?? null,
        listForOwner: async (_businessId, integration, owner) =>
          connections.filter(
            (connection) =>
              connection.integration.id === integration.id &&
              connection.integration.majorVersion === integration.majorVersion &&
              connection.owner.scope === owner.scope
          ),
        listForIntegration: async (_businessId, integration) =>
          connections.filter(
            (connection) =>
              connection.integration.id === integration.id &&
              connection.integration.majorVersion === integration.majorVersion
          ),
      },
      { canUse: async () => true }
    )
  );
}

function secrets(values: Readonly<Record<string, string>>): () => Promise<SecretsService> {
  const service = {
    get: async (key: string) => {
      const value = values[key];
      if (value === undefined) throw new Error(`no secret ${key}`);
      return value;
    },
    resolveCurrent: async (key: string) => {
      const value = values[key];
      return value === undefined ? null : { value, version: "1" };
    },
    revision: async (key: string) => (values[key] === undefined ? null : "1"),
  };
  return async () => service as unknown as SecretsService;
}

function routineBundle(registration: RoutineOimRegistration): RuntimeBundle {
  const compiled = compileOimHttpOperations(
    registration.manifest,
    {},
    {
      deferConfiguration: true,
    }
  )[0];
  if (compiled === undefined) throw new Error("v1 Tool did not compile");
  const contract = compiled.contract;
  const contractDefinition = {
    kind: "ToolContract",
    id: contract.metadata.id,
    slug: contract.metadata.slug,
    authoredVersion: contract.metadata.authoredVersion,
    hash: canonicalHash(contract),
    document: contract,
    references: [],
  };
  const routineDefinition = {
    kind: "Routine",
    id: "routine-1",
    slug: "acme-routine",
    authoredVersion: 1,
    hash: "e".repeat(64),
    document: {
      apiVersion: "tulipfarm.ai/v1",
      kind: "Routine",
      metadata: {
        id: "routine-1",
        slug: "acme-routine",
        schemaVersion: 1,
        authoredVersion: 1,
        lifecycle: "published",
      },
      spec: {
        owner: "operations",
        start: "List tickets",
        states: [
          {
            type: "tool",
            name: "List tickets",
            toolRef: {
              name: contract.spec.toolId,
              version: contract.spec.toolVersion,
            },
            action: contract.spec.action,
            end: true,
          },
        ],
      },
    },
    references: [],
  };
  const definitions = [routineDefinition, contractDefinition];
  return {
    digest: "c".repeat(64),
    businessId: "deployment",
    changesetId: "changeset-1",
    commitSha: "d".repeat(40),
    definitions,
    assets: [],
    get: () => undefined,
    getById: (id) => definitions.find((definition) => definition.id === id),
    asset: () => undefined,
  } as RuntimeBundle;
}

describe("OIM major lifecycle composition", () => {
  let app: FastifyInstance;
  let root: string;
  let loader: SoulLoader;
  let writer: SoulWriter;
  let http: LifecycleHttp;

  beforeEach(async () => {
    root = join(process.cwd(), "node_modules", ".cache", "oim-major-lifecycle", randomUUID());
    await mkdir(root, { recursive: true });
    execFileSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: root });

    const logger = {
      info() {},
      warn() {},
      error() {},
      debug() {},
    } as Logger;
    const signer: CommitSigner = { keyId: "test-key", sign: () => "signature" };
    loader = new SoulLoader(root, logger);
    writer = new SoulWriter(new SoulGitStore(root, signer, logger), logger);
    http = new LifecycleHttp();
    await loader.load();

    app = Fastify();
    registerIntegrationRoutes(
      app,
      loader,
      writer,
      {
        list: async () => [],
        delete: async () => undefined,
      } as unknown as SecretsService,
      new Map(),
      async (request) => {
        (request as FastifyRequest).principal = {
          id: ACTOR_ID,
          kind: "service",
          businessId: "deployment",
          credential: "client_secret",
          authMethods: [],
          authenticatedAt: new Date(),
          clientId: ACTOR_ID,
        };
      },
      () => async () => undefined
    );
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });

  async function installCurrentPackage(): Promise<string> {
    const review = await inspectIntegrationSource(SOURCE, ACTOR_ID, { http });
    const digest = review.integrations[0]?.packageDigest;
    if (digest === undefined) throw new Error("review returned no package digest");
    const result = await installIntegrationFromSource(
      {
        source: SOURCE,
        ref: review.ref,
        approveDigest: digest,
      },
      {
        soulLoader: loader,
        soulWriter: writer,
        bundledSlugs: new Set(),
        actorId: ACTOR_ID,
        http,
      }
    );
    expect(result.packageDigest).toBe(oimPackageDigest(http.package));
    return result.name;
  }

  it("keeps installed majors, Tools, Connections, and removal isolated", async () => {
    expect(await installCurrentPackage()).toBe("acme");

    const v1Manifest = loader.integrations.get("acme")?.oimManifest;
    const v1Operation = v1Manifest?.operations[0];
    if (v1Manifest === undefined || v1Operation === undefined) {
      throw new Error("v1 manifest did not load");
    }
    const pinnedV1Registration: RoutineOimRegistration = { manifest: v1Manifest };
    const pinnedV1Bundle = routineBundle(pinnedV1Registration);
    const v1Connection = persistedConnection("connection-v1", 1, "secret://connection-v1-token");
    const v2Connection = persistedConnection("connection-v2", 2, "secret://connection-v2-token");
    const effects = new MemoryEffectStore();
    const connections = connectionResolver([v1Connection, v2Connection]);
    let runtimeTrustAllowed = true;
    const authorizeOimIntegration = vi.fn(async (_integration: SoulIntegration) => {
      if (!runtimeTrustAllowed) throw new Error("runtime trust denied");
    });
    const routineHost = new InternalRoutineOimToolHost({
      businessId: "deployment",
      runs: {
        authority: async () => ({
          businessId: "deployment",
          runId: "run-1",
          subject: { kind: "user", id: "u1" },
          source: "routine",
          bundleDigest: pinnedV1Bundle.digest,
          routineId: "routine-1",
        }),
      },
      bundles: { load: async () => pinnedV1Bundle },
      registrations: { find: async () => pinnedV1Registration },
      connections,
      effects: {
        get: async () => undefined,
        listAttempts: async () => [],
      },
      secrets: secrets({
        "connection-v1-token": "token-v1",
        "connection-v2-token": "token-v2",
      }),
      http,
      authorize: { authorize: async () => true },
    });
    const registry = new ToolRegistry();
    const sync = new DeclarativeToolSync({
      registry,
      integrations: () => loader.integrations.values(),
      businessId: "deployment",
      effects,
      http,
      secrets: secrets({
        "connection-v1-token": "token-v1",
        "connection-v2-token": "token-v2",
      }),
      connections,
      authorizeOimIntegration,
    });
    const registeredNames = () => registry.getAll().map((tool) => tool.name);
    const context = (toolCallId: string): RequestContext => ({
      userId: "u1",
      runId: "run-1",
      toolCallId,
    });
    const agentToolsFor = (toolId: string, toolCallId: string) =>
      registry.buildToolSet(
        context(toolCallId),
        undefined,
        undefined,
        undefined,
        undefined,
        new Set([toolId])
      );
    const persistedV1ToolId = "oim.acme.v1.tickets-list";
    const persistedV2ToolId = "oim.acme.v2.tickets-list";

    expect(sync.sync()).toBe(1);
    expect(registeredNames()).toEqual(["acme_tickets_list"]);
    expect(Object.keys(agentToolsFor(persistedV1ToolId, "v1-before"))).toEqual([
      "acme_tickets_list",
    ]);
    expect(pinnedV1Bundle.definitions[1]?.document).toMatchObject({
      spec: { toolId: persistedV1ToolId },
    });
    expect(
      await routineHost.prepare("run-1", {
        stateKey: "List tickets",
        connectionId: "connection-v1",
      })
    ).toMatchObject({
      kind: "ready",
      connection: { connectionId: "connection-v1", integrationId: "acme" },
    });

    http.package = manifest("2.0.0");
    expect(await installCurrentPackage()).toBe("acme-v2");
    expect(sync.sync()).toBe(2);

    expect([...loader.integrations.keys()]).toEqual(["acme", "acme-v2"]);
    expect(loader.integrations.get("acme")?.oimManifest?.metadata).toMatchObject({
      id: "acme",
      version: "1.4.0",
    });
    expect(loader.integrations.get("acme-v2")?.oimManifest?.metadata).toMatchObject({
      id: "acme",
      version: "2.0.0",
    });
    expect(Object.keys(readIntegrationLock(writer).integrations).sort()).toEqual([
      "acme",
      "acme-v2",
    ]);
    expect(registeredNames().sort()).toEqual(["acme_v1_tickets_list", "acme_v2_tickets_list"]);

    expect(registeredNames()).not.toContain("acme_tickets_list");
    const v1AgentTools = agentToolsFor(persistedV1ToolId, "v1");
    const v2AgentTools = agentToolsFor(persistedV2ToolId, "v2");
    expect(Object.keys(v1AgentTools)).toEqual(["acme_v1_tickets_list"]);
    expect(Object.keys(v2AgentTools)).toEqual(["acme_v2_tickets_list"]);
    expect(
      await routineHost.prepare("run-1", {
        stateKey: "List tickets",
        connectionId: "connection-v1",
      })
    ).toMatchObject({
      kind: "ready",
      connection: { connectionId: "connection-v1", integrationId: "acme" },
    });
    expect(
      await connections.resolve({
        businessId: "deployment",
        manifest: v1Manifest,
        operation: v1Operation,
        principal: { kind: "user", id: "u1" },
        connectionId: "connection-v2",
      })
    ).toEqual({ kind: "connection_denied", reason: "not_found" });

    expect(
      await v1AgentTools.acme_v1_tickets_list?.execute?.(
        { connection_id: "connection-v2" },
        { messages: [], context: undefined, toolCallId: "wrong-major" }
      )
    ).toMatchObject({
      success: true,
      data: { kind: "connection_denied", reason: "not_found" },
    });
    expect(http.providerRequests).toHaveLength(0);

    runtimeTrustAllowed = false;
    expect(
      await v1AgentTools.acme_v1_tickets_list?.execute?.(
        { connection_id: "connection-v1" },
        { messages: [], context: undefined, toolCallId: "trust-denied" }
      )
    ).toMatchObject({
      success: false,
      error: { code: "internal_error" },
    });
    expect(http.providerRequests).toHaveLength(0);
    expect(await effects.list("deployment")).toEqual([]);

    runtimeTrustAllowed = true;
    expect(
      await v1AgentTools.acme_v1_tickets_list?.execute?.(
        { connection_id: "connection-v1" },
        { messages: [], context: undefined, toolCallId: "v1" }
      )
    ).toMatchObject({ success: true });
    expect(
      await v2AgentTools.acme_v2_tickets_list?.execute?.(
        { connection_id: "connection-v2" },
        { messages: [], context: undefined, toolCallId: "v2" }
      )
    ).toMatchObject({ success: true });
    expect(authorizeOimIntegration).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: "acme",
        oimManifest: expect.objectContaining({
          metadata: expect.objectContaining({ id: "acme", version: "1.4.0" }),
        }),
      })
    );
    expect(http.providerRequests.map((request) => request.headers.Authorization)).toEqual([
      "Token token-v1",
      "Token token-v2",
    ]);

    const intents = await effects.list("deployment");
    expect(intents.map((effect) => effect.intent.toolId)).toEqual([
      "oim.acme.v1.tickets-list",
      "oim.acme.v2.tickets-list",
    ]);
    expect(intents.map((effect) => effect.intent.connection?.connectionId)).toEqual([
      "connection-v1",
      "connection-v2",
    ]);

    const removed = await app.inject({ method: "DELETE", url: "/api/v1/integrations/acme-v2" });
    expect(removed.statusCode).toBe(204);
    expect([...loader.integrations.keys()]).toEqual(["acme"]);
    expect(Object.keys(readIntegrationLock(writer).integrations)).toEqual(["acme"]);

    expect(sync.sync()).toBe(1);
    expect(registeredNames()).toEqual(["acme_tickets_list"]);
    expect(Object.keys(agentToolsFor(persistedV2ToolId, "v2-after"))).toEqual([]);
    const remainingV1AgentTools = agentToolsFor(persistedV1ToolId, "v1-after");
    expect(Object.keys(remainingV1AgentTools)).toEqual(["acme_tickets_list"]);
    expect(
      await routineHost.prepare("run-1", {
        stateKey: "List tickets",
        connectionId: "connection-v1",
      })
    ).toMatchObject({
      kind: "ready",
      connection: { connectionId: "connection-v1", integrationId: "acme" },
    });
    expect(
      await remainingV1AgentTools.acme_tickets_list?.execute?.(
        { connection_id: "connection-v1" },
        { messages: [], context: undefined, toolCallId: "v1-after" }
      )
    ).toMatchObject({ success: true });
    const finalIntents = await effects.list("deployment");
    expect(finalIntents.at(-1)?.intent.toolId).toBe(persistedV1ToolId);
    expect(finalIntents.some((effect) => effect.intent.toolId === persistedV2ToolId)).toBe(true);
  });
});
