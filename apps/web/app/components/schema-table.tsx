import { Link } from "@remix-run/react";
import type * as React from "react";
import type { ResourceRecord } from "~/lib/api";
import { type FieldDescriptor, type RenderedCell, renderValue, type SortState } from "~/lib/schema";

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
}: {
  columns: FieldDescriptor[];
  records: ResourceRecord[];
  type: string;
  // Controlled sort. When `onToggleSort` is provided, headers become sort buttons; otherwise static.
  sort?: SortState;
  onToggleSort?: (column: string) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-sm border border-border">
      <table className="w-full border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-border text-xs uppercase tracking-[0.15em] text-muted-foreground">
            {columns.map((col) => {
              const active = sort?.field === col.name;
              const ariaSort = active
                ? sort.dir === "asc"
                  ? "ascending"
                  : "descending"
                : undefined;
              return (
                <th
                  key={col.name}
                  scope="col"
                  aria-sort={ariaSort}
                  className="whitespace-nowrap px-3 py-2 font-medium"
                >
                  {onToggleSort ? (
                    <button
                      type="button"
                      onClick={() => onToggleSort(col.name)}
                      className="inline-flex items-center gap-1 hover:text-foreground"
                    >
                      {col.name}
                      {active ? <span aria-hidden>{sort.dir === "asc" ? "↑" : "↓"}</span> : null}
                    </button>
                  ) : (
                    col.name
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {records.map((record) => (
            <tr key={record.id} className="transition-colors hover:bg-accent">
              {columns.map((col) => {
                const value = record[col.name];
                if (col.isIdField) {
                  const label = String(value ?? record.id);
                  return (
                    <td key={col.name} className="px-3 py-2 align-top">
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
                  <td key={col.name} className="px-3 py-2 align-top">
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
