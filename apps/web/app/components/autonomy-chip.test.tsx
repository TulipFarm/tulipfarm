import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { deriveGlyph } from "~/components/agent-glyph/derive";
import { AUTONOMY_RANK, AutonomyChip } from "~/components/autonomy-chip";
import type { Autonomy } from "~/lib/agents";

const ALL = Object.keys(AUTONOMY_RANK) as Autonomy[];

describe("AutonomyChip", () => {
  it("names the axis for screen readers so a bare value is not ambiguous", () => {
    render(<AutonomyChip autonomy="full" />);
    expect(screen.getByText(/authority:/)).toBeInTheDocument();
  });

  it("gives the highest authority the peak ink, which the lower steps must not borrow", () => {
    const { container: peak } = render(<AutonomyChip autonomy="full" />);
    expect(peak.firstElementChild?.className).toContain("text-heat-ink-peak");

    for (const autonomy of ALL.filter((value) => value !== "full")) {
      const { container } = render(<AutonomyChip autonomy={autonomy} />);
      expect(container.firstElementChild?.className).not.toContain("text-heat-ink-peak");
    }
  });

  /*
   * The chip and the glyph encode one fact on two channels. If they ever disagree a heavier
   * glyph would sit beside a cooler chip, which reads as two different claims about the same
   * agent.
   */
  it("orders the heat ramp the same way the glyph orders stroke weight", () => {
    for (const a of ALL) {
      for (const b of ALL) {
        const weightA = deriveGlyph("agent", undefined, a).weight;
        const weightB = deriveGlyph("agent", undefined, b).weight;
        expect(Math.sign(AUTONOMY_RANK[a] - AUTONOMY_RANK[b])).toBe(Math.sign(weightA - weightB));
      }
    }
  });
});
