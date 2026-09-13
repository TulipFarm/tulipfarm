import { useEffect, useState } from "react";
import { Button } from "~/components/ui/button";
import { Link } from "~/components/ui/link";
import { listOperationalRuns, type OperationalRun } from "~/lib/operations";
import { useSessionUser } from "~/lib/use-session-user";

type RunsState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; runs: OperationalRun[] };

function RecentRuns() {
  const [state, setState] = useState<RunsState>({ status: "loading" });
  const [revision, setRevision] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision requests a fresh snapshot.
  useEffect(() => {
    let active = true;
    setState({ status: "loading" });
    void listOperationalRuns(undefined, 3).then(
      ({ items }) => {
        if (active) setState({ status: "ready", runs: items });
      },
      () => {
        if (active) setState({ status: "error" });
      }
    );
    return () => {
      active = false;
    };
  }, [revision]);

  return (
    <section aria-label="Recent runs" className="mt-6 border-t border-border pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-foreground">Recent runs</h2>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={state.status === "loading"}
            onClick={() => setRevision((value) => value + 1)}
          >
            Refresh runs
          </Button>
          <Link
            to="/business/activities?source=run"
            className="inline-flex min-h-11 items-center rounded-md px-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground sm:min-h-7"
          >
            All runs
          </Link>
        </div>
      </div>
      {state.status === "loading" ? (
        <p role="status" className="py-2 text-sm text-muted-foreground">
          Loading recent runs...
        </p>
      ) : state.status === "error" ? (
        <p role="alert" className="py-2 text-sm text-muted-foreground">
          Couldn't load recent runs.
        </p>
      ) : state.runs.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">No runs yet.</p>
      ) : (
        <ul className="flex flex-col">
          {state.runs.map((run) => (
            <li key={run.id}>
              <Link
                to={`/runs/${encodeURIComponent(run.id)}`}
                className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-1 py-2 text-sm hover:bg-accent active:bg-accent"
              >
                <span className="min-w-0 flex-1 break-words font-medium text-foreground">
                  {run.routineId}
                </span>
                <span className="text-xs text-muted-foreground">
                  {run.status.replace(/_/g, " ")}
                </span>
                <time
                  dateTime={run.createdAt}
                  className="text-xs text-muted-foreground"
                  title={new Date(run.createdAt).toLocaleString()}
                >
                  {new Date(run.createdAt).toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                  })}
                </time>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function ChatHomeRuns() {
  const user = useSessionUser();
  if (!user?.navigation?.visiblePaths.includes("/runs")) return null;
  return <RecentRuns key={user.id} />;
}
