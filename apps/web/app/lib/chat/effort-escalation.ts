import type { EffortPreset, EffortRung } from "@tulipfarm/schema";

const NEXT_RUNG: Readonly<Record<EffortRung, EffortRung | undefined>> = {
  fast: "balanced",
  balanced: "thorough",
  thorough: undefined,
};

/**
 * One user-visible escalation step.
 *
 * `auto` is not a rung — it is a request to let the deployment choose — so escalating from it needs
 * to know what it actually chose. That is `applied`, reported by the backend on the turn receipt.
 * Guessing instead would skip a rung on any deployment whose default is not the middle one, which
 * is exactly the deployment where the guess matters. With no applied rung to stand on there is
 * nothing honest to escalate to, so no step is offered.
 */
export function nextEffortPreset(
  asked: EffortPreset | undefined,
  applied?: EffortRung
): EffortRung | undefined {
  const rung = asked === "auto" || asked === undefined ? applied : asked;
  return rung === undefined ? undefined : NEXT_RUNG[rung];
}
