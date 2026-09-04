import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "~/lib/utils";

const badgeVariants = cva(
  "inline-flex h-5 shrink-0 items-center gap-1 rounded-full border px-2 text-xs font-medium",
  {
    variants: {
      variant: {
        neutral: "border-transparent bg-muted text-muted-foreground",
        info: "border-transparent bg-status-info-surface text-status-info",
        success: "border-transparent bg-status-success-surface text-status-success",
        warning: "border-transparent bg-status-warning-surface text-status-warning",
        danger: "border-transparent bg-status-danger-surface text-status-danger",
        primary: "border-transparent bg-secondary text-secondary-foreground",
      },
      /**
       * The micro-label form: a tag that classifies the thing it sits on rather than reporting its
       * state — a category, a step count, a tier.
       */
      caps: {
        true: "text-[0.625rem] font-semibold",
        false: "",
      },
    },
    defaultVariants: { variant: "neutral", caps: false },
  }
);

export function Badge({
  className,
  variant,
  caps,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant, caps }), className)} {...props} />;
}

export { badgeVariants };
