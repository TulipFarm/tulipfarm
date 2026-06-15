import { Link, type MetaFunction, useLoaderData, useRouteError } from "@remix-run/react";
import { type FormEvent, useMemo, useState } from "react";
import { DocTable, SearchResults } from "~/components/knowledge/doc-list";
import { ResourcePanel } from "~/components/resource-panel";
import { ErrorState } from "~/components/states";
import { Button } from "~/components/ui/button";
import { ApiError } from "~/lib/api";
import {
  type KnowledgeDocument,
  listDocuments,
  type SearchHit,
  searchDocuments,
} from "~/lib/knowledge-api";
import type { SortState } from "~/lib/schema";

export const meta: MetaFunction = () => [{ title: "Documents · Knowledge · tulipfarm" }];

export async function clientLoader() {
  const page = await listDocuments();
  return { items: page.items, nextCursor: page.nextCursor };
}

const inputClass =
  "h-8 flex-1 rounded-sm border border-border bg-background px-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export default function DocumentsIndex() {
  const { items, nextCursor } = useLoaderData<typeof clientLoader>();
  const [docs, setDocs] = useState<KnowledgeDocument[]>(items);
  const [cursor, setCursor] = useState<string | null>(nextCursor);
  const [loading, setLoading] = useState(false);
  const [sort, setSort] = useState<SortState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [searching, setSearching] = useState(false);

  const sorted = useMemo(() => sortDocuments(docs, sort), [docs, sort]);

  function toggleSort(column: string) {
    setSort((prev) =>
      prev?.field === column
        ? { field: column, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { field: column, dir: "asc" }
    );
  }

  async function loadMore() {
    if (!cursor) return;
    setLoading(true);
    setError(null);
    try {
      const batch = await listDocuments(cursor);
      setDocs((prev) => [...prev, ...batch.items]);
      setCursor(batch.nextCursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load more");
    } finally {
      setLoading(false);
    }
  }

  async function onSearch(e: FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q) {
      setHits(null);
      setWarnings([]);
      return;
    }
    setSearching(true);
    setError(null);
    try {
      const res = await searchDocuments(q);
      setHits(res.results);
      setWarnings(res.warnings);
    } catch (err) {
      setError(err instanceof Error ? err.message : "search failed");
    } finally {
      setSearching(false);
    }
  }

  function clearSearch() {
    setQuery("");
    setHits(null);
    setWarnings([]);
  }

  const crumbs = [{ label: "knowledge", to: "/knowledge" }, { label: "documents" }];

  return (
    <ResourcePanel crumbs={crumbs}>
      <div>
        <Button asChild variant="outline" size="sm">
          <Link to="/knowledge/documents/new">New document</Link>
        </Button>
      </div>

      <form onSubmit={onSearch} className="flex items-center gap-2">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="search knowledge…"
          aria-label="search documents"
          className={inputClass}
        />
        <Button type="submit" variant="outline" size="sm" disabled={searching}>
          {searching ? "…" : "Search"}
        </Button>
        {hits !== null ? (
          <Button type="button" variant="ghost" size="sm" onClick={clearSearch}>
            Clear
          </Button>
        ) : null}
      </form>

      {error ? <p className="text-destructive">error: {error}</p> : null}

      {hits !== null ? (
        <>
          {warnings.includes("embedding-unavailable") ? (
            <p className="text-xs text-muted-foreground">
              ⚠ embeddings unavailable — showing keyword (lexical) results.
            </p>
          ) : null}
          <SearchResults hits={hits} />
        </>
      ) : docs.length === 0 ? (
        <p className="text-muted-foreground">0 results</p>
      ) : (
        <>
          <DocTable documents={sorted} sort={sort ?? undefined} onToggleSort={toggleSort} />
          {cursor ? (
            <div>
              <Button variant="outline" size="sm" onClick={loadMore} disabled={loading}>
                {loading ? "loading…" : "Load more"}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </ResourcePanel>
  );
}

// Client-side sort over the loaded set by a string column (title/domain/updatedAt).
function sortDocuments(docs: KnowledgeDocument[], sort: SortState | null): KnowledgeDocument[] {
  if (!sort) return docs;
  const dir = sort.dir === "asc" ? 1 : -1;
  const key = sort.field as "title" | "domain" | "updatedAt";
  return [...docs].sort(
    (a, b) => ((a[key] ?? "") as string).localeCompare((b[key] ?? "") as string) * dir
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const status = error instanceof ApiError ? error.status : undefined;
  const message = error instanceof Error ? error.message : undefined;
  return <ErrorState section="knowledge" status={status} message={message} />;
}
