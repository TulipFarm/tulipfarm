import { useState } from "react";
import { Activity, Check, Copy, Trash2 } from "~/components/icons";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { copyText } from "~/lib/clipboard";

export interface LoggedInteraction {
  readonly id: string;
  readonly timestamp: string;
  readonly actionId: string;
  readonly componentId: string;
  readonly target: string;
  readonly payload: Record<string, unknown>;
}

export interface EventInspectorProps {
  readonly events: readonly LoggedInteraction[];
  readonly onClear: () => void;
}

export function EventInspector({ events, onClear }: EventInspectorProps) {
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const handleCopyEvent = (event: LoggedInteraction) => {
    void copyText(JSON.stringify(event, null, 2));
    setCopiedId(event.id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  return (
    <section
      aria-label="Interaction event inspector"
      className="rounded-lg border border-border bg-card overflow-hidden shadow-xs"
    >
      <div className="flex items-center justify-between border-b border-border bg-muted/20 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <Activity className="size-4 text-primary" />
          <h3 className="text-sm font-semibold text-foreground">Interaction Event Inspector</h3>
          <Badge variant={events.length > 0 ? "primary" : "neutral"} className="text-[11px]">
            {events.length} {events.length === 1 ? "event" : "events"} logged
          </Badge>
        </div>

        {events.length > 0 ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onClear}
            className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
          >
            <Trash2 className="size-3 mr-1" />
            Clear Log
          </Button>
        ) : null}
      </div>

      <div className="p-4">
        {events.length === 0 ? (
          <div className="py-6 text-center text-xs text-muted-foreground">
            <p>No interaction events recorded yet.</p>
            <p className="mt-1">
              Submit a form, click an action button, or select a choice in the preview to capture
              events.
            </p>
          </div>
        ) : (
          <div className="space-y-2.5 max-h-80 overflow-y-auto pr-1">
            {events.map((event) => (
              <div
                key={event.id}
                data-testid="logged-event-card"
                className="rounded-lg border border-border bg-background p-3 text-xs shadow-xs"
              >
                <div className="flex flex-wrap items-center justify-between gap-1.5 border-b border-border/40 pb-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant="primary" className="font-mono text-[10px]">
                      {event.actionId}
                    </Badge>
                    <Badge variant="neutral" className="font-mono text-[10px]">
                      {event.componentId}
                    </Badge>
                    <span className="text-[11px] text-muted-foreground font-mono">
                      {event.target}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-muted-foreground font-mono">
                      {new Date(event.timestamp).toLocaleTimeString()}
                    </span>
                    <button
                      type="button"
                      onClick={() => handleCopyEvent(event)}
                      className="text-muted-foreground hover:text-foreground p-1 rounded hover:bg-muted"
                      title="Copy event payload"
                    >
                      {copiedId === event.id ? (
                        <Check className="size-3 text-status-success" />
                      ) : (
                        <Copy className="size-3" />
                      )}
                    </button>
                  </div>
                </div>
                <div className="mt-2 rounded bg-muted/40 p-2 font-mono text-[11px] text-foreground overflow-x-auto">
                  <pre>{JSON.stringify(event.payload, null, 2)}</pre>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
