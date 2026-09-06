import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { Sheet } from "./sheet";

/** jsdom reports a zero rect for everything, which would make every click look like a hit. */
function giveTheSheetARect() {
  const dialog = screen.getByRole("dialog", { hidden: true });
  dialog.getBoundingClientRect = () =>
    ({ left: 200, right: 600, top: 100, bottom: 400 }) as DOMRect;
  return dialog;
}

it("closes when the click lands on the backdrop", async () => {
  const onClose = vi.fn();
  render(
    <Sheet open onClose={onClose} title="Preview">
      <p>body</p>
    </Sheet>
  );
  const dialog = giveTheSheetARect();

  await userEvent.pointer({
    target: dialog,
    coords: { clientX: 10, clientY: 10 },
    keys: "[MouseLeft]",
  });

  expect(onClose).toHaveBeenCalledTimes(1);
});

it("stays open when a child dispatches a click carrying no coordinates", async () => {
  const onClose = vi.fn();
  render(
    <Sheet open onClose={onClose} title="Preview">
      <input type="file" data-testid="picker" className="sr-only" />
    </Sheet>
  );
  giveTheSheetARect();

  screen.getByTestId("picker").click();

  expect(onClose).not.toHaveBeenCalled();
});

it("does not let a file picker's cancel event close it", () => {
  const onClose = vi.fn();
  render(
    <Sheet open onClose={onClose} title="Preview">
      <input type="file" data-testid="picker" className="sr-only" />
    </Sheet>
  );

  const event = new Event("cancel", { bubbles: true, cancelable: true });
  screen.getByTestId("picker").dispatchEvent(event);

  expect(event.defaultPrevented).toBe(true);
  expect(onClose).not.toHaveBeenCalled();
});
