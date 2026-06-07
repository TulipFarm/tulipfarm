import type { Tier } from "./llm-service";

export type Autonomy = "full" | "supervised" | "approval-required" | "manual";

// Tier names + "auto" autocomplete; raw provider model ids stay assignable.
export type ModelSelector = Tier | "auto" | (string & {});

export interface SelectionContext {
  autonomy?: Autonomy;
  hasTools?: boolean;
  llmDecision?: boolean;
}

const AUTONOMY_TIER: Record<Autonomy, Tier> = {
  full: "quick",
  supervised: "standard",
  "approval-required": "complex",
  manual: "standard",
};

/**
 * Pick a tier for `model: auto` from request context.
 * x-llm-decision forces complex; otherwise the autonomy map applies (default
 * standard), then quick is bumped to standard when tools are in scope.
 */
export function resolveTier(ctx: SelectionContext): Tier {
  if (ctx.llmDecision) return "complex";
  const base = ctx.autonomy ? AUTONOMY_TIER[ctx.autonomy] : "standard";
  if (base === "quick" && ctx.hasTools) return "standard";
  return base;
}
