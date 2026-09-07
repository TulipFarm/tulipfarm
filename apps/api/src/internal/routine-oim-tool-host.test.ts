import { createHash } from "node:crypto";
import {
  compileOimGraphqlOperations,
  compileOimHttpOperations,
  compileOimOpenApiOperations,
  type EgressHttpRequest,
} from "@tulipfarm/integrations";
import { canonicalHash, type OimManifest, oimToolId } from "@tulipfarm/schema";
import type { RuntimeBundle } from "@tulipfarm/soul";
import type { EffectRecord } from "@tulipfarm/tool-broker";
import { describe, expect, it, vi } from "vitest";
import {
  type ConnectionOriginApprovalRepository,
  connectionOriginApprovalForTrustedConfirmation,
} from "../integrations/connection-origin-policy";
import {
  InternalRoutineOimToolHost,
  LiveRoutineOimAuthorizer,
  type RoutineOimRegistration,
} from "./routine-oim-tool-host";

const BUSINESS_ID = "business-1";
const RUN_ID = "11111111-1111-4111-8111-111111111111";
const EFFECT_ID = "22222222-2222-4222-8222-222222222222";
const SECRET_REF = "secret://33333333-3333-4333-8333-333333333333";
const HOOK_SOURCE = "export const hook = (value) => value;";
const HOOK_SHA256 = createHash("sha256").update(HOOK_SOURCE).digest("hex");

function manifest(source: "http" | "openapi" | "graphql"): OimManifest {
  const operationSource =
    source === "http"
      ? {
          type: "http",
          method: "GET",
          baseUrl: "https://{site}",
          path: "/forecast",
          parameters: [{ name: "city", in: "query", required: true, schema: { type: "string" } }],
        }
      : source === "openapi"
        ? {
            type: "openapi",
            file: "weather.openapi.yml",
            operationId: "forecast",
            baseUrl: "https://{site}",
          }
        : {
            type: "graphql",
            url: "https://graphql.weather.test",
            operation: "Forecast",
            documentFile: "forecast.graphql",
          };
  return {
    oimVersion: "1.0",
    kind: "Integration",
    profiles: { core: "1.2", auth: "1.0" },
    metadata: {
      id: `weather-${source}`,
      version: "1.0.0",
      name: `Weather ${source}`,
      description: "Weather",
      license: "MIT",
    },
    files:
      source === "openapi"
        ? [
            {
              path: "weather.openapi.yml",
              role: "openapi",
              sha256: "a".repeat(64),
            },
          ]
        : source === "graphql"
          ? [
              {
                path: "forecast.graphql",
                role: "graphql",
                sha256: "b".repeat(64),
              },
            ]
          : [],
    auth: {
      credentialSlots: [
        { id: "token", label: "Weather API token", kind: "api_key", required: true },
      ],
      configuration: [
        {
          name: "site",
          required: true,
          agentVisible: true,
          schema: { type: "string" },
        },
      ],
      allowedOriginHosts: ["*.weather.test"],
      steps: [],
    },
    operations: [
      {
        id: "forecast",
        name: "forecast",
        description: "Read a forecast.",
        effect: "read",
        identityMode: "shared_only",
        credentialSlot: "token",
        credentialInjection: { in: "header", name: "Authorization", format: "Bearer {credential}" },
        source: operationSource,
        ...(source === "graphql"
          ? {
              requestSchema: {
                type: "object",
                additionalProperties: false,
                properties: { city: { type: "string" } },
                required: ["city"],
              },
            }
          : {}),
        response: {
          schema:
            source === "graphql"
              ? {
                  type: "object",
                  properties: {
                    data: {
                      type: "object",
                      properties: {
                        forecast: {
                          type: "object",
                          properties: { temperature: { type: "number" } },
                          required: ["temperature"],
                          additionalProperties: false,
                        },
                      },
                      required: ["forecast"],
                      additionalProperties: false,
                    },
                  },
                  required: ["data"],
                  additionalProperties: false,
                }
              : {
                  type: "object",
                  properties: { temperature: { type: "number" } },
                  required: ["temperature"],
                  additionalProperties: false,
                },
          maxBytes: 16_384,
        },
      },
    ],
  } as OimManifest;
}

function registration(source: "http" | "openapi" | "graphql"): RoutineOimRegistration {
  return {
    manifest: manifest(source),
    ...(source === "openapi"
      ? {
          openApiDocuments: {
            "weather.openapi.yml": {
              openapi: "3.0.3",
              servers: [{ url: "https://fallback.weather.test" }],
              paths: {
                "/forecast": {
                  get: {
                    operationId: "forecast",
                    parameters: [
                      {
                        name: "city",
                        in: "query",
                        required: true,
                        schema: { type: "string" },
                      },
                    ],
                    responses: {
                      "200": {
                        description: "ok",
                        content: {
                          "application/json": {
                            schema: {
                              type: "object",
                              properties: { temperature: { type: "number" } },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        }
      : {}),
    ...(source === "graphql"
      ? {
          documents: {
            "forecast.graphql":
              "query Forecast($city: String!) { forecast(city: $city) { temperature } }",
          },
        }
      : {}),
  };
}

function hookedRegistration(): RoutineOimRegistration {
  const base = registration("http");
  return {
    ...base,
    manifest: {
      ...base.manifest,
      profiles: { ...base.manifest.profiles, hooks: "1.0" },
      files: [
        ...(base.manifest.files ?? []),
        { path: "hooks.mjs", role: "hook", sha256: HOOK_SHA256 },
      ],
      hooks: [
        { kind: "input_validate", file: "hooks.mjs", export: "validateInput" },
        { kind: "request_shape", file: "hooks.mjs", export: "shapeRequest" },
        { kind: "response_normalize", file: "hooks.mjs", export: "normalizeResponse" },
      ],
    },
    packageFiles: { "hooks.mjs": HOOK_SOURCE },
  };
}

function approvedOriginRegistration(source: "http" | "openapi" = "http"): RoutineOimRegistration {
  const base = registration(source);
  return {
    ...base,
    manifest: {
      ...base.manifest,
      extensions: {
        ...base.manifest.extensions,
        "x-tulipfarm-origin-policy": {
          mode: "approved_public_exact",
          fields: ["site"],
        },
      },
      auth: {
        ...base.manifest.auth,
        configurationFields: [{ id: "site", label: "Site", type: "url" }],
        allowedOriginHosts: ["api.weather.test"],
      },
    } as OimManifest,
  };
}

function compiledContract(snapshot: RoutineOimRegistration) {
  const operation = snapshot.manifest.operations[0];
  if (operation === undefined) throw new Error("missing operation");
  if (operation.source.type === "http") {
    return compileOimHttpOperations(snapshot.manifest, {}, { deferConfiguration: true })[0]
      ?.contract;
  }
  if (operation.source.type === "openapi") {
    return compileOimOpenApiOperations(
      snapshot.manifest,
      new Map(Object.entries(snapshot.openApiDocuments ?? {})),
      {},
      { deferConfiguration: true }
    )[0]?.contract;
  }
  return compileOimGraphqlOperations(
    snapshot.manifest,
    new Map(Object.entries(snapshot.documents ?? {}))
  )[0]?.contract;
}

function bundle(snapshot: RoutineOimRegistration): RuntimeBundle {
  const contract = compiledContract(snapshot);
  if (contract === undefined) throw new Error("missing contract");
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
    slug: "weather-routine",
    authoredVersion: 1,
    hash: "e".repeat(64),
    document: {
      apiVersion: "tulipfarm.ai/v1",
      kind: "Routine",
      metadata: {
        id: "routine-1",
        slug: "weather-routine",
        schemaVersion: 1,
        authoredVersion: 1,
        lifecycle: "published",
      },
      spec: {
        owner: "operations",
        start: "Forecast",
        states: [
          {
            type: "tool",
            name: "Forecast",
            toolRef: { name: contract.spec.toolId, version: contract.spec.toolVersion },
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
    businessId: BUSINESS_ID,
    changesetId: "changeset-1",
    commitSha: "d".repeat(40),
    definitions,
    assets: [],
    get: () => undefined,
    getById: (id) => definitions.find((definition) => definition.id === id),
    asset: () => undefined,
  } as RuntimeBundle;
}

function effect(
  snapshot: RoutineOimRegistration,
  resolved: Awaited<ReturnType<InternalRoutineOimToolHost["prepare"]>>
): EffectRecord {
  if (resolved.kind !== "ready" || resolved.connection === undefined) {
    throw new Error("expected prepared Connection");
  }
  const toolId = oimToolId(snapshot.manifest, "forecast");
  const now = new Date(0).toISOString();
  return {
    effectId: EFFECT_ID,
    businessId: BUSINESS_ID,
    runId: RUN_ID,
    stateId: "Forecast",
    logicalEffectOrdinal: 0,
    idempotencyKey: `routine:${RUN_ID}:Forecast`,
    intentDigest: "a".repeat(64),
    intent: {
      intentId: EFFECT_ID,
      businessId: BUSINESS_ID,
      runId: RUN_ID,
      stateId: "Forecast",
      toolId,
      toolVersion: snapshot.manifest.metadata.version,
      action: `integration.${snapshot.manifest.metadata.id}.forecast`,
      targetRefs: [],
      arguments: { city: "Pune" },
      destination: resolved.destination,
      credentialRef: resolved.credentialRef,
      connection: resolved.connection,
      idempotencyKey: `routine:${RUN_ID}:Forecast`,
    },
    guardrailRevision: "c".repeat(64),
    state: "dispatched",
    createdAt: now,
    updatedAt: now,
  };
}

function harness(
  source: "http" | "openapi" | "graphql",
  useLiveAuthorizer = false,
  options: {
    readonly registration?: RoutineOimRegistration;
    readonly runPureHook?: (input: {
      readonly exportName: string;
      readonly input: unknown;
    }) => unknown;
    readonly responseBody?: unknown;
    readonly events?: string[];
    readonly originApproval?: "valid" | "missing" | "valid_then_missing";
    readonly connectionConfiguration?: { readonly site: string };
  } = {}
) {
  const snapshot = options.registration ?? registration(source);
  const runtimeBundle = bundle(snapshot);
  let stored: EffectRecord | undefined;
  let authorityAllowed = true;
  let connectionConfiguration = options.connectionConfiguration ?? { site: "east.weather.test" };
  const requests: EgressHttpRequest[] = [];
  const secretKeys: string[] = [];
  const events = options.events ?? [];
  const selectedConnection = {
    businessId: BUSINESS_ID,
    id: "connection-east",
    integration: {
      id: snapshot.manifest.metadata.id,
      majorVersion: 1,
    },
    label: "East account",
    owner: { scope: "organization" as const },
    status: "active" as const,
    isDefault: false,
    configuration: connectionConfiguration,
    agentVisibleConfiguration: ["site"],
    secretBindings: { token: SECRET_REF },
    health: { status: "healthy" as const, checkedAt: null },
    expiresAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  const currentConnection = () => ({
    ...selectedConnection,
    configuration: connectionConfiguration,
  });
  const approval =
    options.originApproval === undefined
      ? undefined
      : connectionOriginApprovalForTrustedConfirmation({
          manifest: snapshot.manifest,
          connection: currentConnection(),
          configurationField: "site",
          approvedBy: "user-1",
          approvedAt: new Date(0).toISOString(),
        });
  const originApprovalGet = vi.fn(async () =>
    options.originApproval === "missing" ? null : (approval ?? null)
  );
  if (options.originApproval === "valid_then_missing") {
    originApprovalGet.mockResolvedValueOnce(approval ?? null).mockResolvedValueOnce(null);
  }
  const resolve = vi.fn(async (input: { connectionId?: string }) => {
    if (input.connectionId !== "connection-east") {
      return { kind: "connection_denied", reason: "not_found" } as const;
    }
    return {
      kind: "ready",
      connection: currentConnection(),
      credentialRef: SECRET_REF,
      binding: {
        connectionId: "connection-east",
        integrationId: snapshot.manifest.metadata.id,
        credentialSlot: "token",
        principalKind: "user",
        principalId: "user-1",
      },
    } as const;
  });
  const liveAuthorizer = new LiveRoutineOimAuthorizer({
    resolvePrincipalLayer: async () => ({
      name: "caller",
      grants: authorityAllowed
        ? [{ action: "*", resourceType: "*", effect: "allow" as const }]
        : [],
    }),
  });
  const host = new InternalRoutineOimToolHost({
    businessId: BUSINESS_ID,
    runs: {
      authority: async () => ({
        businessId: BUSINESS_ID,
        runId: RUN_ID,
        subject: { kind: "user", id: "user-1" },
        source: "routine",
        bundleDigest: runtimeBundle.digest,
        routineId: "routine-1",
      }),
    },
    bundles: { load: async () => runtimeBundle },
    registrations: { find: async () => snapshot },
    connections: {
      resolve,
      reauthorizeConnection: async () => (authorityAllowed ? currentConnection() : null),
      reauthorize: async () => authorityAllowed,
    } as never,
    effects: {
      get: async () => stored,
      listAttempts: async () =>
        stored === undefined
          ? []
          : [
              {
                businessId: BUSINESS_ID,
                effectId: EFFECT_ID,
                attempt: 1,
                state: "dispatched",
                startedAt: new Date(0).toISOString(),
              },
            ],
    },
    secrets: async () =>
      ({
        resolveCurrent: async (key: string) => {
          events.push("secret");
          secretKeys.push(key);
          return { value: "east-token", version: "v1" };
        },
        revision: async (key: string) => {
          events.push("secret");
          secretKeys.push(key);
          return "v1";
        },
      }) as never,
    http: {
      send: async (request) => {
        events.push("provider");
        requests.push(request);
        return {
          status: 200,
          headers: {},
          body:
            options.responseBody ??
            (source === "graphql"
              ? { data: { forecast: { temperature: 24 } } }
              : { temperature: 24 }),
        };
      },
    },
    authorize: useLiveAuthorizer ? liveAuthorizer : { authorize: async () => authorityAllowed },
    ...(options.originApproval === undefined
      ? {}
      : {
          originApprovals: {
            get: originApprovalGet,
            put: vi.fn(async () => {}),
            delete: vi.fn(async () => {}),
          } satisfies ConnectionOriginApprovalRepository,
        }),
    ...(options.runPureHook === undefined
      ? {}
      : {
          hooks: {
            releaseTrust: {
              authorizeToolCompilation: async () => ({}) as never,
            },
            issueHookExecutionGrant: (
              _authorization: unknown,
              _package: unknown,
              kind: string,
              exportName: string
            ) =>
              ({
                source: HOOK_SOURCE,
                sourceSha256: HOOK_SHA256,
                exportName,
                integrationId: snapshot.manifest.metadata.id,
                version: snapshot.manifest.metadata.version,
                packageDigest: "hook-package",
                hookKind: kind,
              }) as never,
            assertHookExecutionGrant: () => {},
            executor: {
              runPureHook: async (input: {
                readonly exportName: string;
                readonly input: unknown;
              }) => options.runPureHook?.(input),
            },
          },
        }),
  });
  return {
    host,
    resolve,
    requests,
    secretKeys,
    events,
    originApprovalGet,
    setEffect(value: EffectRecord) {
      stored = value;
    },
    revoke() {
      authorityAllowed = false;
    },
    setConnectionConfiguration(configuration: { site: string }) {
      connectionConfiguration = configuration;
    },
  };
}

describe.each(["http", "openapi", "graphql"] as const)(
  "InternalRoutineOimToolHost %s source",
  (source) => {
    it("invokes the provider with the exact selected account", async () => {
      const test = harness(source);
      const snapshot = registration(source);
      const prepared = await test.host.prepare(RUN_ID, {
        stateKey: "Forecast",
        connectionId: "connection-east",
      });
      const record = effect(snapshot, prepared);
      test.setEffect(record);

      const result = await test.host.dispatch(RUN_ID, EFFECT_ID, { attempt: 1 });
      expect(test.requests).toHaveLength(1);
      expect(test.secretKeys).toEqual([
        SECRET_REF.slice("secret://".length),
        SECRET_REF.slice("secret://".length),
      ]);
      expect(result).toEqual({
        kind: "succeeded",
        output:
          source === "graphql" ? { data: { forecast: { temperature: 24 } } } : { temperature: 24 },
      });
      expect(test.resolve).toHaveBeenCalledWith(
        expect.objectContaining({
          connectionId: "connection-east",
          requireExplicitConnection: true,
        })
      );
      if (source !== "graphql") {
        expect(test.requests[0]?.url).toContain("east.weather.test");
      }
    });
  }
);

describe("InternalRoutineOimToolHost hooks", () => {
  it("validates and shapes before leasing, then normalizes redacted provider output", async () => {
    const snapshot = hookedRegistration();
    const events: string[] = [];
    const hookCalls: string[] = [];
    const test = harness("http", false, {
      registration: snapshot,
      responseBody: { temperature: 24, access_token: "provider-secret" },
      events,
      runPureHook: ({ exportName, input }) => {
        events.push(`hook:${exportName}`);
        hookCalls.push(exportName);
        if (exportName === "validateInput") return { valid: true };
        if (exportName === "shapeRequest") {
          const value = input as { arguments: Record<string, unknown> };
          return { ...value.arguments, city: "Mumbai" };
        }
        const value = input as { payload: Record<string, unknown> };
        expect(value.payload.access_token).toBe("[redacted]");
        return { temperature: 25 };
      },
    });
    const prepared = await test.host.prepare(RUN_ID, {
      stateKey: "Forecast",
      connectionId: "connection-east",
    });
    const record = effect(snapshot, prepared);
    test.setEffect(record);

    await expect(test.host.dispatch(RUN_ID, EFFECT_ID, { attempt: 1 })).resolves.toEqual({
      kind: "succeeded",
      output: { temperature: 25 },
    });
    expect(record.intent.arguments).toEqual({ city: "Pune" });
    expect(test.requests[0]?.url).toContain("city=Mumbai");
    expect(hookCalls).toEqual(["validateInput", "shapeRequest", "normalizeResponse"]);
    expect(events).toEqual([
      "hook:validateInput",
      "hook:shapeRequest",
      "secret",
      "secret",
      "provider",
      "hook:normalizeResponse",
    ]);
  });

  it("rejects invalid Hook input before leasing Credentials", async () => {
    const snapshot = hookedRegistration();
    const test = harness("http", false, {
      registration: snapshot,
      runPureHook: ({ exportName }) =>
        exportName === "validateInput" ? { valid: false, message: "city is blocked" } : {},
    });
    const prepared = await test.host.prepare(RUN_ID, {
      stateKey: "Forecast",
      connectionId: "connection-east",
    });
    test.setEffect(effect(snapshot, prepared));

    await expect(test.host.dispatch(RUN_ID, EFFECT_ID, { attempt: 1 })).resolves.toEqual({
      kind: "failed",
      error: {
        phase: "before_dispatch",
        code: "input_validation_failed",
        retryable: false,
      },
    });
    expect(test.secretKeys).toHaveLength(0);
    expect(test.requests).toHaveLength(0);
  });

  it("validates normalized output before returning it", async () => {
    const snapshot = hookedRegistration();
    const test = harness("http", false, {
      registration: snapshot,
      runPureHook: ({ exportName, input }) => {
        if (exportName === "validateInput") return { valid: true };
        if (exportName === "shapeRequest") {
          return (input as { arguments: unknown }).arguments;
        }
        return { unexpected: true };
      },
    });
    const prepared = await test.host.prepare(RUN_ID, {
      stateKey: "Forecast",
      connectionId: "connection-east",
    });
    test.setEffect(effect(snapshot, prepared));

    await expect(test.host.dispatch(RUN_ID, EFFECT_ID, { attempt: 1 })).resolves.toEqual({
      kind: "failed",
      error: {
        phase: "after_dispatch",
        code: "invalid_output",
        retryable: false,
      },
    });
  });
});

describe("InternalRoutineOimToolHost approved Connection origins", () => {
  it.each(["http", "openapi"] as const)(
    "dispatches the %s operation only to the exact Connection origin approved by trusted persistence",
    async (source) => {
      const snapshot = approvedOriginRegistration(source);
      const test = harness(source, false, {
        registration: snapshot,
        originApproval: "valid",
        connectionConfiguration: { site: "tenant.customer.example" },
      });
      const prepared = await test.host.prepare(RUN_ID, {
        stateKey: "Forecast",
        connectionId: "connection-east",
      });
      test.setEffect(effect(snapshot, prepared));

      await expect(test.host.dispatch(RUN_ID, EFFECT_ID, { attempt: 1 })).resolves.toEqual({
        kind: "succeeded",
        output: { temperature: 24 },
      });
      expect(test.originApprovalGet).toHaveBeenCalledTimes(2);
      expect(test.requests[0]?.url).toBe("https://tenant.customer.example/forecast?city=Pune");
    }
  );

  it("requires an approved origin before preparing the effect", async () => {
    const snapshot = approvedOriginRegistration();
    const test = harness("http", false, {
      registration: snapshot,
      originApproval: "missing",
      connectionConfiguration: { site: "tenant.customer.example" },
    });

    await expect(
      test.host.prepare(RUN_ID, {
        stateKey: "Forecast",
        connectionId: "connection-east",
      })
    ).resolves.toEqual({ kind: "failed", reason: "action_required" });
    expect(test.secretKeys).toHaveLength(0);
    expect(test.requests).toHaveLength(0);
  });

  it("rejects an approval bound to different Connection configuration", async () => {
    const snapshot = approvedOriginRegistration();
    const test = harness("http", false, {
      registration: snapshot,
      originApproval: "valid",
      connectionConfiguration: { site: "approved.customer.example" },
    });
    test.setConnectionConfiguration({ site: "changed.customer.example" });

    await expect(
      test.host.prepare(RUN_ID, {
        stateKey: "Forecast",
        connectionId: "connection-east",
      })
    ).resolves.toEqual({ kind: "failed", reason: "action_required" });
    expect(test.secretKeys).toHaveLength(0);
    expect(test.requests).toHaveLength(0);
  });

  it("rechecks trusted approval before leasing a Credential on dispatch", async () => {
    const snapshot = approvedOriginRegistration();
    const test = harness("http", false, {
      registration: snapshot,
      originApproval: "valid_then_missing",
      connectionConfiguration: { site: "tenant.customer.example" },
    });
    const prepared = await test.host.prepare(RUN_ID, {
      stateKey: "Forecast",
      connectionId: "connection-east",
    });
    test.setEffect(effect(snapshot, prepared));

    await expect(test.host.dispatch(RUN_ID, EFFECT_ID, { attempt: 1 })).resolves.toEqual({
      kind: "failed",
      error: {
        phase: "before_dispatch",
        code: "action_required",
        retryable: false,
      },
    });
    expect(test.originApprovalGet).toHaveBeenCalledTimes(2);
    expect(test.secretKeys).toHaveLength(0);
    expect(test.requests).toHaveLength(0);
  });
});

describe("InternalRoutineOimToolHost authority", () => {
  it("refuses a Tool that is not the pinned Routine State", async () => {
    const test = harness("http");

    await expect(
      test.host.prepare(RUN_ID, {
        stateKey: "Other",
        connectionId: "connection-east",
      })
    ).resolves.toEqual({ kind: "failed", reason: "routine_state_mismatch" });
    expect(test.resolve).not.toHaveBeenCalled();
  });

  it("refuses a credentialed operation with no explicit Connection id", async () => {
    const test = harness("http");

    await expect(
      test.host.prepare(RUN_ID, {
        stateKey: "Forecast",
      })
    ).resolves.toEqual({ kind: "failed", reason: "connection_required" });
    expect(test.resolve).not.toHaveBeenCalled();
  });

  it("ignores a changed default and resolves the Connection recorded by the Routine", async () => {
    const test = harness("http");
    await test.host.prepare(RUN_ID, {
      stateKey: "Forecast",
      connectionId: "connection-east",
    });

    expect(test.resolve).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: "connection-east" })
    );
  });

  it("denies dispatch when live authority or Connection use was revoked", async () => {
    const test = harness("http", true);
    const snapshot = registration("http");
    const prepared = await test.host.prepare(RUN_ID, {
      stateKey: "Forecast",
      connectionId: "connection-east",
    });
    test.setEffect(effect(snapshot, prepared));
    test.revoke();

    await expect(test.host.dispatch(RUN_ID, EFFECT_ID, { attempt: 1 })).resolves.toEqual({
      kind: "failed",
      error: {
        phase: "before_dispatch",
        code: "authorization_revoked",
        retryable: false,
      },
    });
    expect(test.requests).toHaveLength(0);
  });

  it("denies dispatch when the selected Connection origin changes before lease", async () => {
    const test = harness("http");
    const snapshot = registration("http");
    const prepared = await test.host.prepare(RUN_ID, {
      stateKey: "Forecast",
      connectionId: "connection-east",
    });
    test.setEffect(effect(snapshot, prepared));
    test.setConnectionConfiguration({ site: "west.weather.test" });

    await expect(test.host.dispatch(RUN_ID, EFFECT_ID, { attempt: 1 })).resolves.toEqual({
      kind: "failed",
      error: {
        phase: "before_dispatch",
        code: "adapter_binding_mismatch",
        retryable: false,
      },
    });
    expect(test.secretKeys).toHaveLength(0);
    expect(test.requests).toHaveLength(0);
  });

  it("refuses dispatch without the matching ledger attempt", async () => {
    const test = harness("http");
    const snapshot = registration("http");
    const prepared = await test.host.prepare(RUN_ID, {
      stateKey: "Forecast",
      connectionId: "connection-east",
    });
    test.setEffect(effect(snapshot, prepared));

    await expect(test.host.dispatch(RUN_ID, EFFECT_ID, { attempt: 2 })).resolves.toEqual({
      kind: "failed",
      error: {
        phase: "before_dispatch",
        code: "effect_attempt_mismatch",
        retryable: false,
      },
    });
    expect(test.requests).toHaveLength(0);
  });
});
