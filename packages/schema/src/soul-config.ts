import { type Static, Type } from "@sinclair/typebox";
import { ajv } from "./ajv";
import { CURRENCY_CODES } from "./currencies";
import { TulipFarmValidationError } from "./error";
import { LlmConfigSchema, validateLlmConfig } from "./llm";

/**
 * How attached images are bounded before they reach a model.
 *
 * Refusing is the default rather than resizing because a resize is a silent edit to what the
 * person attached: the model then answers about a picture nobody saw. An operator who would
 * rather trade fidelity for reach turns `downscaleImages` on knowingly.
 */
export const FilesConfigSchema = Type.Object(
  {
    /** Longest edge, in pixels, an image may have before it is refused or downscaled. */
    maxImageDimension: Type.Optional(Type.Integer({ minimum: 1 })),
    /** When true an oversized image is downscaled to fit instead of refused. */
    downscaleImages: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false }
);

export type FilesConfig = Static<typeof FilesConfigSchema>;

export const SoulConfigSchema = Type.Object(
  {
    soulFormatVersion: Type.Optional(Type.Integer({ minimum: 0 })),
    businessName: Type.Optional(Type.String()),
    businessDescription: Type.Optional(Type.String()),
    businessWebsite: Type.Optional(Type.String()),
    setupComplete: Type.Optional(Type.Boolean()),
    gitRemoteUrl: Type.Optional(Type.String()),
    businessCurrency: Type.Optional(
      Type.Unsafe<string>({ type: "string", enum: [...CURRENCY_CODES] })
    ),
    businessCurrencyRate: Type.Optional(Type.Number({ minimum: 0, exclusiveMinimum: 0 })),
    llm: Type.Optional(LlmConfigSchema),
    files: Type.Optional(FilesConfigSchema),
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
