import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Avatar } from "./avatar";
import { Segmented, SegmentedButton } from "./segmented";
import { Switch } from "./switch";

describe("Switch", () => {
  it("publishes its state through aria-checked, so it is not a styled div", () => {
    render(<Switch checked aria-label="Dark mode" />);
    expect(screen.getByRole("switch", { name: "Dark mode" })).toHaveAttribute(
      "aria-checked",
      "true"
    );
  });

  it("reports the value the caller would be moving to, not the one it is on", async () => {
    const onCheckedChange = vi.fn();
    render(<Switch checked={false} onCheckedChange={onCheckedChange} aria-label="Dark mode" />);
    await userEvent.click(screen.getByRole("switch"));
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it("is nameable by a sibling label, which a div could not be", () => {
    render(
      <>
        <label htmlFor="notify">Notify me</label>
        <Switch id="notify" checked={false} />
      </>
    );
    expect(screen.getByRole("switch", { name: "Notify me" })).toBeInTheDocument();
  });

  it("does not fire when disabled", async () => {
    const onCheckedChange = vi.fn();
    render(
      <Switch checked={false} disabled onCheckedChange={onCheckedChange} aria-label="Dark mode" />
    );
    await userEvent.click(screen.getByRole("switch"));
    expect(onCheckedChange).not.toHaveBeenCalled();
  });
});

describe("Segmented", () => {
  function Harness() {
    const [value, setValue] = useState("all");
    return (
      <Segmented>
        <SegmentedButton selected={value === "all"} onClick={() => setValue("all")}>
          All
        </SegmentedButton>
        <SegmentedButton selected={value === "mine"} onClick={() => setValue("mine")}>
          Mine
        </SegmentedButton>
      </Segmented>
    );
  }

  it("marks exactly one segment as pressed", async () => {
    render(<Harness />);
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Mine" })).toHaveAttribute("aria-pressed", "false");

    await userEvent.click(screen.getByRole("button", { name: "Mine" }));
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Mine" })).toHaveAttribute("aria-pressed", "true");
  });

  it("claims no tablist role, because it implements no roving-focus contract", () => {
    render(<Harness />);
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  });
});

describe("Avatar", () => {
  it("gives one identity the same colours every render, so a mark is recognisable", () => {
    const { container: first } = render(<Avatar identity="Priya Raghunathan" />);
    const { container: second } = render(<Avatar identity="Priya Raghunathan" />);
    const style = first.firstElementChild?.getAttribute("style");
    expect(style).toContain("--glyph-hue-");
    expect(second.firstElementChild?.getAttribute("style")).toBe(style);
  });

  it("never pairs a hue with itself, which would render as a flat disc", () => {
    for (const who of ["a", "bob@acme.dev", "Support Team", "zzz", "Lena Ortiz", "9"]) {
      const { container } = render(<Avatar identity={who} />);
      const [from, to] = (container.firstElementChild?.getAttribute("style") ?? "").match(
        /--glyph-hue-\d/g
      ) as string[];
      expect(from).not.toBe(to);
    }
  });

  it("stays out of the accessibility tree, because the name is always rendered beside it", () => {
    render(<Avatar identity="Priya Raghunathan" data-testid="mark" />);
    expect(screen.getByTestId("mark")).toHaveAttribute("aria-hidden", "true");
  });
});
