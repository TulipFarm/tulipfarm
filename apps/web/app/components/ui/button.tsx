import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "~/lib/utils";

// shadcn/ui button (new-york), retuned for the flat, hairline-separated material in DESIGN.md §6.
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-sm font-medium transition-[color,background-color,border-color] disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-3.5 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90 active:bg-primary/85",
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-destructive/90 active:bg-destructive/85",
        outline:
          "border border-border bg-transparent hover:bg-accent hover:text-accent-foreground active:bg-accent/70",
        secondary: "bg-secondary text-secondary-foreground hover:bg-accent active:bg-accent/70",
        ghost: "hover:bg-accent hover:text-accent-foreground active:bg-accent/70",
        link: "text-brand underline-offset-4 hover:underline",
      },
      size: {
        default: "h-7 px-3 has-[>svg]:px-2.5 pointer-coarse:h-8",
        sm: "h-6 gap-1 px-2 has-[>svg]:px-1.5 pointer-coarse:h-8",
        lg: "h-8 px-4 has-[>svg]:px-3",
        icon: "size-7 pointer-coarse:size-8",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
