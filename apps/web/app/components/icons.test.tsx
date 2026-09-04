import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it } from "vitest";
import { Bot, Check } from "~/components/icons";

describe("icons", () => {
  it("uses per-icon modules so Vite does not prebundle the full catalog", () => {
    const source = readFileSync(resolve(process.cwd(), "app/components/icons.tsx"), "utf8");
    const viteConfig = readFileSync(resolve(process.cwd(), "vite.config.ts"), "utf8");
    expect(source).not.toContain('from "reicon-react";');
    expect(viteConfig).toContain('exclude: ["reicon-react"]');
  });

  it("makes a Reicon glyph decorative by default", () => {
    const { container } = render(<Check />);
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("allows an explicit accessible name and aria-hidden override", () => {
    const { container } = render(<Check aria-hidden={false} aria-label="Complete" />);
    const icon = container.querySelector("svg");
    expect(icon).toHaveAttribute("aria-hidden", "false");
    expect(icon).toHaveAttribute("aria-label", "Complete");
  });

  it("does not hide a glyph with an accessible name", () => {
    const { container } = render(<Check aria-label="Complete" />);
    expect(container.querySelector("svg")).not.toHaveAttribute("aria-hidden");
  });

  it("preserves caller classes and forwards refs", () => {
    const ref = createRef<SVGSVGElement>();
    const { container } = render(<Check ref={ref} className="size-4 text-primary" />);
    expect(container.querySelector("svg")).toHaveClass("reicon", "size-4", "text-primary");
    expect(ref.current).toBe(container.querySelector("svg"));
  });

  it("gives a local gap glyph the same contract", () => {
    const { container } = render(<Bot className="size-5" />);
    const icon = container.querySelector("svg");
    expect(icon).toHaveAttribute("aria-hidden", "true");
    expect(icon).toHaveAttribute("stroke-width", "1.5");
    expect(icon).toHaveClass("reicon", "size-5");
  });

  it("keeps semantic names in React DevTools", () => {
    expect(Check.displayName).toBe("Check");
    expect(Bot.displayName).toBe("Bot");
  });
});
