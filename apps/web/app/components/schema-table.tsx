import { Link } from "@remix-run/react";
import type { ResourceRecord } from "~/lib/api";
import { type FieldDescriptor, type RenderedCell, renderValue } from "~/lib/schema";

/*
 * Schema-driven record list. Columns come from `listColumns` — no per-resource code. The id column
 * is the detail link (avoids invalid nested anchors when a row also contains an x-links cell);
 * x-links cells link to the target resource. Plain Tailwind table, terminal aesthetic.
 */

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

export function SchemaTable({
  columns,
  records,
  type,
}: {
  columns: FieldDescriptor[];
  records: ResourceRecord[];
  type: string;
}) {
  return (
    <div className="overflow-x-auto rounded-sm border border-border">
      <table className="w-full border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-border text-xs uppercase tracking-[0.15em] text-muted-foreground">
            {columns.map((col) => (
              <th key={col.name} scope="col" className="whitespace-nowrap px-3 py-2 font-medium">
                {col.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {records.map((record) => (
            <tr key={record.id} className="transition-colors hover:bg-accent">
              {columns.map((col) => {
                const value = record[col.name];
                return (
                  <td key={col.name} className="whitespace-nowrap px-3 py-2 align-top">
                    {col.isIdField ? (
                      <Link
                        to={`/resources/${encodeURIComponent(type)}/${encodeURIComponent(record.id)}`}
                        className="font-medium text-primary hover:underline"
                      >
                        {String(value ?? record.id)}
                      </Link>
                    ) : (
                      <ValueCell cell={renderValue(col, value)} />
                    )}
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
