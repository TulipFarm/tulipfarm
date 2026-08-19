import type { ChatAutonomy, ToolDef } from "./types";

/**
 * The autonomy ladder, least authority first. An Agent's configured autonomy is an authority
 * *ceiling*, not a default: whatever a caller asks for per turn may lower it and must never raise
 * it, or the ceiling shown on the Agent's detail page would be advisory only.
 */
const AUTONOMY_RANK: Readonly<Record<ChatAutonomy, number>> = {
  manual: 0,
  "approval-required": 1,
  supervised: 2,
  full: 3,
};

/** Narrows an authored or transported value to a known level; anything else is not a level. */
export function asChatAutonomy(value: unknown): ChatAutonomy | undefined {
  return typeof value === "string" && Object.hasOwn(AUTONOMY_RANK, value)
    ? (value as ChatAutonomy)
    : undefined;
}

/**
 * The autonomy a turn actually runs at: the more restrictive of the Agent's configured ceiling and
 * the autonomy this particular request asked for. An unrecognised value on either side contributes
 * no ceiling rather than a permissive one, and two absent values leave the turn with none — the
 * gate then denies on the missing context instead of assuming `full`.
 */
export function autonomyCeiling(configured: unknown, requested: unknown): ChatAutonomy | undefined {
  const ceiling = asChatAutonomy(configured);
  const asked = asChatAutonomy(requested);
  if (ceiling === undefined) return asked;
  if (asked === undefined) return ceiling;
  return AUTONOMY_RANK[ceiling] <= AUTONOMY_RANK[asked] ? ceiling : asked;
}

/**
 * Whether this autonomy puts a human between a Tool call and its effect. Mutating Tools under
 * `approval-required` do, unless the Tool's own declaration opts out.
 */
export function autonomyDemandsApproval(
  definition: Pick<ToolDef, "mutating" | "requiresApproval">,
  autonomy: string | undefined
): boolean {
  return (
    autonomy === "approval-required" && definition.mutating && definition.requiresApproval !== false
  );
}
