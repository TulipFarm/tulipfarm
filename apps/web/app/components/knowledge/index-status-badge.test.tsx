import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { IndexStatusBadge } from "./index-status-badge";

describe("IndexStatusBadge", () => {
  it("renders indexed in the ruby (primary) color", () => {
    const { container } = render(<IndexStatusBadge status="indexed" />);
    expect(screen.getByText("indexed")).toBeInTheDocument();
    expect(container.querySelector("[data-status='indexed']")?.className).toContain("text-primary");
  });

  it("renders lexical-only muted", () => {
    const { container } = render(<IndexStatusBadge status="lexical-only" />);
    expect(screen.getByText("lexical-only")).toBeInTheDocument();
    expect(container.querySelector("[data-status='lexical-only']")?.className).toContain(
      "text-muted-foreground"
    );
  });

  it("renders pending muted", () => {
    const { container } = render(<IndexStatusBadge status="pending" />);
    expect(screen.getByText("pending")).toBeInTheDocument();
    expect(container.querySelector("[data-status='pending']")?.className).toContain(
      "text-muted-foreground"
    );
  });
});
