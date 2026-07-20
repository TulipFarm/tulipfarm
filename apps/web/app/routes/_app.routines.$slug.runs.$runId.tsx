import { useLoaderData, useRevalidator, useRouteError } from "@remix-run/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ResourcePanel } from "~/components/resource-panel";
import { RoutineRunCanvas } from "~/components/routines/routine-run-canvas";
import { RunStatusBadge } from "~/components/routines/run-status-badge";
import { ErrorState } from "~/components/states";
import { Button } from "~/components/ui/button";
import { ApiError } from "~/lib/api";
import { cancelRun, getRun, type RunEvent, runEventsUrl } from "~/lib/routines";
import { projectRoutineGraph } from "~/lib/routines/graph";
import { reduceRunOverlay } from "~/lib/routines/run-overlay";

export async function clientLoader({ params }: { params: { slug: string; runId: string } }) {
  const detail = await getRun(params.slug, params.runId);
  return { slug: params.slug, runId: params.runId, detail };
}

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

/**
 * Live progress: EventSource against the run SSE endpoint, resuming from the last
 * journaled seq. A `finish` with reason "suspended" means the run is sleeping/waiting —
 * the stream closes; we revalidate to pick up the new status and reconnect on the next
 * revalidation if the run woke up.
 */
function useRunEvents(
  slug: string,
  runId: string,
  initial: RunEvent[],
  active: boolean,
  onStreamEnd: () => void
) {
  const [events, setEvents] = useState<RunEvent[]>(initial);
  const lastSeq = useRef(initial.length > 0 ? initial[initial.length - 1].seq : 0);

  useEffect(() => {
    setEvents(initial);
    lastSeq.current = initial.length > 0 ? initial[initial.length - 1].seq : 0;
  }, [initial]);

  useEffect(() => {
    if (!active) return;
    const source = new EventSource(runEventsUrl(slug, runId, lastSeq.current), {
      withCredentials: true,
    });
    const onAny = (e: MessageEvent) => {
      const seq = Number(e.lastEventId);
      if (Number.isNaN(seq) || seq <= lastSeq.current) return;
      lastSeq.current = seq;
      let payload: unknown = e.data;
      try {
        payload = JSON.parse(e.data);
      } catch {
        // keep raw string
      }
      setEvents((prev) => [...prev, { seq, type: e.type, payload }]);
      if (e.type === "finish" || e.type === "error") {
        source.close();
        onStreamEnd();
      }
    };
    for (const type of [
      "run.started",
      "state.entered",
      "action.completed",
      "state.completed",
      "state.transitioned",
      "state.retrying",
      "run.sleeping",
      "run.waiting_approval",
      "finish",
      "error",
    ]) {
      source.addEventListener(type, onAny);
    }
    source.onerror = () => {
      source.close();
      onStreamEnd();
    };
    return () => source.close();
  }, [slug, runId, active, onStreamEnd]);

  return events;
}

export default function RunDetail() {
  const { slug, runId, detail } = useLoaderData<typeof clientLoader>();
  const revalidator = useRevalidator();
  const run = detail.run;
  const isLive = !TERMINAL.has(run.status);
  const revalidate = useMemo(() => () => revalidator.revalidate(), [revalidator.revalidate]);
  const events = useRunEvents(slug, runId, detail.events, isLive, revalidate);
  const graph = useMemo(
    () => projectRoutineGraph(run.definitionSnapshot),
    [run.definitionSnapshot]
  );
  const overlay = useMemo(() => {
    const next = reduceRunOverlay(graph, events);
    if (run.status === "cancelled" && run.currentState) {
      const id = `state:${encodeURIComponent(run.currentState)}`;
      next.nodes[id] = { ...next.nodes[id], status: "cancelled", exact: true };
    }
    return next;
  }, [events, graph, run.currentState, run.status]);
  const [cancelError, setCancelError] = useState<string | null>(null);

  const handleCancel = async () => {
    setCancelError(null);
    try {
      await cancelRun(slug, runId);
      revalidator.revalidate();
    } catch (err) {
      setCancelError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <ResourcePanel
      crumbs={[
        { label: "routines", to: "/routines" },
        { label: slug, to: `/routines/${encodeURIComponent(slug)}` },
        { label: runId.slice(0, 8) },
      ]}
    >
      <div className="flex items-center gap-3">
        <RunStatusBadge status={run.status} />
        <span className="font-mono text-xs text-muted-foreground">{runId}</span>
        {run.currentState ? (
          <span className="text-xs text-muted-foreground">at {run.currentState}</span>
        ) : null}
        <span className="ml-auto flex items-center gap-2">
          {isLive ? (
            <Button size="sm" variant="ghost" onClick={handleCancel}>
              cancel run
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={() => revalidator.revalidate()}>
            refresh
          </Button>
        </span>
      </div>
      {cancelError ? <p className="text-destructive text-xs">{cancelError}</p> : null}
      {run.error ? (
        <p className="rounded-sm border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive text-xs">
          {run.error.name}: {run.error.message}
        </p>
      ) : null}

      <RoutineRunCanvas graph={graph} overlay={overlay} events={events} />

      {run.output != null ? (
        <>
          <p className="text-xs uppercase tracking-[0.15em] text-muted-foreground">output</p>
          <pre className="overflow-x-auto rounded-sm border border-border px-3 py-2 font-mono text-xs">
            {JSON.stringify(run.output, null, 2)}
          </pre>
        </>
      ) : null}
    </ResourcePanel>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const status = error instanceof ApiError ? error.status : undefined;
  const message = error instanceof Error ? error.message : undefined;
  return <ErrorState section="routines" status={status} message={message} />;
}
