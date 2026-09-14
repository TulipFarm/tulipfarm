import { useLoaderData, useRouteError } from "@remix-run/react";
import { EmptyState } from "~/components/empty-state";
import { PageShell } from "~/components/page-shell";
import { RoutineCatalog } from "~/components/routines/routine-catalog";
import { ErrorState } from "~/components/states";
import { Button } from "~/components/ui/button";
import { Link } from "~/components/ui/link";
import { ApiError } from "~/lib/api";
import { listOperationalRuns } from "~/lib/operations";
import { listRoutines } from "~/lib/routines";
import { latestByRoutine } from "~/lib/routines/facts";

const createRoutineHref = `/?draft=${encodeURIComponent(
  "Help me create a routine for repeated work. Ask what should start it, what inputs it needs and what result I want. Help me review its steps and limits before publishing."
)}`;

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
        <>
          <Button asChild size="sm" variant="outline">
            <Link to="/business/activities?source=run">All runs</Link>
          </Button>
          {routines.length > 0 ? (
            <Button asChild size="sm">
              <Link to={createRoutineHref}>Create a routine in chat</Link>
            </Button>
          ) : null}
        </>
      }
    >
      {routines.length === 0 ? (
        <EmptyState
          section="routines"
          title="No published routines yet"
          hint="Turn repeated work into a routine. Describe when it should start and the result you need, then review the steps before it runs."
        >
          <Button asChild>
            <Link to={createRoutineHref}>Create a routine in chat</Link>
          </Button>
        </EmptyState>
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
