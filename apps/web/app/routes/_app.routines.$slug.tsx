import {
  type ClientLoaderFunctionArgs,
  Link,
  type MetaFunction,
  useLoaderData,
  useNavigate,
  useRevalidator,
  useRouteError,
} from "@remix-run/react";
import { useMemo, useState } from "react";
import { PageShell } from "~/components/page-shell";
import { DryRunResultPanel } from "~/components/routines/dry-run-result";
import { EffectsPanel } from "~/components/routines/effects-panel";
import { GovernancePanel } from "~/components/routines/governance-panel";
import { RoutineCanvas } from "~/components/routines/routine-canvas";
import { RunPanel } from "~/components/routines/run-panel";
import { RunStatusBadge } from "~/components/routines/run-status-badge";
import { TriggerList } from "~/components/routines/trigger-chip";
import { ErrorState, NotFoundState } from "~/components/states";
import { Button } from "~/components/ui/button";
import { Panel } from "~/components/ui/panel";
import { ApiError } from "~/lib/api";
import { getRoutine, listRuns, type RoutineInputsSchema, triggerRun } from "~/lib/routines";
import { type DryRunResult, dryRunOverlay, dryRunRoutine } from "~/lib/routines/dry-run";
import { routineDisplayName, routineFacts } from "~/lib/routines/facts";
import { projectRoutineGraph } from "~/lib/routines/graph";

export const meta: MetaFunction = () => [{ title: "Routines · tulipfarm" }];

export async function clientLoader({ params }: ClientLoaderFunctionArgs) {
  const slug = params.slug;
  if (!slug) throw new ApiError(404, "missing routine slug");
  const [routine, runs] = await Promise.all([getRoutine(slug), listRuns(slug)]);
  return { routine, runs };
}

function Fact({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-xs text-foreground">{value}</dd>
    </div>
  );
}

export default function RoutineDetailRoute() {
  const { routine, runs } = useLoaderData<typeof clientLoader>();
  const navigate = useNavigate();
  const revalidator = useRevalidator();

  const [busy, setBusy] = useState<"run" | "dry-run" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dryRun, setDryRun] = useState<DryRunResult | null>(null);

  const definition = routine.definition;
  const display = routineDisplayName(routine);
  const facts = useMemo(() => routineFacts(definition), [definition]);
  const graph = useMemo(
    () => projectRoutineGraph(definition, routine.triggers),
    [definition, routine.triggers]
  );
  /* The rehearsal is only worth painting while it still describes the graph on screen. */
  const overlay = useMemo(
    () => (dryRun ? dryRunOverlay(graph, dryRun.steps) : undefined),
    [dryRun, graph]
  );

  const inputs = (definition.spec.input ?? null) as RoutineInputsSchema | null;

  const onRun = async (values: Record<string, unknown>) => {
    setBusy("run");
    setError(null);
    try {
      const { runId } = await triggerRun(routine.slug, values);
      navigate(`/runs/${runId}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  };

  const onDryRun = async (values: Record<string, unknown>) => {
    setBusy("dry-run");
    setError(null);
    try {
      setDryRun(await dryRunRoutine(routine.slug, values));
    } catch (caught) {
      /*
       * Rehearsing takes the same right as running. A reader being refused one is a permission
       * fact, not a broken simulation, and saying "simulation failed" would send them off to
       * debug a routine that is fine.
       */
      const denied = caught instanceof ApiError && (caught.status === 403 || caught.status === 401);
      setError(
        denied
          ? "You do not have permission to simulate this routine. Ask an author to run it for you."
          : caught instanceof Error
            ? caught.message
            : String(caught)
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <PageShell
      crumbs={[{ label: "Routines", to: "/routines" }, { label: display }]}
      title={display}
      description={
        <>
          {/* The h1 is already the slug when no display name exists; repeating it says nothing. */}
          {display === routine.slug ? null : (
            <span className="block font-mono text-xs">{routine.slug}</span>
          )}
          <span className="mt-2 block">
            {facts.stateCount} {facts.stateCount === 1 ? "step" : "steps"}
            {facts.effects.length === 0
              ? ", none of which reach outside this routine."
              : facts.effects.length === facts.stateCount
                ? facts.stateCount === 1
                  ? ", and it reaches outside this routine."
                  : ", all of which reach outside this routine."
                : `, ${facts.effects.length} of which ${facts.effects.length === 1 ? "reaches" : "reach"} outside this routine.`}
          </span>
        </>
      }
      meta={
        <dl className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="flex items-baseline gap-1.5">
            <dt className="text-xs text-muted-foreground">starts</dt>
            <dd>
              <TriggerList triggers={routine.triggers} />
            </dd>
          </div>
          <Fact label="version" value={`v${routine.authoredVersion}`} />
          <Fact label="owner" value={definition.spec.owner} />
        </dl>
      }
      actions={
        <Button asChild size="sm" variant="outline">
          <Link
            to={`/routines/${encodeURIComponent(routine.slug)}/edit`}
            aria-label={`Author ${display}`}
          >
            Author
          </Link>
        </Button>
      }
    >
      <RoutineCanvas
        graph={graph}
        mode={overlay ? "dry-run" : "read"}
        overlay={overlay}
        caption={
          overlay
            ? "Highlighted: the path the last dry run took. Nothing was dispatched."
            : undefined
        }
      />

      <RunPanel
        slug={routine.slug}
        inputs={inputs}
        onRun={onRun}
        onDryRun={onDryRun}
        hasEffects={facts.effects.length > 0}
        busy={busy}
        error={error}
        status={
          dryRun
            ? `Dry run finished. ${dryRun.effects.length === 0 ? "No outbound call would have been made." : `${dryRun.effects.length} ${dryRun.effects.length === 1 ? "call" : "calls"} would have been made, none of them dispatched.`} The result is below this panel.`
            : null
        }
      />

      {dryRun ? <DryRunResultPanel result={dryRun} onClear={() => setDryRun(null)} /> : null}

      <EffectsPanel facts={facts} />

      <GovernancePanel detail={routine} facts={facts} />

      <Panel
        title="Run history"
        description={
          runs.length === 0
            ? undefined
            : `The ${runs.length} most recent ${runs.length === 1 ? "run" : "runs"}.`
        }
        actions={
          <Button
            size="sm"
            variant="ghost"
            onClick={() => revalidator.revalidate()}
            disabled={revalidator.state === "loading"}
          >
            {revalidator.state === "loading" ? "Refreshing…" : "Refresh"}
          </Button>
        }
        flush
      >
        {runs.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">
            This routine has never run. Start one above — a dry run costs nothing.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {runs.map((run) => (
              <li key={run.id}>
                <Link
                  to={`/runs/${run.id}`}
                  className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                >
                  <RunStatusBadge status={run.status} />
                  <span className="font-mono text-xs text-muted-foreground">
                    {run.id.slice(0, 8)}
                  </span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {new Date(run.createdAt).toLocaleString()}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </PageShell>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  if (error instanceof ApiError && error.status === 404) {
    return <NotFoundState section="routines" />;
  }
  const status = error instanceof ApiError ? error.status : undefined;
  const message = error instanceof Error ? error.message : undefined;
  return <ErrorState section="routines" status={status} message={message} />;
}
