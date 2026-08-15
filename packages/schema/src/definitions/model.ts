import { type Static, Type } from "@sinclair/typebox";
import {
  definitionRegistration,
  definitionSchema,
  MODEL_DATA_RETENTION,
  MODEL_MODALITIES,
  MODEL_REASONING_LEVELS,
  type ModelDataRetention,
  type ModelModality,
  type ModelReasoningLevel,
  refListSchema,
} from "./common";

/** ModelProfile definition; model output stays untrusted and never bypasses validation/policy. */

const KIND = "ModelProfile";

export const MODEL_PROFILE_DENIAL_REASONS = [
  "unknown_profile",
  "tools_unsupported",
  "structured_output_unsupported",
  "modality_unsupported",
  "context_window_exceeded",
  "residency_violation",
  "data_retention_violation",
  "training_not_permitted",
  "cost_budget_exceeded",
  // A declared cost ceiling that cannot be enforced, because a link in the selected chain has no
  // price. Distinct from `cost_budget_exceeded`: nothing was overspent, the limit is unenforceable.
  "cost_unpriceable",
  "token_budget_exceeded",
  "latency_budget_exceeded",
  "capability_class_mismatch",
] as const;

export type ModelProfileDenialReason = (typeof MODEL_PROFILE_DENIAL_REASONS)[number];

const modelSpecSchema = Type.Object(
  {
    provider: Type.String({ minLength: 1, maxLength: 128 }),
    model: Type.String({ minLength: 1, maxLength: 128 }),
    // Which named provider connection supplies credentials. Absent means "the connection named
    // after the provider" — so a single-account deployment never has to state it.
    connection: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    capabilityClass: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    reasoning: Type.Unsafe<ModelReasoningLevel>({
      type: "string",
      enum: [...MODEL_REASONING_LEVELS],
    }),
    supports: Type.Object(
      {
        tools: Type.Boolean(),
        structuredOutput: Type.Boolean(),
        contextWindowTokens: Type.Integer({ minimum: 1 }),
        // Modality is a dimension, not a rung: absent means text-only, which is what every
        // profile authored before modality existed actually was.
        inputModalities: Type.Optional(
          Type.Array(Type.Unsafe<ModelModality>({ type: "string", enum: [...MODEL_MODALITIES] }), {
            uniqueItems: true,
          })
        ),
        outputModalities: Type.Optional(
          Type.Array(Type.Unsafe<ModelModality>({ type: "string", enum: [...MODEL_MODALITIES] }), {
            uniqueItems: true,
          })
        ),
      },
      { additionalProperties: false }
    ),
    constraints: Type.Optional(
      Type.Object(
        {
          maxCostUsd: Type.Optional(Type.Number({ minimum: 0 })),
          maxTokens: Type.Optional(Type.Integer({ minimum: 0 })),
          maxLatencyMs: Type.Optional(Type.Integer({ minimum: 0 })),
          dataRetention: Type.Optional(
            Type.Unsafe<ModelDataRetention>({
              type: "string",
              enum: [...MODEL_DATA_RETENTION],
            })
          ),
          allowTraining: Type.Optional(Type.Boolean()),
          residency: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
        },
        { additionalProperties: false }
      )
    ),
    budgets: Type.Optional(
      Type.Object(
        {
          maxCostUsd: Type.Optional(Type.Number({ minimum: 0 })),
          maxTokens: Type.Optional(Type.Integer({ minimum: 0 })),
        },
        { additionalProperties: false }
      )
    ),
    // Fallbacks must satisfy the same Tool, data, residency, and budget constraints.
    fallbacks: Type.Optional(refListSchema),
    // Sensitive caching is off by default (SPEC §17); authors must state intent explicitly.
    allowCaching: Type.Boolean(),
  },
  { additionalProperties: false }
);

export const ModelProfileDefinitionSchema = definitionSchema(KIND, modelSpecSchema);

export const MODEL_PROFILE_DEFINITION = definitionRegistration(KIND, ModelProfileDefinitionSchema);

export type ModelProfileDefinition = Static<typeof ModelProfileDefinitionSchema>;
export type ModelProfileSpec = ModelProfileDefinition["spec"];
