import { Link } from "@remix-run/react";
import type * as React from "react";
import type { ResourceRecord } from "~/lib/api";
import { type FieldDescriptor, type RenderedCell, renderValue, type SortState } from "~/lib/schema";
import { cn } from "~/lib/utils";
import { SortHeader } from "./ui/sort-header";

export type Density = "compact" | "comfortable";

/* The id cell owns detail navigation to avoid nested anchors inside x-links cells. */

// Maps a RenderedCell (from schema.renderValue) to JSX. Shared by the table and the detail view.
export function ValueCell({ cell }: { cell: RenderedCell }) {
  switch (cell.kind) {
    case "muted":
      return <span className="text-muted-foreground">{cell.text}</span>;
    case "link":
      return (
        <Link to={cell.to} className="text-primary hover:underline">
          {cell.label}
          <span aria-hidden> ↗</span>
        </Link>
      );
    case "bool":
      return cell.value ? (
        <span className="text-primary">✓</span>
      ) : (
        <span className="text-muted-foreground">✗</span>
      );
    case "json":
      return <code className="text-foreground">{cell.text}</code>;
    default:
      return <span>{cell.text}</span>;
  }
}

const CELL_MAX_CHARS = 48;

/** The text a cell renders, for the hover title. A boolean glyph has no text worth repeating. */
function cellFullText(cell: RenderedCell): string {
  switch (cell.kind) {
    case "link":
      return cell.label;
    case "bool":
      return "";
    default:
      return cell.text;
  }
}

/* Long values are clamped so one wide cell cannot dictate every column's width, but the full text
   stays reachable on hover rather than being silently cropped. */
function Cell({ text, children }: { text: string; children: React.ReactNode }) {
  return (
    <div className="max-w-[24rem] truncate" title={text.length > CELL_MAX_CHARS ? text : undefined}>
      {children}
    </div>
  );
}

export function SchemaTable({
  columns,
  records,
  type,
  sort,
  onToggleSort,
  density = "comfortable",
}: {
  columns: FieldDescriptor[];
  records: ResourceRecord[];
  type: string;
  // Controlled sort. When `onToggleSort` is provided, headers become sort buttons; otherwise static.
  sort?: SortState;
  onToggleSort?: (column: string) => void;
  density?: Density;
}) {
  const cellPad = density === "compact" ? "px-3 py-1" : "px-3 py-2";
  return (
    /* The grid owns its own vertical scroll so the header can stick to it. Scrolling the page
       instead would carry the header off-screen and leave a wide table with unlabelled columns. */
    <div className="max-h-[70svh] overflow-auto rounded-md border border-border">
      {/* border-separate, not collapse: a collapsed border is painted by the table rather than the
          cell, so the sticky header loses its rule the moment the body scrolls under it. */}
      <table className="w-full border-separate border-spacing-0 text-left text-sm">
        <thead className="sticky top-0 z-10">
          <tr>
            {columns.map((col) => (
              <SortHeader
                key={col.name}
                label={col.name}
                sortKey={col.name}
                active={sort?.field === col.name}
                dir={sort?.dir ?? "asc"}
                className="border-b border-border"
                {...(onToggleSort ? { onSort: onToggleSort } : {})}
              />
            ))}
          </tr>
        </thead>
        {/* With border-separate a border on <tr> is not painted, so the row rule lives on the
            cells. The last row leans on the container's own border instead. */}
        <tbody className="[&>tr:last-child>td]:border-b-0 [&>tr>td]:border-b [&>tr>td]:border-border">
          {records.map((record) => (
            <tr key={record.id} className="transition-colors duration-150 hover:bg-accent">
              {columns.map((col) => {
                const value = record[col.name];
                const numeric = col.kind === "number";
                if (col.isIdField) {
                  const label = String(value ?? record.id);
                  return (
                    <td key={col.name} className={cn(cellPad, "align-top")}>
                      <Cell text={label}>
                        <Link
                          to={`/resources/${encodeURIComponent(type)}/${encodeURIComponent(record.id)}`}
                          className="font-medium text-primary hover:underline"
                        >
                          {label}
                        </Link>
                      </Cell>
                    </td>
                  );
                }
                const cell = renderValue(col, value);
                return (
                  <td
                    key={col.name}
                    className={cn(cellPad, "align-top", numeric && "text-end tabular-nums")}
                  >
                    <Cell text={cellFullText(cell)}>
                      <ValueCell cell={cell} />
                    </Cell>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
