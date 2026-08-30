import { cn } from "~/lib/utils";

export type SortDir = "asc" | "desc";

/**
 * A column header for a sortable data grid. Omit `onSort` for a column that cannot be sorted;
 * the header then renders as plain text and carries no `aria-sort`.
 */
export function SortHeader<K extends string>({
  label,
  sortKey,
  active = false,
  dir = "asc",
  onSort,
  align = "start",
  className,
}: {
  readonly label: string;
  readonly sortKey: K;
  readonly active?: boolean;
  readonly dir?: SortDir;
  readonly onSort?: (key: K) => void;
  readonly align?: "start" | "end";
  readonly className?: string;
}) {
  const nextDir = active && dir === "asc" ? "descending" : "ascending";
  return (
    <th
      scope="col"
      aria-sort={onSort && active ? (dir === "asc" ? "ascending" : "descending") : undefined}
      className={cn(
        "whitespace-nowrap bg-card px-3 py-2 text-xs font-medium text-muted-foreground",
        align === "end" ? "text-end" : "text-start",
        className
      )}
    >
      {onSort ? (
        /* The button's name is the column name only: an aria-label naming the next action would
           become the <th>'s name too, so every cell would be announced under "Type, sort
           descending". aria-sort carries the state and the title carries the hint. */
        <button
          type="button"
          onClick={() => onSort(sortKey)}
          title={`Sort by ${label}, ${nextDir}`}
          className={cn(
            // -my-1 keeps the header's visual height while the target clears WCAG 2.5.8's 24px.
            "-my-1 inline-flex items-center gap-1 rounded-sm py-1 transition-colors duration-150 hover:text-foreground",
            align === "end" && "flex-row-reverse",
            active && "text-foreground"
          )}
        >
          {label}
          {/* Held in the layout even when inactive, so sorting a column does not shift the row. */}
          <span aria-hidden className={cn("text-[0.6875rem]", !active && "opacity-0")}>
            {dir === "asc" ? "\u2191" : "\u2193"}
          </span>
        </button>
      ) : (
        label
      )}
    </th>
  );
}
