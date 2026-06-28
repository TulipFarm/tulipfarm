import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SoulTreeNode } from "~/lib/soul";
import { SoulTree } from "./soul-tree";

const tree: SoulTreeNode[] = [
  {
    name: "agents",
    path: "agents",
    type: "dir",
    children: [{ name: "AGENT.md", path: "agents/AGENT.md", type: "file", size: 12 }],
  },
  { name: "soul.yaml", path: "soul.yaml", type: "file", size: 8 },
];

describe("SoulTree", () => {
  it("renders top-level entries with directories expanded by default", () => {
    render(<SoulTree root={tree} selected={null} onSelect={() => {}} />);
    expect(screen.getByText("agents")).toBeTruthy();
    expect(screen.getByText("soul.yaml")).toBeTruthy();
    // top-level dir open → child visible
    expect(screen.getByText("AGENT.md")).toBeTruthy();
  });

  it("collapses and expands a directory on chevron click", () => {
    render(<SoulTree root={tree} selected={null} onSelect={() => {}} />);
    fireEvent.click(screen.getByLabelText("Collapse"));
    expect(screen.queryByText("AGENT.md")).toBeNull();
    fireEvent.click(screen.getByLabelText("Expand"));
    expect(screen.getByText("AGENT.md")).toBeTruthy();
  });

  it("calls onSelect with the file path when a file is clicked", () => {
    const onSelect = vi.fn();
    render(<SoulTree root={tree} selected={null} onSelect={onSelect} />);
    fireEvent.click(screen.getByText("soul.yaml"));
    expect(onSelect).toHaveBeenCalledWith("soul.yaml");
  });
});
