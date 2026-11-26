import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Button } from '@tulipfarm/sprout/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@tulipfarm/sprout/collapsible';
import { ToolActivity } from '@tulipfarm/sprout/tool-activity';
import type { TableWorkspace } from '@/features/tables/references';
import { useRowThread } from '@/features/tables/row-thread';
import { TableRequestError } from '@/features/tables/request-state';
import { toolVisual } from '@/features/chat/tool-labels';
import { GitHubTaskSourceCard } from '@/features/chat/github-investigation-card';
import { taskCredits } from '@/features/tasks/api';
import type { TaskCard } from './api';
import { currentStep, duration, sentence, useAssignmentRun } from './live';

export const stateLabels = {
  queued: 'Queued',
  working: 'Working',
  waiting: 'Waiting for you',
  done: 'Done',
  failed: 'Failed',
} as const;

/** Everything about the assigned agent's work in one place: why it stopped, what it is doing, and its runs. */
export function AgentWork({
  card,
  tableId,
  workspace,
  me,
  now,
  refresh,
}: {
  card: TaskCard;
  tableId: string;
  workspace: TableWorkspace;
  me: string | undefined;
  now: number;
  refresh: () => Promise<void>;
}) {
  const activity = card.activity;
  const latest = activity?.run;
  const run = useAssignmentRun(workspace.id, activity, me);
  const { api, read } = useRowThread(workspace.id, tableId, card.id);
  const thread = read.state.kind === 'ready' ? read.state.data : null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await operation();
      await read.refresh();
      await refresh();
    } catch (failure) {
      setError(failure instanceof TableRequestError ? failure.message : 'The task could not be updated. Try again.');
    } finally {
      setBusy(false);
    }
  };
  const step = currentStep(run);
  const elapsed = latest
    ? (latest.endedAt ? new Date(latest.endedAt).getTime() : now) - new Date(latest.startedAt).getTime()
    : 0;
  const steps = Math.max(latest?.steps ?? 0, run?.toolCalls ?? 0);
  const credits = run && run.cost.chargedCreditUnits !== '0' ? taskCredits(run.cost.chargedCreditUnits) : null;
  const stopped = card.state === 'waiting' || card.state === 'failed';
  const runs = thread?.runs ?? [];
  return (
    <section className="space-y-3 rounded-lg border p-3" aria-label="Agent work">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{latest && !latest.endedAt ? 'Working now' : 'Agent work'}</h3>
        <div className="flex items-center gap-1">
          {run && latest && (
            <Button
              size="sm"
              variant="ghost"
              nativeButton={false}
              render={
                <Link
                  to="/$workspaceSlug/agent-tasks/$taskId"
                  params={{ workspaceSlug: workspace.slug, taskId: latest.taskId }}
                />
              }
            >
              Open run
            </Button>
          )}
          {thread?.assignment?.canRunNow && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy || card.state === 'working' || card.state === 'queued'}
              onClick={() => void act(api.runNow)}
            >
              Run now
            </Button>
          )}
        </div>
      </div>
      {stopped && activity?.reason && (
        <p
          className={`rounded-md px-3 py-2 text-sm ${card.state === 'failed' ? 'bg-destructive/10 text-destructive' : 'bg-warning-subtle text-warning'}`}
        >
          {sentence(activity.reason)} Reply below to continue.
        </p>
      )}
      {run && latest && card.state === 'waiting' && (
        <GitHubTaskSourceCard
          workspaceId={workspace.id}
          chatId={latest.taskId}
          slug={workspace.slug}
          disabled={busy}
          picked={() => void refresh()}
          working={false}
        />
      )}
      {activity?.wakeAt && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span>
            Checks again{' '}
            {new Date(activity.wakeAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
          </span>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(api.clearWake)}>
            Clear wake-up
          </Button>
        </div>
      )}
      {card.state === 'queued' && <p className="text-sm text-muted-foreground">Waiting for a turn to start.</p>}
      {latest ? (
        <p className="text-xs text-muted-foreground">
          {latest.endedAt ? `Last run took ${duration(elapsed)}` : `Working for ${duration(elapsed)}`} · {steps}{' '}
          {steps === 1 ? 'step' : 'steps'}
          {credits ? ` · ${credits} credits` : ''}
        </p>
      ) : (
        !card.state && <p className="text-sm text-muted-foreground">Not started yet.</p>
      )}
      {latest && !latest.endedAt && step && (
        <p className="text-sm font-medium" aria-live="polite">
          {step}
        </p>
      )}
      {run && run.activity.length > 0 ? (
        <ToolActivity
          variant="stepper"
          items={run.activity.map(item => ({
            id: item.id,
            label: item.presentation.label,
            status: item.status,
            visual: toolVisual(item.tool, item.presentation.brand),
          }))}
        />
      ) : (
        latest &&
        !run && (
          <p className="text-xs text-muted-foreground">
            Step-by-step activity is shown to the person who assigned this agent.
          </p>
        )
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {runs.length > 1 && (
        <Collapsible>
          <CollapsibleTrigger render={<Button variant="ghost" size="sm" />}>
            All runs ({runs.length})
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
              {runs.map(item => (
                <li key={item.taskId}>
                  <Link
                    to="/$workspaceSlug/agent-tasks/$taskId"
                    params={{ workspaceSlug: workspace.slug, taskId: item.taskId }}
                  >
                    {new Date(item.startedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
                  </Link>{' '}
                  · {item.endedAt ? (item.outcome ?? 'ended') : 'working'}
                </li>
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      )}
    </section>
  );
}
