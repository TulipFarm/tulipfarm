import { Link } from "@remix-run/react";
import type { CollectionWithCount } from "~/lib/knowledge-api";

/*
 * Collections list with per-collection document counts. Plain Tailwind table matching SchemaTable's
 * terminal aesthetic; the name links into the collection drill-in. Counts are `tabular-nums`.
 */
export function CollectionList({ items }: { items: CollectionWithCount[] }) {
  return (
    <div className="overflow-x-auto rounded-sm border border-border">
      <table className="w-full border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-border text-xs uppercase tracking-[0.15em] text-muted-foreground">
            <th scope="col" className="px-3 py-2 font-medium">
              name
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              description
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              documents
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {items.map((c) => (
            <tr key={c.id} className="transition-colors hover:bg-accent">
              <td className="whitespace-nowrap px-3 py-2 align-top">
                <Link
                  to={`/knowledge/collections/${encodeURIComponent(c.id)}`}
                  className="font-medium text-primary hover:underline"
                >
                  {c.name}
                </Link>
              </td>
              <td className="px-3 py-2 align-top">
                {c.description ? c.description : <span className="text-muted-foreground">—</span>}
              </td>
              <td className="whitespace-nowrap px-3 py-2 align-top tabular-nums">{c.docCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
