import {
  type DefinitionEnvelope,
  definitionRegistration,
  definitionSchema,
  refListSchema,
  TOOL_ADAPTER_KINDS,
  TOOL_IDEMPOTENCY_STRATEGIES,
  TOOL_RISK_CLASSES,
  type ToolAdapterKind,
  type ToolIdempotencyStrategy,
  type ToolRiskClass,
} from "./common";

/**
 * ToolContract authored definition (SPEC §7.1, §11). Versioned input/output/error schemas, risk
 * and mutation classification, required actions/resources, data classes, allowed destinations,
 * idempotency behaviour, timeout/retry rules, dry-run support, compensation/reconciliation
 * operations, and the implementation adapter. Every Tool call re-enters the Tool Broker; the
 * contract is data, not an execution bypass (SPEC §11.1).
 */

const KIND = "ToolContract";

/** An embedded JSON Schema carried as opaque data (the Tool's own input/output shape). */
const embeddedJsonSchema = { type: "object", additionalProperties: true } as const;

const toolSpecSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "toolId",
    "toolVersion",
    "action",
    "inputSchema",
    "outputSchema",
    "riskClass",
    "mutating",
    "dryRun",
    "idempotency",
    "adapter",
  ],
  properties: {
    toolId: { type: "string", minLength: 1, maxLength: 256 },
    toolVersion: { type: "string", minLength: 1, maxLength: 64 },
    description: { type: "string", minLength: 1, maxLength: 2_000 },
    action: { type: "string", minLength: 1, maxLength: 128 },
    inputSchema: embeddedJsonSchema,
    outputSchema: embeddedJsonSchema,
    errorSchema: embeddedJsonSchema,
    riskClass: { type: "string", enum: [...TOOL_RISK_CLASSES] },
    mutating: { type: "boolean" },
    requiredActions: refListSchema,
    requiredResources: refListSchema,
    dataClasses: refListSchema,
    allowedDestinations: refListSchema,
    idempotency: {
      type: "object",
      additionalProperties: false,
      required: ["strategy"],
      properties: {
        strategy: { type: "string", enum: [...TOOL_IDEMPOTENCY_STRATEGIES] },
      },
    },
    timeout: {
      type: "object",
      additionalProperties: false,
      properties: {
        activeMs: { type: "integer", minimum: 0 },
        wallClockMs: { type: "integer", minimum: 0 },
      },
    },
    retry: {
      type: "object",
      additionalProperties: false,
      required: ["maxAttempts", "safeToRetry"],
      properties: {
        maxAttempts: { type: "integer", minimum: 0 },
        safeToRetry: { type: "boolean" },
      },
    },
    dryRun: { type: "boolean" },
    compensation: {
      type: "object",
      additionalProperties: false,
      properties: {
        operation: { type: "string", minLength: 1, maxLength: 256 },
        reconciliation: { type: "string", minLength: 1, maxLength: 256 },
      },
    },
    adapter: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "ref"],
      properties: {
        kind: { type: "string", enum: [...TOOL_ADAPTER_KINDS] },
        ref: { type: "string", minLength: 1, maxLength: 256 },
      },
    },
  },
  allOf: [
    {
      if: {
        additionalProperties: true,
        required: ["mutating"],
        properties: { mutating: { const: true } },
      },
      // biome-ignore lint/suspicious/noThenProperty: `then` is a JSON Schema keyword.
      then: {
        additionalProperties: true,
        properties: {
          idempotency: {
            type: "object",
            additionalProperties: true,
            required: ["strategy"],
            properties: { strategy: { enum: ["provider", "reconcile"] } },
          },
        },
      },
    },
  ],
} as const;

export const ToolContractDefinitionSchema = definitionSchema(KIND, toolSpecSchema);

export const TOOL_CONTRACT_DEFINITION = definitionRegistration(KIND, ToolContractDefinitionSchema);

export interface ToolContractSpec {
  toolId: string;
  toolVersion: string;
  description?: string;
  action: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  errorSchema?: Record<string, unknown>;
  riskClass: ToolRiskClass;
  mutating: boolean;
  requiredActions?: string[];
  requiredResources?: string[];
  dataClasses?: string[];
  allowedDestinations?: string[];
  idempotency: { strategy: ToolIdempotencyStrategy };
  timeout?: { activeMs?: number; wallClockMs?: number };
  retry?: { maxAttempts: number; safeToRetry: boolean };
  dryRun: boolean;
  compensation?: { operation?: string; reconciliation?: string };
  adapter: { kind: ToolAdapterKind; ref: string };
}

export type ToolContractDefinition = DefinitionEnvelope<"ToolContract", ToolContractSpec>;
