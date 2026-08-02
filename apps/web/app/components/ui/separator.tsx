import type * as React from "react";
import { cn } from "~/lib/utils";

export function Separator({
  orientation = "horizontal",
  className,
  ...props
}: React.ComponentProps<"hr"> & { orientation?: "horizontal" | "vertical" }) {
  return (
    <hr
      aria-orientation={orientation}
      className={cn(
        "shrink-0 border-0 bg-border",
        orientation === "horizontal" ? "h-px w-full" : "h-full w-px",
        className
      )}
      {...props}
    />
  );
}
