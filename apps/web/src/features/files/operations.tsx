import { useMemo, useState, useSyncExternalStore, type DragEvent } from 'react';
import { z } from 'zod';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { FileTypeIcon } from '@tulipfarm/sprout/attachment';
import { Button } from '@tulipfarm/sprout/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@tulipfarm/sprout/dialog';
import { Input } from '@tulipfarm/sprout/input';
import { Label } from '@tulipfarm/sprout/label';
import { Progress } from '@tulipfarm/sprout/progress';
import { WriteFeedback } from '@/features/tables/feedback';
import { TableRequestError } from '@/features/tables/request-state';
import { useTableWrite } from '@/features/tables/use-table-write';
import { formatFileSize } from '@/lib/file-viewer';
import { apiOrigin } from '@/lib/auth';
import { maxUploadBytes, type FilesApi, type FileSummary } from './api';
import type { FinalFocus } from './sharing';

export type Destination = { parentId: string | null; label: string };

export function NameDialog({
  mode,
  open,
  onOpenChange,
  submit,
  done,
  refresh,
  finalFocus,
}: {
  mode: { kind: 'folder'; destination: Destination } | { kind: 'rename'; item: FileSummary };
  open: boolean;
  onOpenChange: (open: boolean) => void;
  submit: (name: string, id: string) => Promise<FileSummary>;
  done: (item: FileSummary) => void;
  refresh: () => void;
  finalFocus?: FinalFocus;
}) {
  const [name, setName] = useState(mode.kind === 'rename' ? mode.item.name : '');
  const [id, setId] = useState(() => (mode.kind === 'rename' ? mode.item.id : crypto.randomUUID()));
  const write = useTableWrite(
    (input: { id: string; name: string }) => submit(input.name, input.id),
    item => {
      done(item);
      onOpenChange(false);
      if (mode.kind === 'folder') {
        setName('');
        setId(crypto.randomUUID());
      }
    },
  );
  const busy = write.state.kind === 'sending';
  const folder = mode.kind === 'folder';
  const trimmed = name.trim();
  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        if (!busy) {
          onOpenChange(next);
          write.reset();
        }
      }}
    >
      <DialogContent size="form" finalFocus={finalFocus}>
        <DialogHeader>
          <DialogTitle>{folder ? 'New folder' : `Rename ${mode.item.kind}`}</DialogTitle>
          <DialogDescription>
            {folder
              ? `Creates a folder in ${mode.destination.label}. You own it, and it inherits that location's sharing.`
              : 'Links and sharing stay the same after renaming.'}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={event => {
            event.preventDefault();
            if (!busy && trimmed) void write.submit({ id, name: trimmed });
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="file-name">{folder ? 'Folder name' : 'Name'}</Label>
            <Input
              id="file-name"
              autoFocus
              value={name}
              maxLength={255}
              required
              disabled={busy}
              placeholder={folder ? 'For example, Supplier contracts' : undefined}
              onChange={event => setName(event.target.value)}
            />
          </div>
          <WriteFeedback
            state={write.state}
            checkStatus={() => {
              write.reset();
              onOpenChange(false);
              refresh();
            }}
            retry={input => void write.submit(input)}
          />
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !trimmed} aria-busy={busy}>
              {busy ? (folder ? 'Creating folder…' : 'Renaming…') : folder ? 'Create folder' : 'Rename'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** `sent` counts bytes the browser has handed to the network. `late` marks an upload that finished on the server before its cancellation arrived. */
type UploadState =
  | { kind: 'waiting' }
  | { kind: 'sending'; sent: number }
  | { kind: 'cancelling' }
  | { kind: 'ready'; late: boolean }
  | { kind: 'cancelled' }
  | { kind: 'failed'; message: string; retry: boolean };
/** A file chosen or dropped. A dropped folder arrives as a `File` too; only its drag entry says it is a folder. */
export type PickedFile = { file: File; folder: boolean };
type UploadAuthority = { userId: string; sessionId: string; workspaceId: string; membershipId: string };
/** A queued file. It carries its own authority, API, and change notice, so it finishes after the Files page that queued it unmounts. */
type Upload = {
  id: string;
  authority: UploadAuthority;
  file: File;
  destination: Destination;
  state: UploadState;
  api: FilesApi;
  changed: () => void;
};
const activeStates = new Set<UploadState['kind']>(['waiting', 'sending', 'cancelling']);
const active = (upload: Upload) => activeStates.has(upload.state.kind);
const sessionResponseSchema = z
  .object({ session: z.object({ id: z.string() }), user: z.object({ id: z.string() }) })
  .nullable();
const sessionChanged = 'Your session changed before the upload finished. Sign in again to retry.';
const sameAuthority = (left: UploadAuthority, right: UploadAuthority) =>
  left.userId === right.userId &&
  left.sessionId === right.sessionId &&
  left.workspaceId === right.workspaceId &&
  left.membershipId === right.membershipId;

async function currentAuthority(authority: UploadAuthority, signal: AbortSignal) {
  const response = await fetch(`${apiOrigin}/v1/auth/get-session`, {
    credentials: 'include',
    cache: 'no-store',
    signal,
  });
  if (!response.ok) throw new TableRequestError(response.status, 'sign-in-required', sessionChanged);
  const parsed = sessionResponseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success || !parsed.data) return false;
  return parsed.data.user.id === authority.userId && parsed.data.session.id === authority.sessionId;
}

/** Uploads live for the browser tab, not the route: opening a file or leaving Files keeps the queue running. */
const queue = (() => {
  let uploads: readonly Upload[] = [];
  const transfers = new Map<string, AbortController>();
  const listeners = new Set<() => void>();
  const warn = (event: BeforeUnloadEvent) => {
    event.preventDefault();
    event.returnValue = '';
  };
  let warning = false;
  function set(next: readonly Upload[]) {
    uploads = next;
    const transferring = uploads.some(active);
    if (transferring !== warning) {
      warning = transferring;
      if (transferring) window.addEventListener('beforeunload', warn);
      else window.removeEventListener('beforeunload', warn);
    }
    for (const listener of listeners) listener();
    pump();
  }
  const update = (id: string, state: UploadState) =>
    set(uploads.map(upload => (upload.id === id ? { ...upload, state } : upload)));
  const failAuthority = (authority: UploadAuthority, message: string) =>
    set(
      uploads.map(upload =>
        active(upload) && sameAuthority(upload.authority, authority)
          ? { ...upload, state: { kind: 'failed', retry: false, message } }
          : upload,
      ),
    );
  /** The server stops a cancelled upload before it commits, unless it had already finished. Reading the id tells which happened. */
  function settleCancel(upload: Upload) {
    upload.api.read(upload.id, AbortSignal.timeout(15_000)).then(
      () => {
        update(upload.id, { kind: 'ready', late: true });
        upload.changed();
      },
      (error: unknown) => {
        update(
          upload.id,
          error instanceof TableRequestError && error.status === 404
            ? { kind: 'cancelled' }
            : {
                kind: 'failed',
                retry: true,
                message:
                  'We couldn’t confirm whether the upload stopped. Retry sends the same file again without creating a copy.',
              },
        );
      },
    );
  }
  function pump() {
    if (uploads.some(upload => upload.state.kind === 'sending')) return;
    const next = uploads.find(upload => upload.state.kind === 'waiting');
    if (!next) return;
    const transfer = new AbortController();
    transfers.set(next.id, transfer);
    update(next.id, { kind: 'sending', sent: 0 });
    const percent = (sent: number) => Math.floor((sent / next.file.size) * 100);
    const progress = (sent: number) => {
      const current = uploads.find(upload => upload.id === next.id)?.state;
      if (current?.kind === 'sending' && percent(sent) !== percent(current.sent))
        update(next.id, { kind: 'sending', sent });
    };
    void (async () => {
      try {
        if (!(await currentAuthority(next.authority, transfer.signal))) {
          transfers.delete(next.id);
          failAuthority(next.authority, sessionChanged);
          return;
        }
        if (transfer.signal.aborted) {
          transfers.delete(next.id);
          update(next.id, { kind: 'cancelled' });
          return;
        }
        await next.api.upload(
          next.id,
          next.file,
          next.destination.parentId,
          next.authority.sessionId,
          transfer.signal,
          progress,
        );
        transfers.delete(next.id);
        update(next.id, { kind: 'ready', late: false });
        next.changed();
      } catch (error) {
        transfers.delete(next.id);
        if (transfer.signal.aborted) return settleCancel(next);
        if (error instanceof TableRequestError && error.status === 401) {
          failAuthority(next.authority, error.message);
          return;
        }
        const rejected = error instanceof TableRequestError && error.status < 500 && ![408, 429].includes(error.status);
        update(next.id, {
          kind: 'failed',
          retry: !rejected,
          message:
            error instanceof TableRequestError
              ? error.message
              : 'The upload could not be confirmed. Retry sends the same file again without creating a copy.',
        });
      }
    })();
  }
  function cancel(id: string) {
    const upload = uploads.find(item => item.id === id);
    if (upload?.state.kind === 'waiting') update(id, { kind: 'cancelled' });
    if (upload?.state.kind !== 'sending') return;
    update(id, { kind: 'cancelling' });
    transfers.get(id)?.abort();
  }
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot: () => uploads,
    add: (added: Upload[]) => set([...uploads, ...added]),
    update,
    cancel,
    remove: (id: string) => set(uploads.filter(upload => upload.id !== id || active(upload))),
    clear: (membershipId: string) =>
      set(uploads.filter(upload => upload.authority.membershipId !== membershipId || active(upload))),
  };
})();

function rejection({ file, folder }: PickedFile): UploadState | null {
  if (folder)
    return {
      kind: 'failed',
      retry: false,
      message: 'Folders can’t be uploaded. Open the folder on your device and upload the files inside it.',
    };
  if (file.size === 0) return { kind: 'failed', retry: false, message: 'This file is empty.' };
  if (file.size > maxUploadBytes)
    return {
      kind: 'failed',
      retry: false,
      message: `This file is ${formatFileSize(file.size)}. The upload limit is 10 MB.`,
    };
  return null;
}

export function useUploads(api: FilesApi, authority: UploadAuthority, changed: () => void) {
  const all = useSyncExternalStore(queue.subscribe, queue.snapshot, queue.snapshot);
  const uploads = useMemo(
    () => all.filter(upload => upload.authority.membershipId === authority.membershipId),
    [all, authority.membershipId],
  );
  return {
    uploads,
    add(files: PickedFile[], destination: Destination) {
      queue.add(
        files.map(picked => ({
          id: crypto.randomUUID(),
          authority,
          file: picked.file,
          destination,
          api,
          changed,
          state: rejection(picked) ?? { kind: 'waiting' },
        })),
      );
    },
    retry: (id: string) => queue.update(id, { kind: 'waiting' }),
    cancel: queue.cancel,
    remove: queue.remove,
    clear: () => queue.clear(authority.membershipId),
  };
}

const stateLabels: Record<UploadState['kind'], string> = {
  waiting: 'Waiting',
  sending: 'Uploading',
  cancelling: 'Cancelling…',
  ready: 'Uploaded',
  cancelled: 'Cancelled',
  failed: 'Not uploaded',
};
const count = (total: number, noun: string) => `${total} ${noun}`;
/** Every byte sent is not yet a stored file: the server still verifies and saves it. */
const sendingLabel = (sent: number, size: number) =>
  sent >= size ? 'Saving…' : `Uploading ${formatFileSize(sent)} of ${formatFileSize(size)}`;

export function UploadList({
  uploads: { uploads, retry, cancel, remove, clear },
}: {
  uploads: ReturnType<typeof useUploads>;
}) {
  if (!uploads.length) return null;
  const pending = uploads.filter(active).length;
  const failed = uploads.filter(upload => upload.state.kind === 'failed').length;
  const cancelled = uploads.filter(upload => upload.state.kind === 'cancelled').length;
  const done = uploads.length - pending - failed - cancelled;
  const summary = pending
    ? `Uploading ${uploads.length - pending + 1} of ${uploads.length}…`
    : failed || cancelled
      ? [
          count(done, 'uploaded'),
          failed ? count(failed, 'failed') : null,
          cancelled ? count(cancelled, 'cancelled') : null,
        ]
          .filter(Boolean)
          .join(', ')
      : `${done === 1 ? '1 file' : `${done} files`} uploaded`;
  return (
    <section aria-label="Uploads" className="space-y-2 rounded-xl border bg-card p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p role="status" className="text-sm font-medium text-foreground">
          {summary}
        </p>
        {pending < uploads.length && (
          <Button variant="ghost" size="sm" onClick={clear}>
            Dismiss finished
          </Button>
        )}
      </div>
      <ul className="divide-y">
        {uploads.map(upload => (
          <li key={upload.id} className="flex min-w-0 items-center gap-3 py-2">
            <FileTypeIcon name={upload.file.name} mediaType={upload.file.type || 'application/octet-stream'} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-foreground" title={upload.file.name}>
                {upload.file.name}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {upload.state.kind === 'ready' && upload.state.late
                  ? 'Uploaded before it could be cancelled'
                  : upload.state.kind === 'sending'
                    ? sendingLabel(upload.state.sent, upload.file.size)
                    : stateLabels[upload.state.kind]}{' '}
                · {upload.destination.label}
              </p>
              {upload.state.kind === 'sending' && (
                <SendingProgress name={upload.file.name} sent={upload.state.sent} size={upload.file.size} />
              )}
            </div>
            <div className="flex shrink-0 flex-wrap justify-end gap-1">
              {(upload.state.kind === 'waiting' || upload.state.kind === 'sending') && (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Cancel uploading ${upload.file.name}`}
                  onClick={() => cancel(upload.id)}
                >
                  Cancel
                </Button>
              )}
              {(upload.state.kind === 'cancelled' || (upload.state.kind === 'failed' && upload.state.retry)) && (
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={`Retry uploading ${upload.file.name}`}
                  onClick={() => retry(upload.id)}
                >
                  Retry
                </Button>
              )}
              {(upload.state.kind === 'cancelled' || upload.state.kind === 'failed') && (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove ${upload.file.name} from uploads`}
                  onClick={() => remove(upload.id)}
                >
                  Remove
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {uploads.flatMap(upload =>
        upload.state.kind === 'failed'
          ? [
              <Alert key={upload.id} variant="destructive">
                <AlertDescription>
                  {upload.file.name}: {upload.state.message}
                </AlertDescription>
              </Alert>,
            ]
          : [],
      )}
    </section>
  );
}

function SendingProgress({ name, sent, size }: { name: string; sent: number; size: number }) {
  const label = sendingLabel(sent, size);
  return (
    <div className="pt-1.5">
      <Progress
        value={Math.floor((sent / size) * 100)}
        aria-label={`Uploading ${name}`}
        getAriaValueText={() => label}
      />
    </div>
  );
}

/** The drag carries files from the device, not text or an element from this page. */
const carriesFiles = (event: DragEvent) => event.dataTransfer.types.includes('Files');
function dropped(transfer: DataTransfer): PickedFile[] {
  return Array.from(transfer.items).flatMap(item => {
    const file = item.kind === 'file' ? item.getAsFile() : null;
    return file ? [{ file, folder: item.webkitGetAsEntry()?.isDirectory === true }] : [];
  });
}

/**
 * Drag-and-drop upload targets. Each zone names where its files go, or `null` where the reader can't add,
 * which still swallows the drop so the browser never navigates away to open the file.
 * An inner zone (a folder row) stops the drag from reaching the list around it.
 */
export function useFileDrop(add: (files: PickedFile[], destination: Destination) => void) {
  const [target, setTarget] = useState<Destination | null>(null);
  const zone = (destination: Destination | null) => ({
    onDragOver(event: DragEvent) {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = destination ? 'copy' : 'none';
      setTarget(current => (current?.parentId === destination?.parentId ? current : destination));
    },
    onDragLeave(event: DragEvent) {
      if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) setTarget(null);
    },
    onDrop(event: DragEvent) {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      setTarget(null);
      if (destination) add(dropped(event.dataTransfer), destination);
    },
  });
  return { target, zone };
}
