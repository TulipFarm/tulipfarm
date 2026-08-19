import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AgentAuthoredBadge } from "./agent-authored-badge";

describe("AgentAuthoredBadge", () => {
  it("labels an Agent-written Page in words, not by colour alone", () => {
    render(<AgentAuthoredBadge authorKind="agent" />);
    expect(screen.getByText("Agent")).toBeInTheDocument();
  });

  it("renders nothing for a Page a person wrote", () => {
    const { container } = render(<AgentAuthoredBadge authorKind="user" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when the author is unknown, rather than claiming a person wrote it", () => {
    const { container } = render(<AgentAuthoredBadge authorKind={null} />);
    expect(container).toBeEmptyDOMElement();
    const undef = render(<AgentAuthoredBadge />);
    expect(undef.container).toBeEmptyDOMElement();
  });

  it("still announces itself to a screen reader when shown compactly", () => {
    render(<AgentAuthoredBadge authorKind="agent" compact />);
    expect(screen.getByText("Written by an Agent")).toBeInTheDocument();
  });
});
