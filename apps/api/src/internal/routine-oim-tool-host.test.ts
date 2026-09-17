import {
  ConnectionResolver,
  compileOimGraphqlOperations,
  compileOimHttpOperations,
  type EgressHttpPort,
  type EgressHttpRequest,
  OimOperationConnectionResolver,
} from "@tulipfarm/integrations";
import { routineStateDefinitionRef } from "@tulipfarm/run-kernel";
import {
  type OimManifest,
  oimFileDigest,
  type routine,
  type ToolContractDefinition,
} from "@tulipfarm/schema";
import type { SecretsService } from "@tulipfarm/secrets";
import type { BundleDefinition, RuntimeBundle, SoulIntegration } from "@tulipfarm/soul";
import type {
  PersistedConnection,
  PersistedRun,
  PersistedState,
  RunBundle,
} from "@tulipfarm/storage";
import {
  AdapterDispatchError,
  intentDigest,
  MemoryEffectStore,
  normalizeToolIntent,
} from "@tulipfarm/tool-broker";
import { describe, expect, it, vi } from "vitest";
import type { OimReleaseDispatchPort } from "../integrations/releases/dispatch-host";
import {
  InternalRoutineOimToolHost,
  LiveRoutineOimAuthorizer,
  LiveRoutineOimFileAuthorizer,
  LiveRoutineOimRunAuthority,
  type RoutineOimClaimEvidence,
  type RoutineOimRegistration,
  type RoutineOimRunAuthority,
} from "./routine-oim-tool-host";
import type { RunAuthority } from "./turn-host";

const BUSINESS_ID = "business-1";
const RUN_ID = "11111111-1111-4111-8111-111111111111";
const ROUTINE_ID = "22222222-2222-4222-8222-222222222222";
const EFFECT_ID = "33333333-3333-4333-8333-333333333333";
const STATE_KEY = "ReadIssue";
const USER_ID = "user-1";
const CLAIM: RoutineOimClaimEvidence = {
  leaseOwner: "worker-1",
  leaseGeneration: 1,
};

const releaseDispatch: OimReleaseDispatchPort = {
  async dispatch(_input, run) {
    return run((operation) => operation());
  },
};

function releaseIntegration(manifest: OimManifest): SoulIntegration {
  return { slug: "acme", sourceIntegration: manifest.metadata.id, oimManifest: manifest };
}

const GRAPHQL_DOCUMENT = "query ReadIssue($id: String!) { issue(id: $id) { id title } }";
const INPUT_VALIDATE_HOOK =
  "export function validate(input) { return { valid: input.arguments.id === 'issue-1' }; }\n";

function graphqlManifest(): OimManifest {
  return {
    oimVersion: "1.0",
    kind: "Integration",
    metadata: {
      id: "acme",
      name: "Acme",
      version: "2.0.0",
      description: "Acme issues",
      license: "Apache-2.0",
    },
    profiles: { core: "1.1", auth: "1.0" },
    auth: {
      credentialSlots: [],
      configurationFields: [{ id: "tenant", label: "Tenant", type: "string" }],
      allowedOriginHosts: ["*.acme.test"],
      steps: [],
    },
    files: [{ path: "read.graphql", role: "graphql", sha256: "a".repeat(64) }],
    operations: [
      {
        id: "read-issue",
        name: "read_issue",
        description: "Read one issue.",
        effect: "read",
        identityMode: "shared_only",
        source: {
          type: "graphql",
          url: "https://{tenant}/graphql",
          operation: "ReadIssue",
          documentFile: "read.graphql",
        },
        requestSchema: {
          type: "object",
          additionalProperties: false,
          properties: { id: { type: "string" } },
          required: ["id"],
        },
        response: { schema: { type: "object" }, maxBytes: 16_384 },
      },
    ],
  } as OimManifest;
}

function multipartManifest(): OimManifest {
  return {
    oimVersion: "1.0",
    kind: "Integration",
    metadata: {
      id: "acme",
      name: "Acme",
      version: "2.0.0",
      description: "Acme uploads",
      license: "Apache-2.0",
    },
    profiles: { core: "1.2" },
    operations: [
      {
        id: "upload",
        name: "upload",
        description: "Upload Files.",
        effect: "send",
        identityMode: "shared_only",
        source: {
          type: "http",
          method: "POST",
          baseUrl: "https://upload.acme.test",
          path: "/files",
          contentType: "multipart",
          multipart: {
            parts: [
              { name: "first", kind: "file", pointer: "/uploads/0/fileId" },
              { name: "second", kind: "file", pointer: "/uploads/1/fileId" },
            ],
          },
        },
        requestSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            uploads: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: { fileId: { type: "string" } },
                required: ["fileId"],
              },
            },
          },
          required: ["uploads"],
        },
        response: { schema: { type: "object" }, maxBytes: 16_384 },
      },
    ],
  } as OimManifest;
}

function credentialManifest(): OimManifest {
  const value = multipartManifest();
  value.profiles.core = "1.0";
  value.profiles.auth = "1.0";
  value.auth = {
    credentialSlots: [{ id: "token", label: "Token", kind: "api_key", required: true }],
    steps: [],
  };
  value.operations = [
    {
      id: "send-message",
      name: "send_message",
      description: "Send a message.",
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
        additionalProperties: false,
        properties: { text: { type: "string" } },
        required: ["text"],
      },
      response: { schema: { type: "object" }, maxBytes: 16_384 },
    },
  ];
  return value;
}

function connection(configuration: Readonly<Record<string, string | number | boolean>>) {
  return {
    businessId: BUSINESS_ID,
    id: "connection-1",
    integration: { id: "acme", majorVersion: 2 },
    label: "Acme",
    owner: { scope: "organization" },
    status: "active",
    isDefault: true,
    configuration,
    agentVisibleConfiguration: [],
    secretBindings: {},
    health: { status: "healthy", checkedAt: "2026-09-12T00:00:00.000Z" },
    expiresAt: null,
    createdAt: new Date("2026-09-12T00:00:00.000Z"),
    updatedAt: new Date("2026-09-12T00:00:00.000Z"),
  } as PersistedConnection;
}

function credentialConnection(
  secretRef: `secret://${string}`,
  status: PersistedConnection["status"] = "active"
): PersistedConnection {
  return {
    ...connection({}),
    status,
    secretBindings: { token: secretRef },
  };
}

function resolver(source: PersistedConnection | (() => PersistedConnection)) {
  const current = () => (typeof source === "function" ? source() : source);
  return new OimOperationConnectionResolver(
    new ConnectionResolver(
      {
        findById: async (_businessId, id) => (id === current().id ? current() : null),
        listForOwner: async () => [current()],
        listForIntegration: async () => [current()],
      },
      { canUse: async () => true }
    ),
    { list: async () => [] }
  );
}

function routineDefinition(contract: ToolContractDefinition): routine.RoutineDefinition {
  return {
    apiVersion: "tulipfarm.ai/v1",
    kind: "Routine",
    metadata: {
      id: ROUTINE_ID,
      slug: "read-issue",
      schemaVersion: 1,
      authoredVersion: 1,
      lifecycle: "published",
    },
    spec: {
      owner: "agent:assistant",
      start: STATE_KEY,
      states: [
        {
          type: "tool",
          name: STATE_KEY,
          toolRef: { name: contract.spec.toolId, version: contract.spec.toolVersion },
          action: contract.spec.action,
          input: {},
          end: true,
        },
      ],
    },
  } as routine.RoutineDefinition;
}

function bundle(contract: ToolContractDefinition): RuntimeBundle {
  const definitions = [
    {
      kind: "Routine",
      id: ROUTINE_ID,
      slug: "read-issue",
      authoredVersion: 1,
      hash: "r".repeat(64),
      document: routineDefinition(contract),
      references: [],
    },
    {
      kind: "ToolContract",
      id: contract.metadata.id,
      slug: contract.metadata.slug,
      authoredVersion: 1,
      hash: "t".repeat(64),
      document: contract,
      references: [],
    },
  ] as unknown as readonly BundleDefinition[];
  return {
    digest: "b".repeat(64),
    businessId: BUSINESS_ID,
    changesetId: "changeset-1",
    commitSha: "c".repeat(40),
    definitions,
    assets: [],
    get: () => undefined,
    getById: (id) => definitions.find((definition) => definition.id === id),
    asset: () => undefined,
  };
}

function authority(bundleDigest: string): RunAuthority {
  return {
    businessId: BUSINESS_ID,
    runId: RUN_ID,
    subject: { kind: "user", id: USER_ID },
    source: "routine",
    bundleDigest,
    routineId: ROUTINE_ID,
  };
}

function runAuthority(
  runtimeBundle: RuntimeBundle,
  overrides: {
    readonly stateKey?: string;
    readonly definitionStateName?: string;
    readonly status?: "running" | "waiting";
  } = {}
): RoutineOimRunAuthority {
  const runBundle: RunBundle = {
    digest: runtimeBundle.digest,
    routineId: ROUTINE_ID,
    routineVersion: "1",
  };
  return {
    claim: async () => ({
      authority: authority(runtimeBundle.digest),
      bundle: runBundle,
      state: {
        key: overrides.stateKey ?? STATE_KEY,
        definitionRef: routineStateDefinitionRef(
          runBundle,
          overrides.definitionStateName ?? STATE_KEY
        ),
        status: overrides.status ?? "running",
      },
    }),
  };
}

class RecordingHttp implements EgressHttpPort {
  readonly sent: EgressHttpRequest[] = [];

  constructor(private readonly failure?: Error) {}

  async send(request: EgressHttpRequest) {
    this.sent.push(request);
    if (this.failure !== undefined) throw this.failure;
    return {
      status: 200,
      headers: {},
      body: { data: { issue: { id: "issue-1", title: "Fixed" } } },
    };
  }
}

describe("LiveRoutineOimAuthorizer", () => {
  it("applies the effective Agent capability restrictions", async () => {
    const compiled = compileOimHttpOperations(multipartManifest(), {})[0];
    if (compiled === undefined) throw new Error("Agent authority fixture did not compile");
    const runtimeBundle = bundle(compiled.contract);
    const authorize = new LiveRoutineOimAuthorizer({
      async resolvePrincipalLayer(name) {
        return {
          name,
          grants: [{ action: "*", resourceType: "*", effect: "allow" }],
        };
      },
    });

    await expect(
      authorize.authorize({
        authority: {
          ...authority(runtimeBundle.digest),
          agent: {
            name: "restricted",
            principalId: "agent-1",
            capabilityRestrictions: { tools: { deny: [compiled.contract.spec.toolId] } },
          },
        },
        bundle: runtimeBundle,
        contract: compiled.contract,
        action: compiled.contract.spec.action,
        arguments: { uploads: [] },
        targetRefs: [],
        destination: "https://upload.acme.test",
      })
    ).resolves.toBe(false);
  });
});

describe("LiveRoutineOimFileAuthorizer", () => {
  it("passes the exact Run, State, caller, Agent, and File set to live File authority", async () => {
    const assertAuthorized = vi.fn(async () => undefined);
    const fileAuthorizer = new LiveRoutineOimFileAuthorizer({ assertAuthorized });
    const compiled = compileOimHttpOperations(multipartManifest(), {})[0];
    if (compiled === undefined) throw new Error("File authority fixture did not compile");
    const runtimeBundle = bundle(compiled.contract);

    await fileAuthorizer.assertAuthorized({
      authority: {
        ...authority(runtimeBundle.digest),
        agent: { name: "uploader", principalId: "agent-1" },
      },
      bundle: runtimeBundle,
      contract: compiled.contract,
      stateKey: STATE_KEY,
      fileIds: ["file-a", "file-b"],
    });

    expect(assertAuthorized).toHaveBeenCalledWith({
      businessId: BUSINESS_ID,
      runId: RUN_ID,
      stateId: STATE_KEY,
      caller: { kind: "user", id: USER_ID },
      agentPrincipalId: "agent-1",
      fileIds: ["file-a", "file-b"],
    });
  });

  describe("LiveRoutineOimRunAuthority", () => {
    const runBundle: RunBundle = {
      digest: "b".repeat(64),
      routineId: ROUTINE_ID,
      routineVersion: "1",
    };
    const persistedRun = (overrides: Partial<PersistedRun> = {}): PersistedRun =>
      ({
        id: RUN_ID,
        businessId: BUSINESS_ID,
        source: "routine",
        bundle: runBundle,
        identity: {
          initiator: { kind: "user", id: USER_ID },
          effectiveSubject: { kind: "user", id: USER_ID },
          guardrailContextRef: "guardrail",
        },
        status: "running",
        version: 2,
        createdAt: "2026-09-13T00:00:00.000Z",
        startedAt: "2026-09-13T00:00:00.000Z",
        finishedAt: null,
        resultArtifactId: null,
        errorEvidenceRef: null,
        leaseOwner: CLAIM.leaseOwner,
        leaseExpiresAt: "2026-09-13T01:00:00.000Z",
        leaseGeneration: CLAIM.leaseGeneration,
        ...overrides,
      }) as PersistedRun;
    const live = (run: PersistedRun, stateExists = true) =>
      new LiveRoutineOimRunAuthority(
        { authority: async () => authority(runBundle.digest) },
        {
          find: async () => run,
          findState: async () =>
            stateExists
              ? ({
                  businessId: BUSINESS_ID,
                  runId: RUN_ID,
                  key: STATE_KEY,
                  definitionRef: routineStateDefinitionRef(runBundle, STATE_KEY),
                  resolvedInput: {},
                  status: "running",
                  version: 1,
                  createdAt: "2026-09-13T00:00:00.000Z",
                  startedAt: "2026-09-13T00:00:00.000Z",
                  finishedAt: null,
                  resultArtifactId: null,
                  errorEvidenceRef: null,
                  output: null,
                } satisfies PersistedState)
              : null,
        },
        () => new Date("2026-09-13T00:30:00.000Z")
      );

    it.each([
      ["transferred claim", { leaseOwner: "worker-2", leaseGeneration: 2 }],
      ["cancelled Run", { status: "cancelled", leaseOwner: null, leaseExpiresAt: null }],
      ["stale generation", { leaseGeneration: 2 }],
    ] as const)("rejects a %s", async (_name, overrides) => {
      await expect(
        live(persistedRun(overrides as Partial<PersistedRun>)).claim({
          businessId: BUSINESS_ID,
          runId: RUN_ID,
          stateKey: STATE_KEY,
          claim: CLAIM,
        })
      ).resolves.toBeUndefined();
    });

    it("rejects a nonexistent persisted State occurrence", async () => {
      await expect(
        live(persistedRun(), false).claim({
          businessId: BUSINESS_ID,
          runId: RUN_ID,
          stateKey: "Parent/ReadIssue",
          claim: CLAIM,
        })
      ).resolves.toBeUndefined();
    });

    it("rejects a claim transferred while the State occurrence is being read", async () => {
      let run = persistedRun();
      const runs = {
        find: vi.fn(async () => run),
        findState: vi.fn(async () => {
          run = persistedRun({ leaseOwner: "worker-2", leaseGeneration: 2 });
          return {
            businessId: BUSINESS_ID,
            runId: RUN_ID,
            key: STATE_KEY,
            definitionRef: routineStateDefinitionRef(runBundle, STATE_KEY),
            resolvedInput: {},
            status: "running",
            version: 1,
            createdAt: "2026-09-13T00:00:00.000Z",
            startedAt: "2026-09-13T00:00:00.000Z",
            finishedAt: null,
            resultArtifactId: null,
            errorEvidenceRef: null,
            output: null,
          } satisfies PersistedState;
        }),
      };
      const host = new LiveRoutineOimRunAuthority(
        { authority: async () => authority(runBundle.digest) },
        runs,
        () => new Date("2026-09-13T00:30:00.000Z")
      );

      await expect(
        host.claim({
          businessId: BUSINESS_ID,
          runId: RUN_ID,
          stateKey: STATE_KEY,
          claim: CLAIM,
        })
      ).resolves.toBeUndefined();
      expect(runs.find).toHaveBeenCalledTimes(2);
    });

    it("accepts a same-owner heartbeat while authority is being read", async () => {
      let run = persistedRun();
      const runs = {
        find: vi.fn(async () => run),
        findState: vi.fn(
          async () =>
            ({
              businessId: BUSINESS_ID,
              runId: RUN_ID,
              key: STATE_KEY,
              definitionRef: routineStateDefinitionRef(runBundle, STATE_KEY),
              resolvedInput: {},
              status: "running",
              version: 1,
              createdAt: "2026-09-13T00:00:00.000Z",
              startedAt: "2026-09-13T00:00:00.000Z",
              finishedAt: null,
              resultArtifactId: null,
              errorEvidenceRef: null,
              output: null,
            }) satisfies PersistedState
        ),
      };
      const host = new LiveRoutineOimRunAuthority(
        {
          authority: async () => {
            run = persistedRun({
              version: 3,
              leaseExpiresAt: "2026-09-13T02:00:00.000Z",
            });
            return authority(runBundle.digest);
          },
        },
        runs,
        () => new Date("2026-09-13T00:30:00.000Z")
      );

      await expect(
        host.claim({
          businessId: BUSINESS_ID,
          runId: RUN_ID,
          stateKey: STATE_KEY,
          claim: CLAIM,
        })
      ).resolves.toMatchObject({
        bundle: runBundle,
        state: { key: STATE_KEY, status: "running" },
      });
    });
  });
});

function noSecrets(): Promise<SecretsService> {
  return Promise.resolve({
    resolveCurrent: async () => null,
  } as unknown as SecretsService);
}

function secretService(secretRef: string, value: string) {
  const key = secretRef.slice("secret://".length);
  const resolveCurrent = vi.fn(async (candidate: string) =>
    candidate === key ? { value, version: "revision-1" } : null
  );
  return {
    resolveCurrent,
    load: async () =>
      ({
        get: async (candidate: string) => (candidate === key ? value : undefined),
        revision: async (candidate: string) => (candidate === key ? "revision-1" : null),
        resolveCurrent,
      }) as unknown as SecretsService,
  };
}

function registration(
  manifest: OimManifest,
  documents: Readonly<Record<string, string>> = {},
  hookFiles?: Readonly<Record<string, string>>
): RoutineOimRegistration {
  return { manifest, documents, ...(hookFiles === undefined ? {} : { hookFiles }) };
}

describe("InternalRoutineOimToolHost", () => {
  async function hookDispatchFixture(
    hookFiles?: Readonly<Record<string, string>>,
    options: {
      readonly mutating?: boolean;
      readonly failure?: Error;
      readonly releaseDispatch?: OimReleaseDispatchPort;
    } = {}
  ) {
    const manifest = graphqlManifest();
    if (options.mutating) {
      manifest.operations = manifest.operations.map((operation) => ({
        ...operation,
        effect: "send" as const,
      }));
    }
    const document = options.mutating
      ? "mutation ReadIssue($id: String!) { issue(id: $id) { id title } }"
      : GRAPHQL_DOCUMENT;
    manifest.files = [
      ...(manifest.files ?? []),
      {
        path: "hooks/validate.mjs",
        role: "hook",
        sha256: oimFileDigest(INPUT_VALIDATE_HOOK),
      },
    ];
    manifest.profiles.hooks = "1.0";
    manifest.hooks = [
      {
        kind: "input_validate",
        file: "hooks/validate.mjs",
        export: "validate",
      },
    ];
    const compiled = compileOimGraphqlOperations(manifest, new Map([["read.graphql", document]]), {
      tenant: "muskan.acme.test",
    })[0];
    if (compiled === undefined) throw new Error("GraphQL fixture did not compile");
    const runtimeBundle = bundle(compiled.contract);
    const effects = new MemoryEffectStore();
    const http = new RecordingHttp(options.failure);
    const runPureHook = vi.fn(async () => ({ valid: true }));
    const host = new InternalRoutineOimToolHost({
      businessId: BUSINESS_ID,
      releaseDispatch: options.releaseDispatch ?? releaseDispatch,
      releaseIntegration,
      runs: runAuthority(runtimeBundle),
      bundles: { load: async () => runtimeBundle },
      registrations: {
        find: async () => registration(manifest, { "read.graphql": document }, hookFiles),
      },
      connections: resolver(connection({ tenant: "muskan.acme.test" })),
      effects,
      secrets: noSecrets,
      http,
      authorize: { authorize: async () => true },
      hookExecutor: { runPureHook },
    });
    const prepared = await host.prepare(RUN_ID, {
      stateKey: STATE_KEY,
      claim: CLAIM,
      connectionId: "connection-1",
      arguments: { id: "issue-1" },
    });
    if (prepared.kind !== "ready") throw new Error("expected ready preparation");
    const intent = normalizeToolIntent({
      intentId: EFFECT_ID,
      businessId: BUSINESS_ID,
      runId: RUN_ID,
      stateId: STATE_KEY,
      toolId: compiled.contract.spec.toolId,
      toolVersion: compiled.contract.spec.toolVersion,
      action: compiled.contract.spec.action,
      targetRefs: [],
      arguments: { id: "issue-1" },
      principalKind: "user",
      principalId: USER_ID,
      integrationId: prepared.integrationId,
      integrationMajorVersion: prepared.integrationMajorVersion,
      operationId: prepared.operationId,
      manifestDigest: prepared.manifestDigest,
      configurationDigest: prepared.configurationDigest,
      destination: prepared.destination,
      connection: prepared.connection,
      idempotencyKey: `routine:${RUN_ID}:${STATE_KEY}`,
    });
    await effects.reserve({
      effectId: EFFECT_ID,
      businessId: BUSINESS_ID,
      runId: RUN_ID,
      stateId: STATE_KEY,
      logicalEffectOrdinal: 1,
      idempotencyKey: intent.idempotencyKey,
      intentDigest: intentDigest(intent),
      intent,
      guardrailRevision: runtimeBundle.digest,
      createdAt: "2026-09-12T00:00:00.000Z",
    });
    await effects.beginAttempt(BUSINESS_ID, EFFECT_ID, "2026-09-12T00:00:01.000Z");
    return { host, http, runPureHook, runtimeBundle };
  }

  it("runs a declared hook from the pinned registration bytes", async () => {
    const { host, http, runPureHook, runtimeBundle } = await hookDispatchFixture({
      "hooks/validate.mjs": INPUT_VALIDATE_HOOK,
    });

    await expect(host.dispatch(RUN_ID, EFFECT_ID, { attempt: 1, claim: CLAIM })).resolves.toEqual({
      kind: "succeeded",
      output: { data: { issue: { id: "issue-1", title: "Fixed" } } },
    });
    expect(runPureHook).toHaveBeenCalledWith({
      source: INPUT_VALIDATE_HOOK,
      sourceSha256: oimFileDigest(INPUT_VALIDATE_HOOK),
      exportName: "validate",
      input: { operationId: "read-issue", arguments: { id: "issue-1" } },
      breakerKey: expect.stringMatching(
        new RegExp(
          `^oim-routine:${BUSINESS_ID}:${runtimeBundle.digest}:[0-9a-f]{64}:input_validate:validate$`
        )
      ),
    });
    expect(http.sent).toHaveLength(1);
  });

  it("keeps a mutating after-dispatch timeout under reconciliation", async () => {
    let settlement: string | undefined;
    const { host } = await hookDispatchFixture(
      { "hooks/validate.mjs": INPUT_VALIDATE_HOOK },
      {
        mutating: true,
        failure: new AdapterDispatchError("after_dispatch", "timeout", true),
        releaseDispatch: {
          async dispatch(_input, run, readSettlement) {
            try {
              return await run((operation) => operation());
            } finally {
              settlement = await readSettlement();
            }
          },
        },
      }
    );

    await expect(
      host.dispatch(RUN_ID, EFFECT_ID, { attempt: 1, claim: CLAIM })
    ).resolves.toMatchObject({
      kind: "failed",
      error: { phase: "after_dispatch", code: "transport_error" },
    });
    expect(settlement).toBe("ambiguous");
  });

  it.each([
    ["missing", undefined, "hook_source_unavailable"],
    [
      "tampered",
      { "hooks/validate.mjs": `${INPUT_VALIDATE_HOOK}\nexport const changed = true;\n` },
      "hook_source_mismatch",
    ],
  ] as const)("fails closed when pinned hook bytes are %s", async (_label, hookFiles, code) => {
    const { host, http, runPureHook } = await hookDispatchFixture(hookFiles);

    await expect(host.dispatch(RUN_ID, EFFECT_ID, { attempt: 1, claim: CLAIM })).resolves.toEqual({
      kind: "failed",
      error: { phase: "before_dispatch", code, retryable: false },
    });
    expect(runPureHook).not.toHaveBeenCalled();
    expect(http.sent).toHaveLength(0);
  });

  it("rejects a persisted occurrence bound to a different authored State", async () => {
    const manifest = graphqlManifest();
    const compiled = compileOimGraphqlOperations(
      manifest,
      new Map([["read.graphql", GRAPHQL_DOCUMENT]]),
      { tenant: "muskan.acme.test" }
    )[0];
    if (compiled === undefined) throw new Error("GraphQL fixture did not compile");
    const runtimeBundle = bundle(compiled.contract);
    const http = new RecordingHttp();
    const host = new InternalRoutineOimToolHost({
      businessId: BUSINESS_ID,
      releaseDispatch,
      releaseIntegration,
      runs: runAuthority(runtimeBundle, { definitionStateName: "DifferentState" }),
      bundles: { load: async () => runtimeBundle },
      registrations: {
        find: async () => registration(manifest, { "read.graphql": GRAPHQL_DOCUMENT }),
      },
      connections: resolver(connection({ tenant: "muskan.acme.test" })),
      effects: new MemoryEffectStore(),
      secrets: noSecrets,
      http,
      authorize: { authorize: async () => true },
    });

    await expect(
      host.prepare(RUN_ID, {
        stateKey: STATE_KEY,
        claim: CLAIM,
        connectionId: "connection-1",
        arguments: { id: "issue-1" },
      })
    ).resolves.toEqual({ kind: "failed", reason: "routine_state_mismatch" });
    expect(http.sent).toHaveLength(0);
  });

  it("binds and dispatches GraphQL to the selected Connection configuration", async () => {
    const manifest = graphqlManifest();
    const compiled = compileOimGraphqlOperations(
      manifest,
      new Map([["read.graphql", GRAPHQL_DOCUMENT]]),
      { tenant: "muskan.acme.test" }
    )[0];
    if (compiled === undefined) throw new Error("GraphQL fixture did not compile");
    const runtimeBundle = bundle(compiled.contract);
    const effects = new MemoryEffectStore();
    const http = new RecordingHttp();
    const host = new InternalRoutineOimToolHost({
      businessId: BUSINESS_ID,
      releaseDispatch,
      releaseIntegration,
      runs: runAuthority(runtimeBundle),
      bundles: { load: async () => runtimeBundle },
      registrations: {
        find: async () => registration(manifest, { "read.graphql": GRAPHQL_DOCUMENT }),
      },
      connections: resolver(connection({ tenant: "muskan.acme.test" })),
      effects,
      secrets: noSecrets,
      http,
      authorize: { authorize: async () => true },
    });

    const prepared = await host.prepare(RUN_ID, {
      stateKey: STATE_KEY,
      claim: CLAIM,
      connectionId: "connection-1",
      arguments: { id: "issue-1" },
    });
    expect(prepared).toMatchObject({
      kind: "ready",
      destination: "https://muskan.acme.test",
      integrationId: "acme",
      integrationMajorVersion: 2,
      operationId: "read-issue",
      connection: { connectionId: "connection-1" },
    });
    if (prepared.kind !== "ready") throw new Error("expected ready preparation");
    const intent = normalizeToolIntent({
      intentId: EFFECT_ID,
      businessId: BUSINESS_ID,
      runId: RUN_ID,
      stateId: STATE_KEY,
      toolId: compiled.contract.spec.toolId,
      toolVersion: compiled.contract.spec.toolVersion,
      action: compiled.contract.spec.action,
      targetRefs: [],
      arguments: { id: "issue-1" },
      principalKind: "user",
      principalId: USER_ID,
      integrationId: prepared.integrationId,
      integrationMajorVersion: prepared.integrationMajorVersion,
      operationId: prepared.operationId,
      manifestDigest: prepared.manifestDigest,
      configurationDigest: prepared.configurationDigest,
      destination: prepared.destination,
      connection: prepared.connection,
      idempotencyKey: `routine:${RUN_ID}:${STATE_KEY}`,
    });
    await effects.reserve({
      effectId: EFFECT_ID,
      businessId: BUSINESS_ID,
      runId: RUN_ID,
      stateId: STATE_KEY,
      logicalEffectOrdinal: 1,
      idempotencyKey: intent.idempotencyKey,
      intentDigest: intentDigest(intent),
      intent,
      guardrailRevision: runtimeBundle.digest,
      createdAt: "2026-09-12T00:00:00.000Z",
    });
    await effects.beginAttempt(BUSINESS_ID, EFFECT_ID, "2026-09-12T00:00:01.000Z");

    await expect(host.dispatch(RUN_ID, EFFECT_ID, { attempt: 1, claim: CLAIM })).resolves.toEqual({
      kind: "succeeded",
      output: { data: { issue: { id: "issue-1", title: "Fixed" } } },
    });
    expect(http.sent).toHaveLength(1);
    expect(http.sent[0]?.url).toBe("https://muskan.acme.test/graphql");
  });

  it("refuses dispatch when the Run claim changes after live authorization", async () => {
    const manifest = graphqlManifest();
    const compiled = compileOimGraphqlOperations(
      manifest,
      new Map([["read.graphql", GRAPHQL_DOCUMENT]]),
      { tenant: "muskan.acme.test" }
    )[0];
    if (compiled === undefined) throw new Error("GraphQL fixture did not compile");
    const runtimeBundle = bundle(compiled.contract);
    const effects = new MemoryEffectStore();
    const http = new RecordingHttp();
    let claimCurrent = true;
    let authorizationCount = 0;
    const claims = runAuthority(runtimeBundle);
    const host = new InternalRoutineOimToolHost({
      businessId: BUSINESS_ID,
      releaseDispatch,
      releaseIntegration,
      runs: {
        claim: async (input) => (claimCurrent ? claims.claim(input) : undefined),
      },
      bundles: { load: async () => runtimeBundle },
      registrations: {
        find: async () => registration(manifest, { "read.graphql": GRAPHQL_DOCUMENT }),
      },
      connections: resolver(connection({ tenant: "muskan.acme.test" })),
      effects,
      secrets: noSecrets,
      http,
      authorize: {
        authorize: async () => {
          authorizationCount += 1;
          if (authorizationCount === 2) claimCurrent = false;
          return true;
        },
      },
    });
    const prepared = await host.prepare(RUN_ID, {
      stateKey: STATE_KEY,
      claim: CLAIM,
      connectionId: "connection-1",
      arguments: { id: "issue-1" },
    });
    if (prepared.kind !== "ready") throw new Error("expected ready preparation");
    const intent = normalizeToolIntent({
      intentId: EFFECT_ID,
      businessId: BUSINESS_ID,
      runId: RUN_ID,
      stateId: STATE_KEY,
      toolId: compiled.contract.spec.toolId,
      toolVersion: compiled.contract.spec.toolVersion,
      action: compiled.contract.spec.action,
      targetRefs: [],
      arguments: { id: "issue-1" },
      principalKind: "user",
      principalId: USER_ID,
      integrationId: prepared.integrationId,
      integrationMajorVersion: prepared.integrationMajorVersion,
      operationId: prepared.operationId,
      manifestDigest: prepared.manifestDigest,
      configurationDigest: prepared.configurationDigest,
      destination: prepared.destination,
      connection: prepared.connection,
      idempotencyKey: `routine:${RUN_ID}:${STATE_KEY}`,
    });
    await effects.reserve({
      effectId: EFFECT_ID,
      businessId: BUSINESS_ID,
      runId: RUN_ID,
      stateId: STATE_KEY,
      logicalEffectOrdinal: 1,
      idempotencyKey: intent.idempotencyKey,
      intentDigest: intentDigest(intent),
      intent,
      guardrailRevision: runtimeBundle.digest,
      createdAt: "2026-09-12T00:00:00.000Z",
    });
    await effects.beginAttempt(BUSINESS_ID, EFFECT_ID, "2026-09-12T00:00:01.000Z");

    await expect(host.dispatch(RUN_ID, EFFECT_ID, { attempt: 1, claim: CLAIM })).resolves.toEqual({
      kind: "failed",
      error: {
        phase: "before_dispatch",
        code: "run_claim_lost",
        retryable: false,
      },
    });
    expect(http.sent).toHaveLength(0);
  });

  it("does not redirect an approved GraphQL effect after Connection configuration changes", async () => {
    const manifest = graphqlManifest();
    const compiled = compileOimGraphqlOperations(
      manifest,
      new Map([["read.graphql", GRAPHQL_DOCUMENT]]),
      { tenant: "muskan.acme.test" }
    )[0];
    if (compiled === undefined) throw new Error("GraphQL fixture did not compile");
    const runtimeBundle = bundle(compiled.contract);
    let row = connection({ tenant: "muskan.acme.test" });
    const effects = new MemoryEffectStore();
    const http = new RecordingHttp();
    const host = new InternalRoutineOimToolHost({
      businessId: BUSINESS_ID,
      releaseDispatch,
      releaseIntegration,
      runs: runAuthority(runtimeBundle),
      bundles: { load: async () => runtimeBundle },
      registrations: {
        find: async () => registration(manifest, { "read.graphql": GRAPHQL_DOCUMENT }),
      },
      connections: resolver(() => row),
      effects,
      secrets: noSecrets,
      http,
      authorize: { authorize: async () => true },
    });
    const prepared = await host.prepare(RUN_ID, {
      stateKey: STATE_KEY,
      claim: CLAIM,
      arguments: { id: "issue-1" },
    });
    if (prepared.kind !== "ready") throw new Error("expected ready preparation");
    const intent = normalizeToolIntent({
      intentId: EFFECT_ID,
      businessId: BUSINESS_ID,
      runId: RUN_ID,
      stateId: STATE_KEY,
      toolId: compiled.contract.spec.toolId,
      toolVersion: compiled.contract.spec.toolVersion,
      action: compiled.contract.spec.action,
      targetRefs: [],
      arguments: { id: "issue-1" },
      principalKind: "user",
      principalId: USER_ID,
      integrationId: prepared.integrationId,
      integrationMajorVersion: prepared.integrationMajorVersion,
      operationId: prepared.operationId,
      manifestDigest: prepared.manifestDigest,
      configurationDigest: prepared.configurationDigest,
      destination: prepared.destination,
      connection: prepared.connection,
      idempotencyKey: `routine:${RUN_ID}:${STATE_KEY}`,
    });
    await effects.reserve({
      effectId: EFFECT_ID,
      businessId: BUSINESS_ID,
      runId: RUN_ID,
      stateId: STATE_KEY,
      logicalEffectOrdinal: 1,
      idempotencyKey: intent.idempotencyKey,
      intentDigest: intentDigest(intent),
      intent,
      guardrailRevision: runtimeBundle.digest,
      createdAt: "2026-09-12T00:00:00.000Z",
    });
    await effects.beginAttempt(BUSINESS_ID, EFFECT_ID, "2026-09-12T00:00:01.000Z");
    row = connection({ tenant: "attacker.acme.test" });

    await expect(host.dispatch(RUN_ID, EFFECT_ID, { attempt: 1, claim: CLAIM })).resolves.toEqual({
      kind: "failed",
      error: {
        phase: "before_dispatch",
        code: "authorization_revoked",
        retryable: false,
      },
    });
    expect(http.sent).toHaveLength(0);
  });

  it("denies a revoked Connection before Secret redemption or provider dispatch", async () => {
    const manifest = credentialManifest();
    const compiled = compileOimHttpOperations(manifest, {})[0];
    if (compiled === undefined) throw new Error("credential fixture did not compile");
    const runtimeBundle = bundle(compiled.contract);
    const secretRef = "secret://11111111-1111-4111-8111-111111111111" as const;
    let row = credentialConnection(secretRef);
    const secret = secretService(secretRef, "provider-token");
    const effects = new MemoryEffectStore();
    const http = new RecordingHttp();
    const host = new InternalRoutineOimToolHost({
      businessId: BUSINESS_ID,
      releaseDispatch,
      releaseIntegration,
      runs: runAuthority(runtimeBundle),
      bundles: { load: async () => runtimeBundle },
      registrations: { find: async () => registration(manifest) },
      connections: resolver(() => row),
      effects,
      secrets: secret.load,
      http,
      authorize: { authorize: async () => true },
    });
    const prepared = await host.prepare(RUN_ID, {
      stateKey: STATE_KEY,
      claim: CLAIM,
      arguments: { text: "hello" },
    });
    if (prepared.kind !== "ready") throw new Error("expected ready preparation");
    expect(prepared.connection).toMatchObject({
      connectionId: "connection-1",
      credentialRevision: "revision-1",
    });
    const intent = normalizeToolIntent({
      intentId: EFFECT_ID,
      businessId: BUSINESS_ID,
      runId: RUN_ID,
      stateId: STATE_KEY,
      toolId: compiled.contract.spec.toolId,
      toolVersion: compiled.contract.spec.toolVersion,
      action: compiled.contract.spec.action,
      targetRefs: [],
      arguments: { text: "hello" },
      principalKind: "user",
      principalId: USER_ID,
      integrationId: prepared.integrationId,
      integrationMajorVersion: prepared.integrationMajorVersion,
      operationId: prepared.operationId,
      manifestDigest: prepared.manifestDigest,
      configurationDigest: prepared.configurationDigest,
      destination: prepared.destination,
      credentialRef: prepared.credentialRef,
      connection: prepared.connection,
      idempotencyKey: `routine:${RUN_ID}:${STATE_KEY}`,
    });
    await effects.reserve({
      effectId: EFFECT_ID,
      businessId: BUSINESS_ID,
      runId: RUN_ID,
      stateId: STATE_KEY,
      logicalEffectOrdinal: 1,
      idempotencyKey: intent.idempotencyKey,
      intentDigest: intentDigest(intent),
      intent,
      guardrailRevision: runtimeBundle.digest,
      createdAt: "2026-09-12T00:00:00.000Z",
    });
    await effects.beginAttempt(BUSINESS_ID, EFFECT_ID, "2026-09-12T00:00:01.000Z");
    const readsAfterPreparation = secret.resolveCurrent.mock.calls.length;
    row = credentialConnection(secretRef, "revoked");

    await expect(host.dispatch(RUN_ID, EFFECT_ID, { attempt: 1, claim: CLAIM })).resolves.toEqual({
      kind: "failed",
      error: {
        phase: "before_dispatch",
        code: "authorization_revoked",
        retryable: false,
      },
    });
    expect(secret.resolveCurrent).toHaveBeenCalledTimes(readsAfterPreparation);
    expect(http.sent).toHaveLength(0);
  });

  it("denies a transferred Run claim after Connection reauthorization but before Secret use", async () => {
    const manifest = credentialManifest();
    const compiled = compileOimHttpOperations(manifest, {})[0];
    if (compiled === undefined) throw new Error("credential fixture did not compile");
    const runtimeBundle = bundle(compiled.contract);
    const secretRef = "secret://11111111-1111-4111-8111-111111111111" as const;
    const secret = secretService(secretRef, "provider-token");
    const effects = new MemoryEffectStore();
    const http = new RecordingHttp();
    const liveConnections = resolver(credentialConnection(secretRef));
    const reauthorizeConnection = liveConnections.reauthorizeConnection.bind(liveConnections);
    let claimCurrent = true;
    vi.spyOn(liveConnections, "reauthorizeConnection").mockImplementation(async (...args) => {
      const resolved = await reauthorizeConnection(...args);
      claimCurrent = false;
      return resolved;
    });
    const claims = runAuthority(runtimeBundle);
    const host = new InternalRoutineOimToolHost({
      businessId: BUSINESS_ID,
      releaseDispatch,
      releaseIntegration,
      runs: {
        claim: async (input) => (claimCurrent ? claims.claim(input) : undefined),
      },
      bundles: { load: async () => runtimeBundle },
      registrations: { find: async () => registration(manifest) },
      connections: liveConnections,
      effects,
      secrets: secret.load,
      http,
      authorize: { authorize: async () => true },
    });
    const prepared = await host.prepare(RUN_ID, {
      stateKey: STATE_KEY,
      claim: CLAIM,
      arguments: { text: "hello" },
    });
    if (prepared.kind !== "ready") throw new Error("expected ready preparation");
    const intent = normalizeToolIntent({
      intentId: EFFECT_ID,
      businessId: BUSINESS_ID,
      runId: RUN_ID,
      stateId: STATE_KEY,
      toolId: compiled.contract.spec.toolId,
      toolVersion: compiled.contract.spec.toolVersion,
      action: compiled.contract.spec.action,
      targetRefs: [],
      arguments: { text: "hello" },
      principalKind: "user",
      principalId: USER_ID,
      integrationId: prepared.integrationId,
      integrationMajorVersion: prepared.integrationMajorVersion,
      operationId: prepared.operationId,
      manifestDigest: prepared.manifestDigest,
      configurationDigest: prepared.configurationDigest,
      destination: prepared.destination,
      credentialRef: prepared.credentialRef,
      connection: prepared.connection,
      idempotencyKey: `routine:${RUN_ID}:${STATE_KEY}`,
    });
    await effects.reserve({
      effectId: EFFECT_ID,
      businessId: BUSINESS_ID,
      runId: RUN_ID,
      stateId: STATE_KEY,
      logicalEffectOrdinal: 1,
      idempotencyKey: intent.idempotencyKey,
      intentDigest: intentDigest(intent),
      intent,
      guardrailRevision: runtimeBundle.digest,
      createdAt: "2026-09-12T00:00:00.000Z",
    });
    await effects.beginAttempt(BUSINESS_ID, EFFECT_ID, "2026-09-12T00:00:01.000Z");
    const readsAfterPreparation = secret.resolveCurrent.mock.calls.length;

    await expect(host.dispatch(RUN_ID, EFFECT_ID, { attempt: 1, claim: CLAIM })).resolves.toEqual({
      kind: "failed",
      error: {
        phase: "before_dispatch",
        code: "run_claim_lost",
        retryable: false,
      },
    });
    expect(secret.resolveCurrent).toHaveBeenCalledTimes(readsAfterPreparation);
    expect(http.sent).toHaveLength(0);
  });

  it("denies the resolved destination before reading a Connection Credential", async () => {
    const manifest = credentialManifest();
    const compiled = compileOimHttpOperations(manifest, {})[0];
    if (compiled === undefined) throw new Error("credential fixture did not compile");
    const runtimeBundle = bundle(compiled.contract);
    const secretRef = "secret://11111111-1111-4111-8111-111111111111" as const;
    const secrets = vi.fn(() => secretService(secretRef, "provider-token").load());
    const http = new RecordingHttp();
    const host = new InternalRoutineOimToolHost({
      businessId: BUSINESS_ID,
      releaseDispatch,
      releaseIntegration,
      runs: runAuthority(runtimeBundle),
      bundles: { load: async () => runtimeBundle },
      registrations: { find: async () => registration(manifest) },
      connections: resolver(credentialConnection(secretRef)),
      effects: new MemoryEffectStore(),
      secrets,
      http,
      authorize: { authorize: async () => false },
    });

    await expect(
      host.prepare(RUN_ID, {
        stateKey: STATE_KEY,
        claim: CLAIM,
        arguments: { text: "hello" },
      })
    ).resolves.toEqual({ kind: "failed", reason: "authorization_revoked" });
    expect(secrets).not.toHaveBeenCalled();
    expect(http.sent).toHaveLength(0);
  });

  it("leases a pinned Connection Credential only inside the API dispatch", async () => {
    const manifest = credentialManifest();
    const compiled = compileOimHttpOperations(manifest, {})[0];
    if (compiled === undefined) throw new Error("credential fixture did not compile");
    const runtimeBundle = bundle(compiled.contract);
    const secretRef = "secret://11111111-1111-4111-8111-111111111111" as const;
    const secret = secretService(secretRef, "provider-token");
    const effects = new MemoryEffectStore();
    const http = new RecordingHttp();
    const host = new InternalRoutineOimToolHost({
      businessId: BUSINESS_ID,
      releaseDispatch,
      releaseIntegration,
      runs: runAuthority(runtimeBundle),
      bundles: { load: async () => runtimeBundle },
      registrations: { find: async () => registration(manifest) },
      connections: resolver(credentialConnection(secretRef)),
      effects,
      secrets: secret.load,
      http,
      authorize: { authorize: async () => true },
    });
    const prepared = await host.prepare(RUN_ID, {
      stateKey: STATE_KEY,
      claim: CLAIM,
      arguments: { text: "hello" },
    });
    if (prepared.kind !== "ready") throw new Error("expected ready preparation");
    const intent = normalizeToolIntent({
      intentId: EFFECT_ID,
      businessId: BUSINESS_ID,
      runId: RUN_ID,
      stateId: STATE_KEY,
      toolId: compiled.contract.spec.toolId,
      toolVersion: compiled.contract.spec.toolVersion,
      action: compiled.contract.spec.action,
      targetRefs: [],
      arguments: { text: "hello" },
      principalKind: "user",
      principalId: USER_ID,
      integrationId: prepared.integrationId,
      integrationMajorVersion: prepared.integrationMajorVersion,
      operationId: prepared.operationId,
      manifestDigest: prepared.manifestDigest,
      configurationDigest: prepared.configurationDigest,
      destination: prepared.destination,
      credentialRef: prepared.credentialRef,
      connection: prepared.connection,
      idempotencyKey: `routine:${RUN_ID}:${STATE_KEY}`,
    });
    await effects.reserve({
      effectId: EFFECT_ID,
      businessId: BUSINESS_ID,
      runId: RUN_ID,
      stateId: STATE_KEY,
      logicalEffectOrdinal: 1,
      idempotencyKey: intent.idempotencyKey,
      intentDigest: intentDigest(intent),
      intent,
      guardrailRevision: runtimeBundle.digest,
      createdAt: "2026-09-12T00:00:00.000Z",
    });
    await effects.beginAttempt(BUSINESS_ID, EFFECT_ID, "2026-09-12T00:00:01.000Z");

    await expect(
      host.dispatch(RUN_ID, EFFECT_ID, { attempt: 1, claim: CLAIM })
    ).resolves.toMatchObject({
      kind: "succeeded",
    });
    expect(http.sent).toHaveLength(1);
    expect(http.sent[0]?.headers).toMatchObject({ Authorization: "Bearer provider-token" });
  });

  it.each(["multipart", "mime"] as const)(
    "authorizes every declared %s File before returning approval bindings",
    async (encoding) => {
      const manifest = multipartManifest();
      if (encoding === "mime") {
        manifest.profiles.core = "1.4";
        const operation = manifest.operations[0];
        if (operation?.source.type !== "http") throw new Error("invalid fixture");
        delete operation.source.multipart;
        delete operation.source.contentType;
        operation.source.mime = { outputPointer: "/raw", maxBytes: 1024 };
        operation.requestSchema = {
          type: "object",
          required: ["attachments"],
          properties: { attachments: { type: "array", items: { type: "string" } } },
          additionalProperties: false,
        };
      }
      const compiled = compileOimHttpOperations(manifest, {})[0];
      if (compiled === undefined) throw new Error("multipart fixture did not compile");
      const runtimeBundle = bundle(compiled.contract);
      const assertAuthorized = vi.fn(async () => undefined);
      const host = new InternalRoutineOimToolHost({
        businessId: BUSINESS_ID,
        releaseDispatch,
        releaseIntegration,
        runs: runAuthority(runtimeBundle),
        bundles: { load: async () => runtimeBundle },
        registrations: { find: async () => registration(manifest) },
        connections: resolver(connection({})),
        effects: new MemoryEffectStore(),
        secrets: noSecrets,
        http: new RecordingHttp(),
        authorize: { authorize: async () => true },
        fileAuthorizer: { assertAuthorized },
      });

      await expect(
        host.prepare(RUN_ID, {
          stateKey: STATE_KEY,
          claim: CLAIM,
          arguments: {
            body:
              encoding === "mime"
                ? { attachments: ["file-b", "file-a"] }
                : {
                    uploads: [{ fileId: "file-b" }, { fileId: "file-a" }],
                  },
          },
        })
      ).resolves.toMatchObject({
        kind: "ready",
        filePrincipalId: USER_ID,
        fileIds: ["file-a", "file-b"],
      });
      expect(assertAuthorized).toHaveBeenCalledWith({
        authority: authority(runtimeBundle.digest),
        bundle: runtimeBundle,
        contract: compiled.contract,
        stateKey: STATE_KEY,
        fileIds: ["file-a", "file-b"],
      });
    }
  );

  it("denies multipart File authority before effect, Secret, or provider work", async () => {
    const manifest = multipartManifest();
    const compiled = compileOimHttpOperations(manifest, {})[0];
    if (compiled === undefined) throw new Error("multipart fixture did not compile");
    const runtimeBundle = bundle(compiled.contract);
    const effects = new MemoryEffectStore();
    const http = new RecordingHttp();
    const secrets = vi.fn(noSecrets);
    const host = new InternalRoutineOimToolHost({
      businessId: BUSINESS_ID,
      releaseDispatch,
      releaseIntegration,
      runs: runAuthority(runtimeBundle),
      bundles: { load: async () => runtimeBundle },
      registrations: { find: async () => registration(manifest) },
      connections: resolver(connection({})),
      effects,
      secrets,
      http,
      authorize: { authorize: async () => true },
      fileAuthorizer: {
        assertAuthorized: async () => {
          throw new Error("denied");
        },
      },
    });

    await expect(
      host.prepare(RUN_ID, {
        stateKey: STATE_KEY,
        claim: CLAIM,
        arguments: {
          body: {
            uploads: [{ fileId: "file-a" }, { fileId: "file-b" }],
          },
        },
      })
    ).resolves.toEqual({ kind: "failed", reason: "file_access_denied" });
    expect(await effects.get(BUSINESS_ID, EFFECT_ID)).toBeUndefined();
    expect(secrets).not.toHaveBeenCalled();
    expect(http.sent).toHaveLength(0);
  });

  it("rechecks the exact multipart Files before opening a stream or provider request", async () => {
    const manifest = multipartManifest();
    const compiled = compileOimHttpOperations(manifest, {})[0];
    if (compiled === undefined) throw new Error("multipart fixture did not compile");
    const runtimeBundle = bundle(compiled.contract);
    const effects = new MemoryEffectStore();
    const http = new RecordingHttp();
    const content = vi.fn(async () => ({
      file: {
        id: "file-a",
        filename: "a.txt",
        mediaType: "text/plain",
        sizeBytes: 1,
      },
      body: (async function* () {
        yield new Uint8Array([65]);
      })(),
    }));
    const assertAuthorized = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("grant revoked"));
    const host = new InternalRoutineOimToolHost({
      businessId: BUSINESS_ID,
      releaseDispatch,
      releaseIntegration,
      runs: runAuthority(runtimeBundle),
      bundles: { load: async () => runtimeBundle },
      registrations: { find: async () => registration(manifest) },
      connections: resolver(connection({})),
      effects,
      secrets: noSecrets,
      http,
      authorize: { authorize: async () => true },
      fileAuthorizer: { assertAuthorized },
      files: {
        content,
        store: async () => {
          throw new Error("not used");
        },
      },
    });
    const arguments_ = {
      body: {
        uploads: [{ fileId: "file-a" }, { fileId: "file-b" }],
      },
    };
    const prepared = await host.prepare(RUN_ID, {
      stateKey: STATE_KEY,
      claim: CLAIM,
      arguments: arguments_,
    });
    if (prepared.kind !== "ready") throw new Error("expected ready preparation");
    const intent = normalizeToolIntent({
      intentId: EFFECT_ID,
      businessId: BUSINESS_ID,
      runId: RUN_ID,
      stateId: STATE_KEY,
      toolId: compiled.contract.spec.toolId,
      toolVersion: compiled.contract.spec.toolVersion,
      action: compiled.contract.spec.action,
      targetRefs: prepared.fileIds?.map((id) => ({ type: "platform.file", id })) ?? [],
      arguments: arguments_,
      principalKind: "user",
      principalId: USER_ID,
      filePrincipalId: prepared.filePrincipalId,
      fileIds: prepared.fileIds,
      integrationId: prepared.integrationId,
      integrationMajorVersion: prepared.integrationMajorVersion,
      operationId: prepared.operationId,
      manifestDigest: prepared.manifestDigest,
      configurationDigest: prepared.configurationDigest,
      destination: prepared.destination,
      idempotencyKey: `routine:${RUN_ID}:${STATE_KEY}`,
    });
    await effects.reserve({
      effectId: EFFECT_ID,
      businessId: BUSINESS_ID,
      runId: RUN_ID,
      stateId: STATE_KEY,
      logicalEffectOrdinal: 1,
      idempotencyKey: intent.idempotencyKey,
      intentDigest: intentDigest(intent),
      intent,
      guardrailRevision: runtimeBundle.digest,
      createdAt: "2026-09-12T00:00:00.000Z",
    });
    await effects.beginAttempt(BUSINESS_ID, EFFECT_ID, "2026-09-12T00:00:01.000Z");

    await expect(host.dispatch(RUN_ID, EFFECT_ID, { attempt: 1, claim: CLAIM })).resolves.toEqual({
      kind: "failed",
      error: {
        phase: "before_dispatch",
        code: "file_access_denied",
        retryable: false,
      },
    });
    expect(assertAuthorized).toHaveBeenCalledTimes(2);
    expect(content).not.toHaveBeenCalled();
    expect(http.sent).toHaveLength(0);
  });
});
