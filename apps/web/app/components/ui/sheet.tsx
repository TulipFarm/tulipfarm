import { X } from "lucide-react";
import type * as React from "react";
import { useEffect, useRef } from "react";
import { cn } from "~/lib/utils";

/* Native <dialog> is re-pinned full-height to the right instead of centered. */
export function Sheet({
  open,
  onClose,
  title,
  headerActions,
  children,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Extra controls seated left of Close, for a sheet that also opens somewhere fuller. */
  headerActions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  // Drive open/close from props; guard against redundant calls. Fall back to the `open` attribute in
  // environments without showModal (jsdom).
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      // showModal throws "Not implemented" under jsdom — fall back to the plain `open` attribute there.
      try {
        d.showModal();
      } catch {
        d.setAttribute("open", "");
      }
    } else if (!open && d.open) {
      try {
        d.close();
      } catch {
        d.removeAttribute("open");
      }
    }
  }, [open]);

  // Sync parent state when the dialog closes natively (Escape).
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    d.addEventListener("close", onClose);
    return () => d.removeEventListener("close", onClose);
  }, [onClose]);

  // Close when the click lands on the ::backdrop (outside the panel's layout rect).
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
    // biome-ignore lint/a11y/useKeyWithClickEvents: <dialog> handles keyboard dismissal natively via Escape (cancel → close event)
    <dialog
      ref={ref}
      onClick={onBackdropClick}
      className={cn(
        "tf-sheet my-0 mr-0 ml-auto h-dvh max-h-dvh w-full max-w-md rounded-none border-border border-l bg-card p-0 text-foreground",
        className
      )}
    >
      <div className="flex h-full flex-col">
        <div className="flex shrink-0 items-center justify-between gap-2 border-border border-b px-4 py-3">
          <h2 className="min-w-0 truncate text-sm font-medium text-foreground">{title}</h2>
          <div className="flex shrink-0 items-center gap-1">
            {headerActions}
            <button
              type="button"
              aria-label="Close"
              onClick={onClose}
              className="cursor-pointer rounded-sm p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <X className="size-4" aria-hidden />
            </button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 text-sm">{children}</div>
      </div>
    </dialog>
  );
}
