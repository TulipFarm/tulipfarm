import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { VisibilityBadge } from "./visibility-badge";

describe("telling a reader whether this is open or restricted", () => {
  it("distinguishes open, restricted, and inherited-restriction", () => {
    const { rerender } = render(<VisibilityBadge visibility="business" />);
    expect(screen.getByText("Everyone")).toBeTruthy();

    rerender(<VisibilityBadge visibility="own" />);
    expect(screen.getByText("Restricted")).toBeTruthy();
    expect(screen.queryByText(/from/)).toBeNull();

    rerender(<VisibilityBadge visibility="inherited" from="Compensation" />);
    expect(screen.getByText(/from Compensation/)).toBeTruthy();
  });

  it("carries the difference in words, not colour alone", () => {
    const { rerender, container } = render(<VisibilityBadge visibility="business" />);
    const openText = container.textContent;
    rerender(<VisibilityBadge visibility="own" />);
    expect(container.textContent).not.toBe(openText);
  });

  it("keeps a readable label when it shrinks to an icon", () => {
    render(<VisibilityBadge visibility="own" compact />);
    expect(screen.getByText(/only named people/i)).toBeTruthy();
  });

  it("names the ancestor in the compact form too, where there is no room to print it", () => {
    render(<VisibilityBadge visibility="inherited" from="Compensation" compact />);
    expect(screen.getByText(/Restricted by Compensation/)).toBeTruthy();
  });
});
