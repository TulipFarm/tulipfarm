import {
  canonicalHash,
  type OimFixtureCase,
  type OimManifest,
  parseOimFixtureSuite,
  parseYamlDocument,
  type ToolContractDefinition,
} from "@tulipfarm/schema";
import {
  AdapterDispatchError,
  EffectDispatcher,
  EffectLedger,
  intentDigest,
  MemoryEffectStore,
  type ToolAdapter,
  type ToolAdapterRequest,
  ToolCatalog,
  ToolDispatchError,
} from "@tulipfarm/tool-broker";
import type { IntegrationHttpResponse } from "../http";
import type { OimFilePort } from "./oim-files";
import { OimGraphqlToolAdapter } from "./oim-graphql-adapter";
import { compileOimGraphqlOperations } from "./oim-graphql-compile";
import { OimHttpToolAdapter } from "./oim-http-adapter";
import { compileOimHttpOperations } from "./oim-http-compile";
import { compileOimOpenApiOperations } from "./oim-openapi-compile";
import type { EgressHttpPort, EgressHttpRequest } from "./openapi-adapter";

export interface OimFixtureResult {
  readonly name: string;
  readonly fixture: string;
  readonly passed: boolean;
  readonly error?: string;
}

const FIXTURE_CREDENTIAL = "oim-fixture-credential";

class RecordingFixtureHttp implements EgressHttpPort {
  request: EgressHttpRequest | undefined;

  constructor(private readonly response: IntegrationHttpResponse) {}

  async send(request: EgressHttpRequest): Promise<IntegrationHttpResponse> {
    if (this.request !== undefined)
      throw new Error("fixture transport received more than one request");
    this.request = request;
    if (
      request.binaryResponse !== undefined &&
      this.response.status >= 200 &&
      this.response.status < 300
    ) {
      if (typeof this.response.body !== "string") {
        throw new Error("binary fixture response body must be a string");
      }
      const bytes = new TextEncoder().encode(this.response.body);
      const declared = Number(
        this.response.headers["content-length"] ??
          this.response.headers["Content-Length"] ??
          bytes.byteLength
      );
      return {
        ...this.response,
        body: await request.binaryResponse({
          headers: this.response.headers,
          declaredBytes:
            Number.isSafeInteger(declared) && declared >= 0 ? declared : bytes.byteLength,
          body: (async function* () {
            yield bytes;
          })(),
        }),
      };
    }
    return this.response;
  }
}

class FixtureFilePort implements OimFilePort {
  constructor(private readonly fixtureName: string) {}

  async content(input: { readonly fileId: string }): Promise<{
    readonly file: {
      readonly id: string;
      readonly filename: string;
      readonly mediaType: string;
      readonly sizeBytes: number;
    };
    readonly body: AsyncIterable<Uint8Array>;
  }> {
    const bytes = new TextEncoder().encode(`fixture:${input.fileId}`);
    return {
      file: {
        id: input.fileId,
        filename: `${input.fileId}.fixture`,
        mediaType: "application/octet-stream",
        sizeBytes: bytes.byteLength,
      },
      body: (async function* () {
        yield bytes;
      })(),
    };
  }

  async store(input: {
    readonly filename: string;
    readonly claimedMediaType: string;
    readonly body: AsyncIterable<Uint8Array>;
  }): Promise<{
    readonly id: string;
    readonly filename: string;
    readonly mediaType: string;
    readonly sizeBytes: number;
  }> {
    let sizeBytes = 0;
    for await (const chunk of input.body) sizeBytes += chunk.byteLength;
    return {
      id: `fixture-${this.fixtureName}-file`,
      filename: input.filename,
      mediaType: input.claimedMediaType,
      sizeBytes,
    };
  }
}

function fixtureRequest(manifest: OimManifest, fixture: OimFixtureCase): ToolAdapterRequest {
  return {
    intent: {
      intentId: `fixture-${fixture.name}`,
      businessId: "oim-fixture",
      runId: `fixture-${fixture.name}`,
      stateId: `fixture-${fixture.name}`,
      toolId: `oim.${manifest.metadata.id}.fixture.${fixture.operationId}`,
      toolVersion: manifest.metadata.version,
      action: `integration.${manifest.metadata.id}.${fixture.operationId}`,
      targetRefs: [],
      arguments: fixture.request,
      idempotencyKey: `fixture-${fixture.name}`,
      filePrincipalId: "oim-fixture",
    },
    idempotencyKey: `fixture-${fixture.name}`,
    attempt: 1,
  };
}

function fixtureCredentials(operation: OimManifest["operations"][number]): Record<string, string> {
  return Object.fromEntries(
    [operation.credentialSlot, operation.secondaryCredential?.slot]
      .filter((slot): slot is string => slot !== undefined)
      .map((slot) => [slot, FIXTURE_CREDENTIAL])
  );
}

function valueDescription(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

function assertExpected(actual: unknown, expected: unknown, path: string): void {
  if (expected === null || typeof expected !== "object") {
    if (!Object.is(actual, expected)) {
      throw new Error(
        `${path} expected ${valueDescription(expected)}, got ${valueDescription(actual)}`
      );
    }
    return;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) {
      throw new Error(`${path} did not match the expected array`);
    }
    for (const [index, item] of expected.entries()) {
      assertExpected(actual[index], item, `${path}[${index}]`);
    }
    return;
  }
  if (actual === null || typeof actual !== "object" || Array.isArray(actual)) {
    throw new Error(`${path} did not match the expected object`);
  }
  for (const [key, value] of Object.entries(expected as Record<string, unknown>)) {
    if (!Object.hasOwn(actual, key)) throw new Error(`${path}.${key} was missing`);
    assertExpected((actual as Record<string, unknown>)[key], value, `${path}.${key}`);
  }
}

function validateFixtureConfiguration(manifest: OimManifest, fixture: OimFixtureCase): void {
  const declared = new Map(
    (manifest.auth?.configurationFields ?? []).map((field) => [field.id, field.type])
  );
  const credentialSlots = new Set((manifest.auth?.credentialSlots ?? []).map((slot) => slot.id));
  for (const [name, value] of Object.entries(fixture.configuration ?? {})) {
    if (credentialSlots.has(name)) {
      throw new Error(`configuration field ${name} is a credential slot`);
    }
    const type = declared.get(name);
    if (type === undefined) {
      throw new Error(`configuration field ${name} is not declared`);
    }
    const valid =
      type === "integer"
        ? typeof value === "number" && Number.isInteger(value)
        : type === "boolean"
          ? typeof value === "boolean"
          : typeof value === "string";
    if (!valid) {
      throw new Error(`configuration field ${name} must be ${type}`);
    }
  }
}

interface FixtureDispatch {
  readonly adapter: ToolAdapter;
  readonly contract: ToolContractDefinition;
}

interface FixtureDispatchFailure {
  readonly phase: "before_dispatch" | "after_dispatch";
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
}

async function dispatchFixture(
  manifest: OimManifest,
  fixture: OimFixtureCase,
  operation: OimManifest["operations"][number],
  compiled: FixtureDispatch,
  credentials: Readonly<Record<string, string>>,
  onAdapterError: (error: AdapterDispatchError) => void
): Promise<unknown> {
  const request = fixtureRequest(manifest, fixture);
  const intent = {
    ...request.intent,
    toolId: compiled.contract.spec.toolId,
    toolVersion: compiled.contract.spec.toolVersion,
    action: compiled.contract.spec.action,
  };
  const effectId = `fixture-effect-${canonicalHash({
    integrationId: manifest.metadata.id,
    fixture: fixture.name,
  })}`;
  const store = new MemoryEffectStore();
  await new EffectLedger(store).reserve({
    effectId,
    businessId: intent.businessId,
    runId: intent.runId,
    stateId: intent.stateId,
    logicalEffectOrdinal: 0,
    idempotencyKey: intent.idempotencyKey,
    intentDigest: intentDigest(intent),
    intent,
    guardrailRevision: "oim-fixture",
    createdAt: "2000-01-01T00:00:00.000Z",
  });
  const adapter: ToolAdapter = {
    kind: compiled.adapter.kind,
    async dispatch(dispatchedRequest) {
      try {
        return await compiled.adapter.dispatch(
          dispatchedRequest,
          operation.credentialSlot === undefined
            ? undefined
            : credentials[operation.credentialSlot],
          credentials
        );
      } catch (error) {
        if (error instanceof AdapterDispatchError) onAdapterError(error);
        throw error;
      }
    },
  };
  return new EffectDispatcher({
    store,
    catalog: ToolCatalog.load([compiled.contract]),
    adapters: new Map([[compiled.contract.spec.adapter.ref, adapter]]),
    now: () => "2000-01-01T00:00:00.000Z",
  }).dispatch(intent.businessId, effectId);
}

function fixtureDispatchFailure(
  error: unknown,
  adapterError: AdapterDispatchError | undefined
): FixtureDispatchFailure | undefined {
  if (adapterError !== undefined) {
    return {
      phase: adapterError.phase,
      code: adapterError.code,
      retryable: adapterError.retryable,
      ...(adapterError.retryAfterMs === undefined
        ? {}
        : { retryAfterMs: adapterError.retryAfterMs }),
    };
  }
  if (
    error instanceof ToolDispatchError &&
    (error.code === "invalid_output" ||
      (error.code === "ambiguous" && error.detail === "invalid_output"))
  ) {
    return { phase: "after_dispatch", code: "invalid_output", retryable: false };
  }
  return undefined;
}

async function runFixture(
  manifest: OimManifest,
  companions: ReadonlyMap<string, string>,
  fixture: OimFixtureCase
): Promise<void> {
  const operation = manifest.operations.find((candidate) => candidate.id === fixture.operationId);
  if (operation === undefined) throw new Error(`operation ${fixture.operationId} was not found`);
  validateFixtureConfiguration(manifest, fixture);

  const http = new RecordingFixtureHttp({
    status: fixture.response.status,
    headers: fixture.response.headers ?? {},
    body: fixture.response.body,
  });
  const credentials = fixtureCredentials(operation);
  const files = new FixtureFilePort(fixture.name);
  let result: unknown;
  let adapterError: AdapterDispatchError | undefined;

  try {
    let compiled: FixtureDispatch;
    if (operation.source.type === "http") {
      const tool = compileOimHttpOperations(manifest, fixture.configuration ?? {}).find(
        (candidate) => candidate.operation.id === fixture.operationId
      );
      if (tool === undefined)
        throw new Error(`operation ${fixture.operationId} is not a native HTTP operation`);
      compiled = {
        contract: tool.contract,
        adapter: new OimHttpToolAdapter({
          binding: tool.binding,
          http,
          files,
          manifest,
          toolId: tool.toolId,
          ...(tool.projection === undefined ? {} : { projection: tool.projection }),
          ...(tool.pagination === undefined ? {} : { pagination: tool.pagination }),
        }),
      };
    } else if (operation.source.type === "graphql") {
      const tool = compileOimGraphqlOperations(
        manifest,
        companions,
        fixture.configuration ?? {}
      ).find((candidate) => candidate.operation.id === fixture.operationId);
      if (tool === undefined)
        throw new Error(`operation ${fixture.operationId} is not a GraphQL operation`);
      compiled = {
        contract: tool.contract,
        adapter: new OimGraphqlToolAdapter({
          binding: tool.binding,
          http,
          manifest,
          ...(tool.projection === undefined ? {} : { projection: tool.projection }),
        }),
      };
    } else if (operation.source.type === "openapi") {
      const documents = new Map<string, unknown>();
      for (const file of (manifest.files ?? []).filter(
        (candidate) => candidate.role === "openapi"
      )) {
        const content = companions.get(file.path);
        if (content === undefined) continue;
        documents.set(file.path, parseYamlDocument(content));
      }
      const tool = compileOimOpenApiOperations(
        manifest,
        documents,
        fixture.configuration ?? {}
      ).find((candidate) => candidate.operation.id === fixture.operationId);
      if (tool === undefined)
        throw new Error(`operation ${fixture.operationId} is not an OpenAPI operation`);
      compiled = {
        contract: tool.contract,
        adapter: new OimHttpToolAdapter({
          binding: tool.binding,
          http,
          files,
          manifest,
          toolId: tool.toolId,
          ...(tool.projection === undefined ? {} : { projection: tool.projection }),
          ...(tool.pagination === undefined ? {} : { pagination: tool.pagination }),
        }),
      };
    } else {
      throw new Error(`operation ${fixture.operationId} has no runtime adapter`);
    }
    result = await dispatchFixture(manifest, fixture, operation, compiled, credentials, (error) => {
      adapterError = error;
    });
  } catch (error) {
    if (!("expectedError" in fixture.expect)) throw error;
    const failure = fixtureDispatchFailure(error, adapterError);
    if (failure === undefined) {
      throw new Error(
        `expected ${fixture.expect.expectedError.code}, got ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    assertExpected(http.request, fixture.expect.request, "request");
    assertExpected(failure, fixture.expect.expectedError, "error");
    return;
  }

  assertExpected(http.request, fixture.expect.request, "request");
  if ("expectedError" in fixture.expect) {
    throw new Error(`expected ${fixture.expect.expectedError.code}, got a successful result`);
  }
  assertExpected(result, fixture.expect.result, "result");
}

/**
 * Runs a package's declared fixture companions without network, clock, filesystem, or real
 * credential access. The compiler and adapters are the production implementations; only their
 * transport is replaced with the fixture's recorded response.
 */
export async function runOimFixtures(
  manifest: OimManifest,
  companions: ReadonlyMap<string, string>
): Promise<readonly OimFixtureResult[]> {
  const results: OimFixtureResult[] = [];
  for (const file of manifest.files ?? []) {
    if (file.role !== "fixture") continue;
    const content = companions.get(file.path);
    if (content === undefined) {
      results.push({
        name: file.path,
        fixture: file.path,
        passed: false,
        error: "fixture file is missing",
      });
      continue;
    }
    try {
      const suite = parseOimFixtureSuite(content);
      for (const fixture of suite.cases) {
        try {
          await runFixture(manifest, companions, fixture);
          results.push({ name: fixture.name, fixture: file.path, passed: true });
        } catch (error) {
          results.push({
            name: fixture.name,
            fixture: file.path,
            passed: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      results.push({
        name: file.path,
        fixture: file.path,
        passed: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}
