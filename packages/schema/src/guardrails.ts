import { type Static, Type } from "@sinclair/typebox";
import { ajv } from "./ajv";
import { TulipFarmValidationError } from "./error";

/**
 * guardrails.yaml meta-schema. Strict per-stage guard unions (V1 fixed set — a guard
 * placed in the wrong stage fails validation). Validated at the soul write boundary;
 * `"soul"` is the closest existing `ValidationBoundary` (it is a soul config file).
 * Mirrors `agent.ts` enum style (`Type.Unsafe` + `enum` so AJV emits self-correctable
 * messages).
 */

const SENSITIVITY = ["low", "medium", "high"] as const;
const CONTENT_PATTERNS = ["credit_card", "ssn", "api_key", "email"] as const;
const TOOL_TIERS = ["system", "platform", "integration"] as const;

const PromptInjectionGuard = Type.Object(
  {
    guard: Type.Literal("prompt_injection"),
    sensitivity: Type.Optional(
      Type.Unsafe<(typeof SENSITIVITY)[number]>({ type: "string", enum: [...SENSITIVITY] })
    ),
  },
  { additionalProperties: false }
);

const ToolBlocklistGuard = Type.Object(
  {
    guard: Type.Literal("tool_blocklist"),
    block: Type.Optional(Type.Array(Type.String({ minLength: 1 }))), // names + wildcard globs
    category: Type.Optional(
      Type.Array(
        Type.Unsafe<(typeof TOOL_TIERS)[number]>({ type: "string", enum: [...TOOL_TIERS] })
      )
    ),
  },
  { additionalProperties: false }
);

const ContentFilterGuard = Type.Object(
  {
    guard: Type.Literal("content_filter"),
    patterns: Type.Array(
      Type.Unsafe<(typeof CONTENT_PATTERNS)[number]>({
        type: "string",
        enum: [...CONTENT_PATTERNS],
      }),
      { minItems: 1 }
    ),
  },
  { additionalProperties: false }
);

export const GuardrailsConfigSchema = Type.Object(
  {
    input: Type.Optional(Type.Array(PromptInjectionGuard)),
    "tool-call": Type.Optional(Type.Array(ToolBlocklistGuard)),
    output: Type.Optional(Type.Array(ContentFilterGuard)),
  },
  { additionalProperties: false }
);

export type GuardrailsConfig = Static<typeof GuardrailsConfigSchema>;
export type PromptInjectionConfig = Static<typeof PromptInjectionGuard>;
export type ToolBlocklistConfig = Static<typeof ToolBlocklistGuard>;
export type ContentFilterConfig = Static<typeof ContentFilterGuard>;

const check = ajv.compile(GuardrailsConfigSchema);

/**
 * Validate a guardrails config against the meta-schema. Returns the typed object on
 * success; throws `TulipFarmValidationError` (boundary `"soul"`) on the first failure.
 */
export function validateGuardrailsConfig(data: unknown): GuardrailsConfig {
  if (!check(data)) {
    const e = check.errors?.[0];
    throw new TulipFarmValidationError(
      "soul",
      e?.instancePath ?? "",
      e?.message ?? "invalid guardrails config"
    );
  }
  return data as GuardrailsConfig;
}
