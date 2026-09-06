import { type OimFixtureCase, type OimManifest, parseOimFixtureSuite } from "@tulipfarm/schema";
import type { ToolAdapterRequest } from "@tulipfarm/tool-broker";
import type { IntegrationHttpResponse } from "../http";
import { GraphqlToolAdapter } from "./graphql-adapter";
import { compileOimGraphqlOperations } from "./oim-graphql-compile";
import { OimHttpToolAdapter } from "./oim-http-adapter";
import { compileOimHttpOperations } from "./oim-http-compile";
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
    return this.response;
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

async function runFixture(
  manifest: OimManifest,
  companions: ReadonlyMap<string, string>,
  fixture: OimFixtureCase
): Promise<void> {
  const operation = manifest.operations.find((candidate) => candidate.id === fixture.operationId);
  if (operation === undefined) throw new Error(`operation ${fixture.operationId} was not found`);

  const http = new RecordingFixtureHttp({
    status: fixture.response.status,
    headers: fixture.response.headers ?? {},
    body: fixture.response.body,
  });
  const request = fixtureRequest(manifest, fixture);
  const credentials = fixtureCredentials(operation);
  let result: unknown;

  if (operation.source.type === "http") {
    const tool = compileOimHttpOperations(manifest).find(
      (candidate) => candidate.operation.id === fixture.operationId
    );
    if (tool === undefined)
      throw new Error(`operation ${fixture.operationId} is not a native HTTP operation`);
    result = await new OimHttpToolAdapter({
      binding: tool.binding,
      http,
      toolId: tool.toolId,
    }).dispatch(
      request,
      operation.credentialSlot === undefined ? undefined : credentials[operation.credentialSlot],
      credentials
    );
  } else if (operation.source.type === "graphql") {
    const tool = compileOimGraphqlOperations(manifest, companions).find(
      (candidate) => candidate.operation.id === fixture.operationId
    );
    if (tool === undefined)
      throw new Error(`operation ${fixture.operationId} is not a GraphQL operation`);
    result = await new GraphqlToolAdapter({ binding: tool.binding, http }).dispatch(
      request,
      operation.credentialSlot === undefined ? undefined : credentials[operation.credentialSlot],
      credentials
    );
  } else {
    throw new Error(`operation ${fixture.operationId} has no runtime adapter`);
  }

  assertExpected(http.request, fixture.expect.request, "request");
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
