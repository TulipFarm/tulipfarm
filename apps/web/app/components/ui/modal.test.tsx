import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { Modal } from "./modal";

/** jsdom reports a zero rect for everything, which would make every click look like a hit. */
function giveTheDialogARect() {
  const dialog = screen.getByRole("dialog", { hidden: true });
  dialog.getBoundingClientRect = () =>
    ({ left: 200, right: 600, top: 100, bottom: 400 }) as DOMRect;
  return dialog;
}

it("closes when the click lands on the backdrop", async () => {
  const onClose = vi.fn();
  render(
    <Modal open onClose={onClose} title="Add File">
      <p>body</p>
    </Modal>
  );
  const dialog = giveTheDialogARect();

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
    <Modal open onClose={onClose} title="Add File">
      {/* The file picker is opened by calling .click() on a hidden input, and a programmatic
          click reports clientX/clientY of 0 — which sits outside the dialog's rect. */}
      <input type="file" data-testid="picker" className="sr-only" />
    </Modal>
  );
  giveTheDialogARect();

  screen.getByTestId("picker").click();

  expect(onClose).not.toHaveBeenCalled();
});

it("does not let a file picker's cancel event close it", () => {
  const onClose = vi.fn();
  render(
    <Modal open onClose={onClose} title="Add File">
      <input type="file" data-testid="picker" className="sr-only" />
    </Modal>
  );

  // Chrome fires this on the input when the picker is dismissed; it bubbles to the <dialog>,
  // which reads it as its own Escape gesture. Preventing it is what keeps the dialog up.
  const event = new Event("cancel", { bubbles: true, cancelable: true });
  screen.getByTestId("picker").dispatchEvent(event);

  expect(event.defaultPrevented).toBe(true);
  expect(onClose).not.toHaveBeenCalled();
});

it("still lets its own cancel close it, so Escape keeps working", () => {
  render(
    <Modal open onClose={vi.fn()} title="Add File">
      <p>body</p>
    </Modal>
  );

  const event = new Event("cancel", { bubbles: true, cancelable: true });
  screen.getByRole("dialog", { hidden: true }).dispatchEvent(event);

  expect(event.defaultPrevented).toBe(false);
});
