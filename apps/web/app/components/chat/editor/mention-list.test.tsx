import { act, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { MentionList, type MentionListRef } from "./mention-list";

describe("MentionList", () => {
  it("renders a loading state while Knowledge search is pending", () => {
    render(<MentionList command={vi.fn()} items={[]} kind="knowledge" loading />);

    expect(screen.getByRole("status")).toHaveTextContent("Searching Knowledge…");
  });

  it("renders an empty state when Knowledge search finds no matches", () => {
    render(<MentionList command={vi.fn()} items={[]} kind="knowledge" />);

    expect(screen.getByText("No matching Knowledge.")).toBeInTheDocument();
  });

  // The suggestion plugin awaits `items` even when it resolves synchronously, so it reports
  // `loading` for every trigger. Only Knowledge actually queries a server; the rest must not
  // borrow its wording for the microtask before their static list arrives.
  it("never shows a search state for a trigger that cannot search", () => {
    render(<MentionList command={vi.fn()} items={[]} kind="skill" loading />);

    expect(screen.getByText("No matching Skills.")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("keeps selecting returned Knowledge items with keyboard navigation", () => {
    const command = vi.fn();
    const ref = createRef<MentionListRef>();
    render(
      <MentionList
        ref={ref}
        command={command}
        items={[
          { id: "page-1", label: "Operating profile", description: "Autonomy choices" },
          { id: "page-2", label: "Support policy", description: "Response guidelines" },
        ]}
        kind="knowledge"
      />
    );

    act(() => {
      ref.current?.onKeyDown({ event: new KeyboardEvent("keydown", { key: "ArrowDown" }) });
    });
    ref.current?.onKeyDown({ event: new KeyboardEvent("keydown", { key: "Enter" }) });

    expect(command).toHaveBeenCalledWith({ id: "page-2", label: "Support policy" });
    fireEvent.mouseDown(screen.getByRole("button", { name: /Operating profile/i }));
    expect(command).toHaveBeenCalledWith({ id: "page-1", label: "Operating profile" });
  });
});
