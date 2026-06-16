import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MarkdownView } from "~/components/markdown-view";
import type { MentionEntry } from "./use-mention-catalog";

function agentEntry(label: string, name: string): MentionEntry {
  return {
    kind: "agent",
    phrase: `@${label}`,
    id: name,
    label,
    description: `Handles ${label} work.`,
    domain: "Billing",
    autonomy: "supervised",
  };
}

describe("mention highlighting + cards", () => {
  it("wraps a known multi-word @agent mention in a chip with a hover card", () => {
    const mentions = [agentEntry("Billing Assistant", "billing-assistant")];
    const { container } = render(
      <MarkdownView mentions={mentions}>{"@Billing Assistant help me"}</MarkdownView>
    );
    const chips = container.querySelectorAll(".tf-mention");
    expect(chips).toHaveLength(1);
    expect(chips[0]?.textContent).toBe("@Billing Assistant");
    // The hover card explains what the tag actually is.
    const card = container.querySelector('[role="tooltip"]');
    expect(card?.textContent).toContain("Agent");
    expect(card?.textContent).toContain("Handles Billing Assistant work.");
  });

  it("does not highlight anything without a catalog (e.g. assistant messages)", () => {
    const { container } = render(<MarkdownView>{"@Billing Assistant hi"}</MarkdownView>);
    expect(container.querySelector(".tf-mention")).toBeNull();
  });

  it("guards against partial / email-like false positives", () => {
    const { container } = render(
      <MarkdownView mentions={[agentEntry("A", "a")]}>{"reach a@Andrew now"}</MarkdownView>
    );
    expect(container.querySelector(".tf-mention")).toBeNull();
  });
});
