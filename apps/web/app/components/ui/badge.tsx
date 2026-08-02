import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "~/lib/utils";

const badgeVariants = cva(
  "inline-flex h-5 shrink-0 items-center gap-1 rounded-sm border px-1.5 text-xs font-medium",
  {
    variants: {
      variant: {
        neutral: "border-border bg-muted text-muted-foreground",
        info: "border-status-info/30 bg-status-info/10 text-status-info",
        success: "border-status-success/30 bg-status-success/10 text-status-success",
        warning: "border-status-warning/30 bg-status-warning/10 text-status-warning",
        danger: "border-status-danger/30 bg-status-danger/10 text-status-danger",
        primary: "border-primary/30 bg-primary/10 text-primary",
      },
    },
    defaultVariants: { variant: "neutral" },
  }
);

export function Badge({
  className,
  variant,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { badgeVariants };
