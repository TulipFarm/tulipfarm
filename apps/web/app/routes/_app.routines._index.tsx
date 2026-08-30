import { Link, useLoaderData, useRouteError } from "@remix-run/react";
import { EmptyState } from "~/components/empty-state";
import { PageShell } from "~/components/page-shell";
import type { LatestRuns } from "~/components/routines/routine-catalog";
import { RoutineCatalog } from "~/components/routines/routine-catalog";
import { ErrorState } from "~/components/states";
import { Button } from "~/components/ui/button";
import { ApiError } from "~/lib/api";
import { listOperationalRuns } from "~/lib/operations";
import { listRoutines, type RunStatus } from "~/lib/routines";

/**
 * The newest Run per Routine, from one page of the global Run feed.
 *
 * One request rather than one per Routine: the feed is already newest-first, so the first Run seen
 * for a Routine is its newest, and a catalog of fifty Routines would otherwise cost fifty round
 * trips to answer a question worth one. A Routine whose newest Run fell outside this page reads as
 * "never run" — wrong only for a Routine idle longer than the last hundred Runs, and corrected by
 * opening it.
 */
function latestByRoutine(
  runs: readonly { id: string; routineId: string; status: string; createdAt: string }[]
): LatestRuns {
  const latest: LatestRuns = {};
  for (const run of runs) {
    if (latest[run.routineId]) continue;
    latest[run.routineId] = {
      id: run.id,
      status: run.status as RunStatus,
      createdAt: run.createdAt,
    };
  }
  return latest;
}

export async function clientLoader() {
  const [routines, runs] = await Promise.all([
    listRoutines(),
    // Health is a nicety; a catalog that will not render because the Run feed is down is a worse
    // answer than one that renders without it.
    listOperationalRuns(undefined, 100).catch(() => ({ items: [], nextCursor: null })),
  ]);
  return { routines, latest: latestByRoutine(runs.items) };
}

export default function RoutinesIndex() {
  const { routines, latest } = useLoaderData<typeof clientLoader>();

  return (
    <PageShell
      crumbs={[{ label: "Routines" }]}
      title="Routines"
      actions={
        <Button asChild size="sm" variant="outline">
          <Link to="/business/activities?source=run">All runs</Link>
        </Button>
      }
    >
      {routines.length === 0 ? (
        <EmptyState
          section="routines"
          title="No published routines yet"
          hint="Ask the assistant to create and publish one."
        />
      ) : (
        <RoutineCatalog routines={routines} latest={latest} />
      )}
    </PageShell>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const status = error instanceof ApiError ? error.status : undefined;
  const message = error instanceof Error ? error.message : undefined;
  return <ErrorState section="routines" status={status} message={message} />;
}
