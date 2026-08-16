import { type Static, Type } from "@sinclair/typebox";
import {
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

/** ToolContract definition; every call still re-enters the Tool Broker. */

const KIND = "ToolContract";

/** An embedded JSON Schema carried as opaque data (the Tool's own input/output shape). */
const embeddedJsonSchema = Type.Unsafe<Record<string, unknown>>({
  type: "object",
  additionalProperties: true,
});

/**
 * How one call's arguments name the object it acts on, so a grant can be scoped to that object
 * rather than to the whole Tool. `id` is a template over the call's own arguments: `{issueNumber}`
 * interpolates a dotted argument path, and anything else is literal. Every declared `type` must
 * also appear in `requiredResources`, because derived targets replace the static resource list at
 * the authorization gate.
 */
const targetBindingListSchema = Type.Array(
  Type.Object(
    {
      type: Type.String({ minLength: 1, maxLength: 128 }),
      id: Type.String({ minLength: 1, maxLength: 512 }),
      domain: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    },
    { additionalProperties: false }
  ),
  { minItems: 1, maxItems: 16 }
);

const toolSpecSchema = Type.Object(
  {
    toolId: Type.String({ minLength: 1, maxLength: 256 }),
    toolVersion: Type.String({ minLength: 1, maxLength: 64 }),
    description: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000 })),
    action: Type.String({ minLength: 1, maxLength: 128 }),
    inputSchema: embeddedJsonSchema,
    outputSchema: embeddedJsonSchema,
    errorSchema: Type.Optional(embeddedJsonSchema),
    riskClass: Type.Unsafe<ToolRiskClass>({ type: "string", enum: [...TOOL_RISK_CLASSES] }),
    mutating: Type.Boolean(),
    requiredActions: Type.Optional(refListSchema),
    requiredResources: Type.Optional(refListSchema),
    targets: Type.Optional(targetBindingListSchema),
    dataClasses: Type.Optional(refListSchema),
    allowedDestinations: Type.Optional(refListSchema),
    dryRun: Type.Boolean(),
    idempotency: Type.Object(
      {
        strategy: Type.Unsafe<ToolIdempotencyStrategy>({
          type: "string",
          enum: [...TOOL_IDEMPOTENCY_STRATEGIES],
        }),
      },
      { additionalProperties: false }
    ),
    timeout: Type.Optional(
      Type.Object(
        {
          activeMs: Type.Optional(Type.Integer({ minimum: 0 })),
          wallClockMs: Type.Optional(Type.Integer({ minimum: 0 })),
        },
        { additionalProperties: false }
      )
    ),
    retry: Type.Optional(
      Type.Object(
        {
          maxAttempts: Type.Integer({ minimum: 0 }),
          safeToRetry: Type.Boolean(),
        },
        { additionalProperties: false }
      )
    ),
    compensation: Type.Optional(
      Type.Object(
        {
          operation: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
          reconciliation: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        },
        { additionalProperties: false }
      )
    ),
    adapter: Type.Object(
      {
        kind: Type.Unsafe<ToolAdapterKind>({ type: "string", enum: [...TOOL_ADAPTER_KINDS] }),
        ref: Type.String({ minLength: 1, maxLength: 256 }),
      },
      { additionalProperties: false }
    ),
  },
  {
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
  }
);

export const ToolContractDefinitionSchema = definitionSchema(KIND, toolSpecSchema);

export const TOOL_CONTRACT_DEFINITION = definitionRegistration(KIND, ToolContractDefinitionSchema);

export type ToolContractDefinition = Static<typeof ToolContractDefinitionSchema>;
export type ToolContractSpec = ToolContractDefinition["spec"];
