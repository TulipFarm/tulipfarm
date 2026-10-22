import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { WorkspaceSkillDeletion } from '@tulipfarm/agents/workspace-skill-contracts';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Button } from '@tulipfarm/sprout/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@tulipfarm/sprout/dialog';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import { WriteFeedback } from '@/features/tables/feedback';
import { TableRequestError, type ReadState, type WriteState } from '@/features/tables/request-state';
import { useTableWrite } from '@/features/tables/use-table-write';
import { useFeatureChanges } from '@/lib/query';
import type { skillApi, SkillLifecycleCommand, SkillReceipt } from './api';
import { skillKeys, useSkillDeletion } from './queries';

type Api = ReturnType<typeof skillApi>;
type Target = SkillLifecycleCommand['lifecycle'];
type PinUse = WorkspaceSkillDeletion['blockers'][number]['uses'][number];
type DeletionView =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'unavailable' }
  | { kind: 'ready'; data: WorkspaceSkillDeletion; refreshing: boolean };

const busyLabels: Record<Target, string> = {
  archived: 'Archiving skill…',
  active: 'Restoring skill…',
  deleted: 'Deleting skill…',
};
const useLabels: Record<PinUse, string> = {
  'saved-definition': 'Saved version pins this skill',
  'active-revision': 'Active version pins this skill',
  'open-run': 'A run in progress uses this skill',
  'open-task': 'An open task uses this skill',
};
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

function deletionView(state: ReadState<WorkspaceSkillDeletion>): DeletionView {
  if (state.kind === 'ready')
    return state.error ? { kind: 'error' } : { kind: 'ready', data: state.data, refreshing: state.refreshing };
  return { kind: state.kind };
}

export function SkillLifecycle({
  api,
  id,
  name,
  workspaceSlug,
  archived,
  version,
  refresh,
  onChanged,
  onDeleted,
}: {
  api: Api;
  id: string;
  name: string;
  workspaceSlug: string;
  archived: boolean;
  version: number;
  refresh: () => Promise<void>;
  onChanged: (expectedVersion: number, receipt: SkillReceipt) => void;
  onDeleted: () => void;
}) {
  const { change } = useFeatureChanges();
  const [deleting, setDeleting] = useState(false);
  const [message, setMessage] = useState('');
  const [confirmed, setConfirmed] = useState<SkillReceipt | null>(null);
  const write = useTableWrite(
    async (command: SkillLifecycleCommand) => {
      try {
        return { command, receipt: await api.send(id, command) };
      } catch (error) {
        if (error instanceof TableRequestError) void change({ keys: [skillKeys.deletion(id)] });
        throw error;
      }
    },
    ({ command, receipt }) => {
      onChanged(command.expectedVersion, receipt);
      if (receipt.lifecycle === 'deleted') {
        onDeleted();
        return;
      }
      setConfirmed(receipt);
      setDeleting(false);
      setMessage(
        receipt.lifecycle === 'archived'
          ? "Skill archived. It's hidden from skill lists and pickers. Agents that pin it keep working."
          : 'Skill restored.',
      );
    },
  );
  const current =
    confirmed && confirmed.version > version
      ? { archived: confirmed.lifecycle === 'archived', version: confirmed.version }
      : { archived, version };
  const pending = write.state.kind === 'sending' ? write.state.input.lifecycle : null;
  const locked = write.state.kind === 'sending' || write.state.kind === 'uncertain';
  const submit = (command: SkillLifecycleCommand) => {
    setMessage('');
    void write.submit(command);
  };
  const request = (lifecycle: Target, expectedVersion: number) =>
    submit({ kind: 'lifecycle', requestId: crypto.randomUUID(), expectedVersion, lifecycle });

  return (
    <section aria-labelledby="skill-lifecycle-heading" className="space-y-3 border-t pt-6">
      <h2 id="skill-lifecycle-heading" className="text-lg font-medium">
        {current.archived ? 'Restore or delete' : 'Archive or delete'}
      </h2>
      <p>
        {current.archived
          ? 'Restoring shows this skill in skill lists and pickers again.'
          : 'Archiving hides this skill from skill lists and pickers. Agents that pin it keep working.'}
      </p>
      <div className="flex flex-wrap gap-2">
        {current.archived ? (
          <Button disabled={locked} aria-busy={pending === 'active'} onClick={() => request('active', current.version)}>
            {pending === 'active' ? busyLabels.active : 'Restore skill'}
          </Button>
        ) : (
          <Button
            variant="outline"
            disabled={locked}
            aria-busy={pending === 'archived'}
            onClick={() => request('archived', current.version)}
          >
            {pending === 'archived' ? busyLabels.archived : 'Archive skill'}
          </Button>
        )}
        <Button
          variant="destructive"
          disabled={locked}
          onClick={() => {
            write.reset();
            setMessage('');
            setDeleting(true);
          }}
        >
          Delete skill
        </Button>
      </div>
      {message && <p role="status">{message}</p>}
      {!deleting && <WriteFeedback state={write.state} checkStatus={() => void refresh()} retry={submit} />}
      {deleting && (
        <SkillDeleteDialog
          api={api}
          id={id}
          name={name}
          workspaceSlug={workspaceSlug}
          state={write.state}
          retry={submit}
          request={request}
          onClose={() => setDeleting(false)}
        />
      )}
    </section>
  );
}

function SkillDeleteDialog({
  api,
  id,
  name,
  workspaceSlug,
  state,
  retry,
  request,
  onClose,
}: {
  api: Api;
  id: string;
  name: string;
  workspaceSlug: string;
  state: WriteState<SkillLifecycleCommand>;
  retry: (command: SkillLifecycleCommand) => void;
  request: (lifecycle: 'archived' | 'deleted', expectedVersion: number) => void;
  onClose: () => void;
}) {
  const deletion = useSkillDeletion(api, id);
  const [checking, setChecking] = useState(false);
  const check = async () => {
    setChecking(true);
    try {
      await deletion.refresh();
    } finally {
      setChecking(false);
    }
  };
  const view = deletionView(deletion.state);
  const sending = state.kind === 'sending';
  const locked = sending || state.kind === 'uncertain';
  const pending = sending ? state.input.lifecycle : null;
  const blocked = view.kind === 'ready' && view.data.blockerCount > 0;
  const title = view.kind === 'ready' ? view.data.name : name;
  const close = () => {
    if (!sending) onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={open => {
        if (!open) close();
      }}
    >
      <DialogContent size="form">
        <DialogHeader>
          <DialogTitle>
            <span className="wrap-anywhere">{blocked ? `“${title}” can't be deleted` : `Delete “${title}”?`}</span>
          </DialogTitle>
          {view.kind === 'ready' && (
            <DialogDescription>
              {blocked
                ? 'Agents use this skill. Deleting it would stop them. Archive it to hide it from lists and pickers while those agents keep working.'
                : "This can't be undone. The skill leaves lists, pickers, and new chats. Sent messages keep its name."}
            </DialogDescription>
          )}
        </DialogHeader>
        <div className="-mx-4 min-h-0 space-y-3 overflow-y-auto px-4 pb-1">
          {view.kind === 'loading' && (
            <div role="status" className="space-y-2">
              <p className="text-sm text-muted-foreground">Checking where this skill is used…</p>
              <Skeleton aria-hidden="true" />
              <Skeleton aria-hidden="true" />
            </div>
          )}
          {view.kind === 'error' && (
            <Alert variant="destructive">
              <AlertDescription>Couldn't check where this skill is used.</AlertDescription>
            </Alert>
          )}
          {view.kind === 'unavailable' && (
            <Alert>
              <AlertDescription>This skill was deleted or you can no longer manage it.</AlertDescription>
            </Alert>
          )}
          {view.kind === 'ready' && blocked && <BlockingAgents deletion={view.data} workspaceSlug={workspaceSlug} />}
          <WriteFeedback state={state} checkStatus={() => void check()} retry={retry} />
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={sending} onClick={close}>
            {view.kind === 'unavailable' || blocked ? 'Close' : 'Cancel'}
          </Button>
          {view.kind === 'error' && (
            <Button variant="outline" disabled={checking} aria-busy={checking} onClick={() => void check()}>
              Check again
            </Button>
          )}
          {view.kind === 'ready' && blocked && view.data.lifecycle === 'active' && (
            <Button
              disabled={locked || view.refreshing}
              aria-busy={pending === 'archived'}
              onClick={() => request('archived', view.data.version)}
            >
              {pending === 'archived' ? busyLabels.archived : 'Archive instead'}
            </Button>
          )}
          {view.kind === 'ready' && !blocked && (
            <Button
              variant="destructive"
              disabled={locked || view.refreshing}
              aria-busy={pending === 'deleted'}
              onClick={() => request('deleted', view.data.version)}
            >
              {pending === 'deleted' ? busyLabels.deleted : 'Delete skill'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BlockingAgents({ deletion, workspaceSlug }: { deletion: WorkspaceSkillDeletion; workspaceSlug: string }) {
  const more = deletion.blockerCount - deletion.blockers.length - deletion.hiddenAgents;
  return (
    <>
      {deletion.blockers.length > 0 && (
        <ul aria-label="Agents that use this skill" className="divide-y rounded-lg border">
          {deletion.blockers.map(blocker => (
            <li key={blocker.agentId} className="grid min-w-0 grid-cols-1 px-3 py-2">
              <Button
                variant="link"
                size="md"
                role="link"
                nativeButton={false}
                render={
                  <Link to="/$workspaceSlug/agents/$agentId" params={{ workspaceSlug, agentId: blocker.agentId }} />
                }
              >
                <span className="min-w-0 flex-1 truncate text-start">{blocker.name ?? 'Unnamed agent'}</span>
              </Button>
              {blocker.uses.map(use => (
                <p key={use} className="text-xs text-muted-foreground">
                  {useLabels[use]}
                </p>
              ))}
            </li>
          ))}
        </ul>
      )}
      {deletion.hiddenAgents > 0 && (
        <p className="text-sm text-foreground">
          {plural(deletion.hiddenAgents, 'agent')} you can't open also {deletion.hiddenAgents === 1 ? 'uses' : 'use'}{' '}
          this skill.
        </p>
      )}
      {more > 0 && <p className="text-sm text-foreground">And {plural(more, 'more agent')}.</p>}
      {deletion.lifecycle === 'archived' && <p className="text-sm text-foreground">It's already archived.</p>}
    </>
  );
}
