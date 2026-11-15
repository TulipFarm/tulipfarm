import { useEffect, useId, useRef, useState } from 'react';
import { Code } from 'reicon-react/icons/Code';
import { codingAgentLabels } from '@tulipfarm/agents/coding-run-contracts';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Button } from '@tulipfarm/sprout/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@tulipfarm/sprout/collapsible';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import { TableRequestError } from '@/features/tables/request-state';
import { codingRunErrorMessage, type CodingRunView } from './api';
import { useCodingRun, useCodingRunsApi } from './queries';

const outcomes: Record<string, string> = {
  completed: 'Finished',
  failed: 'The agent stopped with an error',
  'timed-out': 'Stopped at the 30-minute limit',
  cancelled: 'Cancelled',
  'clone-failed': 'Could not clone the repository',
  'plan-required': 'No plan was available to run it',
  'plan-changed': 'Not run because the plan changed',
  'github-account-required': 'Not run because no GitHub account is selected',
};

function statusText(run: CodingRunView) {
  switch (run.status) {
    case 'denied':
      return 'You chose not to run this';
    case 'expired':
      return 'Expired without a decision';
    case 'approved':
      return 'Starting…';
    case 'running':
      return 'Running…';
    case 'interrupted':
      return 'Stopped before it finished';
    case 'finished':
      return (run.outcome && outcomes[run.outcome]) ?? 'Finished';
    default:
      return null;
  }
}

function Heading({ id, run }: { id: string; run: CodingRunView }) {
  return (
    <h4 id={id} className="flex min-w-0 items-center gap-2 text-sm font-medium">
      <Code size={16} aria-hidden="true" />
      <span className="min-w-0 break-all">
        {codingAgentLabels[run.agent]} on {run.repository}
        {run.branch && <span className="text-muted-foreground"> · {run.branch}</span>}
      </span>
    </h4>
  );
}

/** A coding run waiting in a chat, read by its call ID. Only the member who asked can see or decide it. */
export function CodingRunReviewCard({
  workspaceId,
  runId,
  onSettled,
}: {
  workspaceId: string;
  runId: string;
  onSettled?: () => Promise<void> | void;
}) {
  const read = useCodingRun(workspaceId, runId);
  const status = read.state.kind === 'ready' ? read.state.data.status : null;
  const latest = useRef(onSettled);
  latest.current = onSettled;
  useEffect(() => {
    if (status && status !== 'awaiting-approval' && status !== 'approved' && status !== 'running')
      void latest.current?.();
  }, [status]);
  if (read.state.kind === 'unavailable')
    return (
      <p role="status" className="text-xs text-muted-foreground">
        Waiting for approval from the person who asked.
      </p>
    );
  if (read.state.kind === 'error')
    return (
      <section className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-border bg-card px-3 py-2 text-sm text-card-foreground">
        <span className="font-medium">Could not load this coding run</span>
        <Button variant="link" size="sm" onClick={() => void read.refresh()}>
          Try again
        </Button>
      </section>
    );
  if (read.state.kind !== 'ready')
    return (
      <div role="status" aria-label="Loading coding run" className="space-y-2">
        <Skeleton />
        <span className="sr-only">Loading coding run…</span>
      </div>
    );
  return <CodingRunReview workspaceId={workspaceId} run={read.state.data} refresh={read.refresh} />;
}

export function CodingRunReview({
  workspaceId,
  run,
  refresh,
}: {
  workspaceId: string;
  run: CodingRunView;
  refresh: () => Promise<void>;
}) {
  const id = useId();
  const api = useCodingRunsApi(workspaceId);
  const [sending, setSending] = useState<'approve' | 'deny' | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Kept across retries of the same choice, so a lost response replays instead of conflicting.
  const command = useRef<{ decision: 'approve' | 'deny'; id: string } | null>(null);
  const settled = statusText(run);
  if (settled)
    return (
      <section
        aria-labelledby={`${id}-title`}
        className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-xl border border-border bg-card px-3 py-2 text-sm text-card-foreground"
      >
        <Heading id={`${id}-title`} run={run} />
        <p role="status" className="min-w-0 text-muted-foreground">
          {settled}
        </p>
      </section>
    );

  async function decide(decision: 'approve' | 'deny') {
    if (sending) return;
    if (command.current?.decision !== decision) command.current = { decision, id: crypto.randomUUID() };
    setSending(decision);
    setError(null);
    try {
      await api.decide(run.id, { commandId: command.current.id, digest: run.digest, decision });
      await refresh();
    } catch (failure) {
      if (failure instanceof TableRequestError && failure.status < 500) command.current = null;
      setError(codingRunErrorMessage(failure));
      if (failure instanceof TableRequestError && [404, 409].includes(failure.status)) await refresh();
    } finally {
      setSending(null);
    }
  }

  return (
    <section
      aria-labelledby={`${id}-title`}
      className="space-y-3 rounded-xl border border-border bg-card px-3 py-3 text-card-foreground"
    >
      <div className="space-y-0.5">
        <Heading id={`${id}-title`} run={run} />
        <p className="text-xs text-muted-foreground">
          Runs for up to 30 minutes on {run.ownPlan ? 'your' : 'a shared'} plan, with your selected GitHub account.
          Nothing is pushed.
        </p>
      </div>
      <Collapsible>
        <CollapsibleTrigger render={<Button variant="ghost" size="sm" />}>Task</CollapsibleTrigger>
        <CollapsibleContent>
          <pre className="mt-2 max-h-48 overflow-auto rounded-md bg-muted p-2 font-mono text-xs whitespace-pre-wrap wrap-anywhere">
            {run.task}
          </pre>
        </CollapsibleContent>
      </Collapsible>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
        <p className="text-xs text-muted-foreground">Nothing runs until you choose.</p>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={sending !== null}
            aria-busy={sending === 'deny'}
            onClick={() => void decide('deny')}
          >
            Don’t run
          </Button>
          <Button
            size="sm"
            disabled={sending !== null}
            aria-busy={sending === 'approve'}
            onClick={() => void decide('approve')}
          >
            {sending === 'approve' ? 'Starting…' : 'Run agent'}
          </Button>
        </div>
      </div>
    </section>
  );
}
