import { type MetaFunction, useLoaderData, useRouteError } from "@remix-run/react";
import { EmptyState } from "~/components/empty-state";
import { PageShell } from "~/components/page-shell";
import { RoutineRow } from "~/components/routines/routine-row";
import { ErrorState } from "~/components/states";
import { Button } from "~/components/ui/button";
import { Link } from "~/components/ui/link";
import { ApiError } from "~/lib/api";
import { listOperationalRuns } from "~/lib/operations";
import { listRoutines } from "~/lib/routines";
import { latestByRoutine, routineTriggerKinds, runHealth } from "~/lib/routines/facts";

export const meta: MetaFunction = () => [{ title: "Scheduled Tasks · tulipfarm" }];

export async function clientLoader() {
  const [routines, runs] = await Promise.all([
    listRoutines(),
    // Health is a nicety; a page that will not render because the Run feed is down is a worse
    // answer than one that renders without it.
    listOperationalRuns(undefined, 100).catch(() => ({ items: [], nextCursor: null })),
  ]);
  const scheduled = routines.filter((routine) => routineTriggerKinds(routine).includes("schedule"));
  return { routines: scheduled, latest: latestByRoutine(runs.items) };
}

/**
 * The Routines that run on their own clock — cron, interval and one-off datetime Triggers — apart
 * from the ones a person, an event or a request starts. `/routines` still lists everything; this
 * is the narrower question an operator asks when they want to know what fires unattended.
 */
export default function ScheduledTasks() {
  const { routines, latest } = useLoaderData<typeof clientLoader>();

  return (
    <PageShell
      crumbs={[{ label: "Routines", to: "/routines" }, { label: "Scheduled Tasks" }]}
      title="Scheduled Tasks"
      actions={
        <Button asChild size="sm" variant="outline">
          <Link to="/routines">All routines</Link>
        </Button>
      }
    >
      {routines.length === 0 ? (
        <EmptyState
          section="scheduled tasks"
          title="No routines run on a schedule yet"
          hint="A routine with a cron, interval or one-time trigger will show up here once it is published."
        >
          <Button asChild variant="outline">
            <Link to="/routines">Browse all routines</Link>
          </Button>
        </EmptyState>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-md border border-border">
          {routines.map((routine) => {
            const run = latest[routine.id];
            return (
              <li key={routine.slug} className="min-w-0">
                <RoutineRow
                  routine={routine}
                  latest={run}
                  health={runHealth(run)}
                  headingLevel={2}
                />
              </li>
            );
          })}
        </ul>
      )}
    </PageShell>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const status = error instanceof ApiError ? error.status : undefined;
  const message = error instanceof Error ? error.message : undefined;
  return <ErrorState section="scheduled tasks" status={status} message={message} />;
}
