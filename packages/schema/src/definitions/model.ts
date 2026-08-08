import {
  type DefinitionEnvelope,
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
 * ModelProfile authored definition (SPEC §7.1, §17). Provider/model, capability class, reasoning
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

const modelSpecSchema = {
  type: "object",
  additionalProperties: false,
  required: ["provider", "model", "reasoning", "supports", "allowCaching"],
  properties: {
    provider: { type: "string", minLength: 1, maxLength: 128 },
    model: { type: "string", minLength: 1, maxLength: 128 },
    // Which named provider connection supplies credentials. Absent means "the connection named
    // after the provider" — so a single-account deployment never has to state it.
    connection: { type: "string", minLength: 1, maxLength: 128 },
    capabilityClass: { type: "string", minLength: 1, maxLength: 64 },
    reasoning: { type: "string", enum: [...MODEL_REASONING_LEVELS] },
    supports: {
      type: "object",
      additionalProperties: false,
      required: ["tools", "structuredOutput", "contextWindowTokens"],
      properties: {
        tools: { type: "boolean" },
        structuredOutput: { type: "boolean" },
        contextWindowTokens: { type: "integer", minimum: 1 },
        // Modality is a dimension, not a rung: absent means text-only, which is what every
        // profile authored before modality existed actually was.
        inputModalities: {
          type: "array",
          uniqueItems: true,
          items: { type: "string", enum: [...MODEL_MODALITIES] },
        },
        outputModalities: {
          type: "array",
          uniqueItems: true,
          items: { type: "string", enum: [...MODEL_MODALITIES] },
        },
      },
    },
    constraints: {
      type: "object",
      additionalProperties: false,
      properties: {
        maxCostUsd: { type: "number", minimum: 0 },
        maxTokens: { type: "integer", minimum: 0 },
        maxLatencyMs: { type: "integer", minimum: 0 },
        dataRetention: { type: "string", enum: [...MODEL_DATA_RETENTION] },
        allowTraining: { type: "boolean" },
        residency: { type: "string", minLength: 1, maxLength: 64 },
      },
    },
    budgets: {
      type: "object",
      additionalProperties: false,
      properties: {
        maxCostUsd: { type: "number", minimum: 0 },
        maxTokens: { type: "integer", minimum: 0 },
      },
    },
    // Ordered fallback ModelProfile references; fallback occurs only when the replacement meets the
    // same Tool/structured-output/context/data/residency/budget constraints (SPEC §17).
    fallbacks: refListSchema,
    // Sensitive caching is off by default (SPEC §17); authors must state intent explicitly.
    allowCaching: { type: "boolean" },
  },
} as const;

export const ModelProfileDefinitionSchema = definitionSchema(KIND, modelSpecSchema);

export const MODEL_PROFILE_DEFINITION = definitionRegistration(KIND, ModelProfileDefinitionSchema);

export interface ModelProfileSpec {
  provider: string;
  model: string;
  /** Named provider connection supplying credentials; defaults to the provider name. */
  connection?: string;
  capabilityClass?: string;
  reasoning: ModelReasoningLevel;
  supports: {
    tools: boolean;
    structuredOutput: boolean;
    contextWindowTokens: number;
    /** Absent means text-only — the honest reading of a profile authored before modality existed. */
    inputModalities?: ModelModality[];
    outputModalities?: ModelModality[];
  };
  constraints?: {
    maxCostUsd?: number;
    maxTokens?: number;
    maxLatencyMs?: number;
    dataRetention?: ModelDataRetention;
    allowTraining?: boolean;
    residency?: string;
  };
  budgets?: { maxCostUsd?: number; maxTokens?: number };
  fallbacks?: string[];
  allowCaching: boolean;
}

export type ModelProfileDefinition = DefinitionEnvelope<"ModelProfile", ModelProfileSpec>;
