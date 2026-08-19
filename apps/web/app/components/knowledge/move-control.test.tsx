/**
 * The affordance that gets a person from a tree row to the readership warning.
 *
 * The warning in `MoveDialog` is only worth what this control is worth: if the path can be typed
 * but the preview is skipped, or if a cancelled move leaves the typed path lying around to be
 * confirmed later against a stale preview, the guarantee is gone.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MoveControl } from "./move-control";

const previewPageMove = vi.fn();
const movePage = vi.fn();
const listSubjects = vi.fn();

vi.mock("~/lib/knowledge-api", () => ({
  previewPageMove: (...args: unknown[]) => previewPageMove(...args),
  movePage: (...args: unknown[]) => movePage(...args),
  listSubjects: (...args: unknown[]) => listSubjects(...args),
}));

const widens = {
  effect: "widens" as const,
  before: [],
  after: [],
  gained: [{ kind: "user" as const, id: "u2" }],
  lost: [],
  ownRestrictionSurvives: null,
  descendants: [],
};

const directory = { users: [], teams: [], roles: [] };

function setup() {
  const onMoved = vi.fn();
  render(<MoveControl pageId="p1" pageTitle="Bands" currentPath="comp/bands" onMoved={onMoved} />);
  return { onMoved };
}

function openAndType(path: string) {
  fireEvent.click(screen.getByRole("button", { name: "Move Bands" }));
  fireEvent.change(screen.getByLabelText("New path"), { target: { value: path } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
}

describe("getting from a tree row to the readership warning", () => {
  beforeEach(() => {
    previewPageMove.mockReset().mockResolvedValue(widens);
    movePage.mockReset().mockResolvedValue(undefined);
    listSubjects.mockReset().mockResolvedValue(directory);
  });

  it("names the Page in the trigger, so the action is operable without seeing the row", () => {
    setup();
    expect(screen.getByRole("button", { name: "Move Bands" })).toBeTruthy();
  });

  it("previews before it moves, never the other way round", async () => {
    setup();
    openAndType("archive/bands");
    await waitFor(() =>
      expect(previewPageMove).toHaveBeenCalledWith("p1", {
        path: "archive/bands",
      })
    );
    expect(movePage).not.toHaveBeenCalled();
  });

  it("refuses a path identical to the current one instead of previewing a no-op", async () => {
    setup();
    openAndType("comp/bands");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("different"));
    expect(previewPageMove).not.toHaveBeenCalled();
  });

  it("refuses an empty path", async () => {
    setup();
    openAndType("   ");
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(previewPageMove).not.toHaveBeenCalled();
  });

  it("surfaces a refused preview rather than moving anyway", async () => {
    previewPageMove.mockRejectedValue(new Error("destination Space is restricted"));
    setup();
    openAndType("locked/bands");
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("destination Space is restricted")
    );
    expect(movePage).not.toHaveBeenCalled();
  });

  it("moves only after the warning is confirmed, and tells the tree to refresh", async () => {
    const { onMoved } = setup();
    openAndType("archive/bands");
    await screen.findByTestId("gained");
    const confirm = screen.getByRole("button", { name: "Move" });
    fireEvent.click(confirm);
    await waitFor(() => expect(movePage).toHaveBeenCalledWith("p1", { path: "archive/bands" }));
    await waitFor(() => expect(onMoved).toHaveBeenCalled());
  });

  it("drops the typed path when the warning is dismissed, so nothing stale can be confirmed", async () => {
    setup();
    openAndType("archive/bands");
    await screen.findByTestId("gained");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByTestId("gained")).toBeNull();
    expect(movePage).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Move Bands" }));
    expect((screen.getByLabelText("New path") as HTMLInputElement).value).toBe("comp/bands");
  });
});
