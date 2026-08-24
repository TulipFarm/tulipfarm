import { type Static, Type } from "@sinclair/typebox";
import { ajv } from "./ajv";
import { TulipFarmValidationError } from "./error";

/** guardrails.yaml schema: strict per-stage unions; wrong-stage guards fail validation. */

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

/**
 * Screens what a Tool brought back, which is the one stage no other guard covers.
 *
 * `input` sees what the person wrote and `tool-call` sees what the model proposed; neither sees a
 * fetched page, an API body or a Knowledge excerpt. That content is attacker-controlled whenever
 * the destination is, and it reaches the model as a transcript entry the model has every reason to
 * treat as trustworthy — the widest indirect-injection channel a Turn has.
 */
const UntrustedContentGuard = Type.Object(
  {
    guard: Type.Literal("untrusted_content"),
    sensitivity: Type.Optional(
      Type.Unsafe<(typeof SENSITIVITY)[number]>({ type: "string", enum: [...SENSITIVITY] })
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
    "tool-result": Type.Optional(Type.Array(UntrustedContentGuard)),
    output: Type.Optional(Type.Array(ContentFilterGuard)),
  },
  { additionalProperties: false }
);

export type GuardrailsConfig = Static<typeof GuardrailsConfigSchema>;
export type PromptInjectionConfig = Static<typeof PromptInjectionGuard>;
export type ToolBlocklistConfig = Static<typeof ToolBlocklistGuard>;
export type UntrustedContentConfig = Static<typeof UntrustedContentGuard>;
export type ContentFilterConfig = Static<typeof ContentFilterGuard>;

export type GuardrailStage = keyof GuardrailsConfig;

/**
 * The one stage each guard is valid in.
 *
 * The stage unions above are strict, so a guard filed under the wrong stage fails validation
 * rather than silently never running. An author names the guard; the stage follows from it and is
 * never a second thing to get wrong.
 */
export const GUARDRAIL_STAGE_BY_GUARD = {
  prompt_injection: "input",
  tool_blocklist: "tool-call",
  untrusted_content: "tool-result",
  content_filter: "output",
} as const satisfies Record<string, GuardrailStage>;

export type GuardrailGuardName = keyof typeof GUARDRAIL_STAGE_BY_GUARD;

/** The stage a guard belongs to, or `undefined` for a name no stage union admits. */
export function guardrailStageFor(guard: string): GuardrailStage | undefined {
  return Object.hasOwn(GUARDRAIL_STAGE_BY_GUARD, guard)
    ? GUARDRAIL_STAGE_BY_GUARD[guard as GuardrailGuardName]
    : undefined;
}

const check = ajv.compile(GuardrailsConfigSchema);

/** Validate guardrails config; throws `TulipFarmValidationError` on the first failure. */
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
