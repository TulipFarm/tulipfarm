/**
 * Moving a Page is a permission change wearing the costume of a filing operation.
 *
 * The tests below encode the one rule that makes the warning worth anything: it fires when
 * readership changes and stays silent when it does not. A confirmation on every move trains people
 * to dismiss it, and a dialog everyone dismisses protects nobody.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PageMovePreview, SubjectDirectory } from "~/lib/knowledge-api";
import { MoveDialog } from "./move-dialog";

const directory: SubjectDirectory = {
  users: [
    { kind: "user", id: "u1", label: "Ana Ruiz" },
    { kind: "user", id: "u2", label: "Bo Lang" },
  ],
  teams: [{ kind: "group", id: "finance", label: "finance" }],
  roles: [],
};

const unchanged: PageMovePreview = {
  effect: "unchanged",
  before: [],
  after: [],
  gained: [],
  lost: [],
  ownRestrictionSurvives: null,
  descendants: [],
};

function setup(preview: PageMovePreview, overrides: Record<string, unknown> = {}) {
  const onConfirm = vi.fn().mockResolvedValue(undefined);
  const onCancel = vi.fn();
  render(
    <MoveDialog
      open
      pageTitle="Bands"
      destination="comp/archive"
      preview={preview}
      directory={directory}
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...overrides}
    />
  );
  return { onConfirm, onCancel };
}

describe("warning before a move changes who can read", () => {
  it("names who gains access when the move widens readership", () => {
    setup({
      ...unchanged,
      effect: "widens",
      gained: [
        { kind: "user", id: "u2" },
        { kind: "group", id: "finance" },
      ],
    });
    const gains = screen.getByTestId("gained").textContent ?? "";
    expect(gains).toMatch(/Bo Lang/);
    expect(gains).toMatch(/finance/);
    // A raw identifier is not a name; the point of the warning is that it can be read.
    expect(gains).not.toMatch(/u2/);
  });

  it("names who loses access when the move narrows readership", () => {
    setup({ ...unchanged, effect: "narrows", lost: [{ kind: "user", id: "u1" }] });
    expect(screen.getByTestId("lost").textContent).toMatch(/Ana Ruiz/);
  });

  it("reports both halves of a mixed move", () => {
    setup({
      ...unchanged,
      effect: "mixed",
      gained: [{ kind: "user", id: "u2" }],
      lost: [{ kind: "user", id: "u1" }],
    });
    expect(screen.getByTestId("gained").textContent).toMatch(/Bo Lang/);
    expect(screen.getByTestId("lost").textContent).toMatch(/Ana Ruiz/);
  });

  it("says whether the Page's own restriction still holds at the destination", () => {
    const { unmount } = render(
      <MoveDialog
        open
        pageTitle="Bands"
        destination="comp/archive"
        preview={{ ...unchanged, effect: "narrows", ownRestrictionSurvives: false }}
        directory={directory}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(screen.getByTestId("own-restriction").textContent).toMatch(/no longer|not hold|lost/i);
    unmount();

    setup({ ...unchanged, effect: "widens", ownRestrictionSurvives: true });
    expect(screen.getByTestId("own-restriction").textContent).toMatch(/still/i);
  });

  it("says nothing about a restriction the Page never had", () => {
    setup({ ...unchanged, effect: "widens", ownRestrictionSurvives: null });
    expect(screen.queryByTestId("own-restriction")).toBeNull();
  });

  it("reports the effect on Pages nested beneath, not only the Page grabbed", () => {
    setup({
      ...unchanged,
      effect: "widens",
      gained: [{ kind: "user", id: "u2" }],
      descendants: [
        { pageId: "p2", path: "comp/bands/2024", effect: "widens" },
        { pageId: "p3", path: "comp/bands/2025", effect: "unchanged" },
      ],
    });
    const nested = screen.getByTestId("descendants").textContent ?? "";
    expect(nested).toMatch(/comp\/bands\/2024/);
    // Dragging a branch is where the largest accidental disclosures come from.
    expect(nested).toMatch(/2 pages|2 nested/i);
  });

  it("moves without asking when readership does not change", async () => {
    const { onConfirm } = setup(unchanged);
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("button", { name: /move anyway|confirm/i })).toBeNull();
  });

  it("does not move until the person confirms, when readership does change", () => {
    const { onConfirm } = setup({ ...unchanged, effect: "widens" });
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("leaves the Page where it was when cancelled", () => {
    const { onConfirm, onCancel } = setup({ ...unchanged, effect: "narrows" });
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("reports a failed move instead of pretending it happened", async () => {
    const onConfirm = vi.fn().mockRejectedValue(new Error("destination is gone"));
    const { onCancel } = setup({ ...unchanged, effect: "widens" }, { onConfirm });

    fireEvent.click(screen.getByRole("button", { name: /move/i }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/destination/));
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("will not fire the move twice while one is in flight", async () => {
    let release: () => void = () => {};
    const onConfirm = vi
      .fn()
      .mockImplementation(() => new Promise<void>((resolve) => (release = resolve)));
    setup({ ...unchanged, effect: "widens" }, { onConfirm });

    const button = screen.getByRole("button", { name: /move/i });
    fireEvent.click(button);
    fireEvent.click(button);

    expect(onConfirm).toHaveBeenCalledTimes(1);
    release();
  });
});
