import { AlertTriangle, ArrowRight, CornerDownLeft, Zap } from "lucide-react";
import { Link } from "~/components/ui/link";
import type { CatalogSort, CatalogSortKey, CatalogType } from "~/lib/resource-catalog";
import { formatCount, timeAgo } from "~/lib/schema";
import { cn } from "~/lib/utils";
import { SortHeader } from "../ui/sort-header";

/** How many link targets fit in a cell before the rest collapse into a "+N" with a full title. */
const LINK_PREVIEW = 2;

function LinkList({
  targets,
  direction,
}: {
  readonly targets: readonly string[];
  readonly direction: "out" | "in";
}) {
  if (targets.length === 0) return null;
  const shown = targets.slice(0, LINK_PREVIEW);
  const rest = targets.length - shown.length;
  const Icon = direction === "out" ? ArrowRight : CornerDownLeft;
  const label = direction === "out" ? "Points at" : "Referenced by";

  return (
    <span className="flex items-center gap-1" title={`${label}: ${targets.join(", ")}`}>
      <Icon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
      <span className="sr-only">{label}: </span>
      <span className="truncate">{shown.join(", ")}</span>
      {rest > 0 ? <span className="shrink-0 text-muted-foreground">+{rest}</span> : null}
    </span>
  );
}

export function CatalogTable({
  rows,
  sort,
  onSort,
}: {
  readonly rows: readonly CatalogType[];
  readonly sort: CatalogSort;
  readonly onSort: (key: CatalogSortKey) => void;
}) {
  const header = (key: CatalogSortKey, label: string, align?: "start" | "end") => (
    <SortHeader
      label={label}
      sortKey={key}
      active={sort.key === key}
      dir={sort.key === key ? sort.dir : "asc"}
      onSort={onSort}
      className="border-b border-border"
      {...(align ? { align } : {})}
    />
  );

  return (
    /* The grid owns its vertical scroll so the header can stick to it; scrolling the page instead
       would carry the header off-screen and leave a wide table with unlabelled columns. */
    <div className="max-h-[70svh] overflow-auto rounded-md border border-border">
      {/* border-separate, not collapse: a collapsed border is painted by the table rather than the
          cell, so the sticky header loses its rule the moment the body scrolls under it. */}
      <table className="w-full min-w-[44rem] border-separate border-spacing-0 text-sm">
        <thead className="sticky top-0 z-10">
          <tr>
            {header("name", "Type")}
            {header("domain", "Domain")}
            {header("records", "Records", "end")}
            {header("fields", "Fields", "end")}
            <SortHeader
              label="Relationships"
              sortKey="relationships"
              className="border-b border-border"
            />
            {header("updated", "Last write", "end")}
          </tr>
        </thead>
        {/* With border-separate a border on <tr> is not painted, so the row rule lives on the
            cells. The last row leans on the container's own border instead. */}
        <tbody className="[&>tr:last-child>td]:border-b-0 [&>tr>td]:border-b [&>tr>td]:border-border">
          {rows.map((row) => (
            <tr key={row.name} className="group transition-colors duration-150 hover:bg-accent">
              <td className="px-3 py-2.5 align-top">
                <Link
                  to={`/resources/${encodeURIComponent(row.name)}`}
                  className="font-medium text-foreground underline-offset-4 group-hover:underline"
                >
                  {row.name}
                </Link>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  {row.schemaError ? (
                    <span className="inline-flex items-center gap-1 text-status-danger">
                      <AlertTriangle aria-hidden className="size-3" />
                      Schema will not parse
                    </span>
                  ) : row.keyFields.length > 0 ? (
                    row.keyFields.join(" \u00b7 ")
                  ) : (
                    "No fields yet"
                  )}
                </p>
              </td>

              <td className="px-3 py-2.5 align-top">
                {row.domain ? (
                  <span className="text-foreground">{row.domain}</span>
                ) : (
                  <span className="text-muted-foreground">{"\u2014"}</span>
                )}
                {row.hasHooks ? (
                  <span
                    title="This type runs hooks on write"
                    className="mt-0.5 flex items-center gap-1 text-xs text-status-info"
                  >
                    <Zap aria-hidden className="size-3" />
                    Hooks
                  </span>
                ) : null}
              </td>

              <td
                className={cn(
                  "px-3 py-2.5 text-end align-top tabular-nums",
                  row.recordCount === null && "text-muted-foreground"
                )}
                title={row.recordCount === null ? "You cannot list this type" : undefined}
              >
                {formatCount(row.recordCount)}
              </td>

              <td className="px-3 py-2.5 text-end align-top tabular-nums">
                {row.fieldCount}
                {row.requiredCount > 0 ? (
                  <span
                    className="text-xs text-muted-foreground"
                    title={`${row.requiredCount} required`}
                  >
                    {" "}
                    ({row.requiredCount} req)
                  </span>
                ) : null}
              </td>

              <td className="max-w-[18rem] px-3 py-2.5 align-top text-xs">
                {row.links.length === 0 && row.linkedBy.length === 0 ? (
                  <span className="text-muted-foreground">None</span>
                ) : (
                  <span className="flex flex-col gap-0.5">
                    <LinkList targets={row.links} direction="out" />
                    <LinkList targets={row.linkedBy} direction="in" />
                  </span>
                )}
              </td>

              <td className="whitespace-nowrap px-3 py-2.5 text-end align-top text-xs text-muted-foreground">
                {row.lastUpdatedAt ? (
                  <span title={new Date(row.lastUpdatedAt).toLocaleString()}>
                    {timeAgo(row.lastUpdatedAt)}
                  </span>
                ) : (
                  "Never"
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
