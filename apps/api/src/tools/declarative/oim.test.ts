import type { EgressHttpPort, EgressHttpRequest } from "@tulipfarm/integrations";
import { ConnectionResolver, OimOperationConnectionResolver } from "@tulipfarm/integrations";
import type { OimManifest } from "@tulipfarm/schema";
import type { SecretsService } from "@tulipfarm/secrets";
import type { SoulIntegration } from "@tulipfarm/soul";
import type { PersistedConnection } from "@tulipfarm/storage";
import { EffectDispatchDeferredError, MemoryEffectStore } from "@tulipfarm/tool-broker";
import type { RequestContext } from "@tulipfarm/tool-host";
import { describe, expect, it, vi } from "vitest";
import {
  type ConnectionOriginApprovalRepository,
  connectionOriginApprovalForTrustedConfirmation,
} from "../../integrations/connection-origin-policy";
import { buildDeclarativeTools, oimSecretRef } from "./tools";

function oimManifest(overrides: Partial<OimManifest> = {}): OimManifest {
  return {
    oimVersion: "1.0",
    kind: "Integration",
    metadata: {
      id: "twilio",
      name: "Twilio",
      version: "1.0.0",
      description: "Send messages.",
      license: "Apache-2.0",
    },
    profiles: { core: "1.0", auth: "1.0" },
    auth: {
      credentialSlots: [{ id: "api_token", label: "API token", kind: "api_key", required: true }],
      steps: [],
    },
    operations: [
      {
        id: "get-message",
        name: "get_message",
        description: "Read one message.",
        effect: "read",
        identityMode: "shared_only",
        credentialSlot: "api_token",
        credentialInjection: { in: "header", name: "Authorization", format: "Bearer {token}" },
        source: {
          type: "http",
          method: "GET",
          baseUrl: "https://api.twilio.test",
          path: "/v1/messages/{message_id}",
          parameters: [{ name: "message_id", in: "path", schema: { type: "string" } }],
        },
        response: { schema: { type: "object" }, maxBytes: 16_384 },
      },
      {
        id: "send-message",
        name: "send_message",
        description: "Send one message.",
        effect: "send",
        identityMode: "shared_only",
        credentialSlot: "api_token",
        credentialInjection: { in: "header", name: "Authorization", format: "Bearer {token}" },
        source: {
          type: "http",
          method: "POST",
          baseUrl: "https://api.twilio.test",
          path: "/v1/messages",
        },
        requestSchema: { type: "object" },
        response: { schema: { type: "object" }, maxBytes: 16_384 },
      },
    ],
    ...overrides,
  } as OimManifest;
}

function integration(manifest = oimManifest(), slug = "twilio"): SoulIntegration {
  return { slug, sourceIntegration: manifest.metadata.id, oimManifest: manifest };
}

class RecordingHttp implements EgressHttpPort {
  readonly sent: EgressHttpRequest[] = [];
  status = 200;
  body: unknown = { sid: "SM1", account_token: "super-secret" };

  async send(request: EgressHttpRequest) {
    this.sent.push(request);
    return { status: this.status, headers: {}, body: this.body };
  }
}

function secretsStub(values: Record<string, string>): () => Promise<SecretsService> {
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

function deps(http: RecordingHttp, values: Record<string, string> = {}) {
  return {
    businessId: "biz-1",
    effects: new MemoryEffectStore(),
    secrets: secretsStub(values),
    http,
  };
}

const CTX: RequestContext = { userId: "u1", runId: "run-1", toolCallId: "call-1" };
const CONNECTED = { "integration.twilio.api_token": "tok-live" };

describe("OIM Integrations reaching chat", () => {
  it("publishes one namespaced Tool per OIM operation", () => {
    const { tools, problems } = buildDeclarativeTools([integration()], deps(new RecordingHttp()));

    expect(problems).toEqual([]);
    expect(tools.map((tool) => tool.name)).toEqual(["twilio_get_message", "twilio_send_message"]);
  });

  it("keeps side-by-side major aliases readable and internal Tool ids pinned", async () => {
    const publicManifest = (version: string): OimManifest => {
      const manifest = oimManifest({
        metadata: { ...oimManifest().metadata, id: "acme", name: "Acme", version },
      });
      manifest.auth = undefined;
      manifest.operations = manifest.operations.map(
        ({ credentialSlot: _slot, credentialInjection: _injection, ...operation }) => operation
      );
      return manifest;
    };
    const effects = new MemoryEffectStore();
    const { tools, problems } = buildDeclarativeTools(
      [
        integration(publicManifest("1.9.0"), "acme"),
        integration(publicManifest("2.0.0"), "acme-v2"),
      ],
      { ...deps(new RecordingHttp()), effects }
    );

    expect(problems).toEqual([]);
    expect(tools.map((tool) => tool.name)).toEqual([
      "acme_v1_get_message",
      "acme_v1_send_message",
      "acme_v2_get_message",
      "acme_v2_send_message",
    ]);

    await tools
      .find((tool) => tool.name === "acme_v1_get_message")
      ?.execute({ message_id: "SM1" }, { ...CTX, toolCallId: "v1-call" });
    await tools
      .find((tool) => tool.name === "acme_v2_get_message")
      ?.execute({ message_id: "SM2" }, { ...CTX, toolCallId: "v2-call" });

    expect((await effects.list("biz-1")).map((effect) => effect.intent.toolId)).toEqual([
      "oim.acme.v1.get-message",
      "oim.acme.v2.get-message",
    ]);
  });

  it("refuses duplicate artifacts for one Integration major", () => {
    const manifest = oimManifest();
    const { tools, problems } = buildDeclarativeTools(
      [integration(manifest), integration(manifest, "twilio-copy")],
      deps(new RecordingHttp())
    );

    expect(tools).toEqual([]);
    expect(problems).toHaveLength(2);
    expect(problems.every((problem) => problem.includes("installed more than once"))).toBe(true);
  });

  it("takes mutability from the declared effect, not the HTTP verb", () => {
    const { tools } = buildDeclarativeTools([integration()], deps(new RecordingHttp()));

    expect(tools.find((t) => t.name === "twilio_get_message")?.mutating).toBe(false);
    expect(tools.find((t) => t.name === "twilio_send_message")?.mutating).toBe(true);
  });

  it("calls the provider through the ledgered path with the leased credential", async () => {
    const http = new RecordingHttp();
    const { tools } = buildDeclarativeTools([integration()], deps(http, CONNECTED));

    const result = await tools
      .find((tool) => tool.name === "twilio_get_message")
      ?.execute({ message_id: "SM1" }, CTX);

    expect(result).toMatchObject({ success: true });
    expect(http.sent[0]?.url).toBe("https://api.twilio.test/v1/messages/SM1");
    expect(http.sent).toHaveLength(1);
  });

  it("never returns a credential-shaped provider field to the model", async () => {
    const http = new RecordingHttp();
    http.body = { sid: "SM1", account_token: "super-secret", refresh_token: "unexpected-refresh" };
    const { tools } = buildDeclarativeTools([integration()], deps(http, CONNECTED));

    const result = (await tools
      .find((tool) => tool.name === "twilio_get_message")
      ?.execute({ message_id: "SM1" }, CTX)) as { data: Record<string, unknown> };

    expect(result.data.sid).toBe("SM1");
    expect(result.data.account_token).toBe("[redacted]");
    expect(result.data.refresh_token).toBe("[redacted]");
    expect(JSON.stringify(result)).not.toContain("unexpected-refresh");
  });

  it("refuses to lease another integration's credential", async () => {
    const http = new RecordingHttp();
    const { tools } = buildDeclarativeTools(
      [integration()],
      deps(http, { "integration.other.api_token": "tok-other" })
    );

    const result = await tools
      .find((tool) => tool.name === "twilio_get_message")
      ?.execute({ message_id: "SM1" }, CTX);

    expect(result).toMatchObject({ success: false });
    expect(http.sent).toHaveLength(0);
  });

  it("publishes operations that use different primary credential slots", () => {
    const manifest = oimManifest();
    const auth = manifest.auth;
    if (auth === undefined) throw new Error("fixture");
    manifest.auth = {
      ...auth,
      credentialSlots: [
        ...auth.credentialSlots,
        { id: "other_token", label: "Other token", kind: "api_key", required: true },
      ],
    };
    const [read, send] = manifest.operations;
    if (read === undefined || send === undefined) throw new Error("fixture");
    const { tools, problems } = buildDeclarativeTools(
      [
        integration({
          ...manifest,
          operations: [read, { ...send, credentialSlot: "other_token" }],
        }),
      ],
      deps(new RecordingHttp())
    );

    expect(problems).toEqual([]);
    expect(tools.map((tool) => tool.name)).toEqual(["twilio_get_message", "twilio_send_message"]);
  });

  it("resolves the primary slot declared by the operation being called", async () => {
    const manifest = oimManifest();
    const auth = manifest.auth;
    if (auth === undefined) throw new Error("fixture");
    manifest.auth = {
      ...auth,
      credentialSlots: [
        ...auth.credentialSlots,
        { id: "send_token", label: "Send token", kind: "api_key", required: true },
      ],
    };
    const send = manifest.operations[1];
    if (send === undefined) throw new Error("fixture");
    send.credentialSlot = "send_token";
    send.credentialInjection = {
      in: "header",
      name: "Authorization",
      format: "Token {token}",
    };
    const effects = new MemoryEffectStore();
    const { tools } = buildDeclarativeTools([integration(manifest)], {
      ...deps(new RecordingHttp(), { "sec-conn-1-send-token": "send-live" }),
      effects,
      connections: connectionResolver([
        persistedConnection({
          secretBindings: { send_token: "secret://sec-conn-1-send-token" },
        }),
      ]),
    });

    const result = await tools
      .find((tool) => tool.name === "twilio_send_message")
      ?.execute({ body: {} }, CTX);

    expect(result).toMatchObject({ success: true });
    expect((await effects.list("biz-1"))[0]?.intent.connection?.credentialSlot).toBe("send_token");
  });

  it("names the slot in the secret ref so slots cannot collide with legacy egress refs", () => {
    expect(oimSecretRef("twilio", "api_token")).toBe("secret://integrations/twilio/oim/api_token");
  });
});

function persistedConnection(overrides: Record<string, unknown> = {}) {
  return {
    id: "conn-1",
    integration: { id: "twilio", majorVersion: 1 },
    label: "Twilio (org)",
    owner: { scope: "organization" },
    status: "active",
    isDefault: true,
    configuration: { account_sid: "AC1", private_note: "internal" },
    agentVisibleConfiguration: ["account_sid"],
    secretBindings: { api_token: "secret://sec-conn-1-api-token" },
    health: { status: "healthy" },
    expiresAt: null,
    ...overrides,
  } as unknown as PersistedConnection;
}

function connectionResolver(
  connections: readonly PersistedConnection[],
  canUse: boolean | (() => boolean) = true
): OimOperationConnectionResolver {
  return new OimOperationConnectionResolver(
    new ConnectionResolver(
      {
        findById: async (_business, id) => connections.find((c) => c.id === id) ?? null,
        listForOwner: async (_business, _integration, owner) => [
          ...connections.filter((c) => c.owner.scope === owner.scope),
        ],
        listForIntegration: async () => [...connections],
      },
      { canUse: async () => (typeof canUse === "function" ? canUse() : canUse) }
    )
  );
}

describe("OIM Connection resolution", () => {
  it("rejects a resolver result bound to another Integration major", async () => {
    const http = new RecordingHttp();
    const connection = persistedConnection({
      integration: { id: "twilio", majorVersion: 2 },
    });
    const connections = {
      resolve: async () => ({
        kind: "ready" as const,
        connection,
        credentialRef: "secret://sec-conn-1-api-token" as const,
        binding: {
          connectionId: connection.id,
          integrationId: "twilio",
          credentialSlot: "api_token",
          principalKind: "user",
          principalId: "u1",
        },
      }),
    } as unknown as OimOperationConnectionResolver;
    const { tools } = buildDeclarativeTools([integration()], {
      ...deps(http, { "sec-conn-1-api-token": "tok-connection" }),
      connections,
    });

    const result = await tools
      .find((tool) => tool.name === "twilio_get_message")
      ?.execute({ connection_id: "conn-1", message_id: "SM1" }, CTX);

    expect(result).toMatchObject({
      success: true,
      data: { kind: "connection_denied", reason: "not_authorized" },
    });
    expect(http.sent).toHaveLength(0);
  });

  it("spends the resolved Connection's Secret and records the binding on the effect", async () => {
    const http = new RecordingHttp();
    const effects = new MemoryEffectStore();
    const { tools } = buildDeclarativeTools([integration()], {
      ...deps(http, { "sec-conn-1-api-token": "tok-connection" }),
      effects,
      connections: connectionResolver([persistedConnection()]),
    });

    const result = await tools
      .find((tool) => tool.name === "twilio_get_message")
      ?.execute({ message_id: "SM1" }, CTX);

    expect(result).toMatchObject({ success: true });
    // The recorded intent names the exact Connection and slot, so an Approval binds to that rather
    // than to whatever this integration's single Credential happens to be later.
    const [effect] = await effects.list("biz-1");
    expect(effect?.intent).toMatchObject({
      connection: {
        connectionId: "conn-1",
        integrationId: "twilio",
        credentialSlot: "api_token",
        principalKind: "user",
        principalId: "u1",
      },
      credentialRef: "secret://sec-conn-1-api-token",
      destination: "https://api.twilio.test",
    });
  });

  it("admits the exact Connection through the durable rate-limit store before dispatch", async () => {
    const http = new RecordingHttp();
    const admit = vi.fn(async () => ({ outcome: "admitted" as const }));
    const { tools } = buildDeclarativeTools([integration()], {
      ...deps(http, { "sec-conn-1-api-token": "tok-connection" }),
      connections: connectionResolver([persistedConnection()]),
      rateLimits: {
        admit,
        imposeCooldown: vi.fn(async () => {}),
      },
    });

    const result = await tools
      .find((tool) => tool.name === "twilio_get_message")
      ?.execute({ connection_id: "conn-1", message_id: "SM1" }, CTX);

    expect(result).toMatchObject({ success: true });
    expect(admit).toHaveBeenCalledWith({
      scope: {
        businessId: "biz-1",
        integrationId: "twilio",
        integrationMajorVersion: 1,
        connectionId: "conn-1",
        scope: "connection",
      },
      quota: undefined,
      now: expect.any(Date),
    });
    expect(http.sent).toHaveLength(1);
  });

  it("parks a rate-limited effect for durable retry without sending to the provider", async () => {
    const http = new RecordingHttp();
    const effects = new MemoryEffectStore();
    const parkRetry = vi.fn(async () => ({ waitId: "wait-1" }));
    const { tools } = buildDeclarativeTools([integration()], {
      ...deps(http, { "sec-conn-1-api-token": "tok-connection" }),
      effects,
      connections: connectionResolver([persistedConnection()]),
      rateLimits: {
        admit: async () => ({
          outcome: "limited",
          retryAt: new Date(Date.now() + 60_000).toISOString(),
        }),
        imposeCooldown: vi.fn(async () => {}),
      },
      parkRetry,
    });

    const call = tools
      .find((tool) => tool.name === "twilio_get_message")
      ?.execute({ connection_id: "conn-1", message_id: "SM1" }, CTX);

    await expect(call).rejects.toBeInstanceOf(EffectDispatchDeferredError);
    expect(parkRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz-1",
        runId: "run-1",
        stateId: "invoke:call-1",
        attempt: 1,
        reason: "oim_rate_limited",
      })
    );
    expect(await effects.list("biz-1")).toEqual([expect.objectContaining({ state: "authorized" })]);
    expect(http.sent).toHaveLength(0);
  });

  it("runs verified request and response Hooks at the governed OIM boundaries", async () => {
    const manifest = oimManifest({
      profiles: { core: "1.0", hooks: "1.0" },
      files: [
        {
          path: "hooks/runtime.js",
          role: "hook",
          sha256: "a".repeat(64),
        },
      ],
      hooks: [
        { kind: "input_validate", file: "hooks/runtime.js", export: "validateInput" },
        { kind: "request_shape", file: "hooks/runtime.js", export: "shapeRequest" },
        { kind: "response_normalize", file: "hooks/runtime.js", export: "normalizeResponse" },
      ],
    });
    const http = new RecordingHttp();
    const effects = new MemoryEffectStore();
    const run = vi.fn(
      async (_integration: SoulIntegration, hook: { kind: string }, input: unknown) => {
        const value = input as { arguments?: Record<string, unknown>; payload?: unknown };
        if (hook.kind === "input_validate") return { valid: true };
        if (hook.kind === "request_shape") {
          return { body: { text: "shaped" } };
        }
        return { normalized: value.payload };
      }
    );
    const { tools } = buildDeclarativeTools(
      [
        {
          ...integration(manifest),
          oimPackageFiles: { "hooks/runtime.js": "export function normalizeResponse() {}" },
        },
      ],
      {
        ...deps(http, { "sec-conn-1-api-token": "tok-connection" }),
        effects,
        connections: connectionResolver([persistedConnection()]),
        verifiedOimHooks: { run },
      }
    );

    const result = await tools
      .find((tool) => tool.name === "twilio_send_message")
      ?.execute({ connection_id: "conn-1", body: { text: "original" } }, CTX);

    expect(result).toMatchObject({
      success: true,
      data: {
        normalized: {
          sid: "SM1",
          account_token: "[redacted]",
        },
      },
    });
    expect(http.sent[0]).toMatchObject({
      url: "https://api.twilio.test/v1/messages",
      body: { text: "shaped" },
    });
    expect((await effects.list("biz-1"))[0]?.intent.arguments).toEqual({
      body: { text: "original" },
    });
    expect(run.mock.calls.map(([, hook]) => hook.kind)).toEqual([
      "input_validate",
      "request_shape",
      "response_normalize",
    ]);
  });

  it("fails closed before reservation when a declared request Hook has no verified runner", async () => {
    const manifest = oimManifest({
      profiles: { core: "1.0", hooks: "1.0" },
      files: [
        {
          path: "hooks/runtime.js",
          role: "hook",
          sha256: "a".repeat(64),
        },
      ],
      hooks: [{ kind: "input_validate", file: "hooks/runtime.js", export: "validateInput" }],
    });
    const http = new RecordingHttp();
    const effects = new MemoryEffectStore();
    const { tools } = buildDeclarativeTools([integration(manifest)], {
      ...deps(http, { "sec-conn-1-api-token": "tok-connection" }),
      effects,
      connections: connectionResolver([persistedConnection()]),
    });

    const result = await tools
      .find((tool) => tool.name === "twilio_get_message")
      ?.execute({ connection_id: "conn-1", message_id: "SM1" }, CTX);

    expect(result).toEqual({
      success: false,
      error: {
        code: "internal_error",
        message: "The Integration Hook could not be executed safely.",
      },
    });
    expect(await effects.list("biz-1")).toEqual([]);
    expect(http.sent).toHaveLength(0);
  });

  it("rejects a request Hook that changes the authorized target", async () => {
    const manifest = oimManifest({
      profiles: { core: "1.0", hooks: "1.0" },
      files: [
        {
          path: "hooks/runtime.js",
          role: "hook",
          sha256: "a".repeat(64),
        },
      ],
      hooks: [{ kind: "request_shape", file: "hooks/runtime.js", export: "shapeRequest" }],
    });
    const http = new RecordingHttp();
    const { tools } = buildDeclarativeTools([integration(manifest)], {
      ...deps(http, { "sec-conn-1-api-token": "tok-connection" }),
      connections: connectionResolver([persistedConnection()]),
      verifiedOimHooks: {
        run: async () => ({ message_id: "SM2" }),
      },
    });

    const result = await tools
      .find((tool) => tool.name === "twilio_get_message")
      ?.execute({ connection_id: "conn-1", message_id: "SM1" }, CTX);

    expect(result).toEqual({
      success: false,
      error: {
        code: "internal_error",
        message: "dispatch_failed:request_shape_target_mismatch",
      },
    });
    expect(http.sent).toHaveLength(0);
  });

  it("uses an explicit Connection choice and never sends the host-owned id to the provider", async () => {
    const http = new RecordingHttp();
    const effects = new MemoryEffectStore();
    const chosen = persistedConnection({
      id: "conn-2",
      isDefault: false,
      secretBindings: { api_token: "secret://sec-conn-2-api-token" },
    });
    const { tools } = buildDeclarativeTools([integration()], {
      ...deps(http, { "sec-conn-2-api-token": "tok-connection" }),
      effects,
      connections: connectionResolver([persistedConnection(), chosen]),
    });

    const tool = tools.find((candidate) => candidate.name === "twilio_get_message");
    expect(tool?.inputSchema).toMatchObject({
      properties: { connection_id: { type: "string" } },
    });
    const result = await tool?.execute({ connection_id: "conn-2", message_id: "SM1" }, CTX);

    expect(result).toMatchObject({ success: true });
    expect(http.sent[0]?.url).toBe("https://api.twilio.test/v1/messages/SM1");
    const [effect] = await effects.list("biz-1");
    expect(effect?.intent.connection?.connectionId).toBe("conn-2");
    expect(effect?.intent.arguments).toEqual({ message_id: "SM1" });
  });

  it("requires an exact Connection for a persistent Routine call", async () => {
    const http = new RecordingHttp();
    const { tools } = buildDeclarativeTools([integration()], {
      ...deps(http, { "sec-conn-1-api-token": "tok-connection" }),
      connections: connectionResolver([persistedConnection()]),
    });
    const tool = tools.find((candidate) => candidate.name === "twilio_get_message");

    const missing = await tool?.execute(
      { message_id: "SM1" },
      {
        ...CTX,
        routineContext: { routineId: "routine-1", runId: "routine-run-1" },
      }
    );

    expect(missing).toMatchObject({
      success: true,
      data: {
        kind: "connection_required",
        requiredAction: "select_connection",
        candidates: [{ id: "conn-1" }],
      },
    });
    expect(http.sent).toHaveLength(0);
  });

  it("compiles a tenant destination from the exact selected Connection at dispatch", async () => {
    const manifest = oimManifest({
      extensions: {
        "x-tulipfarm-origin-policy": {
          mode: "approved_public_exact",
          fields: ["site"],
        },
      },
    });
    manifest.profiles.auth = "1.0";
    manifest.auth = {
      credentialSlots: [{ id: "api_token", label: "API token", kind: "api_key" }],
      configurationFields: [{ id: "site", label: "Site", type: "string" }],
      allowedOriginHosts: ["*.twilio.test"],
      steps: [],
    };
    const operation = manifest.operations[0];
    if (operation === undefined || operation.source.type !== "http") throw new Error("fixture");
    operation.source.baseUrl = "https://{site}";
    const http = new RecordingHttp();
    const effects = new MemoryEffectStore();
    const { tools, problems } = buildDeclarativeTools([integration(manifest)], {
      ...deps(http, { "sec-conn-1-api-token": "tok-connection" }),
      effects,
      connections: connectionResolver([
        persistedConnection({ configuration: { site: "tenant.twilio.test" } }),
      ]),
    });

    expect(problems).toEqual([]);
    const result = await tools[0]?.execute({ connection_id: "conn-1", message_id: "SM1" }, CTX);

    expect(result).toMatchObject({ success: true });
    expect(http.sent[0]?.url).toBe("https://tenant.twilio.test/v1/messages/SM1");
    const [effect] = await effects.list("biz-1");
    expect(effect?.intent.destination).toBe("https://tenant.twilio.test");
  });

  it("injects a configured HTTP header from the exact selected Connection", async () => {
    const manifest = oimManifest();
    manifest.auth = {
      credentialSlots: [{ id: "api_token", label: "API token", kind: "api_key" }],
      configurationFields: [
        { id: "user_agent", label: "User-Agent", type: "string", required: true },
      ],
      steps: [],
    };
    const operation = manifest.operations[0];
    if (operation === undefined || operation.source.type !== "http") throw new Error("fixture");
    operation.source.parameters = [
      ...(operation.source.parameters ?? []),
      {
        name: "User-Agent",
        in: "header",
        schema: { type: "string" },
        configurationField: "user_agent",
      } as never,
    ];
    const http = new RecordingHttp();
    const { tools, problems } = buildDeclarativeTools([integration(manifest)], {
      ...deps(http, { "sec-conn-1-api-token": "tok-connection" }),
      connections: connectionResolver([
        persistedConnection({
          configuration: { user_agent: "web:tulipfarm:1.0 (by /u/muskan)" },
        }),
      ]),
    });

    expect(problems).toEqual([]);
    expect(tools[0]?.inputSchema).not.toHaveProperty("properties.User-Agent");
    const result = await tools[0]?.execute({ connection_id: "conn-1", message_id: "SM1" }, CTX);

    expect(result).toMatchObject({ success: true });
    expect(http.sent[0]?.headers["User-Agent"]).toBe("web:tulipfarm:1.0 (by /u/muskan)");
  });

  it("compiles only an exact trusted approved Connection origin", async () => {
    const manifest = oimManifest({
      extensions: {
        "x-tulipfarm-origin-policy": {
          mode: "approved_public_exact",
          fields: ["site"],
        },
      },
    });
    manifest.auth = {
      credentialSlots: [{ id: "api_token", label: "API token", kind: "api_key" }],
      configurationFields: [{ id: "site", label: "Site", type: "url" }],
      allowedOriginHosts: ["api.twilio.example"],
      steps: [],
    };
    const operation = manifest.operations[0];
    if (operation === undefined || operation.source.type !== "http") throw new Error("fixture");
    operation.source.baseUrl = "https://{site}";
    const connection = persistedConnection({
      configuration: { site: "tenant.twilio.example" },
    });
    const approval = connectionOriginApprovalForTrustedConfirmation({
      manifest,
      connection,
      configurationField: "site",
      approvedBy: "u1",
      approvedAt: "2026-09-07T09:00:00.000Z",
    });
    const originApprovals: ConnectionOriginApprovalRepository = {
      get: vi.fn(async () => approval),
      put: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    };
    const http = new RecordingHttp();
    const { tools } = buildDeclarativeTools([integration(manifest)], {
      ...deps(http, { "sec-conn-1-api-token": "tok-connection" }),
      connections: connectionResolver([connection]),
      originApprovals,
    });

    expect(tools[0]?.inputSchema).not.toHaveProperty("properties.approval");
    const result = await tools[0]?.execute({ connection_id: "conn-1", message_id: "SM1" }, CTX);

    expect(result).toMatchObject({ success: true });
    expect(http.sent[0]?.url).toBe("https://tenant.twilio.example/v1/messages/SM1");
    expect(http.sent[0]?.body).toBeUndefined();
    expect(originApprovals.get).toHaveBeenCalledTimes(2);
  });

  it("fails closed when an origin approval disappears before credential leasing", async () => {
    const manifest = oimManifest({
      extensions: {
        "x-tulipfarm-origin-policy": {
          mode: "approved_public_exact",
          fields: ["site"],
        },
      },
    });
    manifest.auth = {
      credentialSlots: [{ id: "api_token", label: "API token", kind: "api_key" }],
      configurationFields: [{ id: "site", label: "Site", type: "url" }],
      allowedOriginHosts: ["api.twilio.example"],
      steps: [],
    };
    const operation = manifest.operations[0];
    if (operation === undefined || operation.source.type !== "http") throw new Error("fixture");
    operation.source.baseUrl = "https://{site}";
    const connection = persistedConnection({
      configuration: { site: "tenant.twilio.example" },
    });
    const approval = connectionOriginApprovalForTrustedConfirmation({
      manifest,
      connection,
      configurationField: "site",
      approvedBy: "u1",
      approvedAt: "2026-09-07T09:00:00.000Z",
    });
    const get = vi.fn().mockResolvedValueOnce(approval).mockResolvedValueOnce(null);
    const http = new RecordingHttp();
    const { tools } = buildDeclarativeTools([integration(manifest)], {
      ...deps(http, { "sec-conn-1-api-token": "tok-connection" }),
      connections: connectionResolver([connection]),
      originApprovals: {
        get,
        put: vi.fn(async () => {}),
        delete: vi.fn(async () => {}),
      },
    });

    const result = await tools[0]?.execute({ connection_id: "conn-1", message_id: "SM1" }, CTX);

    expect(result).toMatchObject({ success: false });
    expect(get).toHaveBeenCalledTimes(2);
    expect(http.sent).toHaveLength(0);
  });

  it("leases both slots from one Connection for a two-credential OIM operation", async () => {
    const manifest = oimManifest();
    const operation = manifest.operations[0];
    if (operation === undefined) throw new Error("fixture");
    operation.secondaryCredential = {
      slot: "token",
      injection: { in: "query", name: "token", format: "{token}" },
    };
    const http = new RecordingHttp();
    const effects = new MemoryEffectStore();
    const { tools } = buildDeclarativeTools([integration(manifest)], {
      ...deps(http, {
        "sec-conn-1-api-token": "key-live",
        "sec-conn-1-token": "token-live",
      }),
      effects,
      connections: connectionResolver([
        persistedConnection({
          secretBindings: {
            api_token: "secret://sec-conn-1-api-token",
            token: "secret://sec-conn-1-token",
          },
        }),
      ]),
    });

    const result = await tools
      .find((tool) => tool.name === "twilio_get_message")
      ?.execute({ message_id: "SM1" }, CTX);

    expect(result).toMatchObject({ success: true });
    expect(http.sent[0]?.url).toBe("https://api.twilio.test/v1/messages/SM1?token=token-live");
    const [effect] = await effects.list("biz-1");
    expect(effect?.intent).toMatchObject({
      credentialRef: "secret://sec-conn-1-api-token",
      secondaryCredentialRef: "secret://sec-conn-1-token",
      connection: { credentialSlot: "api_token" },
      secondaryConnection: { credentialSlot: "token" },
    });
  });

  it("answers with a choice instead of dispatching when no Connection is available", async () => {
    const http = new RecordingHttp();
    const { tools } = buildDeclarativeTools([integration()], {
      ...deps(http, CONNECTED),
      connections: connectionResolver([]),
    });

    const result = await tools
      .find((tool) => tool.name === "twilio_get_message")
      ?.execute({ message_id: "SM1" }, CTX);

    expect(result).toMatchObject({
      success: true,
      data: { kind: "connection_required", requiredAction: "connect", candidates: [] },
    });
    expect(http.sent).toHaveLength(0);
  });

  it("requires a personal Connection without returning an organization credential", async () => {
    const manifest = oimManifest();
    const operation = manifest.operations[0];
    if (operation === undefined) throw new Error("fixture");
    operation.identityMode = "personal_required";
    const http = new RecordingHttp();
    const { tools } = buildDeclarativeTools([integration(manifest)], {
      ...deps(http, { "sec-conn-1-api-token": "organization-token" }),
      connections: connectionResolver([persistedConnection()]),
    });

    const result = await tools
      .find((tool) => tool.name === "twilio_get_message")
      ?.execute({ message_id: "SM1" }, CTX);

    expect(result).toMatchObject({
      success: true,
      data: { kind: "connection_required", requiredAction: "connect" },
    });
    expect(JSON.stringify(result)).not.toContain("secret://sec-conn-1-api-token");
    expect(http.sent).toHaveLength(0);
  });

  it("does not fall back to the deployment Credential when use is denied", async () => {
    const http = new RecordingHttp();
    const { tools } = buildDeclarativeTools([integration()], {
      // The deployment-wide Credential is present and would work; a denied Connection must not
      // quietly borrow it.
      ...deps(http, CONNECTED),
      connections: connectionResolver([persistedConnection()], false),
    });

    const result = await tools
      .find((tool) => tool.name === "twilio_get_message")
      ?.execute({ message_id: "SM1" }, CTX);

    expect(result).toMatchObject({ data: { kind: "connection_required" } });
    expect(http.sent).toHaveLength(0);
  });

  it("does not lease or dispatch after Team access is revoked after the intent resolves", async () => {
    const http = new RecordingHttp();
    const secretRead = vi.fn(async () => ({ value: "tok-connection", version: "1" }));
    let checks = 0;
    const { tools } = buildDeclarativeTools([integration()], {
      ...deps(http),
      connections: connectionResolver(
        [
          persistedConnection({
            owner: { scope: "team", teamId: "00000000-0000-4000-8000-000000000004" },
          }),
        ],
        () => checks++ === 0
      ),
      secrets: async () =>
        ({
          resolveCurrent: secretRead,
          revision: async () => "1",
        }) as unknown as SecretsService,
    });

    const result = await tools
      .find((tool) => tool.name === "twilio_get_message")
      ?.execute({ message_id: "SM1" }, CTX);

    expect(result).toMatchObject({ success: false });
    expect(checks).toBe(2);
    expect(secretRead).not.toHaveBeenCalled();
    expect(http.sent).toHaveLength(0);
  });

  it("offers only the Agent-visible configuration of a candidate", async () => {
    const http = new RecordingHttp();
    const { tools } = buildDeclarativeTools([integration()], {
      ...deps(http, CONNECTED),
      connections: connectionResolver([
        persistedConnection({ id: "conn-1", isDefault: false }),
        persistedConnection({ id: "conn-2", isDefault: false, label: "Twilio (backup)" }),
      ]),
    });

    const result = (await tools
      .find((tool) => tool.name === "twilio_get_message")
      ?.execute({ message_id: "SM1" }, CTX)) as {
      data: { kind: string; candidates: readonly { configuration: Record<string, unknown> }[] };
    };

    expect(result.data.kind).toBe("connection_ambiguous");
    expect(result.data.candidates).toHaveLength(2);
    for (const candidate of result.data.candidates) {
      expect(candidate.configuration).toEqual({ account_sid: "AC1" });
      expect(JSON.stringify(candidate)).not.toContain("internal");
    }
  });

  it("refuses a Connection whose credential slot is unbound", async () => {
    const http = new RecordingHttp();
    const { tools } = buildDeclarativeTools([integration()], {
      ...deps(http, CONNECTED),
      connections: connectionResolver([persistedConnection({ secretBindings: {} })]),
    });

    const result = await tools
      .find((tool) => tool.name === "twilio_get_message")
      ?.execute({ message_id: "SM1" }, CTX);

    expect(result).toMatchObject({
      data: { kind: "credential_required", connectionId: "conn-1", credentialSlot: "api_token" },
    });
    expect(http.sent).toHaveLength(0);
  });

  it("refuses an expired Connection rather than spending a stale credential", async () => {
    const http = new RecordingHttp();
    const { tools } = buildDeclarativeTools([integration()], {
      ...deps(http, CONNECTED),
      connections: connectionResolver([persistedConnection({ expiresAt: "2000-01-01T00:00:00Z" })]),
    });

    const result = await tools
      .find((tool) => tool.name === "twilio_get_message")
      ?.execute({ message_id: "SM1" }, CTX);

    expect(result).toMatchObject({
      data: { kind: "connection_unhealthy", requiredAction: "reconnect", status: "expired" },
    });
    expect(http.sent).toHaveLength(0);
  });

  it("leaves the deployment Credential path alone when no resolver is configured", async () => {
    const http = new RecordingHttp();
    const { tools } = buildDeclarativeTools([integration()], deps(http, CONNECTED));

    const result = await tools
      .find((tool) => tool.name === "twilio_get_message")
      ?.execute({ message_id: "SM1" }, CTX);

    expect(result).toMatchObject({ success: true });
    expect(http.sent).toHaveLength(1);
  });
});

describe("OIM Connection Secret routing", () => {
  it("denies a Connection whose Secret binding is not a valid opaque id", async () => {
    // The Connection store is the only writer of these, so a malformed one is corruption. It must
    // deny the lease rather than surface as a broken Tool.
    const http = new RecordingHttp();
    const { tools } = buildDeclarativeTools([integration()], {
      ...deps(http, { "sec-conn-1-api-token": "tok-connection" }),
      connections: connectionResolver([
        persistedConnection({ secretBindings: { api_token: "secret://not/opaque" } }),
      ]),
    });

    const result = await tools
      .find((tool) => tool.name === "twilio_get_message")
      ?.execute({ message_id: "SM1" }, CTX);

    expect(result).toMatchObject({ success: false });
    expect(http.sent).toHaveLength(0);
  });

  it("does not serve the deployment Credential to a Connection lease", async () => {
    // The deployment Credential has no durable revision, so it can never satisfy the revision
    // pinning a Connection lease requires — it must not be substituted for a missing Connection
    // Secret.
    const http = new RecordingHttp();
    const { tools } = buildDeclarativeTools([integration()], {
      ...deps(http, CONNECTED),
      connections: connectionResolver([persistedConnection()]),
    });

    const result = await tools
      .find((tool) => tool.name === "twilio_get_message")
      ?.execute({ message_id: "SM1" }, CTX);

    expect(result).toMatchObject({ success: false });
    expect(http.sent).toHaveLength(0);
  });
});

const GRAPHQL_DOCUMENT = `query ListTeams($first: Int!) {
  teams(first: $first) { nodes { id name } }
}`;

function graphqlIntegration(): SoulIntegration {
  return {
    slug: "tasks",
    sourceIntegration: "tasks",
    oimDocuments: { "operations/list-teams.graphql": GRAPHQL_DOCUMENT },
    oimManifest: {
      ...oimManifest(),
      metadata: {
        id: "tasks",
        name: "Tasks",
        version: "1.0.0",
        description: "Read tasks.",
        license: "Apache-2.0",
      },
      operations: [
        {
          id: "list-teams",
          name: "list_teams",
          description: "List teams.",
          effect: "read",
          identityMode: "shared_only",
          credentialSlot: "api_token",
          credentialInjection: { in: "header", name: "Authorization", format: "{token}" },
          source: {
            type: "graphql",
            url: "https://api.tasks.test/graphql",
            operation: "ListTeams",
            documentFile: "operations/list-teams.graphql",
          },
          requestSchema: {
            type: "object",
            properties: { first: { type: "integer" } },
            required: ["first"],
            additionalProperties: false,
          },
          response: { schema: { type: "object" }, maxBytes: 16_384 },
        },
      ],
    } as OimManifest,
  };
}

describe("OIM GraphQL operations reaching chat", () => {
  it("publishes a Tool from a document the package shipped", () => {
    const { tools, problems } = buildDeclarativeTools(
      [graphqlIntegration()],
      deps(new RecordingHttp())
    );

    expect(problems).toEqual([]);
    expect(tools.map((tool) => tool.name)).toEqual(["tasks_list_teams"]);
    expect(tools[0]?.mutating).toBe(false);
  });

  describe("OIM OpenAPI operations reaching chat", () => {
    it("loads the declared operation and dispatches it through the existing OpenAPI request builder", async () => {
      const manifest: OimManifest = {
        ...oimManifest(),
        metadata: {
          id: "tasks",
          name: "Tasks",
          version: "1.0.0",
          description: "Read tasks.",
          license: "Apache-2.0",
        },
        operations: [
          {
            id: "get-task",
            name: "get_task",
            description: "Read one task.",
            effect: "read",
            identityMode: "shared_only",
            credentialSlot: "api_token",
            credentialInjection: {
              in: "header",
              name: "Authorization",
              format: "Token {token}",
            },
            source: {
              type: "openapi",
              file: "openapi.yaml",
              operationId: "getTask",
            },
            response: {
              schema: { type: "object" },
              maxBytes: 16_384,
            },
          },
        ],
      };
      const provider: SoulIntegration = {
        slug: "tasks",
        sourceIntegration: "tasks",
        oimManifest: manifest,
        oimOpenApiDocuments: {
          "openapi.yaml": {
            openapi: "3.0.3",
            servers: [{ url: "https://api.tasks.test/v1" }],
            paths: {
              "/tasks/{task_id}": {
                get: {
                  operationId: "getTask",
                  parameters: [
                    {
                      name: "task_id",
                      in: "path",
                      required: true,
                      schema: { type: "string" },
                    },
                  ],
                  responses: { "200": { description: "ok" } },
                },
              },
            },
          },
        },
      };
      const http = new RecordingHttp();
      const { tools, problems } = buildDeclarativeTools([provider], {
        ...deps(http, { "sec-conn-1-api-token": "tok-connection" }),
        connections: connectionResolver([
          persistedConnection({
            integration: { id: "tasks", majorVersion: 1 },
          }),
        ]),
      });

      const result = await tools[0]?.execute({ connection_id: "conn-1", task_id: "TASK-1" }, CTX);

      expect(problems).toEqual([]);
      expect(result).toMatchObject({ success: true });
      expect(http.sent[0]).toMatchObject({
        url: "https://api.tasks.test/v1/tasks/TASK-1",
        method: "GET",
        headers: { Authorization: "Token tok-connection" },
      });
    });
  });

  it("sends the package's document and the Agent's variables, never query text", async () => {
    const http = new RecordingHttp();
    const { tools } = buildDeclarativeTools(
      [graphqlIntegration()],
      deps(http, { "integration.tasks.api_token": "tok-live" })
    );

    const result = await tools[0]?.execute(
      { first: 5, query: "mutation { deleteEverything }" },
      CTX
    );

    expect(result).toMatchObject({ success: true });

    const [sent] = http.sent;
    expect(sent?.url).toBe("https://api.tasks.test/graphql");
    expect(sent?.headers.Authorization).toBe("tok-live");
    expect(sent?.body).toMatchObject({ query: GRAPHQL_DOCUMENT, operationName: "ListTeams" });
  });

  it("compiles a templated endpoint from the exact selected Connection", async () => {
    const provider = graphqlIntegration();
    const manifest = provider.oimManifest;
    if (manifest === undefined) throw new Error("fixture");
    manifest.auth = {
      credentialSlots: [{ id: "api_token", label: "API token", kind: "api_key" }],
      configurationFields: [{ id: "shop", label: "Shop host", type: "string", required: true }],
      allowedOriginHosts: ["*.myshopify.com"],
      steps: [],
    };
    const operation = manifest.operations[0];
    if (operation === undefined || operation.source.type !== "graphql") throw new Error("fixture");
    operation.source.url = "https://{shop}/admin/api/2026-07/graphql.json";
    const http = new RecordingHttp();
    const { tools, problems } = buildDeclarativeTools([provider], {
      ...deps(http, { "sec-conn-1-api-token": "tok-connection" }),
      connections: connectionResolver([
        persistedConnection({
          integration: { id: "tasks", majorVersion: 1 },
          configuration: { shop: "muskan-store.myshopify.com" },
        }),
      ]),
    });

    expect(problems).toEqual([]);
    const result = await tools[0]?.execute({ connection_id: "conn-1", first: 5 }, CTX);

    expect(result).toMatchObject({ success: true });
    expect(http.sent[0]?.url).toBe(
      "https://muskan-store.myshopify.com/admin/api/2026-07/graphql.json"
    );
  });
});
