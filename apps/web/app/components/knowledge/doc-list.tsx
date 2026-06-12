import { Link } from "@remix-run/react";
import type { KnowledgeDocument, SearchHit } from "~/lib/knowledge-api";
import type { SortState } from "~/lib/schema";
import { IndexStatusBadge } from "./index-status-badge";

/*
 * Documents browse table + semantic-search results list. Both presentational; the route owns the
 * loaded set, sort state, "load more" cursor, and search mode. Matches SchemaTable's terminal look.
 */
const SORTABLE = new Set(["title", "domain", "updatedAt"]);
const COLUMNS: { key: string; label: string }[] = [
  { key: "title", label: "title" },
  { key: "domain", label: "domain" },
  { key: "tags", label: "tags" },
  { key: "updatedAt", label: "updated" },
  { key: "indexingStatus", label: "status" },
];

export function DocTable({
  documents,
  sort,
  onToggleSort,
}: {
  documents: KnowledgeDocument[];
  sort?: SortState;
  onToggleSort?: (column: string) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-sm border border-border">
      <table className="w-full border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-border text-xs uppercase tracking-[0.15em] text-muted-foreground">
            {COLUMNS.map((col) => {
              const active = sort?.field === col.key;
              const sortable = onToggleSort && SORTABLE.has(col.key);
              return (
                <th
                  key={col.key}
                  scope="col"
                  aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}
                  className="whitespace-nowrap px-3 py-2 font-medium"
                >
                  {sortable ? (
                    <button
                      type="button"
                      onClick={() => onToggleSort(col.key)}
                      className="inline-flex items-center gap-1 hover:text-foreground"
                    >
                      {col.label}
                      {active ? <span aria-hidden>{sort.dir === "asc" ? "↑" : "↓"}</span> : null}
                    </button>
                  ) : (
                    col.label
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {documents.map((d) => (
            <tr key={d.id} className="transition-colors hover:bg-accent">
              <td className="whitespace-nowrap px-3 py-2 align-top">
                <Link
                  to={`/knowledge/documents/${encodeURIComponent(d.id)}`}
                  className="font-medium text-primary hover:underline"
                >
                  {d.title}
                </Link>
              </td>
              <td className="px-3 py-2 align-top">
                {d.domain ? d.domain : <span className="text-muted-foreground">—</span>}
              </td>
              <td className="px-3 py-2 align-top">
                {d.tags.length ? (
                  d.tags.join(", ")
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </td>
              <td className="whitespace-nowrap px-3 py-2 align-top text-muted-foreground">
                {d.updatedAt.slice(0, 10)}
              </td>
              <td className="whitespace-nowrap px-3 py-2 align-top">
                <IndexStatusBadge status={d.indexingStatus ?? "pending"} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SearchResults({ hits }: { hits: SearchHit[] }) {
  if (hits.length === 0) return <p className="text-muted-foreground">0 results</p>;
  return (
    <ul className="flex flex-col gap-2">
      {hits.map((h) => (
        <li key={h.chunkId} className="rounded-sm border border-border px-3 py-2">
          <div className="flex items-center gap-2">
            <Link
              to={`/knowledge/documents/${encodeURIComponent(h.documentId)}`}
              className="font-medium text-primary hover:underline"
            >
              {h.title}
            </Link>
            <span className="ml-auto text-xs tabular-nums text-muted-foreground">
              score {h.score.toFixed(2)}
            </span>
          </div>
          <p className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">{h.content}</p>
        </li>
      ))}
    </ul>
  );
}
