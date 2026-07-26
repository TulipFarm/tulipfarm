import {
  canonicalHash,
  type ToolContractDefinition,
  type ToolContractSpec,
} from "@tulipfarm/schema";

export const POSTGRES_ADAPTER_REF = "integration:postgres";

export const POSTGRES_TOOL_IDS = {
  read: "postgres.read",
  mutate: "postgres.mutate",
} as const;

const identifierSchema = {
  type: "string",
  pattern: "^[A-Za-z_][A-Za-z0-9_]*$",
} as const;

const whereSchema = {
  type: "array",
  maxItems: 20,
  items: {
    type: "object",
    additionalProperties: false,
    required: ["column", "equals"],
    properties: {
      column: identifierSchema,
      equals: {},
    },
  },
} as const;

const readInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schema", "table", "columns", "limit"],
  properties: {
    schema: identifierSchema,
    table: identifierSchema,
    columns: {
      type: "array",
      minItems: 1,
      uniqueItems: true,
      items: identifierSchema,
    },
    where: whereSchema,
    limit: { type: "integer", minimum: 1 },
  },
} as const;

const mutationInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["operation", "schema", "table", "returning"],
  properties: {
    operation: { type: "string", enum: ["insert", "update", "delete"] },
    schema: identifierSchema,
    table: identifierSchema,
    values: {
      type: "object",
      minProperties: 1,
      additionalProperties: true,
    },
    where: whereSchema,
    returning: {
      type: "array",
      minItems: 1,
      uniqueItems: true,
      items: identifierSchema,
    },
  },
} as const;

const resultSchema = {
  type: "object",
  additionalProperties: false,
  required: ["rows", "rowCount"],
  properties: {
    rows: {
      type: "array",
      items: { type: "object", additionalProperties: true },
    },
    rowCount: { type: "integer", minimum: 0 },
  },
} as const;

function publish(id: string, slug: string, spec: ToolContractSpec): ToolContractDefinition {
  return {
    apiVersion: "tulipfarm.ai/v1",
    kind: "ToolContract",
    metadata: {
      id,
      slug,
      schemaVersion: 1,
      authoredVersion: 1,
      lifecycle: "published",
      publishedDigest: canonicalHash(spec),
    },
    spec,
  };
}

export const POSTGRES_READ_TOOL_CONTRACT = publish(
  "7f5af47e-41f0-4dbc-9718-3ea64a3148ea",
  "postgres-read",
  {
    toolId: POSTGRES_TOOL_IDS.read,
    toolVersion: "1.0.0",
    action: POSTGRES_TOOL_IDS.read,
    inputSchema: readInputSchema,
    outputSchema: resultSchema,
    riskClass: "medium",
    mutating: false,
    requiredActions: ["integration.postgres.read"],
    requiredResources: ["postgres.table"],
    dataClasses: ["source_content"],
    idempotency: { strategy: "none" },
    retry: { maxAttempts: 2, safeToRetry: true },
    dryRun: false,
    adapter: { kind: "postgres", ref: POSTGRES_ADAPTER_REF },
  }
);

export const POSTGRES_MUTATION_TOOL_CONTRACT = publish(
  "d1be6428-e7b6-4438-940f-04e819d2ba31",
  "postgres-mutate",
  {
    toolId: POSTGRES_TOOL_IDS.mutate,
    toolVersion: "1.0.0",
    action: POSTGRES_TOOL_IDS.mutate,
    inputSchema: mutationInputSchema,
    outputSchema: resultSchema,
    riskClass: "high",
    mutating: true,
    requiredActions: ["integration.postgres.mutate"],
    requiredResources: ["postgres.table"],
    dataClasses: ["source_content"],
    idempotency: { strategy: "reconcile" },
    retry: { maxAttempts: 1, safeToRetry: false },
    dryRun: false,
    compensation: { reconciliation: "postgres.mutation.lookup" },
    adapter: { kind: "postgres", ref: POSTGRES_ADAPTER_REF },
  }
);

export const POSTGRES_TOOL_CONTRACTS = [
  POSTGRES_READ_TOOL_CONTRACT,
  POSTGRES_MUTATION_TOOL_CONTRACT,
] as const;
