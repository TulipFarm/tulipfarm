import { useState } from "react";
import type { RoutineGraph } from "~/lib/routines/graph";
import type { RunEvent, RunOverlay } from "~/lib/routines/run-overlay";
import { RoutineCanvas } from "./routine-canvas";

type Props = { graph: RoutineGraph; overlay: RunOverlay; events: RunEvent[] };

export function RoutineRunCanvas({ graph, overlay, events }: Props) {
  const [journalOpen, setJournalOpen] = useState(false);
  return (
    <div className="space-y-4">
      <RoutineCanvas graph={graph} mode="run" overlay={overlay} />
      <div className="rounded-sm border border-border bg-card text-xs">
        <button
          type="button"
          aria-expanded={journalOpen}
          aria-controls="run-journal"
          onClick={() => setJournalOpen((open) => !open)}
          className="min-h-11 cursor-pointer px-4 py-3 font-mono text-[0.625rem] uppercase tracking-[0.16em] text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
        >
          Journal
        </button>
        <ol
          id="run-journal"
          hidden={!journalOpen}
          className="divide-y divide-border border-t border-border font-mono text-[0.625rem]"
        >
          {events.length ? (
            events.map((event) => (
              <li key={event.seq} className="grid grid-cols-[auto_1fr] gap-x-3 px-4 py-2">
                <span className="text-muted-foreground">{event.seq}</span>
                <span>{event.type}</span>
                {event.payload !== undefined && (
                  <pre className="col-start-2 mt-1 overflow-x-auto whitespace-pre-wrap text-muted-foreground">
                    {typeof event.payload === "string"
                      ? event.payload
                      : JSON.stringify(event.payload, null, 2)}
                  </pre>
                )}
              </li>
            ))
          ) : (
            <li className="px-4 py-3 text-muted-foreground">No events yet</li>
          )}
        </ol>
      </div>
    </div>
  );
}
