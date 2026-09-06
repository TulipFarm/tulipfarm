import type * as React from "react";
import { useEffect, useId, useRef } from "react";
import { X } from "~/components/icons";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

/* Native <dialog> supplies focus trap, Escape close, and ::backdrop without a dependency. */

export function Modal({
  open,
  onClose,
  title,
  children,
  className,
  bodyClassName,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  className?: string;
  /** Overrides the body's padding and flow, for a modal whose content fills its own height. */
  bodyClassName?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  // Drive open/close from props. Guard against calling when already in the
  // desired state to prevent spurious 'close' events triggering onClose.
  // Falls back to toggling the `open` attribute directly in environments that
  // don't implement showModal (e.g. jsdom in tests).
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      if (typeof d.showModal === "function") {
        d.showModal();
      } else {
        d.setAttribute("open", "");
      }
    } else if (!open && d.open) {
      if (typeof d.close === "function") {
        d.close();
      } else {
        d.removeAttribute("open");
      }
    }
  }, [open]);

  // Sync parent state when the dialog closes natively (Escape key).
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    d.addEventListener("close", onClose);
    return () => d.removeEventListener("close", onClose);
  }, [onClose]);

  // Chrome fires a bubbling `cancel` on <input type="file"> when the picker is dismissed, and a
  // <dialog> ancestor reads that as its own Escape gesture and closes — taking the upload dialog
  // down the moment the OS picker opens. https://issues.chromium.org/issues/41491454
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    const swallowDescendantCancel = (event: Event) => {
      if (event.target === d) return;
      event.preventDefault();
      event.stopPropagation();
    };
    d.addEventListener("cancel", swallowDescendantCancel);
    return () => d.removeEventListener("cancel", swallowDescendantCancel);
  }, []);

  // Close when the user clicks the ::backdrop (click lands on <dialog> itself,
  // outside its layout rect).
  function onBackdropClick(e: React.MouseEvent<HTMLDialogElement>) {
    // A click on a child never reaches the backdrop, whatever its coordinates say. Opening the
    // file picker calls .click() on a hidden input, and a programmatic click reports (0, 0) —
    // which the rect test below would read as a backdrop hit and close the dialog mid-upload.
    if (e.target !== e.currentTarget) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const outside =
      e.clientX < rect.left ||
      e.clientX > rect.right ||
      e.clientY < rect.top ||
      e.clientY > rect.bottom;
    if (outside) onClose();
  }

  if (!open) return null;

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: <dialog> handles keyboard dismissal natively via the Escape key (cancel → close event)
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClick={onBackdropClick}
      className={cn(
        "m-auto flex max-h-[85dvh] w-full max-w-sm flex-col overflow-hidden rounded-lg border border-border bg-popover p-0 text-foreground shadow-lg",
        "[&::backdrop]:bg-foreground/30",
        className
      )}
    >
      <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
        <h2 id={titleId} className="text-sm font-medium text-foreground">
          {title}
        </h2>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </div>
      <div className={cn("min-h-0 overflow-y-auto px-4 py-4 text-sm", bodyClassName)}>
        {children}
      </div>
    </dialog>
  );
}

export function ConfirmModal({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel = "Delete",
  busyLabel = "Deleting…",
  busy = false,
  error = null,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description: string;
  confirmLabel?: string;
  busyLabel?: string;
  busy?: boolean;
  /** A failed confirm belongs inside the dialog — `showModal` makes the rest of the page inert. */
  error?: string | null;
}) {
  return (
    <Modal open={open} onClose={onClose} title={title}>
      <p className="text-muted-foreground">{description}</p>
      {error ? (
        <p role="alert" className="mt-3 text-destructive">
          {error}
        </p>
      ) : null}
      <div className="mt-4 flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="rounded-sm"
          onClick={onClose}
          disabled={busy}
        >
          Cancel
        </Button>
        <Button
          type="button"
          variant="destructive"
          size="sm"
          className="rounded-sm"
          onClick={onConfirm}
          disabled={busy}
        >
          {busy ? busyLabel : confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
