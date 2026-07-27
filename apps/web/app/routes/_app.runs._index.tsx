import { Link, useLoaderData, useRouteError } from "@remix-run/react";
import { useState } from "react";
import { EmptyState } from "~/components/empty-state";
import { ErrorState } from "~/components/states";
import { ApiError } from "~/lib/api";
import { listOperationalRuns, type OperationalRun } from "~/lib/operations";

export async function clientLoader() {
  return listOperationalRuns();
}

function timestamp(value: string) {
  return new Date(value).toLocaleString();
}

export default function RunsRoute() {
  const first = useLoaderData<typeof clientLoader>();
  // Keyset paging: each "Load more" appends the next page rather than re-reading from the top, so
  // Runs created while the operator is browsing cannot shift rows across page boundaries.
  const [runs, setRuns] = useState<OperationalRun[]>(first.items);
  const [cursor, setCursor] = useState(first.nextCursor);
  const [busy, setBusy] = useState(false);

  async function loadMore() {
    if (!cursor) return;
    setBusy(true);
    try {
      const page = await listOperationalRuns(cursor);
      setRuns((current) => [...current, ...page.items]);
      setCursor(page.nextCursor);
    } finally {
      setBusy(false);
    }
  }

  if (runs.length === 0) {
    return (
      <EmptyState
        section="runs"
        title="No Runs yet"
        hint="Runs appear here once a Routine, Chat turn, or trigger starts one."
      />
    );
  }

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-6 sm:px-6">
      <h1 className="text-sm font-medium uppercase tracking-[0.2em] text-muted-foreground">Runs</h1>
      <ul className="divide-y divide-border border border-border bg-card">
        {runs.map((run) => (
          <li key={run.id}>
            <Link
              to={`/runs/${encodeURIComponent(run.id)}`}
              className="grid gap-1 px-3 py-2 text-xs hover:bg-muted sm:grid-cols-4 sm:items-center"
            >
              <span className="rounded-sm border border-border px-2 py-1 text-center">
                {run.status}
              </span>
              <strong className="truncate">
                {run.routineId}@{run.routineVersion}
              </strong>
              <code className="truncate text-muted-foreground">{run.id}</code>
              <span className="text-muted-foreground sm:text-right">
                {timestamp(run.createdAt)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {cursor ? (
        <button
          type="button"
          disabled={busy}
          onClick={loadMore}
          className="self-start rounded-sm border border-border px-2.5 py-1.5 text-xs hover:bg-muted disabled:opacity-60"
        >
          {busy ? "Loading…" : "Load more"}
        </button>
      ) : null}
    </div>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  return (
    <ErrorState
      section="runs"
      status={error instanceof ApiError ? error.status : undefined}
      message={error instanceof Error ? error.message : undefined}
    />
  );
}
