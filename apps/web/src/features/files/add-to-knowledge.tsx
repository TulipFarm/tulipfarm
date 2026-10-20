import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Book } from 'reicon-react/icons/Book';
import { Check } from 'reicon-react/icons/Check';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { FileTypeIcon } from '@tulipfarm/sprout/attachment';
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
import { Spinner } from '@tulipfarm/sprout/spinner';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { errorMessage, type FileSummary } from './api';
import { knowledgeApi, type KnowledgeEntry } from './knowledge-api';
import { PromotionSummary } from './promotion-summary';
import type { FinalFocus } from './sharing';

/** Each file's place in Add to Knowledge. A failed add keeps its ids so retrying cannot create a second entry. */
type Row =
  | { kind: 'new' }
  | { kind: 'sending' }
  | { kind: 'failed'; message: string }
  | { kind: 'tracking'; entry: KnowledgeEntry; existing: boolean; retrying?: boolean; retryFailed?: string };

const limit = 20;
const pollMs = 2000;
const pollWindowMs = 120_000;
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const working = (row: Row) =>
  row.kind === 'tracking' && (row.entry.parsing === 'queued' || row.entry.parsing === 'parsing');

const failures: Record<string, string> = {
  unsupported: 'TulipFarm can’t extract text from this file type.',
  encrypted: 'This file is password-protected. Remove the password, upload it again, and add the new copy.',
  malformed: 'TulipFarm couldn’t read this file. It may be damaged.',
  'resource-limited': 'This file is too large or complex to extract.',
};

export function AddToKnowledgeDialog({
  workspaceId,
  items,
  finalFocus,
  onClose,
}: {
  workspaceId: string;
  items: FileSummary[];
  finalFocus?: FinalFocus;
  onClose: () => void;
}) {
  const api = useMemo(() => knowledgeApi(workspaceId), [workspaceId]);
  const files = useMemo(() => items.filter(item => item.kind === 'file'), [items]);
  const folders = items.length - files.length;
  const ids = useRef(
    new Map(files.map(file => [file.id, { documentId: crypto.randomUUID(), commandId: crypto.randomUUID() }])),
  );
  const [load, setLoad] = useState<{ kind: 'loading' } | { kind: 'failed'; message: string } | { kind: 'ready' }>({
    kind: 'loading',
  });
  const [rows, setRows] = useState<ReadonlyMap<string, Row>>(new Map());
  const [started, setStarted] = useState(false);
  const [polling, setPolling] = useState<'active' | 'paused'>('active');
  const [attempt, setAttempt] = useState(0);
  const controller = useRef(new AbortController());
  useEffect(() => () => controller.current.abort(), []);
  const update = (fileId: string, row: Row) => setRows(current => new Map(current).set(fileId, row));

  useEffect(() => {
    if (files.length > limit || !files.length) return;
    const signal = controller.current.signal;
    setLoad({ kind: 'loading' });
    api.list(signal).then(
      entries => {
        if (signal.aborted) return;
        setRows(
          new Map(
            files.map(file => {
              const entry = entries.find(item => item.kind === 'file' && item.fileId === file.id);
              return [file.id, entry ? { kind: 'tracking', entry, existing: true } : { kind: 'new' }];
            }),
          ),
        );
        setLoad({ kind: 'ready' });
      },
      (error: unknown) => {
        if (!signal.aborted)
          setLoad({
            kind: 'failed',
            message: errorMessage(
              error,
              'Couldn’t check your Knowledge. Nothing was added. Check your connection and try again.',
            ),
          });
      },
    );
  }, [api, files, attempt]);

  const anyWorking = [...rows.values()].some(working);
  useEffect(() => {
    if (!anyWorking || polling !== 'active') return;
    const deadline = setTimeout(() => setPolling('paused'), pollWindowMs);
    return () => clearTimeout(deadline);
  }, [anyWorking, polling]);
  useEffect(() => {
    if (!anyWorking || polling !== 'active') return;
    const signal = controller.current.signal;
    let busy = false;
    const timer = setInterval(() => {
      if (busy) return;
      busy = true;
      void Promise.all(
        [...rows]
          .filter(([, row]) => working(row))
          .map(async ([fileId, row]) => {
            if (row.kind !== 'tracking') return;
            try {
              const entry = await api.get(row.entry.documentId, signal);
              if (!signal.aborted) update(fileId, { ...row, entry });
            } catch {
              /* The next check, or Check status, tries again. */
            }
          }),
      ).finally(() => {
        busy = false;
      });
    }, pollMs);
    return () => clearInterval(timer);
  }, [anyWorking, polling, rows, api]);

  async function add(file: FileSummary) {
    const key = ids.current.get(file.id);
    if (!key) return;
    update(file.id, { kind: 'sending' });
    try {
      const entry = await api.add(
        { ...key, title: file.name.slice(0, 512), fileId: file.id },
        AbortSignal.any([controller.current.signal, AbortSignal.timeout(60000)]),
      );
      update(file.id, { kind: 'tracking', entry, existing: entry.documentId !== key.documentId });
    } catch (error) {
      if (controller.current.signal.aborted) return;
      update(file.id, {
        kind: 'failed',
        message: errorMessage(error, 'We couldn’t confirm the file was added. Try again; it won’t be added twice.'),
      });
    }
  }
  async function addAll() {
    setStarted(true);
    setPolling('active');
    for (const file of files)
      if (rows.get(file.id)?.kind === 'new' || rows.get(file.id)?.kind === 'failed') await add(file);
  }
  async function retry(fileId: string, row: Extract<Row, { kind: 'tracking' }>) {
    update(fileId, { ...row, retrying: true });
    try {
      const entry = await api.retry(row.entry, crypto.randomUUID(), controller.current.signal);
      update(fileId, { ...row, entry, retrying: false });
      setPolling('active');
    } catch (error) {
      if (!controller.current.signal.aborted)
        update(fileId, {
          ...row,
          retrying: false,
          retryFailed: errorMessage(error, 'Couldn’t start extraction again. Try again.'),
        });
    }
  }
  async function checkNow() {
    setPolling('active');
    for (const [fileId, row] of rows)
      if (row.kind === 'tracking' && working(row)) {
        try {
          update(fileId, { ...row, entry: await api.get(row.entry.documentId, controller.current.signal) });
        } catch {
          /* Shown as still extracting. */
        }
      }
  }

  const pending = files.filter(file => {
    const row = rows.get(file.id);
    return row?.kind === 'new' || row?.kind === 'failed';
  });
  const sending = [...rows.values()].some(row => row.kind === 'sending');
  const title =
    files.length === 1 ? `Add “${files[0]?.name}” to Knowledge` : `Add ${plural(files.length, 'file')} to Knowledge`;
  let body: ReactNode;
  let footer: ReactNode;
  if (!files.length) {
    body = (
      <StatePanel
        kind="unavailable"
        heading="h3"
        title="No files selected"
        description="Folders can’t be added to Knowledge. Select files instead."
      />
    );
    footer = <Button onClick={onClose}>Close</Button>;
  } else if (files.length > limit) {
    body = (
      <StatePanel
        kind="unavailable"
        heading="h3"
        title={`Choose up to ${limit} files`}
        description={`You can add up to ${limit} files at a time. You selected ${files.length}.`}
      />
    );
    footer = <Button onClick={onClose}>Back to Files</Button>;
  } else if (load.kind === 'loading') {
    body = (
      <div role="status" aria-label="Checking your Knowledge" className="space-y-3 py-2">
        <Skeleton />
        <Skeleton />
        <span className="sr-only">Checking your Knowledge…</span>
      </div>
    );
    footer = (
      <Button variant="outline" onClick={onClose}>
        Cancel
      </Button>
    );
  } else if (load.kind === 'failed') {
    body = (
      <StatePanel kind="error" heading="h3" title="Couldn’t check your Knowledge" description={load.message}>
        <Button variant="outline" onClick={() => setAttempt(value => value + 1)}>
          Check again
        </Button>
      </StatePanel>
    );
    footer = (
      <Button variant="outline" onClick={onClose}>
        Cancel
      </Button>
    );
  } else {
    body = (
      <>
        <PromotionSummary
          destination={
            <>
              <Book size={14} aria-hidden="true" />
              Your Knowledge
            </>
          }
          audience="Only you. Your chats and agents can search it; other people can’t."
        />
        <p className="text-sm text-muted-foreground">
          TulipFarm saves the text of each file as it is now. It won’t follow later edits. If you lose access to a file,
          or it’s deleted, its entry stops being used.
        </p>
        <ul aria-label="Files to add" className="divide-y rounded-lg border">
          {files.map(file => (
            <li key={file.id} className="space-y-1.5 px-3 py-2.5">
              <p className="flex min-w-0 items-center gap-2 text-sm font-medium text-foreground">
                <FileTypeIcon name={file.name} mediaType={file.mediaType ?? ''} />
                <span className="min-w-0 truncate" title={file.name}>
                  {file.name}
                </span>
              </p>
              <RowStatus
                row={rows.get(file.id) ?? { kind: 'new' }}
                paused={polling === 'paused'}
                name={file.name}
                retryAdd={() => void add(file)}
                retryExtraction={row => void retry(file.id, row)}
              />
            </li>
          ))}
        </ul>
        {polling === 'paused' && anyWorking && (
          <div className="space-y-2">
            <Alert>
              <AlertDescription>
                Extraction is taking longer than usual. It continues after you close this dialog.
              </AlertDescription>
            </Alert>
            <Button variant="outline" size="sm" onClick={() => void checkNow()}>
              Check status
            </Button>
          </div>
        )}
      </>
    );
    footer =
      !started && pending.length ? (
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void addAll()}>
            <Book size={16} aria-hidden="true" />
            {pending.length === files.length ? 'Add to Knowledge' : `Add ${plural(pending.length, 'file')}`}
          </Button>
        </>
      ) : (
        <Button variant={sending ? 'outline' : 'default'} disabled={sending} onClick={onClose}>
          {sending ? 'Adding…' : 'Done'}
        </Button>
      );
  }

  return (
    <Dialog
      open
      onOpenChange={open => {
        if (!open && !sending) onClose();
      }}
    >
      <DialogContent size="form" finalFocus={finalFocus}>
        <DialogHeader>
          <DialogTitle>
            <span className="wrap-anywhere">{title}</span>
          </DialogTitle>
          <DialogDescription>
            Adds the file’s text to your personal Knowledge so chats can use it later.
            {folders > 0 && ` ${plural(folders, 'folder')} ${folders === 1 ? 'isn’t' : 'aren’t'} included.`}
          </DialogDescription>
        </DialogHeader>
        <div className="-mx-4 min-h-0 space-y-3 overflow-y-auto px-4 pb-1">{body}</div>
        <DialogFooter>{footer}</DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RowStatus({
  row,
  paused,
  name,
  retryAdd,
  retryExtraction,
}: {
  row: Row;
  paused: boolean;
  name: string;
  retryAdd: () => void;
  retryExtraction: (row: Extract<Row, { kind: 'tracking' }>) => void;
}) {
  const line = (icon: ReactNode, text: string, tone: 'muted' | 'foreground' | 'destructive' = 'muted') => (
    <p
      className={`flex items-center gap-1.5 text-sm ${tone === 'muted' ? 'text-muted-foreground' : tone === 'destructive' ? 'text-destructive' : 'text-foreground'}`}
    >
      {icon}
      {text}
    </p>
  );
  if (row.kind === 'new') return line(null, 'Ready to add');
  if (row.kind === 'sending') return line(<Spinner aria-hidden="true" />, 'Adding…');
  if (row.kind === 'failed')
    return (
      <div className="flex flex-wrap items-center gap-2">
        <p role="alert" className="mr-auto min-w-0 basis-56 text-sm text-destructive">
          {row.message}
        </p>
        <Button variant="outline" size="sm" aria-label={`Try adding ${name} again`} onClick={retryAdd}>
          Try again
        </Button>
      </div>
    );
  const { entry } = row;
  if (entry.parsing === 'queued' || entry.parsing === 'parsing')
    return line(
      paused ? null : <Spinner aria-hidden="true" />,
      entry.parsing === 'queued' ? 'Waiting to extract text…' : 'Extracting text…',
    );
  if (entry.parsing === 'ready')
    return line(
      <Check size={14} aria-hidden="true" />,
      row.existing ? 'Already in your Knowledge. Chats can use it.' : 'Ready. Chats can use it from your Knowledge.',
      'foreground',
    );
  if (entry.parsing === 'ocr-unavailable')
    return line(null, 'This file has scanned pages. TulipFarm can’t read text from images yet.', 'destructive');
  if (entry.canRetry)
    return (
      <div className="flex flex-wrap items-center gap-2">
        <p className="mr-auto min-w-0 basis-56 text-sm text-destructive">
          {row.retryFailed ?? 'Text extraction didn’t finish.'}
        </p>
        <Button
          variant="outline"
          size="sm"
          disabled={row.retrying}
          aria-busy={row.retrying}
          aria-label={`Retry extraction for ${name}`}
          onClick={() => retryExtraction(row)}
        >
          {row.retrying ? 'Retrying…' : 'Retry extraction'}
        </Button>
      </div>
    );
  return line(null, failures[entry.failure ?? ''] ?? 'Text extraction failed after several attempts.', 'destructive');
}
