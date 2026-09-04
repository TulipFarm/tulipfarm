import type * as React from "react";
import { cn } from "~/lib/utils";

export function Select({ className, ...props }: React.ComponentProps<"select">) {
  return (
    <select
      className={cn(
        "h-7 w-full rounded-md border border-input bg-background px-2.5 text-sm pointer-coarse:h-8",
        "transition-[color,border-color]",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    />
  );
}
