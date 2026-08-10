import type * as React from "react";
import { cn } from "~/lib/utils";

/**
 * The standard grouping container for settings and configuration surfaces.
 *
 * The top bar owns page identity, so a Panel names a group of related controls — never the page.
 * Use `flush` when children are full-bleed rows that draw their own separators.
 */
export function Panel({
  title,
  description,
  actions,
  footer,
  flush = false,
  className,
  children,
  ...props
}: Omit<React.ComponentProps<"section">, "title"> & {
  title?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  footer?: React.ReactNode;
  flush?: boolean;
}) {
  const hasHeader = Boolean(title || description || actions);

  return (
    <section
      className={cn("overflow-hidden rounded-md border border-border bg-card", className)}
      {...props}
    >
      {hasHeader ? (
        <div
          className={cn(
            "flex items-start justify-between gap-4 px-4 pt-4",
            flush ? "pb-4" : "pb-0",
            flush && "border-b border-border"
          )}
        >
          <div className="min-w-0">
            {title ? <h2 className="text-sm font-semibold text-foreground">{title}</h2> : null}
            {description ? (
              <p className="mt-1 max-w-prose text-sm text-muted-foreground">{description}</p>
            ) : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}

      <div className={cn(flush ? "" : "p-4", hasHeader && !flush && "pt-4")}>{children}</div>

      {footer ? (
        <div className="flex items-center justify-between gap-4 border-t border-border bg-muted/40 px-4 py-3">
          {footer}
        </div>
      ) : null}
    </section>
  );
}

/** A single full-bleed row inside a `flush` Panel. */
export function PanelRow({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-4 border-b border-border px-4 py-3 last:border-b-0",
        className
      )}
      {...props}
    />
  );
}

/** The empty state for a Panel whose collection has no members yet. */
export function PanelEmpty({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p className={cn("py-6 text-center text-sm text-muted-foreground", className)} {...props} />
  );
}
