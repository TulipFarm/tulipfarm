import { useState } from 'react';
import type { z } from 'zod';
import { workflowSchema } from '@tulipfarm/workflows/contracts';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from '@tulipfarm/sprout/alert-dialog';
import { Button } from '@tulipfarm/sprout/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/empty';
import { workflowRequest, WorkflowRequestError } from './api';
import { useWorkflowChanges } from './queries';

const reasons = {
  capacity: 'Waiting for run capacity. Events resume automatically as earlier runs finish.',
  'values-too-large':
    'The complete row snapshot exceeds the run input limit. It is kept, not truncated. Reduce future row size; cancel these events only if you no longer need them.',
  'values-unavailable':
    'Required snapshot data is unavailable. Ask a workspace admin to restore it, or explicitly cancel these events.',
  'workflow-disabled':
    'The workflow is disabled. Restore its access if needed, then enable this same revision to resume.',
  'revision-replaced':
    'These events belong to an earlier revision. Their snapshots are kept and will not run under the new definition. Cancel them only if they are no longer needed.',
  'workflow-archived': 'The workflow is archived. Its pending snapshots are kept until you explicitly cancel them.',
} as const;

export function RowEventQueue({
  workspaceId,
  workflow,
  onRefresh,
}: {
  workspaceId: string;
  workflow: z.infer<typeof workflowSchema>;
  onRefresh: () => Promise<void>;
}) {
  const queue = workflow.rowQueue;
  const changes = useWorkflowChanges();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [command, setCommand] = useState<{ commandId: string; expectedGeneration: number } | null>(null);
  const refresh = async () => {
    setBusy(true);
    setError(null);
    try {
      await onRefresh();
    } catch {
      setError('Queue status could not refresh. Check status again.');
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    setBusy(true);
    setError(null);
    const body = command ?? { commandId: crypto.randomUUID(), expectedGeneration: workflow.generation };
    setCommand(body);
    try {
      workflowSchema.parse(
        await workflowRequest(`/workspaces/${workspaceId}/workflows/${workflow.id}/row-events/cancel`, 'POST', body),
      );
      await changes.saved(workflow.id);
      setConfirm(false);
      setCommand(null);
    } catch (failure) {
      if (failure instanceof WorkflowRequestError && failure.code === 'stale-generation') {
        setCommand(null);
        setConfirm(false);
        setError('This workflow changed. Check queue status, then confirm cancellation again.');
      } else
        setError(
          'Cancellation was not confirmed. Check queue status before retrying; the request may already have completed.',
        );
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="Row event queue" className="space-y-3">
      <h3 className="text-sm font-medium">Row event queue</h3>
      {queue === null ? (
        <Alert role="note">
          <AlertDescription>
            Queue details are hidden because you cannot read every source table. Ask a workspace admin for table read
            access.
          </AlertDescription>
        </Alert>
      ) : !queue.available ? (
        <Alert role="note">
          <AlertDescription>
            Durable row capture is unavailable until this workspace’s storage update finishes.
          </AlertDescription>
        </Alert>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            Every accepted event keeps its snapshot until a run starts or you cancel it. Large imports wait for
            capacity; no events are dropped at a queue limit.
          </p>
          {queue.pending + queue.blocked > 0 ? (
            <p role="status" className="text-sm">
              {queue.pending} pending · {queue.blocked} blocked
              {queue.oldestAt ? ` · Oldest: ${new Date(queue.oldestAt).toLocaleString()}` : ''}
            </p>
          ) : (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No waiting row events</EmptyTitle>
                <EmptyDescription>
                  New row events appear here after a matching table change. Started events appear in run history.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
          {queue.blockers.map(blocker => (
            <Alert key={blocker.reason} role="note">
              <AlertDescription>
                {blocker.count} blocked: {reasons[blocker.reason]}
              </AlertDescription>
            </Alert>
          ))}
          {queue.cancelled > 0 && <p className="text-sm">{queue.cancelled} events explicitly cancelled.</p>}
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={busy} onClick={() => void refresh()}>
              {busy ? 'Checking queue…' : 'Check queue status'}
            </Button>
            {workflow.capabilities.manage && queue.pending + queue.blocked > 0 && (
              <Button
                variant="destructive"
                disabled={busy}
                onClick={() => {
                  setCommand(null);
                  setConfirm(true);
                }}
              >
                Cancel waiting events
              </Button>
            )}
          </div>
        </>
      )}
      {error && !confirm && (
        <p role="alert" className="text-sm">
          {error}
        </p>
      )}
      <AlertDialog
        open={confirm}
        onOpenChange={open => {
          if (!busy) setConfirm(open);
        }}
      >
        <AlertDialogContent>
          <AlertDialogTitle>Cancel all waiting row events?</AlertDialogTitle>
          <AlertDialogDescription>
            This permanently cancels pending and blocked row events, including events from earlier revisions, and
            releases their snapshots. It does not cancel runs that have already started. New events can still arrive if
            the workflow is enabled.
          </AlertDialogDescription>
          {error && (
            <p role="alert" className="text-sm">
              {error}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Keep events</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={event => {
                event.preventDefault();
                void cancel();
              }}
            >
              {busy ? 'Cancelling…' : 'Cancel waiting events'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
