import type { ReactNode } from 'react';
import { ChevronDown } from 'reicon-react/icons/ChevronDown';
import { Code } from 'reicon-react/icons/Code';
import { Badge } from '@tulipfarm/sprout/badge';
import { Button } from '@tulipfarm/sprout/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@tulipfarm/sprout/collapsible';
import { Spinner } from '@tulipfarm/sprout/spinner';

type ToolState =
  | { kind: 'queued' }
  | { kind: 'running' }
  | { kind: 'approval'; onDecision: (decision: 'approve' | 'deny') => void }
  | { kind: 'complete' }
  | { kind: 'error'; message: string; onRetry: () => void };
const labels = {
  queued: 'Queued',
  running: 'Running',
  approval: 'Needs approval',
  complete: 'Complete',
  error: 'Failed',
};

export function ToolCall({
  name,
  summary,
  state,
  input,
  children,
  defaultOpen = false,
}: {
  name: string;
  summary: string;
  state: ToolState;
  input?: string;
  children?: ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <div data-slot="tool-call" className="overflow-hidden rounded-xl border">
      <Collapsible defaultOpen={defaultOpen}>
        <CollapsibleTrigger className="group flex w-full flex-wrap items-center gap-2 bg-muted/30 p-3 text-left text-sm hover:bg-muted">
          {state.kind === 'running' ? <Spinner aria-hidden="true" /> : <Code size={16} aria-hidden="true" />}
          <span className="min-w-0 flex-1 wrap-anywhere font-medium">{name}</span>
          <Badge
            variant={
              state.kind === 'error'
                ? 'destructive'
                : state.kind === 'complete'
                  ? 'success'
                  : state.kind === 'approval'
                    ? 'warning'
                    : 'secondary'
            }
          >
            {labels[state.kind]}
          </Badge>
          <ChevronDown
            size={14}
            aria-hidden="true"
            className="shrink-0 transition-transform group-aria-expanded:rotate-180"
          />
          <span className="w-full text-muted-foreground">{summary}</span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="space-y-3 border-t p-3">
            {input && (
              <div>
                <p className="mb-1 text-xs font-medium text-muted-foreground">Input</p>
                <pre className="overflow-auto rounded-md bg-muted p-3 font-mono text-xs" tabIndex={0}>
                  {input}
                </pre>
              </div>
            )}
            {children && <div className="text-base">{children}</div>}
            {!children && state.kind === 'queued' && <p className="text-sm text-muted-foreground">Waiting to start.</p>}
            {state.kind === 'running' && (
              <p role="status" className="text-sm text-muted-foreground">
                Running the sample tool. No action is executed.
              </p>
            )}
            {state.kind === 'approval' && (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => state.onDecision('approve')}>
                  Approve sample
                </Button>
                <Button size="sm" variant="outline" onClick={() => state.onDecision('deny')}>
                  Decline sample
                </Button>
              </div>
            )}
            {state.kind === 'complete' && !children && (
              <p className="text-sm text-muted-foreground">Sample result: the fictional record is ready.</p>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
      {state.kind === 'error' && (
        <div className="space-y-2 border-t p-3">
          <p role="alert" className="text-sm text-destructive">
            {state.message}
          </p>
          <Button variant="outline" size="sm" onClick={state.onRetry}>
            Retry tool
          </Button>
        </div>
      )}
    </div>
  );
}
