import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AgentGlyph } from "./agent-glyph";

describe("AgentGlyph", () => {
  it("renders an svg with at least one stroked path", () => {
    const { container } = render(<AgentGlyph name="Atlas" domain="Support" />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.querySelectorAll("path").length).toBeGreaterThan(0);
  });

  it("is labeled with the agent name and archetype by default", () => {
    const { getByRole } = render(<AgentGlyph name="Atlas" domain="Customer Support" />);
    const svg = getByRole("img");
    expect(svg.getAttribute("aria-label")).toBe("Atlas agent, support archetype");
  });

  it("hides from the a11y tree when decorative", () => {
    const { container, queryByRole } = render(<AgentGlyph name="Atlas" decorative />);
    expect(queryByRole("img")).toBeNull();
    expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("maps size to svg dimensions (default md=28, lg=40)", () => {
    const { container: md } = render(<AgentGlyph name="A" />);
    expect(md.querySelector("svg")?.getAttribute("width")).toBe("28");
    const { container: lg } = render(<AgentGlyph name="A" size="lg" />);
    expect(lg.querySelector("svg")?.getAttribute("width")).toBe("40");
  });

  it("applies the state as a glyph-<state> class", () => {
    const { container } = render(<AgentGlyph name="A" state="thinking" />);
    expect(container.querySelector("svg")?.classList.contains("glyph-thinking")).toBe(true);
  });

  it("uses the ruby primary when active, a muted hue otherwise", () => {
    const { container: on } = render(<AgentGlyph name="A" active />);
    expect(on.querySelector("svg")?.style.getPropertyValue("--glyph-stroke")).toBe(
      "var(--primary)"
    );
    const { container: off } = render(<AgentGlyph name="A" />);
    expect(off.querySelector("svg")?.style.getPropertyValue("--glyph-stroke")).toMatch(
      /^var\(--glyph-hue-[0-6]\)$/
    );
  });

  it("renders every base shape without throwing", () => {
    const domains = ["support", "sales", "research", "data", "operations", "finance", "legal"];
    for (const domain of domains) {
      const { container } = render(<AgentGlyph name={`a-${domain}`} domain={domain} />);
      const svg = container.querySelector("svg");
      const drawn =
        (svg?.querySelectorAll("path").length ?? 0) + (svg?.querySelectorAll("circle").length ?? 0);
      expect(drawn).toBeGreaterThan(0);
    }
  });
});
