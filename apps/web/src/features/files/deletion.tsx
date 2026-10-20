import { useState } from 'react';
import type { DeletionOutcome, DeletionPreview } from '@tulipfarm/files/contracts';
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
import { Progress } from '@tulipfarm/sprout/progress';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import { failedWrite } from '@/features/tables/request-state';
import { formatFileSize } from '@/lib/file-viewer';
import { useFeatureRead } from '@/lib/query';
import { fileKeys, maxUploadBytes, type FilesApi, type FileSummary } from './api';

type FinalFocus = React.ComponentProps<typeof DialogContent>['finalFocus'];
type Sending = { kind: 'idle' } | { kind: 'sending' } | { kind: 'failed'; message: string };

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;
const limit = (bytes: number) =>
  Number.isInteger(bytes / 1024 / 1024) ? `${bytes / 1024 / 1024} MB` : formatFileSize(bytes);

function contents(preview: DeletionPreview) {
  if (preview.item.kind === 'file') return `${formatFileSize(preview.bytes)} of storage will be freed.`;
  if (!preview.files) return 'The folder is empty.';
  return `It holds ${plural(preview.files, 'file')} using ${formatFileSize(preview.bytes)} of storage, which will be freed.`;
}

/** Owner-only permanent deletion. The server rechecks ownership and the folder's contents when the action runs. */
export function DeleteForeverDialog({
  api,
  item,
  finalFocus,
  onClose,
}: {
  api: FilesApi;
  item: FileSummary;
  finalFocus?: FinalFocus;
  onClose: (outcome: DeletionOutcome | null) => void;
}) {
  const preview = useFeatureRead({
    key: fileKeys.deletion(item.id),
    staleTime: 0,
    load: signal => api.previewDeletion(item.id, signal),
  });
  const [sending, setSending] = useState<Sending>({ kind: 'idle' });
  const busy = sending.kind === 'sending';
  async function remove() {
    if (busy) return;
    setSending({ kind: 'sending' });
    try {
      onClose(await api.deleteForever(item.id));
    } catch (error) {
      const outcome = failedWrite(null, error);
      setSending({
        kind: 'failed',
        message:
          outcome.kind === 'rejected'
            ? outcome.message
            : 'We couldn’t confirm the deletion. Check Trash before trying again. If deletion started, it continues and the item can’t be restored.',
      });
      if (outcome.kind === 'rejected') void preview.refresh();
    }
  }
  const close = () => {
    if (!busy) onClose(null);
  };
  const state = preview.state;
  const blocked = state.kind === 'ready' && state.data.blockerCount > 0;

  return (
    <Dialog
      open
      onOpenChange={open => {
        if (!open) close();
      }}
    >
      <DialogContent size="form" finalFocus={finalFocus}>
        <DialogHeader>
          <DialogTitle>
            <span className="wrap-anywhere">
              {blocked ? `“${item.name}” can’t be deleted forever yet` : `Delete “${item.name}” forever?`}
            </span>
          </DialogTitle>
          <DialogDescription>
            {blocked
              ? 'Other people own items inside this folder. Deleting forever never removes someone else’s files.'
              : item.kind === 'folder'
                ? 'This can’t be undone. The folder and everything in it are removed for everyone it was shared with.'
                : 'This can’t be undone. The file is removed for everyone it was shared with.'}
          </DialogDescription>
        </DialogHeader>
        <div className="-mx-4 min-h-0 space-y-3 overflow-y-auto px-4 pb-1">
          {state.kind === 'loading' && (
            <div role="status" aria-label="Checking what will be deleted" className="space-y-2">
              <Skeleton />
              <Skeleton />
              <span className="sr-only">Checking what will be deleted…</span>
            </div>
          )}
          {(state.kind === 'error' || state.kind === 'unavailable') && (
            <Alert variant="destructive">
              <AlertDescription>
                {state.kind === 'unavailable'
                  ? 'Only the owner can delete this item forever, or it’s no longer in Trash.'
                  : 'Couldn’t check what would be deleted. Check your connection and try again.'}
              </AlertDescription>
            </Alert>
          )}
          {state.kind === 'ready' &&
            (blocked ? (
              <>
                <p className="text-sm text-foreground">
                  Ask the owners to move these items out, or move them yourself if you can manage them. Then delete the
                  folder forever.
                </p>
                <ul aria-label="Items owned by other people" className="divide-y rounded-lg border">
                  {state.data.blockers.map(blocker => (
                    <li key={blocker.id} className="flex min-w-0 items-baseline justify-between gap-3 px-3 py-2">
                      <span className="truncate text-sm font-medium text-foreground" title={blocker.name}>
                        {blocker.name}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">{blocker.owner.name}</span>
                    </li>
                  ))}
                </ul>
                {state.data.blockerCount > state.data.blockers.length && (
                  <p className="text-sm text-muted-foreground">
                    And {plural(state.data.blockerCount - state.data.blockers.length, 'more item')} owned by other
                    people.
                  </p>
                )}
              </>
            ) : (
              <p className="text-sm text-foreground">{contents(state.data)}</p>
            ))}
          {sending.kind === 'failed' && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{sending.message}</AlertDescription>
            </Alert>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={close}>
            {blocked ? 'Close' : 'Cancel'}
          </Button>
          {(state.kind === 'error' || state.kind === 'unavailable') && (
            <Button variant="outline" onClick={() => void preview.refresh()}>
              Check again
            </Button>
          )}
          {state.kind === 'ready' && !blocked && (
            <Button variant="destructive" disabled={busy} aria-busy={busy} onClick={() => void remove()}>
              {busy ? 'Deleting forever…' : 'Delete forever'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Workspace storage, including Trash, with the per-file limit people need before choosing files. */
export function StorageUsage({ api }: { api: FilesApi }) {
  const usage = useFeatureRead({ key: fileKeys.usage, staleTime: 0, load: signal => api.usage(signal) });
  const state = usage.state;
  if (state.kind === 'loading')
    return (
      <div role="status" aria-label="Loading storage use" className="space-y-2">
        <Skeleton />
        <span className="sr-only">Loading storage use…</span>
      </div>
    );
  if (state.kind !== 'ready')
    return (
      <div className="space-y-1 text-xs text-muted-foreground">
        <p>Storage use unavailable. Uploads are limited to {limit(maxUploadBytes)} per file.</p>
        <Button variant="link" size="sm" onClick={() => void usage.refresh()}>
          Check storage again
        </Button>
      </div>
    );
  const { usedBytes, quotaBytes, maxFileBytes } = state.data;
  const percent = Math.min(100, Math.round((usedBytes / quotaBytes) * 100));
  return (
    <div className="space-y-2">
      <Progress value={percent} aria-label="Workspace storage used" />
      <p className="text-xs text-muted-foreground">
        <span className="text-foreground tabular-nums">{formatFileSize(usedBytes)}</span> of{' '}
        {formatFileSize(quotaBytes)} used, including Trash.
      </p>
      <p className="text-xs text-muted-foreground">Up to {limit(maxFileBytes)} per file.</p>
    </div>
  );
}

export function deletionNotice(item: FileSummary, outcome: DeletionOutcome) {
  return outcome.state === 'deleted'
    ? { kind: 'done' as const, text: `“${item.name}” was deleted forever.` }
    : {
        kind: 'failed' as const,
        text: `“${item.name}” can’t be restored, but its deletion hasn’t finished. It still uses storage. Retry deletion from Trash, or it finishes automatically when storage is reachable.`,
      };
}
