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

// Prefer deepest non-oneOf AJV errors so users see the real schema defect.
function bestError(errors: AjvErrors): NonNullable<AjvErrors>[number] | undefined {
  if (!errors || errors.length === 0) return undefined;
  const specific = errors.filter((e) => e.keyword !== "oneOf");
  const pool = specific.length > 0 ? specific : errors;
  return pool.reduce((deepest, e) =>
    e.instancePath.length > deepest.instancePath.length ? e : deepest
  );
}

export function firstError(errors: AjvErrors): string {
  const e = bestError(errors);
  return e
    ? `${e.instancePath || "(root)"} ${e.message ?? "is invalid"}`.trim()
    : "invalid arguments";
}
