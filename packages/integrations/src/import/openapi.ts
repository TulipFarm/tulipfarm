import {
  canonicalHash,
  type ToolContractDefinition,
  type ToolContractSpec,
} from "@tulipfarm/schema";
import {
  GovernedImportError,
  type GovernedImportRequestBase,
  type GovernedImportResult,
  type GovernedToolContractProposalPort,
  kebabCase,
  requireDestinations,
  requireExplicitSelection,
} from "./proposal";

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;

interface OpenApiOperation {
  readonly operationId?: unknown;
  readonly parameters?: unknown;
  readonly requestBody?: unknown;
  readonly responses?: unknown;
}

interface SelectedOpenApiOperation {
  readonly method: (typeof HTTP_METHODS)[number];
  readonly path: string;
  readonly operationId: string;
  readonly operation: OpenApiOperation;
}

export interface OpenApiImportRequest extends GovernedImportRequestBase {
  readonly integrationSlug: string;
  readonly document: unknown;
  readonly selectedOperations: readonly string[];
}

export interface OpenApiImportDependencies {
  readonly proposals: GovernedToolContractProposalPort;
  readonly definitionId: (slug: string) => string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function operations(document: unknown): SelectedOpenApiOperation[] {
  const root = record(document);
  if (
    root === undefined ||
    typeof root.openapi !== "string" ||
    (!root.openapi.startsWith("3.0.") && !root.openapi.startsWith("3.1."))
  ) {
    throw new GovernedImportError("discovery_invalid");
  }
  const paths = record(root.paths);
  if (paths === undefined) throw new GovernedImportError("discovery_invalid");
  const found: SelectedOpenApiOperation[] = [];
  for (const [path, pathValue] of Object.entries(paths)) {
    const pathItem = record(pathValue);
    if (pathItem === undefined) continue;
    for (const method of HTTP_METHODS) {
      const operation = record(pathItem[method]) as OpenApiOperation | undefined;
      if (operation === undefined || typeof operation.operationId !== "string") continue;
      found.push({ method, path, operationId: operation.operationId, operation });
    }
  }
  return found;
}

function inputSchema(operation: SelectedOpenApiOperation): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  if (Array.isArray(operation.operation.parameters)) {
    for (const candidate of operation.operation.parameters) {
      const parameter = record(candidate);
      if (
        parameter === undefined ||
        typeof parameter.name !== "string" ||
        record(parameter.schema) === undefined
      ) {
        throw new GovernedImportError("discovery_invalid");
      }
      properties[parameter.name] = parameter.schema;
      if (parameter.required === true) required.push(parameter.name);
    }
  }
  const requestBody = record(operation.operation.requestBody);
  if (requestBody !== undefined) {
    const content = record(requestBody.content);
    const media = record(content?.["application/json"]);
    const schema = record(media?.schema);
    if (schema === undefined) throw new GovernedImportError("discovery_invalid");
    properties.body = schema;
    if (requestBody.required === true) required.push("body");
  }
  return {
    type: "object",
    additionalProperties: false,
    ...(required.length === 0 ? {} : { required }),
    properties,
  };
}

function outputSchema(operation: SelectedOpenApiOperation): Record<string, unknown> {
  const responses = record(operation.operation.responses);
  if (responses === undefined) throw new GovernedImportError("discovery_invalid");
  for (const [status, responseValue] of Object.entries(responses)) {
    if (!/^2\d\d$/.test(status)) continue;
    const response = record(responseValue);
    const content = record(response?.content);
    const media = record(content?.["application/json"]);
    const schema = record(media?.schema);
    if (schema !== undefined) return schema;
  }
  throw new GovernedImportError("discovery_invalid");
}

function definition(
  request: OpenApiImportRequest,
  operation: SelectedOpenApiOperation,
  discoveryDigest: string,
  definitionId: (slug: string) => string
): ToolContractDefinition {
  const integrationSlug = kebabCase(request.integrationSlug);
  const operationSlug = kebabCase(operation.operationId);
  if (integrationSlug === "" || operationSlug === "") {
    throw new GovernedImportError("discovery_invalid");
  }
  const slug = `openapi-${integrationSlug}-${operationSlug}`;
  const mutating = operation.method !== "get";
  const operationDigest = canonicalHash(operation);
  const spec: ToolContractSpec = {
    toolId: `openapi.${integrationSlug}.${operationSlug}`,
    toolVersion: "1.0.0",
    action: operation.operationId,
    inputSchema: inputSchema(operation),
    outputSchema: outputSchema(operation),
    riskClass: mutating ? "high" : "medium",
    mutating,
    allowedDestinations: [...request.allowedDestinations],
    idempotency: { strategy: mutating ? "reconcile" : "none" },
    retry: { maxAttempts: 1, safeToRetry: false },
    dryRun: false,
    adapter: {
      kind: "openapi",
      ref: `openapi:${integrationSlug}:${discoveryDigest}:${operationDigest}`,
    },
  };
  return {
    apiVersion: "tulipfarm.ai/v1",
    kind: "ToolContract",
    metadata: {
      id: definitionId(slug),
      slug,
      displayName: operation.operationId,
      schemaVersion: 1,
      authoredVersion: 1,
      lifecycle: "draft",
    },
    spec,
  };
}

export async function importOpenApiAsProposal(
  request: OpenApiImportRequest,
  dependencies: OpenApiImportDependencies
): Promise<GovernedImportResult> {
  requireExplicitSelection(request.selectedOperations);
  requireDestinations(request.allowedDestinations);
  const available = operations(request.document);
  const byId = new Map(available.map((operation) => [operation.operationId, operation]));
  const selected = request.selectedOperations.map((operationId) => {
    const operation = byId.get(operationId);
    if (operation === undefined) throw new GovernedImportError("operation_not_found");
    return operation;
  });
  const discoveryDigest = canonicalHash({
    document: request.document,
    allowedDestinations: request.allowedDestinations,
  });
  const definitions = selected.map((operation) =>
    definition(request, operation, discoveryDigest, dependencies.definitionId)
  );
  const proposed = await dependencies.proposals.propose({
    id: request.changesetId,
    businessId: request.businessId,
    principalId: request.principalId,
    expectedBaseCommit: request.expectedBaseCommit,
    source: "import",
    discoveryDigest,
    activation: "proposal_only",
    requiresApproval: true,
    definitions,
  });
  return {
    proposalId: proposed.proposalId,
    discoveryDigest,
    proposedTools: definitions.map((tool) => tool.spec.toolId),
  };
}
