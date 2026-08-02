import type * as React from "react";
import { cn } from "~/lib/utils";

export function Checkbox({ className, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type="checkbox"
      className={cn(
        "size-4 rounded-sm border border-input accent-primary disabled:cursor-not-allowed",
        "disabled:opacity-50",
        className
      )}
      {...props}
    />
  );
}
