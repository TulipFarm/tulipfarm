import { X } from "lucide-react";
import type * as React from "react";
import { useEffect, useRef } from "react";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

/*
 * Modal — built on the native <dialog> element.
 *
 * Using the browser's showModal() gives us focus-trap, Escape-to-close, and
 * the ::backdrop pseudo-element for free — no Radix or third-party dependency.
 * Flat/hairline aesthetic: no shadows, rounded-sm panel, border-border.
 */

export function Modal({
  open,
  onClose,
  title,
  children,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);

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

  // Close when the user clicks the ::backdrop (click lands on <dialog> itself,
  // outside its layout rect).
  function onBackdropClick(e: React.MouseEvent<HTMLDialogElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const outside =
      e.clientX < rect.left ||
      e.clientX > rect.right ||
      e.clientY < rect.top ||
      e.clientY > rect.bottom;
    if (outside) onClose();
  }

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: <dialog> handles keyboard dismissal natively via the Escape key (cancel → close event)
    <dialog
      ref={ref}
      onClick={onBackdropClick}
      className={cn(
        "m-auto w-full max-w-sm rounded-sm border border-border bg-card p-0 text-foreground",
        "[&::backdrop]:bg-foreground/30",
        className
      )}
    >
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-sm font-medium text-foreground">{title}</h2>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="rounded-sm p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </div>
      <div className="px-4 py-4 text-sm">{children}</div>
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
  busy = false,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description: string;
  confirmLabel?: string;
  busy?: boolean;
}) {
  return (
    <Modal open={open} onClose={onClose} title={title}>
      <p className="text-muted-foreground">{description}</p>
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
          {busy ? "Deleting…" : confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
