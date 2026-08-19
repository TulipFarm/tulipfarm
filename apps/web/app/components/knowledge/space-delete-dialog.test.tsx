import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SpaceDeleteDialog } from "./space-delete-dialog";

/**
 * Deleting a Space takes its Pages with it. The dialog exists to say so *before* it happens, in
 * the specific — "12 pages", not "this cannot be undone" — because a generic warning is one the
 * reader has learned to click through.
 */
function open(props: Partial<React.ComponentProps<typeof SpaceDeleteDialog>> = {}) {
  const onConfirm = vi.fn().mockResolvedValue(undefined);
  const onClose = vi.fn();
  render(
    <SpaceDeleteDialog
      open
      space={{ id: "s1", name: "handbook", pageCount: 12 }}
      onConfirm={onConfirm}
      onClose={onClose}
      {...props}
    />
  );
  return { onConfirm, onClose };
}

describe("SpaceDeleteDialog", () => {
  it("names the Space and counts exactly what will be lost", () => {
    open();
    expect(screen.getByRole("dialog")).toHaveTextContent("handbook");
    expect(screen.getByRole("dialog")).toHaveTextContent("12 pages");
  });

  it("says a Space is empty rather than claiming it holds 0 pages", () => {
    open({ space: { id: "s1", name: "handbook", pageCount: 0 } });
    expect(screen.getByRole("dialog")).toHaveTextContent(/no pages/i);
    expect(screen.getByRole("dialog")).not.toHaveTextContent("0 pages");
  });

  it("agrees with itself on singular", () => {
    open({ space: { id: "s1", name: "handbook", pageCount: 1 } });
    expect(screen.getByRole("dialog")).toHaveTextContent("1 page");
    expect(screen.getByRole("dialog")).not.toHaveTextContent("1 pages");
  });

  it("offers cancel separately from the destructive confirm", async () => {
    const { onConfirm, onClose } = open();
    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onClose).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("deletes only on the explicit confirm", async () => {
    const { onConfirm } = open();
    await userEvent.click(screen.getByRole("button", { name: /confirm delete/i }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("cannot be double-submitted while the delete is in flight", async () => {
    let release: () => void = () => {};
    const onConfirm = vi.fn(() => new Promise<void>((r) => (release = r)));
    render(
      <SpaceDeleteDialog
        open
        space={{ id: "s1", name: "handbook", pageCount: 2 }}
        onConfirm={onConfirm}
        onClose={vi.fn()}
      />
    );
    const confirm = screen.getByRole("button", { name: /confirm delete/i });
    await userEvent.click(confirm);
    expect(confirm).toBeDisabled();
    await userEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledOnce();
    release();
  });

  it("reports a failed delete in the dialog rather than closing over it", async () => {
    const onConfirm = vi.fn().mockRejectedValue(new Error("space is in use"));
    const onClose = vi.fn();
    render(
      <SpaceDeleteDialog
        open
        space={{ id: "s1", name: "handbook", pageCount: 2 }}
        onConfirm={onConfirm}
        onClose={onClose}
      />
    );
    await userEvent.click(screen.getByRole("button", { name: /confirm delete/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("space is in use");
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /confirm delete/i })).toBeEnabled();
  });
});
