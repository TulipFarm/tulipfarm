import { type Static, Type } from "@sinclair/typebox";
import { ajv } from "./ajv";
import { modelPolicySchema } from "./definitions/common";
import { TulipFarmValidationError } from "./error";

/** AGENT.md frontmatter schema: write-time only, strict, and name comes from directory. */

export const AUTONOMY_VALUES = ["full", "supervised", "approval-required", "manual"] as const;

export const AgentFrontmatterSchema = Type.Object(
  {
    label: Type.Optional(Type.String({ minLength: 1 })),
    domain: Type.Optional(Type.String({ minLength: 1 })),
    description: Type.Optional(Type.String({ minLength: 1 })),
    model: Type.Optional(Type.String({ minLength: 1, pattern: "^\\S+$" })),
    // Use enum, not union, so AJV emits self-correctable allowed-values errors.
    autonomy: Type.Optional(
      Type.Unsafe<(typeof AUTONOMY_VALUES)[number]>({ type: "string", enum: [...AUTONOMY_VALUES] })
    ),
    modelPolicy: Type.Optional(modelPolicySchema),
    placeholder: Type.Optional(Type.Array(Type.String())),
    suggestions: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false }
);

export type AgentFrontmatter = Static<typeof AgentFrontmatterSchema>;

const check = ajv.compile(AgentFrontmatterSchema);

/** Validate AGENT.md frontmatter; throws `TulipFarmValidationError` on the first failure. */
export function validateAgentFrontmatter(frontmatter: unknown): AgentFrontmatter {
  if (!check(frontmatter)) {
    const e = check.errors?.[0];
    throw new TulipFarmValidationError(
      "agent",
      e?.instancePath ?? "",
      e?.message ?? "invalid agent frontmatter"
    );
  }
  return frontmatter as AgentFrontmatter;
}
