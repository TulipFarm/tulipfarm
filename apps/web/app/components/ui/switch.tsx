import type * as React from "react";
import { cn } from "~/lib/utils";

/**
 * A two-state toggle whose change takes effect immediately.
 *
 * Use it only where that is true. A setting that needs a Save press is a `Checkbox` — a switch
 * that has not applied yet reports a state the system is not in, and the reader has no way to
 * tell the two apart.
 *
 * It is a real `<button role="switch">`, not a styled checkbox, so `aria-checked` carries the
 * state and a `<label htmlFor>` still names it. The knob moves under `translate`, which is the one
 * transform reduced motion collapses without losing the state — the fill changes too.
 */
export function Switch({
  checked,
  onCheckedChange,
  className,
  disabled,
  ...props
}: Omit<React.ComponentProps<"button">, "onChange" | "type" | "value"> & {
  checked: boolean;
  onCheckedChange?: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange?.(!checked)}
      className={cn(
        "inline-flex h-6 w-10 shrink-0 items-center rounded-full border border-transparent p-1",
        "transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40",
        "disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-primary" : "bg-track",
        className
      )}
      {...props}
    >
      <span
        aria-hidden
        className={cn(
          "size-4 rounded-full bg-raised shadow-xs transition-transform",
          checked ? "translate-x-4" : "translate-x-0"
        )}
      />
    </button>
  );
}
