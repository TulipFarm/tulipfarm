import { Link, type MetaFunction, useLoaderData, useRouteError } from "@remix-run/react";
import { useState } from "react";
import { SpaceList } from "~/components/knowledge/space-list";
import { ResourcePanel } from "~/components/resource-panel";
import { ErrorState } from "~/components/states";
import { Button } from "~/components/ui/button";
import { ApiError } from "~/lib/api";
import { type KnowledgeSpace, listSpaces } from "~/lib/knowledge-api";

export const meta: MetaFunction = () => [{ title: "Spaces · Knowledge · tulipfarm" }];

export async function clientLoader() {
  const page = await listSpaces();
  return { items: page.items, nextCursor: page.nextCursor };
}

export default function SpacesIndex() {
  const { items, nextCursor } = useLoaderData<typeof clientLoader>();
  const [spaces, setSpaces] = useState<KnowledgeSpace[]>(items);
  const [cursor, setCursor] = useState<string | null>(nextCursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadMore() {
    if (!cursor) return;
    setLoading(true);
    setError(null);
    try {
      const batch = await listSpaces(cursor);
      setSpaces((prev) => [...prev, ...batch.items]);
      setCursor(batch.nextCursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load more");
    } finally {
      setLoading(false);
    }
  }

  const crumbs = [{ label: "knowledge", to: "/knowledge" }, { label: "spaces" }];

  return (
    <ResourcePanel crumbs={crumbs}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-base font-bold text-foreground">Spaces</h1>
          <p className="text-sm text-muted-foreground">
            OKF knowledge spaces — hierarchical, cross-linked wikis for humans and agents.
          </p>
        </div>
        <Button asChild size="sm">
          <Link to="/knowledge/spaces/new">＋ New space</Link>
        </Button>
      </div>
      {error ? <p className="text-destructive">error: {error}</p> : null}
      {spaces.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
          No spaces yet. Create one to start a knowledge wiki.
        </p>
      ) : (
        <>
          <SpaceList items={spaces} />
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
