import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

/**
 * The at-a-glance numbers above a table. Values use tabular figures so the digits line up in a
 * column and a changing count does not reflow the label beside it.
 *
 * The column count only ever divides the five figures evenly. A 2- or 3-column tier leaves an
 * implicit trailing cell that the `gap-px` hairline grid paints as a solid empty box, so narrow
 * viewports stack instead, with each label and value on one line.
 */
export function StatStrip({
  stats,
}: {
  readonly stats: ReadonlyArray<{
    label: string;
    value: ReactNode;
    title?: string;
    muted?: boolean;
  }>;
}) {
  return (
    <dl className="grid grid-cols-1 gap-px overflow-hidden rounded-md border border-border bg-border sm:grid-cols-5">
      {stats.map((stat) => (
        <div
          key={stat.label}
          className="flex items-baseline justify-between gap-3 bg-card px-3 py-2.5 sm:flex-col sm:items-start sm:gap-1"
        >
          <dt className="text-xs font-medium text-muted-foreground">{stat.label}</dt>
          <dd
            title={stat.title}
            className={cn(
              "truncate text-lg font-semibold tabular-nums",
              stat.muted ? "text-muted-foreground" : "text-foreground"
            )}
          >
            {stat.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
