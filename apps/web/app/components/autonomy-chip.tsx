import type { Autonomy } from "~/lib/agents";
import { cn } from "~/lib/utils";

/**
 * How much rope the agent holds, low to high. This is an *ordered* scale, not a set of kinds,
 * which is why the chip uses the sequential `heat-*` ramp rather than a categorical or status
 * tone: an agent that acts alone is not in a "warning state", it simply holds more authority
 * than one that cannot. `AgentGlyph` already encodes the same order as stroke weight, and
 * `autonomy-chip.test.tsx` asserts the two never disagree.
 */
export const AUTONOMY_RANK: Record<Autonomy, 1 | 2 | 3 | 4> = {
  manual: 1,
  "approval-required": 2,
  supervised: 3,
  full: 4,
};

const RANK_TONE: Record<1 | 2 | 3 | 4, string> = {
  1: "bg-heat-1 text-heat-ink",
  2: "bg-heat-2 text-heat-ink",
  3: "bg-heat-3 text-heat-ink",
  4: "bg-heat-4 text-heat-ink-peak",
};

type Props = {
  autonomy: Autonomy;
  /** `sm` matches the agents list; `xs` matches the chat mention chip. */
  size?: "xs" | "sm";
  className?: string;
};

/**
 * The authority an agent carries, as a filled chip. The visible text carries the value on its
 * own, so the ramp is reinforcement and never the sole channel.
 */
export function AutonomyChip({ autonomy, size = "sm", className }: Props) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-sm uppercase",
        size === "sm" ? "px-1.5 py-0.5 tracking-[0.15em]" : "px-1 py-0.5 tracking-[0.12em]",
        RANK_TONE[AUTONOMY_RANK[autonomy]],
        className
      )}
    >
      <span className="sr-only">authority: </span>
      {autonomy}
    </span>
  );
}
