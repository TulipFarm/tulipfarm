import { type Static, Type } from "@sinclair/typebox";
import { ajv } from "./ajv";
import { TulipFarmValidationError } from "./error";
import { LlmConfigSchema, validateLlmConfig } from "./llm";

export const SoulConfigSchema = Type.Object(
  {
    soulFormatVersion: Type.Optional(Type.Integer({ minimum: 0 })),
    businessName: Type.Optional(Type.String()),
    businessDescription: Type.Optional(Type.String()),
    businessWebsite: Type.Optional(Type.String()),
    setupComplete: Type.Optional(Type.Boolean()),
    gitRemoteUrl: Type.Optional(Type.String()),
    llm: Type.Optional(LlmConfigSchema),
  },
  { additionalProperties: true }
);

export type SoulConfig = Static<typeof SoulConfigSchema>;

const check = ajv.compile(SoulConfigSchema);

export function validateSoulConfig(data: unknown): SoulConfig {
  if (!check(data)) {
    const e = check.errors?.[0];
    throw new TulipFarmValidationError(
      "soul",
      e?.instancePath ?? "",
      e?.message ?? "invalid soul.yaml"
    );
  }
  const config = data as SoulConfig;
  if (config.llm !== undefined) validateLlmConfig(config.llm);
  return config;
}
