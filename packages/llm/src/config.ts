import { type Static, Type } from "@sinclair/typebox";
import { ajv } from "@tulipfarm/validation";

export class LlmConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmConfigValidationError";
  }
}

export class LlmNotConfiguredError extends Error {
  constructor() {
    super("LLM not configured");
    this.name = "LlmNotConfiguredError";
  }
}

export class UnknownModelError extends Error {
  constructor(modelId: string) {
    super(`model not configured in any tier: ${modelId}`);
    this.name = "UnknownModelError";
  }
}

const ProviderEntrySchema = Type.Object({
  provider: Type.String(),
  model: Type.String({ minLength: 1, pattern: "^\\S+$" }),
  api_key_ref: Type.Optional(Type.String()),
  base_url: Type.Optional(Type.String()),
});

const TierConfigSchema = Type.Object({
  providers: Type.Array(ProviderEntrySchema, { minItems: 1 }),
});

export const LlmConfigSchema = Type.Object({
  tiers: Type.Object({
    quick: TierConfigSchema,
    standard: TierConfigSchema,
    complex: TierConfigSchema,
  }),
});

export type ProviderEntry = Static<typeof ProviderEntrySchema>;
export type TierConfig = Static<typeof TierConfigSchema>;
export type LlmConfig = Static<typeof LlmConfigSchema>;

const checkConfig = ajv.compile(LlmConfigSchema);

export function validateLlmConfig(data: unknown): LlmConfig {
  if (!checkConfig(data)) {
    const e = checkConfig.errors?.[0] ?? { instancePath: "", message: "invalid config" };
    const path = e.instancePath ? `${e.instancePath}: ` : "";
    throw new LlmConfigValidationError(`${path}${e.message ?? "invalid config"}`);
  }
  return data as LlmConfig;
}
