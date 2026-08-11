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

/**
 * ModelProfile bundle definition (SPEC §7.1, §17). Provider/model, capability class, reasoning
 * level, Tool/structured-output/context support, cost/latency/data-retention/training/residency
 * constraints, fallback order, budgets, and whether caching is permitted. Model output is
 * untrusted; AJV validation, Guardrail, and Tool authorization remain independent of the model.
 */

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
    // Ordered fallback ModelProfile references; fallback occurs only when the replacement meets the
    // same Tool/structured-output/context/data/residency/budget constraints (SPEC §17).
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
