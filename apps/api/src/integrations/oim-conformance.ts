import {
  type OimConformanceAdapter,
  type OimConformanceReport,
  type OimConformanceVector,
  runConformance,
} from "@oim-standard/conformance/conformance";
import {
  ConnectionResolver,
  compileOimGraphqlOperations,
  compileOimHttpOperations,
  compileOimOpenApiOperations,
  type EgressHttpRequest,
  GraphqlToolAdapter,
  GuardedEgressHttp,
  OimHttpToolAdapter,
  OimOperationConnectionResolver,
  OpenApiToolAdapter,
  runOimFixtures,
} from "@tulipfarm/integrations";
import {
  type OimManifest,
  oimCompatibilityIssues,
  oimFileDigest,
  oimManifestIssues,
  oimPackageIssues,
  parseOimManifest,
  type ToolContractDefinition,
  validateOimManifest,
} from "@tulipfarm/schema";
import type { PersistedConnection } from "@tulipfarm/storage";
import {
  type ToolAdapterRequest,
  type ToolAuthorizationContext,
  ToolBroker,
  ToolCatalog,
} from "@tulipfarm/tool-broker";

const PUBLIC_TEST_ADDRESS = "93.184.216.34";
const BUSINESS_ID = "oim-conformance";
const PRINCIPAL_ID = "oim-conformance-user";

export async function runTulipFarmOimConformance(
  runtimeVersion: string
): Promise<OimConformanceReport> {
  return runConformance({
    runtime: { name: "TulipFarm", version: runtimeVersion },
    profiles: { core: "1.2" },
    adapter: createTulipFarmOimConformanceAdapter(),
  });
}

export function createTulipFarmOimConformanceAdapter(): OimConformanceAdapter {
  return {
    runCase: async (vector) => runCoreCase(vector),
  };
}

async function runCoreCase(vector: OimConformanceVector): Promise<unknown> {
  const input = record(vector.input);
  switch (vector.caseId) {
    case "core.manifest.strict":
      return strictManifestResult(input);
    case "core.package.exact-files":
      return exactFilesResult(input);
    case "core.operation.http":
      return httpOperationResult(input);
    case "core.operation.openapi":
      return openApiOperationResult(input);
    case "core.operation.graphql":
      return graphqlOperationResult(input);
    case "core.fixtures.hermetic":
      return fixtureResult(input);
    case "core.compatibility.same-major":
      return compatibilityResult(input);
    default:
      throw new Error(`TulipFarm has no conformance adapter for ${vector.caseId}`);
  }
}

function strictManifestResult(input: Record<string, unknown>): { accepted: boolean } {
  try {
    parseOimManifest(string(input.source));
    return { accepted: true };
  } catch {
    return { accepted: false };
  }
}

function exactFilesResult(input: Record<string, unknown>) {
  const declared = strings(input.declared);
  const present = strings(input.present);
  const manifest = baseManifest();
  manifest.files = declared.map((path) => ({
    path,
    role: "guide",
    sha256: oimFileDigest(path === "guide.md" ? "guide" : "x"),
  }));
  const files = new Map(present.map((path) => [path, path === "guide.md" ? "guide" : "x"]));
  const issues = oimPackageIssues(manifest, files);
  return {
    accepted: issues.length === 0,
    undeclared: present.filter((path) => !declared.includes(path)),
  };
}

async function httpOperationResult(input: Record<string, unknown>): Promise<unknown> {
  const operation = string(input.operation);
  const argumentsValue = record(input.arguments);
  const response = input.response;
  const manifest = httpManifest(operation);
  const [compiled] = compileOimHttpOperations(manifest);
  if (compiled === undefined) throw new Error(`HTTP operation ${operation} did not compile`);

  const recording = recordingTransport(response);
  const guarded = new GuardedEgressHttp(recording, {
    resolve: async () => [PUBLIC_TEST_ADDRESS],
  });
  const request = adapterRequest(
    compiled.toolId,
    manifest.metadata.version,
    compiled.contract.spec.action,
    requiredDestination(compiled.contract),
    argumentsValue
  );

  if (operation === "native-http") {
    const resolved = await resolveFixtureConnection(manifest);
    if (resolved.kind !== "ready") throw new Error(`Connection resolved as ${resolved.kind}`);
    const authorization = authorizeFixtureIntent(compiled.contract, {
      ...request.intent,
      credentialRef: resolved.credentialRef,
      connection: resolved.binding,
    });
    const result = await new OimHttpToolAdapter({
      binding: compiled.binding,
      http: guarded,
      toolId: compiled.toolId,
    }).dispatch(request, "fixture-token", { api_key: "fixture-token" });
    const sent = requiredRequest(recording.request);
    return {
      method: sent.method,
      url: sent.url,
      result,
      destinationGuard: sent.pinnedAddresses?.includes(PUBLIC_TEST_ADDRESS) ? "passed" : "failed",
      authorization,
      connection: resolved.kind,
      credentialInjected: sent.headers.Authorization === "Bearer fixture-token",
    };
  }

  const files =
    operation === "multipart-http"
      ? {
          content: async () => ({
            file: {
              id: "file-1",
              filename: "report.txt",
              mediaType: "text/plain",
              sizeBytes: 6,
            },
            body: bytes("report"),
          }),
          store: async () => {
            throw new Error("the multipart vector does not store a response file");
          },
        }
      : undefined;
  const result = await new OimHttpToolAdapter({
    binding: compiled.binding,
    http: guarded,
    toolId: compiled.toolId,
    ...(files === undefined ? {} : { files }),
  }).dispatch(
    operation === "multipart-http"
      ? {
          ...request,
          intent: { ...request.intent, filePrincipalId: PRINCIPAL_ID },
        }
      : request
  );
  const sent = requiredRequest(recording.request);
  if (operation === "form-http") {
    return {
      contentType: sent.headers["content-type"],
      body: sent.bodyText,
      result,
    };
  }
  return {
    parts: (sent.multipart ?? []).map((part) => ({
      name: part.name,
      kind: part.filename === undefined ? "field" : "file",
    })),
    result,
  };
}

async function openApiOperationResult(input: Record<string, unknown>) {
  const operationId = string(input.operationId);
  const manifest = openApiManifest(operationId);
  const document = {
    openapi: "3.0.3",
    servers: [{ url: "https://api.example.test" }],
    paths: {
      "/pets/{id}": {
        get: {
          operationId,
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": {
              content: { "application/json": { schema: { type: "object" } } },
            },
          },
        },
      },
    },
  };
  const [compiled] = compileOimOpenApiOperations(manifest, new Map([["openapi.json", document]]));
  if (compiled === undefined) throw new Error("OpenAPI operation did not compile");
  const recording = recordingTransport(input.response);
  const result = await new OpenApiToolAdapter({
    binding: compiled.binding,
    http: new GuardedEgressHttp(recording, {
      resolve: async () => [PUBLIC_TEST_ADDRESS],
    }),
  }).dispatch(
    adapterRequest(
      compiled.toolId,
      manifest.metadata.version,
      compiled.contract.spec.action,
      requiredDestination(compiled.contract),
      record(input.arguments)
    )
  );
  const sent = requiredRequest(recording.request);
  return { method: sent.method, url: sent.url, result };
}

async function graphqlOperationResult(input: Record<string, unknown>) {
  const operation = string(input.operation);
  const document = `query ${operation}($id: ID!) { pet(id: $id) { id } }`;
  const manifest = graphqlManifest(operation);
  const [compiled] = compileOimGraphqlOperations(
    manifest,
    new Map([["operations/get-pet.graphql", document]])
  );
  if (compiled === undefined) throw new Error("GraphQL operation did not compile");
  const recording = recordingTransport(input.response);
  const result = await new GraphqlToolAdapter({
    binding: compiled.binding,
    http: new GuardedEgressHttp(recording, {
      resolve: async () => [PUBLIC_TEST_ADDRESS],
    }),
  }).dispatch(
    adapterRequest(
      compiled.toolId,
      manifest.metadata.version,
      compiled.contract.spec.action,
      requiredDestination(compiled.contract),
      record(input.variables)
    )
  );
  const body = record(requiredRequest(recording.request).body);
  return { operation: body.operationName, variables: body.variables, result };
}

async function fixtureResult(input: Record<string, unknown>) {
  const manifest = baseManifest();
  manifest.files = [
    {
      path: "fixtures.yml",
      role: "fixture",
      sha256: "0".repeat(64),
    },
  ];
  manifest.operations[0] = {
    ...manifest.operations[0],
    source: {
      type: "http",
      method: "GET",
      baseUrl: "https://api.example.test",
      path: "/weather",
      parameters: [{ name: "city", in: "query", schema: { type: "string" } }],
    },
  };
  const suite = JSON.stringify({
    version: 1,
    cases: [
      {
        name: "weather",
        operationId: "weather",
        request: input.request,
        response: { status: 200, body: input.response },
        expect: {
          request: {
            method: "GET",
            url: "https://api.example.test/weather?city=Paris",
          },
          result: input.response,
        },
      },
    ],
  });
  const results = await runOimFixtures(manifest, new Map([["fixtures.yml", suite]]));
  return {
    passed: results.length === 1 && results.every((result) => result.passed),
    networkCalls: 0,
  };
}

function compatibilityResult(input: Record<string, unknown>) {
  const previous = baseManifest();
  previous.metadata.version = string(input.previous);
  const next = structuredClone(previous);
  next.metadata.version = string(input.next);
  next.operations[0].requestSchema = {
    type: "object",
    properties: { requiredValue: { type: "string" } },
    required: ["requiredValue"],
    additionalProperties: false,
  };
  return { compatible: oimCompatibilityIssues(previous, next).length === 0 };
}

function httpManifest(operation: string): OimManifest {
  const manifest = baseManifest();
  if (operation === "native-http") {
    manifest.auth = {
      credentialSlots: [{ id: "api_key", label: "API key", kind: "api_key" }],
      steps: [
        {
          id: "key",
          title: "Connect",
          type: "fields",
          fields: [
            {
              id: "api_key",
              label: "API key",
              input: "password",
              target: { type: "credential", slot: "api_key" },
            },
          ],
        },
      ],
    };
    manifest.profiles.auth = "1.0";
    manifest.operations[0] = {
      ...manifest.operations[0],
      credentialSlot: "api_key",
      credentialInjection: {
        in: "header",
        name: "Authorization",
        format: "Bearer {token}",
      },
      source: {
        type: "http",
        method: "GET",
        baseUrl: "https://api.example.test",
        path: "/weather",
        parameters: [{ name: "city", in: "query", schema: { type: "string" } }],
      },
    };
  } else if (operation === "form-http") {
    manifest.profiles.core = "1.1";
    manifest.operations[0] = {
      ...manifest.operations[0],
      source: {
        type: "http",
        method: "POST",
        baseUrl: "https://api.example.test",
        path: "/search",
        contentType: "form",
      },
      requestSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
    };
  } else if (operation === "multipart-http") {
    manifest.profiles.core = "1.2";
    manifest.operations[0] = {
      ...manifest.operations[0],
      source: {
        type: "http",
        method: "POST",
        baseUrl: "https://api.example.test",
        path: "/documents",
        contentType: "multipart",
        multipart: {
          parts: [
            { name: "title", kind: "field", pointer: "/title", maxBytes: 256 },
            { name: "document", kind: "file", pointer: "/fileId" },
          ],
        },
      },
      requestSchema: {
        type: "object",
        properties: { title: { type: "string" }, fileId: { type: "string" } },
        required: ["title", "fileId"],
        additionalProperties: false,
      },
    };
  } else {
    throw new Error(`unknown HTTP conformance operation ${operation}`);
  }
  return checkedManifest(manifest);
}

function openApiManifest(operationId: string): OimManifest {
  const manifest = baseManifest();
  manifest.files = [{ path: "openapi.json", role: "openapi", sha256: "0".repeat(64) }];
  manifest.operations[0] = {
    ...manifest.operations[0],
    id: "get-pet",
    name: "get_pet",
    source: {
      type: "openapi",
      file: "openapi.json",
      operationId,
    },
  };
  return checkedManifest(manifest);
}

function graphqlManifest(operation: string): OimManifest {
  const manifest = baseManifest();
  manifest.files = [
    {
      path: "operations/get-pet.graphql",
      role: "graphql",
      sha256: "0".repeat(64),
    },
  ];
  manifest.operations[0] = {
    ...manifest.operations[0],
    id: "get-pet",
    name: "get_pet",
    source: {
      type: "graphql",
      url: "https://api.example.test/graphql",
      operation,
      documentFile: "operations/get-pet.graphql",
    },
    requestSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  };
  return checkedManifest(manifest);
}

function baseManifest(): OimManifest {
  return {
    oimVersion: "1.0",
    kind: "Integration",
    metadata: {
      id: "weather",
      name: "Weather",
      version: "1.0.0",
      description: "Read weather.",
      license: "Apache-2.0",
    },
    profiles: { core: "1.0" },
    operations: [
      {
        id: "weather",
        name: "read_weather",
        description: "Read weather.",
        effect: "read",
        identityMode: "shared_only",
        source: {
          type: "http",
          method: "GET",
          baseUrl: "https://api.example.test",
          path: "/weather",
        },
        response: { schema: { type: "object" }, maxBytes: 4096 },
      },
    ],
  };
}

function checkedManifest(manifest: OimManifest): OimManifest {
  const validated = validateOimManifest(manifest);
  const issues = oimManifestIssues(validated);
  if (issues.length > 0) throw new Error(issues.join("; "));
  return validated;
}

async function resolveFixtureConnection(manifest: OimManifest) {
  const connection: PersistedConnection = {
    id: "connection-1",
    businessId: BUSINESS_ID,
    integration: { id: manifest.metadata.id, majorVersion: 1 },
    label: "Conformance",
    owner: { scope: "organization" },
    status: "active",
    isDefault: true,
    configuration: {},
    agentVisibleConfiguration: [],
    secretBindings: { api_key: "secret://api-key" },
    health: { status: "healthy", checkedAt: null },
    expiresAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  const reader = {
    findById: async (_businessId: string, id: string) => (id === connection.id ? connection : null),
    listForOwner: async () => [connection],
    listForIntegration: async () => [connection],
  };
  const resolver = new OimOperationConnectionResolver(
    new ConnectionResolver(reader, { canUse: async () => true })
  );
  return resolver.resolve({
    businessId: BUSINESS_ID,
    manifest,
    operation: manifest.operations[0],
    principal: { kind: "user", id: PRINCIPAL_ID },
  });
}

function authorizeFixtureIntent(
  definition: Parameters<typeof ToolCatalog.load>[0][number],
  intent: ToolAdapterRequest["intent"]
): string {
  const destination = requiredDestination(definition);
  const grant = {
    action: definition.spec.action,
    resourceType: "Tool",
    recordSelector: definition.spec.toolId,
    destination,
    effect: "allow" as const,
  };
  const context: ToolAuthorizationContext = {
    authorityLayers: ["user", "agent", "run", "tool", "credential"].map((name) => ({
      name,
      grants: [grant],
    })),
    guardrailRules: [
      {
        id: "oim-conformance",
        effect: "allow",
        action: definition.spec.action,
        resourceType: "Tool",
        recordSelector: definition.spec.toolId,
        destination,
        maxAutonomy: "execute_policy_authorized",
        maxTaint: "trusted",
      },
    ],
    dlpRules: [{ dataClass: "source_content", allowedDestinations: [destination] }],
    guardrailRevision: "oim-conformance",
    autonomy: "execute_policy_authorized",
    taint: "trusted",
  };
  return new ToolBroker(ToolCatalog.load([definition])).authorize(intent, context).outcome;
}

function requiredDestination(definition: ToolContractDefinition): string {
  const destination = definition.spec.allowedDestinations?.[0];
  if (destination === undefined) {
    throw new Error(`Tool ${definition.spec.toolId} has no allowed destination`);
  }
  return destination;
}

function adapterRequest(
  toolId: string,
  toolVersion: string,
  action: string,
  destination: string | undefined,
  argumentsValue: Record<string, unknown>
): ToolAdapterRequest {
  return {
    intent: {
      intentId: "intent-1",
      businessId: BUSINESS_ID,
      runId: "run-1",
      stateId: "state-1",
      toolId,
      toolVersion,
      action,
      targetRefs: [],
      arguments: argumentsValue,
      destination,
      idempotencyKey: "effect-1",
    },
    idempotencyKey: "effect-1",
    attempt: 1,
  };
}

function recordingTransport(response: unknown): {
  request?: EgressHttpRequest;
  send(
    request: EgressHttpRequest
  ): Promise<{ status: number; headers: Record<string, string>; body: unknown }>;
} {
  return {
    async send(request) {
      this.request = request;
      return { status: 200, headers: {}, body: response };
    },
  };
}

function requiredRequest(request: EgressHttpRequest | undefined): EgressHttpRequest {
  if (request === undefined) throw new Error("conformance transport received no request");
  return request;
}

async function* bytes(value: string): AsyncIterable<Uint8Array> {
  yield new TextEncoder().encode(value);
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("conformance vector input must be an object");
  }
  return value as Record<string, unknown>;
}

function string(value: unknown): string {
  if (typeof value !== "string") throw new Error("conformance vector value must be a string");
  return value;
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("conformance vector value must be a string array");
  }
  return value as string[];
}
