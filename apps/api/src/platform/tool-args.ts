import type { ajv } from "@tulipfarm/schema";

/** Argument and AJV-error helpers shared by the platform Tool modules. */

type AjvErrors = ReturnType<typeof ajv.compile>["errors"];

/** Delegation authorizes `platform.agent`, not Soul edits to `soul.agent`. */
export const SOUL_AGENT_TARGET = "platform.agent";
export const SOUL_ROUTINE_TARGET = "soul.routine";
export const SOUL_SKILL_TARGET = "soul.skill";

function stringArg(args: unknown, key: string): string | undefined {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return undefined;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function soulTarget(
  type: typeof SOUL_AGENT_TARGET | typeof SOUL_ROUTINE_TARGET | typeof SOUL_SKILL_TARGET,
  args: unknown,
  key: string
) {
  const id = stringArg(args, key);
  return id === undefined ? [] : [{ type, id }];
}

// AJV's own `oneOf` errors just say "must match exactly one schema"; the branch errors nested
// under them name the real defect. Drop the `oneOf` noise, but only once something more specific
// survives to replace it.
function meaningfulErrors(errors: AjvErrors): NonNullable<AjvErrors> {
  if (!errors || errors.length === 0) return [];
  const specific = errors.filter((e) => e.keyword !== "oneOf");
  return specific.length > 0 ? specific : errors;
}

/**
 * Renders every AJV violation from one failed call, not just one — AJV is configured with
 * `allErrors: true` (`packages/schema/src/ajv.ts`) so it already finds them all. Reporting a
 * single error forced a model correcting a bad Tool call to discover the rest one repair attempt
 * at a time, burning the Turn's repair budget on defects it was never told about.
 */
export function firstError(errors: AjvErrors): string {
  const list = meaningfulErrors(errors);
  if (list.length === 0) return "invalid arguments";

  const seen = new Set<string>();
  const lines: string[] = [];
  for (const e of list) {
    const path = e.instancePath || "(root)";
    const message = e.message ?? "is invalid";
    const key = `${path}|${message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`- \`${path}\`: ${message}`);
  }

  return (
    `<validation_errors count="${lines.length}">\n${lines.join("\n")}\n</validation_errors>\n` +
    "Fix every error listed above before retrying the call."
  );
}
