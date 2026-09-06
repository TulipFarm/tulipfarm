import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Avatar, TeamAvatar } from "./avatar";

/*
 * Shape carries the meaning here, so these assert the shape and not the hue: a reader tells a
 * Team from a person by the corner radius before they have read a single character.
 */
describe("identity marks", () => {
  it("draws a person as a circle", () => {
    render(<Avatar identity="Muskan Vijayvargiya" data-testid="mark" />);
    expect(screen.getByTestId("mark").className).toContain("rounded-full");
  });

  it("draws an agent as a circle, same as a person", () => {
    render(<Avatar identity="Support Agent" data-testid="mark" />);
    expect(screen.getByTestId("mark").className).toContain("rounded-full");
  });

  it("draws a Team as a square", () => {
    render(<TeamAvatar identity="engineering" data-testid="mark" />);
    const mark = screen.getByTestId("mark");
    expect(mark.className).toContain("rounded-xl");
    expect(mark.className).not.toContain("rounded-full");
  });

  it("gives one Team the same mark everywhere it is shown", () => {
    const { unmount } = render(<TeamAvatar identity="engineering" data-testid="mark" />);
    const first = screen.getByTestId("mark").getAttribute("style");
    unmount();

    render(<TeamAvatar identity="engineering" data-testid="mark" />);
    expect(screen.getByTestId("mark").getAttribute("style")).toBe(first);
  });

  it("keeps a Team's mark out of the accessibility tree, since its name is always beside it", () => {
    render(<TeamAvatar identity="engineering" data-testid="mark" />);
    expect(screen.getByTestId("mark")).toHaveAttribute("aria-hidden");
  });

  it("keeps the two seeded Teams visually apart", () => {
    // These two ship with every instance, so a palette collision between them is the one clash a
    // person is guaranteed to see. Their marks are also already familiar, which is why the index
    // is a character sum: changing the hash silently repaints every Team in the business.
    const { unmount } = render(<TeamAvatar identity="engineering" data-testid="mark" />);
    const engineering = screen.getByTestId("mark").getAttribute("style");
    unmount();

    render(<TeamAvatar identity="everyone" data-testid="mark" />);
    expect(screen.getByTestId("mark").getAttribute("style")).not.toBe(engineering);
  });
});
