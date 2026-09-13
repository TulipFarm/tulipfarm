import { createCipheriv, createDecipheriv } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import {
  ConnectionResolver,
  type EgressHttpPort,
  type EgressHttpRequest,
  type OimContinuationCodec,
  type OimContinuationState,
  OimOperationConnectionResolver,
} from "@tulipfarm/integrations";
import type { OimManifest } from "@tulipfarm/schema";
import type { SecretsService } from "@tulipfarm/secrets";
import type { SoulIntegration } from "@tulipfarm/soul";
import type { PersistedConnection } from "@tulipfarm/storage";
import { MemoryEffectStore, PgEffectStore, type ToolIntent } from "@tulipfarm/tool-broker";
import {
  ApprovalsRepo,
  InMemoryToolCatalog,
  RegistryToolDispatcher,
  type ToolApprovalPort,
  ToolApprovalService,
} from "@tulipfarm/tool-host";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { type Queryable, transactionPort } from "../../db";
import { makeMigratedPglite } from "../../test/pglite";
import { buildDeclarativeTools } from "./tools";

const BUSINESS_ID = "business-1";
const RUN_ID = "11111111-1111-4111-8111-111111111111";
const AUTHORITY = {
  businessId: BUSINESS_ID,
  runId: RUN_ID,
  turn: {
    conversationId: "22222222-2222-4222-8222-222222222222",
    id: "33333333-3333-4333-8333-333333333333",
    attempt: 1,
  },
  subject: { kind: "user" as const, id: "user-1" },
  source: "chat" as const,
  bundleDigest: "bundle",
};

function manifest(): OimManifest {
  return {
    oimVersion: "1.0",
    kind: "Integration",
    metadata: {
      id: "acme",
      name: "Acme",
      version: "1.0.0",
      description: "Acme messages",
      license: "Apache-2.0",
    },
    profiles: { core: "1.0", auth: "1.0" },
    auth: {
      credentialSlots: [{ id: "token", label: "Token", kind: "api_key", required: true }],
      steps: [],
    },
    operations: [
      {
        id: "send-message",
        name: "send_message",
        description: "Send a message",
        effect: "send",
        identityMode: "shared_only",
        credentialSlot: "token",
        credentialInjection: { in: "header", name: "Authorization", format: "Bearer {token}" },
        source: {
          type: "http",
          method: "POST",
          baseUrl: "https://api.acme.test",
          path: "/messages",
        },
        requestSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
          additionalProperties: false,
        },
        response: { schema: { type: "object" }, maxBytes: 16_384 },
      },
    ],
  } as OimManifest;
}

function connection(
  id: string,
  isDefault: boolean,
  secretRef: `secret://${string}`,
  configuration: Readonly<Record<string, string | number | boolean>> = {}
) {
  return {
    businessId: BUSINESS_ID,
    id,
    integration: { id: "acme", majorVersion: 1 },
    label: id,
    owner: { scope: "organization" },
    status: "active",
    isDefault,
    configuration,
    agentVisibleConfiguration: [],
    secretBindings: { token: secretRef },
    health: { status: "healthy", checkedAt: "2026-09-12T00:00:00.000Z" },
    expiresAt: null,
    createdAt: new Date("2026-09-12T00:00:00.000Z"),
    updatedAt: new Date("2026-09-12T00:00:00.000Z"),
  } as PersistedConnection;
}

function connectionResolver(rows: () => readonly PersistedConnection[]) {
  return new OimOperationConnectionResolver(
    new ConnectionResolver(
      {
        findById: async (_businessId, id) => rows().find((row) => row.id === id) ?? null,
        listForOwner: async () => [...rows()],
        listForIntegration: async () => [...rows()],
      },
      { canUse: async () => true }
    ),
    { list: async () => [] }
  );
}

function connectionResolverWithLookup(
  rows: () => readonly PersistedConnection[],
  findById: (businessId: string, id: string) => Promise<PersistedConnection | null>
) {
  return new OimOperationConnectionResolver(
    new ConnectionResolver(
      {
        findById,
        listForOwner: async () => [...rows()],
        listForIntegration: async () => [...rows()],
      },
      { canUse: async () => true }
    ),
    { list: async () => [] }
  );
}

function secrets(
  values: Readonly<Record<string, string>>,
  revisions: Readonly<Record<string, string>> = {}
) {
  const revision = vi.fn(async (key: string) =>
    values[key] === undefined ? null : (revisions[key] ?? "1")
  );
  const resolveCurrent = vi.fn(async (key: string) => {
    const value = values[key];
    return value === undefined ? null : { value, version: revisions[key] ?? "1" };
  });
  return {
    revision,
    resolveCurrent,
    service: async () =>
      ({
        get: async (key: string) => values[key],
        revision,
        resolveCurrent,
      }) as unknown as SecretsService,
  };
}

class RecordingHttp implements EgressHttpPort {
  readonly sent: EgressHttpRequest[] = [];

  async send(request: EgressHttpRequest) {
    this.sent.push(request);
    return { status: 200, headers: {}, body: { id: "message-1" } };
  }
}

function integration(oimManifest = manifest()): SoulIntegration {
  return { slug: "acme", sourceIntegration: "acme", oimManifest };
}

function openApiIntegration(oimManifest: OimManifest, document: unknown): SoulIntegration {
  return {
    slug: "acme",
    sourceIntegration: "acme",
    oimManifest,
    oimOpenApiDocuments: { "openapi.json": document },
  };
}

class SecureTestContinuationCodec implements OimContinuationCodec {
  private readonly key = Buffer.alloc(32, 7);
  private nonce = 0;

  async seal(state: OimContinuationState): Promise<string> {
    const iv = Buffer.alloc(12);
    iv.writeUInt32BE(++this.nonce, 8);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(state), "utf8"),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
  }

  async unseal(token: string): Promise<unknown> {
    const encoded = Buffer.from(token, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", this.key, encoded.subarray(0, 12));
    decipher.setAuthTag(encoded.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([decipher.update(encoded.subarray(28)), decipher.final()]).toString("utf8")
    );
  }
}

function openApiManifest(
  response: OimManifest["operations"][number]["response"],
  pagination?: OimManifest["operations"][number]["pagination"]
): OimManifest {
  return {
    oimVersion: "1.0",
    kind: "Integration",
    metadata: {
      id: "acme",
      name: "Acme",
      version: "1.0.0",
      description: "Acme items",
      license: "Apache-2.0",
    },
    profiles: { core: "1.0" },
    operations: [
      {
        id: "list-items",
        name: "list_items",
        description: "List items",
        effect: "read",
        identityMode: "shared_only",
        source: {
          type: "openapi",
          file: "openapi.json",
          operationId: "listItems",
        },
        response,
        ...(pagination === undefined ? {} : { pagination }),
      },
    ],
    files: [{ path: "openapi.json", role: "openapi", sha256: "0".repeat(64) }],
  } as OimManifest;
}

function openApiDocument(binary = false) {
  return {
    openapi: "3.0.3",
    servers: [{ url: "https://api.acme.test/v1" }],
    paths: {
      "/items": {
        get: {
          operationId: "listItems",
          parameters: [{ name: "cursor", in: "query", schema: { type: "string" } }],
          responses: {
            "200": {
              content: {
                [binary ? "application/pdf" : "application/json"]: {
                  schema: binary ? { type: "string", format: "binary" } : { type: "object" },
                },
              },
            },
          },
        },
      },
    },
  };
}

function multipartManifest(): OimManifest {
  const multipart = manifest();
  multipart.profiles.core = "1.2";
  const operation = multipart.operations[0];
  if (operation === undefined || operation.source.type !== "http") {
    throw new Error("invalid fixture");
  }
  operation.source = {
    ...operation.source,
    contentType: "multipart",
    multipart: {
      parts: [
        { name: "first", kind: "file", pointer: "/uploads/0/fileId" },
        { name: "second", kind: "file", pointer: "/uploads/1/fileId" },
      ],
    },
  };
  operation.requestSchema = {
    type: "object",
    properties: {
      uploads: {
        type: "array",
        items: {
          type: "object",
          properties: { fileId: { type: "string" } },
          required: ["fileId"],
          additionalProperties: false,
        },
      },
    },
    required: ["uploads"],
    additionalProperties: false,
  };
  return multipart;
}

describe("OIM Chat dispatch safety", () => {
  it("pins the approved Connection when the default changes before resume", async () => {
    let rows = [
      connection("connection-1", true, "secret://00000000-0000-4000-8000-000000000001"),
      connection("connection-2", false, "secret://00000000-0000-4000-8000-000000000002"),
    ];
    const http = new RecordingHttp();
    const secretSource = secrets({
      "00000000-0000-4000-8000-000000000001": "first-token",
      "00000000-0000-4000-8000-000000000002": "second-token",
    });
    const effects = new MemoryEffectStore();
    const tooling = buildDeclarativeTools([integration()], {
      businessId: BUSINESS_ID,
      effects,
      secrets: secretSource.service,
      http,
      connections: connectionResolver(() => rows),
    });
    const registry = new InMemoryToolCatalog();
    for (const tool of tooling.tools) registry.register(tool);
    let pinnedIntent: ToolIntent | undefined;
    const approvals = {
      findIntent: vi.fn(async () => pinnedIntent),
      decide: vi.fn(async (input: { intent?: ToolIntent }) => {
        if (pinnedIntent === undefined) {
          pinnedIntent = input.intent;
          return { status: "pending" as const, approvalId: "approval-1" };
        }
        return { status: "approved" as const, approvalId: "approval-1" };
      }),
      consume: vi.fn(async () => true),
    };
    const dispatcher = new RegistryToolDispatcher({
      registry,
      artifacts: { read: async () => ({ content: {} }) } as never,
      preparation: tooling.preparation,
      approvals: approvals as unknown as ToolApprovalPort,
      authorityLayers: {
        resolvePrincipalLayer: async (name) => ({ name, grants: [] }),
      },
      gate: { authorize: () => ({ outcome: "awaiting_approval" }) },
    });

    await expect(
      dispatcher.dispatch(AUTHORITY, {
        callId: "call-1",
        name: "acme_send_message",
        arguments: { body: { text: "hello" } },
      })
    ).resolves.toEqual({ status: "awaiting_approval", approvalId: "approval-1" });
    expect(await effects.list(BUSINESS_ID)).toEqual([]);
    expect(http.sent).toEqual([]);
    expect(pinnedIntent?.connection?.connectionId).toBe("connection-1");

    rows = [
      connection("connection-1", false, "secret://00000000-0000-4000-8000-000000000001"),
      connection("connection-2", true, "secret://00000000-0000-4000-8000-000000000002"),
    ];
    await expect(
      dispatcher.dispatch(AUTHORITY, {
        callId: "call-1",
        name: "acme_send_message",
        arguments: { body: { text: "hello" } },
      })
    ).resolves.toMatchObject({ status: "succeeded" });

    expect(http.sent).toHaveLength(1);
    expect(http.sent[0]?.headers.Authorization).toBe("Bearer first-token");
    expect(JSON.stringify(await effects.list(BUSINESS_ID))).not.toContain("first-token");
  });

  it("denies the resolved destination before effect reservation or credential use", async () => {
    const http = new RecordingHttp();
    const secretSource = secrets({
      "00000000-0000-4000-8000-000000000001": "first-token",
    });
    const effects = new MemoryEffectStore();
    const tooling = buildDeclarativeTools([integration()], {
      businessId: BUSINESS_ID,
      effects,
      secrets: secretSource.service,
      http,
      connections: connectionResolver(() => [
        connection("connection-1", true, "secret://00000000-0000-4000-8000-000000000001"),
      ]),
    });
    const registry = new InMemoryToolCatalog();
    for (const tool of tooling.tools) registry.register(tool);
    const dispatcher = new RegistryToolDispatcher({
      registry,
      artifacts: { read: async () => ({ content: {} }) } as never,
      preparation: tooling.preparation,
      authorityLayers: {
        resolvePrincipalLayer: async (name) => ({ name, grants: [] }),
      },
      gate: {
        authorize: (input) => {
          expect(input.definition.effectiveDestination).toBe("https://api.acme.test");
          return { outcome: "denied", reason: "destination_denied" };
        },
      },
    });

    await expect(
      dispatcher.dispatch(AUTHORITY, {
        callId: "call-2",
        name: "acme_send_message",
        arguments: { body: { text: "hello" } },
      })
    ).resolves.toMatchObject({ status: "denied" });
    expect(await effects.list(BUSINESS_ID)).toEqual([]);
    expect(http.sent).toEqual([]);
    expect(secretSource.resolveCurrent).not.toHaveBeenCalled();
  });

  it("denies exact nested multipart File IDs before approval, lease, stream, or effect", async () => {
    const multipart = multipartManifest();
    const http = new RecordingHttp();
    const secretSource = secrets({
      "00000000-0000-4000-8000-000000000001": "first-token",
    });
    const effects = new MemoryEffectStore();
    const authorizeFiles = vi.fn(async () => {
      throw new Error("file denied");
    });
    const tooling = buildDeclarativeTools([integration(multipart)], {
      businessId: BUSINESS_ID,
      effects,
      secrets: secretSource.service,
      http,
      connections: connectionResolver(() => [
        connection("connection-1", true, "secret://00000000-0000-4000-8000-000000000001"),
      ]),
      authorizeFiles,
    });
    const registry = new InMemoryToolCatalog();
    for (const tool of tooling.tools) registry.register(tool);
    const dispatcher = new RegistryToolDispatcher({
      registry,
      artifacts: { read: async () => ({ content: {} }) } as never,
      preparation: tooling.preparation,
    });

    await expect(
      dispatcher.dispatch(AUTHORITY, {
        callId: "call-3",
        name: "acme_send_message",
        arguments: {
          body: {
            uploads: [{ fileId: "file-b" }, { fileId: "file-a" }],
          },
        },
      })
    ).resolves.toMatchObject({ status: "denied" });
    expect(authorizeFiles).toHaveBeenCalledWith(
      expect.objectContaining({ fileIds: ["file-a", "file-b"] })
    );
    expect(await effects.list(BUSINESS_ID)).toEqual([]);
    expect(http.sent).toEqual([]);
    expect(secretSource.revision).not.toHaveBeenCalled();
    expect(secretSource.resolveCurrent).not.toHaveBeenCalled();
  });

  it("denies a changed Connection configuration before effect or credential use", async () => {
    const configured = manifest();
    if (configured.auth === undefined) throw new Error("invalid fixture");
    configured.auth.configurationFields = [
      { id: "user_agent", label: "User-Agent", type: "string", required: true },
    ];
    const operation = configured.operations[0];
    if (operation === undefined || operation.source.type !== "http") {
      throw new Error("invalid fixture");
    }
    operation.source.parameters = [
      {
        name: "User-Agent",
        in: "header",
        required: true,
        schema: { type: "string", minLength: 1 },
        configurationField: "user_agent",
      } as never,
    ];
    let rows = [
      connection("connection-1", true, "secret://00000000-0000-4000-8000-000000000001", {
        user_agent: "approved-agent",
      }),
    ];
    const http = new RecordingHttp();
    const secretSource = secrets({
      "00000000-0000-4000-8000-000000000001": "first-token",
    });
    const effects = new MemoryEffectStore();
    const tooling = buildDeclarativeTools([integration(configured)], {
      businessId: BUSINESS_ID,
      effects,
      secrets: secretSource.service,
      http,
      connections: connectionResolver(() => rows),
    });
    const registry = new InMemoryToolCatalog();
    for (const tool of tooling.tools) registry.register(tool);
    let pinnedIntent: ToolIntent | undefined;
    const dispatcher = new RegistryToolDispatcher({
      registry,
      artifacts: { read: async () => ({ content: {} }) } as never,
      preparation: tooling.preparation,
      approvals: {
        findIntent: async () => pinnedIntent,
        decide: async (input) => {
          if (pinnedIntent === undefined) {
            pinnedIntent = input.intent;
            return { status: "pending" as const, approvalId: "approval-configuration" };
          }
          return { status: "approved" as const, approvalId: "approval-configuration" };
        },
        consume: async () => true,
      },
      authorityLayers: {
        resolvePrincipalLayer: async (name) => ({ name, grants: [] }),
      },
      gate: { authorize: () => ({ outcome: "awaiting_approval" }) },
    });
    const call = {
      callId: "call-configuration",
      name: "acme_send_message",
      arguments: { body: { text: "hello" } },
    };

    await expect(dispatcher.dispatch(AUTHORITY, call)).resolves.toMatchObject({
      status: "awaiting_approval",
    });
    rows = [
      connection("connection-1", true, "secret://00000000-0000-4000-8000-000000000001", {
        user_agent: "changed-agent",
      }),
    ];
    await expect(dispatcher.dispatch(AUTHORITY, call)).resolves.toMatchObject({
      status: "denied",
    });

    expect(await effects.list(BUSINESS_ID)).toEqual([]);
    expect(http.sent).toEqual([]);
    expect(secretSource.resolveCurrent).not.toHaveBeenCalled();
  });

  it("denies a rotated Connection Credential before effect or plaintext resolution", async () => {
    const secretKey = "00000000-0000-4000-8000-000000000001";
    const revisions: Record<string, string> = { [secretKey]: "1" };
    const secretSource = secrets({ [secretKey]: "first-token" }, revisions);
    const effects = new MemoryEffectStore();
    const http = new RecordingHttp();
    const tooling = buildDeclarativeTools([integration()], {
      businessId: BUSINESS_ID,
      effects,
      secrets: secretSource.service,
      http,
      connections: connectionResolver(() => [
        connection("connection-1", true, `secret://${secretKey}`),
      ]),
    });

    const registry = new InMemoryToolCatalog();
    for (const tool of tooling.tools) registry.register(tool);
    let pinnedIntent: ToolIntent | undefined;
    const dispatcher = new RegistryToolDispatcher({
      registry,
      artifacts: { read: async () => ({ content: {} }) } as never,
      preparation: tooling.preparation,
      approvals: {
        findIntent: async () => pinnedIntent,
        decide: async (input) => {
          if (pinnedIntent === undefined) {
            pinnedIntent = input.intent;
            return { status: "pending" as const, approvalId: "approval-credential" };
          }
          return { status: "approved" as const, approvalId: "approval-credential" };
        },
        consume: async () => true,
      },
      authorityLayers: {
        resolvePrincipalLayer: async (name) => ({ name, grants: [] }),
      },
      gate: { authorize: () => ({ outcome: "awaiting_approval" }) },
    });
    const call = {
      callId: "call-credential",
      name: "acme_send_message",
      arguments: { body: { text: "hello" } },
    };

    await expect(dispatcher.dispatch(AUTHORITY, call)).resolves.toMatchObject({
      status: "awaiting_approval",
    });
    revisions[secretKey] = "2";
    await expect(dispatcher.dispatch(AUTHORITY, call)).resolves.toMatchObject({
      status: "denied",
    });

    expect(await effects.list(BUSINESS_ID)).toEqual([]);
    expect(http.sent).toEqual([]);
    expect(secretSource.resolveCurrent).not.toHaveBeenCalled();
  });

  it("denies a Connection revoked after outer reauthorization but before Secret lease issue", async () => {
    const active = connection(
      "connection-1",
      true,
      "secret://00000000-0000-4000-8000-000000000001"
    );
    const revoked = { ...active, status: "revoked" as const, isDefault: false };
    let lookups = 0;
    const http = new RecordingHttp();
    const secretSource = secrets({
      "00000000-0000-4000-8000-000000000001": "still-present-after-revoke",
    });
    const tooling = buildDeclarativeTools([integration()], {
      businessId: BUSINESS_ID,
      effects: new MemoryEffectStore(),
      secrets: secretSource.service,
      http,
      connections: connectionResolverWithLookup(
        () => [active],
        async () => (++lookups <= 2 ? active : revoked)
      ),
    });
    const registry = new InMemoryToolCatalog();
    for (const tool of tooling.tools) registry.register(tool);
    const dispatcher = new RegistryToolDispatcher({
      registry,
      artifacts: { read: async () => ({ content: {} }) } as never,
      preparation: tooling.preparation,
    });

    await expect(
      dispatcher.dispatch(AUTHORITY, {
        callId: "call-revoked-at-lease",
        name: "acme_send_message",
        arguments: { body: { text: "hello" } },
      })
    ).resolves.toMatchObject({ status: "failed" });

    expect(lookups).toBe(3);
    expect(http.sent).toEqual([]);
    expect(secretSource.resolveCurrent).not.toHaveBeenCalled();
  });

  it("replays valid confirmation but queues missing output before mutable checks", async () => {
    const database: PGlite = await makeMigratedPglite();
    onTestFinished(async () => await database.close());
    const secretKey = "00000000-0000-4000-8000-000000000001";
    const revisions: Record<string, string> = { [secretKey]: "1" };
    const secretSource = secrets({ [secretKey]: "first-token" }, revisions);
    let rows = [connection("connection-1", true, `secret://${secretKey}`)];
    let filesAllowed = true;
    const authorizeFiles = vi.fn(async () => {
      if (!filesAllowed) throw new Error("File grant revoked");
    });
    const assertAuthorized = vi.fn(async () => {
      if (!filesAllowed) throw new Error("File grant revoked");
    });
    const content = vi.fn(async () => ({
      file: {
        id: "file-1",
        filename: "input.txt",
        mediaType: "text/plain",
        sizeBytes: 5,
      },
      body: (async function* () {
        yield new TextEncoder().encode("hello");
      })(),
    }));
    const storeOutput = vi.fn(async () => {
      throw new Error("File output must not be stored");
    });
    const http = new RecordingHttp();
    const effects = new PgEffectStore(transactionPort(database as unknown as Queryable));
    const tooling = buildDeclarativeTools([integration(multipartManifest())], {
      businessId: BUSINESS_ID,
      effects,
      secrets: secretSource.service,
      http,
      connections: connectionResolver(() => rows),
      authorizeFiles,
      fileReadAuthorization: { assertAuthorized },
      files: {
        content,
        store: storeOutput,
      },
    });
    let agentPrincipalId = "agent-1";
    const authorize = vi.fn(() => ({ outcome: "awaiting_approval" as const }));
    const queryable = database as unknown as Queryable;
    const transactions = transactionPort(queryable);
    const approvalRepo = new ApprovalsRepo(queryable);
    let approvals: ToolApprovalPort = new ToolApprovalService({ transactions });
    const host = (current: typeof tooling) => {
      const registry = new InMemoryToolCatalog();
      for (const tool of current.tools) registry.register(tool);
      return new RegistryToolDispatcher({
        registry,
        artifacts: {
          read: async () => ({ content: { agentId: "configured-agent" } }),
        } as never,
        agents: {
          resolve: () => ({ name: "configured-agent", principalId: agentPrincipalId }),
        },
        preparation: current.preparation,
        approvals,
        authorityLayers: {
          resolvePrincipalLayer: async (name) => ({ name, grants: [] }),
        },
        gate: { authorize },
      });
    };
    let dispatcher = host(tooling);
    const call = {
      callId: "call-confirmed-replay",
      stateId: "agent-state-1",
      name: "acme_send_message",
      arguments: { body: { uploads: [{ fileId: "file-1" }, { fileId: "file-1" }] } },
    };

    const pending = await dispatcher.dispatch(AUTHORITY, call);
    expect(pending).toMatchObject({
      status: "awaiting_approval",
    });
    if (pending.status !== "awaiting_approval") throw new Error(JSON.stringify(pending));
    await approvalRepo.settlePending(pending.approvalId, "approved", "user:approver");
    const confirmed = await dispatcher.dispatch(AUTHORITY, call);
    expect(confirmed).toMatchObject({ status: "succeeded", output: { id: "message-1" } });
    await expect(
      approvals.findIntent?.({
        runId: AUTHORITY.runId,
        toolCallId: call.callId,
        toolName: call.name,
        args: call.arguments,
      })
    ).resolves.toMatchObject({ agentPrincipalId: "agent-1" });
    expect(await effects.list(BUSINESS_ID)).toEqual([
      expect.objectContaining({ state: "confirmed", output: { id: "message-1" } }),
    ]);
    const beforeReplay = {
      http: http.sent.length,
      resolve: secretSource.resolveCurrent.mock.calls.length,
      authorize: authorizeFiles.mock.calls.length,
      assert: assertAuthorized.mock.calls.length,
      content: content.mock.calls.length,
      store: storeOutput.mock.calls.length,
      policy: authorize.mock.calls.length,
    };

    rows = [
      {
        ...rows[0],
        status: "revoked",
        isDefault: false,
        configuration: { changed: true },
      } as PersistedConnection,
    ];
    revisions[secretKey] = "2";
    filesAllowed = false;
    approvals = new ToolApprovalService({ transactions });
    dispatcher = host(
      buildDeclarativeTools([integration(multipartManifest())], {
        businessId: BUSINESS_ID,
        effects: new PgEffectStore(transactionPort(database as unknown as Queryable)),
        secrets: secretSource.service,
        http,
        connections: connectionResolver(() => rows),
        authorizeFiles,
        fileReadAuthorization: { assertAuthorized },
        files: {
          content,
          store: storeOutput,
        },
      })
    );

    await expect(dispatcher.dispatch(AUTHORITY, call)).resolves.toEqual({
      status: "succeeded",
      replayed: true,
      output: { id: "message-1" },
    });
    expect({
      http: http.sent.length,
      resolve: secretSource.resolveCurrent.mock.calls.length,
      authorize: authorizeFiles.mock.calls.length,
      assert: assertAuthorized.mock.calls.length,
      content: content.mock.calls.length,
      store: storeOutput.mock.calls.length,
      policy: authorize.mock.calls.length,
    }).toEqual(beforeReplay);

    await expect(
      dispatcher.dispatch(AUTHORITY, {
        ...call,
        arguments: { body: { uploads: [{ fileId: "file-2" }, { fileId: "file-1" }] } },
      })
    ).resolves.toMatchObject({ status: "denied" });
    await expect(
      dispatcher.dispatch({ ...AUTHORITY, subject: { kind: "user" as const, id: "user-2" } }, call)
    ).resolves.toMatchObject({ status: "denied" });
    agentPrincipalId = "agent-2";
    await expect(dispatcher.dispatch(AUTHORITY, call)).resolves.toMatchObject({
      status: "denied",
    });
    await expect(
      dispatcher.dispatch(AUTHORITY, { ...call, callId: "different-call" })
    ).resolves.toMatchObject({ status: "denied" });
    await expect(
      dispatcher.dispatch({ ...AUTHORITY, runId: "different-run" }, call)
    ).resolves.toMatchObject({ status: "denied" });
    expect(http.sent).toHaveLength(1);
    const [persisted] = await effects.list(BUSINESS_ID);
    if (persisted === undefined) throw new Error("confirmed effect was not persisted");
    expect(persisted.state).toBe("confirmed");

    await database.query(
      `UPDATE effect_records
       SET output = NULL, output_stored = false
       WHERE business_id = $1 AND effect_id = $2`,
      [BUSINESS_ID, persisted.effectId]
    );
    const beforeReconciliation = {
      http: http.sent.length,
      resolve: secretSource.resolveCurrent.mock.calls.length,
      authorize: authorizeFiles.mock.calls.length,
      assert: assertAuthorized.mock.calls.length,
      content: content.mock.calls.length,
      store: storeOutput.mock.calls.length,
      policy: authorize.mock.calls.length,
    };
    const reconciliationResults = await Promise.all([
      dispatcher.dispatch(AUTHORITY, call),
      dispatcher.dispatch(AUTHORITY, call),
    ]);
    expect(reconciliationResults).toEqual([
      expect.objectContaining({ status: "denied" }),
      expect.objectContaining({ status: "denied" }),
    ]);
    await expect(dispatcher.dispatch(AUTHORITY, call)).resolves.toMatchObject({
      status: "denied",
    });
    expect(await effects.get(BUSINESS_ID, persisted.effectId)).toMatchObject({
      state: "reconciliation_required",
      outputStored: false,
    });
    expect({
      http: http.sent.length,
      resolve: secretSource.resolveCurrent.mock.calls.length,
      authorize: authorizeFiles.mock.calls.length,
      assert: assertAuthorized.mock.calls.length,
      content: content.mock.calls.length,
      store: storeOutput.mock.calls.length,
      policy: authorize.mock.calls.length,
    }).toEqual(beforeReconciliation);
  });

  it("reauthorizes multipart Files immediately before reading them", async () => {
    const http = new RecordingHttp();
    const secretSource = secrets({
      "00000000-0000-4000-8000-000000000001": "first-token",
    });
    const effects = new MemoryEffectStore();
    const authorizeFiles = vi.fn(async () => undefined);
    const assertAuthorized = vi.fn(async () => {
      throw new Error("file grant revoked");
    });
    const content = vi.fn(async () => {
      throw new Error("File content must not be read");
    });
    const tooling = buildDeclarativeTools([integration(multipartManifest())], {
      businessId: BUSINESS_ID,
      effects,
      secrets: secretSource.service,
      http,
      connections: connectionResolver(() => [
        connection("connection-1", true, "secret://00000000-0000-4000-8000-000000000001"),
      ]),
      authorizeFiles,
      fileReadAuthorization: { assertAuthorized },
      files: {
        content,
        store: async () => {
          throw new Error("File output must not be stored");
        },
      },
    });
    const registry = new InMemoryToolCatalog();
    for (const tool of tooling.tools) registry.register(tool);
    const dispatcher = new RegistryToolDispatcher({
      registry,
      artifacts: { read: async () => ({ content: {} }) } as never,
      preparation: tooling.preparation,
    });

    await expect(
      dispatcher.dispatch(AUTHORITY, {
        callId: "call-file-read",
        stateId: "agent-state-1",
        name: "acme_send_message",
        arguments: {
          body: {
            uploads: [{ fileId: "file-b" }, { fileId: "file-a" }],
          },
        },
      })
    ).resolves.toMatchObject({ status: "failed" });

    expect(authorizeFiles).toHaveBeenCalledTimes(2);
    expect(authorizeFiles).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ stateId: "agent-state-1" })
    );
    expect(authorizeFiles).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ stateId: "agent-state-1" })
    );
    expect(assertAuthorized).toHaveBeenCalledWith(
      expect.objectContaining({ fileIds: ["file-a", "file-b"] })
    );
    expect(content).not.toHaveBeenCalled();
    expect(http.sent).toEqual([]);
  });

  it("uses OIM OpenAPI pagination, projection, and redaction through the Chat host", async () => {
    const oimManifest = openApiManifest(
      {
        schema: {
          type: "object",
          properties: {
            values: { type: "array", items: { type: "object" } },
            next: { type: "string" },
            access_token: { type: "string" },
          },
          additionalProperties: true,
        },
        projection: ["/values"],
        maxBytes: 16_384,
      },
      { type: "cursor", requestParameter: "cursor", responsePath: "/next" }
    );
    const sent: EgressHttpRequest[] = [];
    const http: EgressHttpPort = {
      async send(request) {
        sent.push(request);
        return sent.length === 1
          ? {
              status: 200,
              headers: {},
              body: {
                values: [{ id: "item-1" }],
                next: "provider-cursor-2",
                access_token: "must-not-leak",
              },
            }
          : {
              status: 200,
              headers: {},
              body: { values: [{ id: "item-2" }], access_token: "must-not-leak" },
            };
      },
    };
    const tooling = buildDeclarativeTools([openApiIntegration(oimManifest, openApiDocument())], {
      businessId: BUSINESS_ID,
      effects: new MemoryEffectStore(),
      secrets: secrets({}).service,
      http,
      connections: connectionResolver(() => []),
      paginationRuntime: { codec: new SecureTestContinuationCodec(), now: () => 1_000 },
    });
    expect(tooling.problems).toEqual([]);
    const registry = new InMemoryToolCatalog();
    for (const tool of tooling.tools) registry.register(tool);
    const dispatcher = new RegistryToolDispatcher({
      registry,
      artifacts: { read: async () => ({ content: {} }) } as never,
      preparation: tooling.preparation,
    });

    const first = await dispatcher.dispatch(AUTHORITY, {
      callId: "call-openapi-page-1",
      name: "acme_list_items",
      arguments: {},
    });
    if (first.status !== "succeeded") throw new Error(JSON.stringify(first));
    expect(first).toMatchObject({
      status: "succeeded",
      output: { values: [{ id: "item-1" }], next_page_token: expect.any(String) },
    });
    expect(JSON.stringify(first)).not.toContain("provider-cursor-2");
    expect(JSON.stringify(first)).not.toContain("must-not-leak");
    const token = (first.output as Record<string, unknown>).next_page_token;
    if (typeof token !== "string") throw new Error("expected continuation token");

    await expect(
      dispatcher.dispatch(AUTHORITY, {
        callId: "call-openapi-page-2",
        name: "acme_list_items",
        arguments: { page_token: token },
      })
    ).resolves.toMatchObject({
      status: "succeeded",
      output: { values: [{ id: "item-2" }] },
    });
    expect(sent[1]?.url).toContain("cursor=provider-cursor-2");
  });

  it.each(["http", "openapi"] as const)(
    "binds authenticated File ownership for download-only OIM %s Tools",
    async (sourceType) => {
      const response = { mode: "binary" as const, maxBytes: 8 };
      const oimManifest = openApiManifest(response);
      const operation = oimManifest.operations[0];
      if (operation === undefined) throw new Error("invalid fixture");
      if (sourceType === "http") {
        operation.source = {
          type: "http",
          method: "GET",
          baseUrl: "https://api.acme.test",
          path: "/items",
        };
        oimManifest.files = [];
      }
      const store = vi.fn(async (input) => ({
        id: `file-${sourceType}`,
        filename: input.filename,
        mediaType: input.claimedMediaType,
        sizeBytes: input.declaredBytes,
      }));
      const http: EgressHttpPort = {
        async send(request) {
          if (request.binaryResponse === undefined) {
            throw new Error("OIM binary response sink missing");
          }
          const headers = {
            "content-type": "application/pdf",
            "content-disposition": 'attachment; filename="items.pdf"',
          };
          const body = await request.binaryResponse({
            headers,
            declaredBytes: 4,
            body: (async function* () {
              yield new Uint8Array([1, 2, 3, 4]);
            })(),
          });
          return { status: 200, headers, body };
        },
      };
      const tooling = buildDeclarativeTools(
        [
          sourceType === "openapi"
            ? openApiIntegration(oimManifest, openApiDocument(true))
            : integration(oimManifest),
        ],
        {
          businessId: BUSINESS_ID,
          effects: new MemoryEffectStore(),
          secrets: secrets({}).service,
          http,
          connections: connectionResolver(() => []),
          files: {
            content: async () => {
              throw new Error("download-only Tool must not read a File");
            },
            store,
          },
        }
      );
      expect(tooling.problems).toEqual([]);
      const registry = new InMemoryToolCatalog();
      for (const tool of tooling.tools) registry.register(tool);
      let pinnedIntent: ToolIntent | undefined;
      const dispatcher = new RegistryToolDispatcher({
        registry,
        artifacts: { read: async () => ({ content: {} }) } as never,
        preparation: tooling.preparation,
        approvals: {
          findIntent: async () => pinnedIntent,
          decide: async (input) => {
            if (pinnedIntent === undefined) {
              pinnedIntent = input.intent;
              return { status: "pending" as const, approvalId: `approval-${sourceType}` };
            }
            return { status: "approved" as const, approvalId: `approval-${sourceType}` };
          },
          consume: async () => true,
        },
        authorityLayers: {
          resolvePrincipalLayer: async (name) => ({ name, grants: [] }),
        },
        gate: { authorize: () => ({ outcome: "awaiting_approval" }) },
      });
      const call = {
        callId: `call-binary-${sourceType}`,
        name: "acme_list_items",
        arguments: {},
      };

      await expect(dispatcher.dispatch(AUTHORITY, call)).resolves.toMatchObject({
        status: "awaiting_approval",
      });
      expect(pinnedIntent?.filePrincipalId).toBe("user-1");
      expect(pinnedIntent?.fileIds).toBeUndefined();
      await expect(dispatcher.dispatch(AUTHORITY, call)).resolves.toMatchObject({
        status: "succeeded",
        output: { fileId: `file-${sourceType}` },
      });
      expect(store).toHaveBeenCalledWith(expect.objectContaining({ ownerPrincipalId: "user-1" }));
    }
  );
});
