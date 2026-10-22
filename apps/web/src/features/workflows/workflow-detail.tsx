import { useMemo, type ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { z } from 'zod';
import { withheldOutputSchema, type RunDetail } from '@tulipfarm/workflows/contracts';
import { Button } from '@tulipfarm/sprout/button';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { Disclosure } from '@/components/disclosure';
import type { ReadState } from '@/features/tables/request-state';
import { taskApi } from '@/features/tasks/api';
import { taskReads } from '@/features/tasks/queries';
import { taskStatusLabel } from '@/features/tasks/status';
import { useFeatureRead } from '@/lib/query';
import { workspaceRoute } from '@/router';
import { useWorkflowDefinition, useWorkflowRun } from './queries';
import { NamedWorkflowViewer } from './named-viewer';
import { workflowRunStates } from './run-projection';
import { runNote, stepNote } from './run-notes';

export type WorkflowReference =
  | { kind: 'draft'; chatId: string; draftId: string }
  | { kind: 'definition'; workflowId: string; revision: string }
  | { kind: 'run'; workflowId: string; runId: string };
export function WorkflowRead<T>({
  state,
  refresh,
  children,
}: {
  state: ReadState<T>;
  refresh: () => Promise<void>;
  children: (value: T, notice: string | undefined) => ReactNode;
}) {
  if (state.kind === 'loading')
    return (
      <div role="status" aria-label="Loading workflow diagram" className="space-y-3 p-4">
        <Skeleton shape="title" />
        <Skeleton shape="panel" />
        <span className="sr-only">Loading workflow diagram...</span>
      </div>
    );
  if (state.kind !== 'ready')
    return (
      <StatePanel
        kind={state.kind}
        title={state.kind === 'unavailable' ? 'Workflow unavailable' : 'Workflow could not load'}
        description={
          state.kind === 'unavailable'
            ? 'It is missing, or your access to this workflow or its sources changed. The diagram has been cleared.'
            : 'The workflow could not be checked. Retry to load the diagram.'
        }
      >
        <Button variant="outline" onClick={() => void refresh()}>
          Retry loading workflow
        </Button>
      </StatePanel>
    );
  return children(
    state.data,
    state.error ? 'Refresh failed. This is the last checked view, not the latest state.' : undefined,
  );
}
export function WorkflowDefinition({
  workspaceId,
  workflowId,
  revision = 'saved',
  surface = 'page',
  navigation,
}: {
  workspaceId: string;
  workflowId: string;
  revision?: string;
  surface?: 'page' | 'canvas';
  navigation?: ReactNode;
}) {
  const read = useWorkflowDefinition(workspaceId, workflowId, revision);
  const navigate = useNavigate(),
    { workspaceSlug } = workspaceRoute.useParams();
  return (
    <WorkflowRead state={read.state} refresh={read.refresh}>
      {(detail, notice) => (
        <NamedWorkflowViewer
          workspaceId={workspaceId}
          surface={surface}
          view={{
            key: `definition:${workflowId}:${detail.revision}`,
            definition: detail.definition,
            labels: {
              actor: ['manual', 'event'].includes(detail.definition.trigger.kind)
                ? 'the person who starts it'
                : (detail.actor?.name ?? 'an unassigned person'),
            },
            source: revision === 'active' ? 'Active' : 'Saved',
            revisionLabel:
              detail.revision === detail.savedRevision
                ? detail.activeRevision === detail.revision
                  ? 'Saved and active revision'
                  : 'Saved revision'
                : detail.revision === detail.activeRevision
                  ? 'Active revision'
                  : 'Earlier saved revision',
            ...(notice ? { notice } : {}),
          }}
          navigation={navigation}
          onRefresh={() => void read.refresh()}
          onEdit={
            detail.canManage && !detail.archived
              ? () =>
                  void navigate({
                    to: '/$workspaceSlug',
                    params: { workspaceSlug },
                    search: { intent: 'edit-workflow', workflowId },
                  })
              : undefined
          }
        />
      )}
    </WorkflowRead>
  );
}
export function WorkflowRun({
  workspaceId,
  workflowId,
  runId,
  surface = 'page',
  navigation,
}: {
  workspaceId: string;
  workflowId: string;
  runId: string;
  surface?: 'page' | 'canvas';
  navigation?: ReactNode;
}) {
  const read = useWorkflowRun(workspaceId, workflowId, runId);
  const labels = {
    queued: 'Queued',
    running: 'Running',
    waiting: 'Waiting',
    completed: 'Completed',
    cancelled: 'Cancelled',
    blocked: 'Blocked',
    failed: 'Failed',
    skipped: 'Skipped',
  };
  return (
    <WorkflowRead state={read.state} refresh={read.refresh}>
      {(detail, notice) => (
        <NamedWorkflowViewer
          workspaceId={workspaceId}
          surface={surface}
          view={{
            key: `run:${workflowId}:${runId}:${detail.run.revision}`,
            source: 'Run',
            definition: detail.definition,
            revisionLabel: 'Definition used by this run',
            labels: { actor: detail.actor ? detail.actor.name : 'an unavailable person' },
            ...(notice || read.delayed
              ? { notice: notice ?? 'Automatic checks stopped. Refresh to check this run again.' }
              : {}),
            run: {
              label: labels[detail.run.status],
              status: detail.run.status,
              states: workflowRunStates(detail),
              note:
                runNote(detail.run) ||
                'Only recorded progress is shown. Next eligible does not mean a step has started.',
            },
          }}
          navigation={navigation}
          onRefresh={() => void read.refresh()}
          stepContent={id => (
            <RunStepDetail
              workspaceId={workspaceId}
              agent={detail.definition.steps.some(step => step.id === id && step.kind === 'agent')}
              receipt={detail.run.steps.find(step => step.stepId === id)}
            />
          )}
        />
      )}
    </WorkflowRead>
  );
}
function RunStepDetail({
  workspaceId,
  agent,
  receipt,
}: {
  workspaceId: string;
  agent: boolean;
  receipt: RunDetail['run']['steps'][number] | undefined;
}) {
  if (!receipt) return null;
  if (withheldOutputSchema.safeParse(receipt.output).success)
    return <p className="text-sm">Output hidden because its source access changed.</p>;
  const task = z.object({ taskId: z.uuid() }).safeParse(receipt.output);
  return (
    <div className="space-y-2 text-sm">
      {receipt.prompt && <p>{receipt.prompt}</p>}
      {receipt.dueAt && (
        <p>Due {new Date(receipt.dueAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</p>
      )}
      {stepNote(receipt.output) && <p>{stepNote(receipt.output)}</p>}
      {agent && task.success && <WorkflowTask workspaceId={workspaceId} taskId={task.data.taskId} />}
      {receipt.output !== null && (
        <Disclosure title="Recorded output">
          <pre className="max-h-64 overflow-auto text-xs">{JSON.stringify(receipt.output, null, 2)}</pre>
        </Disclosure>
      )}
    </div>
  );
}
function WorkflowTask({ workspaceId, taskId }: { workspaceId: string; taskId: string }) {
  const api = useMemo(() => taskApi(workspaceId), [workspaceId]);
  const read = useFeatureRead(taskReads.summary(api, taskId));
  const navigate = useNavigate(),
    { workspaceSlug } = workspaceRoute.useParams();
  return read.state.kind === 'ready' ? (
    <div>
      <p>Agent task: {taskStatusLabel(read.state.data)}</p>
      <Button
        variant="link"
        size="sm"
        onClick={() => void navigate({ to: '/$workspaceSlug/agent-tasks/$taskId', params: { workspaceSlug, taskId } })}
      >
        Open agent task
      </Button>
    </div>
  ) : read.state.kind === 'loading' ? (
    <p role="status">Checking linked task...</p>
  ) : (
    <div>
      <p>
        {read.state.kind === 'unavailable'
          ? 'The linked private task is unavailable with your access.'
          : 'The linked task could not load. Retry to check its status.'}
      </p>
      <Button size="sm" variant="ghost" onClick={() => void read.refresh()}>
        Check task access
      </Button>
    </div>
  );
}
