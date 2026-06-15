import { Link, type MetaFunction, useLoaderData, useRouteError } from "@remix-run/react";
import { useState } from "react";
import { CollectionList } from "~/components/knowledge/collection-list";
import { ResourcePanel } from "~/components/resource-panel";
import { ErrorState } from "~/components/states";
import { Button } from "~/components/ui/button";
import { ApiError } from "~/lib/api";
import { type CollectionWithCount, listCollectionsWithCounts } from "~/lib/knowledge-api";

export const meta: MetaFunction = () => [{ title: "Collections · Knowledge · tulipfarm" }];

export async function clientLoader() {
  const page = await listCollectionsWithCounts();
  return { items: page.items, nextCursor: page.nextCursor };
}

export default function CollectionsIndex() {
  const { items, nextCursor } = useLoaderData<typeof clientLoader>();
  const [cols, setCols] = useState<CollectionWithCount[]>(items);
  const [cursor, setCursor] = useState<string | null>(nextCursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadMore() {
    if (!cursor) return;
    setLoading(true);
    setError(null);
    try {
      const batch = await listCollectionsWithCounts(cursor);
      setCols((prev) => [...prev, ...batch.items]);
      setCursor(batch.nextCursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load more");
    } finally {
      setLoading(false);
    }
  }

  const crumbs = [{ label: "knowledge", to: "/knowledge" }, { label: "collections" }];

  return (
    <ResourcePanel crumbs={crumbs}>
      <div>
        <Button asChild variant="outline" size="sm">
          <Link to="/knowledge/collections/new">New collection</Link>
        </Button>
      </div>
      {error ? <p className="text-destructive">error: {error}</p> : null}
      {cols.length === 0 ? (
        <p className="text-muted-foreground">0 results</p>
      ) : (
        <>
          <CollectionList items={cols} />
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

export function ErrorBoundary() {
  const error = useRouteError();
  const status = error instanceof ApiError ? error.status : undefined;
  const message = error instanceof Error ? error.message : undefined;
  return <ErrorState section="knowledge" status={status} message={message} />;
}
