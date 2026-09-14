import {
  canonicalHash,
  type OimManifest,
  type OimOperation,
  oimToolId,
  type ToolContractDefinition,
  type ToolContractSpec,
} from "@tulipfarm/schema";
import { type CompiledOimGraphqlTool, compileOimGraphqlOperations } from "./oim-graphql-compile";
import {
  type CompiledOimHttpTool,
  compileOimHttpOperations,
  type OimCompileOptions,
  type OimConfiguration,
} from "./oim-http-compile";
import { type CompiledOimOpenApiTool, compileOimOpenApiOperations } from "./oim-openapi-compile";

export type CompiledOimLeafTool =
  | CompiledOimHttpTool
  | CompiledOimGraphqlTool
  | CompiledOimOpenApiTool;
export type CompiledOimTool = CompiledOimLeafTool | CompiledOimCompositeTool;

export type OimCompositeCompileErrorCode =
  | "source_not_composite"
  | "component_not_found"
  | "component_cycle";

export class OimCompositeCompileError extends Error {
  readonly name = "OimCompositeCompileError";

  constructor(
    readonly code: OimCompositeCompileErrorCode,
    readonly operationId: string
  ) {
    super(`oim_composite_compile:${code}:${operationId}`);
  }
}

export interface CompiledOimCompositeStep {
  readonly id: string;
  readonly bindings: NonNullable<
    Extract<OimOperation["source"], { type: "composite" }>["steps"][number]["bindings"]
  >;
  readonly tool: CompiledOimTool;
}

export interface CompiledOimCompositeTool {
  readonly operation: OimOperation;
  readonly name: string;
  readonly description: string;
  readonly mutating: boolean;
  readonly toolId: string;
  readonly adapterRef: string;
  readonly contract: ToolContractDefinition;
  readonly binding: { readonly steps: readonly CompiledOimCompositeStep[] };
  readonly projection?: undefined;
  readonly pagination?: undefined;
  readonly steps: readonly CompiledOimCompositeStep[];
}

const RISK_RANK = { low: 0, medium: 1, high: 2 } as const;

function strongestRisk(tools: readonly CompiledOimTool[]): ToolContractSpec["riskClass"] {
  return tools.reduce<ToolContractSpec["riskClass"]>(
    (strongest, tool) =>
      RISK_RANK[tool.contract.spec.riskClass] > RISK_RANK[strongest]
        ? tool.contract.spec.riskClass
        : strongest,
    "low"
  );
}

function compileContract(
  manifest: OimManifest,
  operation: OimOperation,
  steps: readonly CompiledOimCompositeStep[]
): ToolContractDefinition {
  const final = steps.at(-1)?.tool;
  if (final === undefined) throw new OimCompositeCompileError("component_not_found", operation.id);
  const children = steps.map((step) => step.tool);
  const mutating = children.some((tool) => tool.mutating);
  const spec: ToolContractSpec = {
    toolId: oimToolId(manifest, operation.id),
    toolVersion: manifest.metadata.version,
    description: operation.description,
    action: `integration.${manifest.metadata.id}.${operation.name}`,
    requiredActions: [
      ...new Set(
        children.flatMap(
          (tool) => tool.contract.spec.requiredActions ?? [tool.contract.spec.action]
        )
      ),
    ].sort(),
    inputSchema: operation.requestSchema ?? { type: "object", additionalProperties: false },
    outputSchema: final.contract.spec.outputSchema,
    riskClass: strongestRisk(children),
    mutating,
    allowedDestinations: [
      ...new Set(children.flatMap((tool) => tool.contract.spec.allowedDestinations ?? [])),
    ].sort(),
    dataClasses: ["source_content"],
    dryRun: false,
    idempotency: { strategy: mutating ? "reconcile" : "none" },
    retry: { maxAttempts: 3, safeToRetry: true },
    adapter: {
      kind: "native",
      ref: `oim-composite:${canonicalHash({ operation, steps }).slice(0, 32)}`,
    },
  };
  return {
    apiVersion: "tulipfarm.ai/v1",
    kind: "ToolContract",
    metadata: {
      id: `oim-composite-${canonicalHash(spec.toolId).slice(0, 21)}`,
      slug: `${manifest.metadata.id}-${operation.name}`,
      displayName: operation.name,
      schemaVersion: 1,
      authoredVersion: 1,
      lifecycle: "published",
      publishedDigest: canonicalHash(spec),
    },
    spec,
  };
}

/** Compiles bounded composite operations from the same declared leaf operations they invoke. */
export function compileOimCompositeOperations(
  manifest: OimManifest,
  documents: ReadonlyMap<string, string> = new Map(),
  openApiDocuments: ReadonlyMap<string, unknown> = new Map(),
  configuration: OimConfiguration = {},
  options: OimCompileOptions = {}
): CompiledOimCompositeTool[] {
  const operations = new Map(manifest.operations.map((operation) => [operation.id, operation]));
  const leaves = new Map(
    [
      ...compileOimHttpOperations(manifest, configuration, options),
      ...compileOimGraphqlOperations(manifest, documents, configuration, options),
      ...compileOimOpenApiOperations(manifest, openApiDocuments, configuration, options),
    ].map((tool) => [tool.operation.id, tool])
  );
  const compiled = new Map<string, CompiledOimCompositeTool>();

  const compile = (operation: OimOperation, stack: readonly string[]): CompiledOimTool => {
    if (operation.source.type !== "composite") {
      const leaf = leaves.get(operation.id);
      if (leaf === undefined) {
        throw new OimCompositeCompileError("component_not_found", operation.id);
      }
      return leaf;
    }
    const cached = compiled.get(operation.id);
    if (cached !== undefined) return cached;
    if (stack.includes(operation.id)) {
      throw new OimCompositeCompileError("component_cycle", operation.id);
    }
    const steps = operation.source.steps.map((step) => {
      const component = operations.get(step.operationId);
      if (component === undefined) {
        throw new OimCompositeCompileError("component_not_found", operation.id);
      }
      return {
        id: step.id,
        bindings: step.bindings ?? [],
        tool: compile(component, [...stack, operation.id]),
      };
    });
    const contract = compileContract(manifest, operation, steps);
    const result: CompiledOimCompositeTool = {
      operation,
      name: operation.name,
      description: operation.description,
      mutating: contract.spec.mutating,
      toolId: contract.spec.toolId,
      adapterRef: contract.spec.adapter.ref,
      contract,
      binding: { steps },
      steps,
    };
    compiled.set(operation.id, result);
    return result;
  };

  return manifest.operations
    .filter((operation) => operation.source.type === "composite")
    .map((operation) => compile(operation, []) as CompiledOimCompositeTool);
}
