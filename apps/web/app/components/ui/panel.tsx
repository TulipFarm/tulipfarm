import type * as React from "react";
import { useId } from "react";
import { cn } from "~/lib/utils";

/**
 * The top bar owns page identity, so a Panel names a group of related controls — never the
 * page.
 *
 * A titled Panel points `aria-labelledby` at its own heading. A `<section>` is only a landmark once
 * it has an accessible name, so without this every panel on a page is an anonymous div to a screen
 * reader and there is no way to move between the groups the page is built out of.
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
  const headingId = useId();
  const hasHeader = Boolean(title || description || actions);

  return (
    <section
      className={cn("overflow-hidden rounded-lg border border-border bg-card", className)}
      aria-labelledby={title ? headingId : undefined}
      {...props}
    >
      {hasHeader ? (
        <div
          className={cn(
            "flex flex-col items-stretch gap-4 px-4 pt-4 sm:flex-row sm:items-start sm:justify-between",
            flush ? "pb-4" : "pb-0",
            flush && "border-b border-border"
          )}
        >
          <div className="min-w-0">
            {title ? (
              <h2 id={headingId} className="text-sm font-semibold text-foreground">
                {title}
              </h2>
            ) : null}
            {description ? (
              <p className="mt-1 max-w-prose text-base text-muted-foreground">{description}</p>
            ) : null}
          </div>
          {actions ? (
            <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:shrink-0">
              {actions}
            </div>
          ) : null}
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

export function PanelEmpty({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p className={cn("py-6 text-center text-sm text-muted-foreground", className)} {...props} />
  );
}

/**
 * One setting: what it is on the left, the control that changes it on the right.
 *
 * The reader scans the left column to find the thing they came to change, so the label and its
 * explanation are one block and the control is the only thing in the right column — a control
 * inlined after the description would put the target somewhere different on every row. The columns
 * stack below `md`, where two of them leave the control too narrow to operate.
 *
 * `htmlFor` names the control the label points at. Omit it only when the right column holds
 * several controls or something that is not a labelable element, in which case the caller must
 * label them itself.
 */
export function SettingRow({
  label,
  description,
  htmlFor,
  className,
  children,
  ...props
}: Omit<React.ComponentProps<"div">, "title"> & {
  label: React.ReactNode;
  description?: React.ReactNode;
  htmlFor?: string;
}) {
  const Label = htmlFor ? "label" : "span";

  return (
    <div
      className={cn(
        "grid gap-x-8 gap-y-2 border-b border-border py-5 last:border-b-0 md:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]",
        className
      )}
      {...props}
    >
      <div className="min-w-0">
        <Label
          htmlFor={htmlFor}
          className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground"
        >
          {label}
        </Label>
        {description ? (
          <p className="mt-1 max-w-prose text-base text-muted-foreground">{description}</p>
        ) : null}
      </div>
      <div className="min-w-0 max-w-md">{children}</div>
    </div>
  );
}
