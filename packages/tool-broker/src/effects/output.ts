import { ajv } from "@tulipfarm/schema";

export type ToolOutputValidator = (output: unknown) => boolean;

/** Compiles the contract boundary used after adapter normalization and before effect confirmation. */
export function compileToolOutputValidator(
  outputSchema: Readonly<Record<string, unknown>>
): ToolOutputValidator {
  const validate = ajv.compile(outputSchema);
  return (output) => validate(output);
}
