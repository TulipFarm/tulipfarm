import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MarkdownView } from "~/components/markdown-view";

describe("plan keyword highlighting in user messages", () => {
  it("highlights 'plan' and 'planning' with plan theme", () => {
    const { container } = render(
      <MarkdownView highlightPlanKeywords>
        Let's make a plan and start planning the architecture.
      </MarkdownView>
    );

    const keywords = container.querySelectorAll(".tf-plan-keyword");
    expect(keywords).toHaveLength(2);
    expect(keywords[0]?.textContent).toBe("plan");
    expect(keywords[1]?.textContent).toBe("planning");
    expect(keywords[0]?.className).toContain("text-run-active");
  });

  it("highlights '/plan' invocation", () => {
    const { container } = render(
      <MarkdownView highlightPlanKeywords>/plan review the codebase</MarkdownView>
    );

    const keywords = container.querySelectorAll(".tf-plan-keyword");
    expect(keywords).toHaveLength(1);
    expect(keywords[0]?.textContent).toBe("/plan");
  });

  it("does not match words containing plan as a substring", () => {
    const { container } = render(
      <MarkdownView highlightPlanKeywords>
        The airplane landed near the plant with an explanation.
      </MarkdownView>
    );

    const keywords = container.querySelectorAll(".tf-plan-keyword");
    expect(keywords).toHaveLength(0);
  });
});
