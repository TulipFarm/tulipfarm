import { useEffect, useRef, useState } from 'react';
import {
  memoryFileContentSchema,
  memoryFileMaximumBytes,
  memoryFilesSchema,
  memoryGroups,
  memoryInstructionResultSchema,
  type MemoryFile,
  type MemoryFileChange,
  type MemoryFileContent,
  type MemoryGroup,
} from '@tulipfarm/conversations/personal-memory-contracts';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from '@tulipfarm/sprout/alert-dialog';
import { Button } from '@tulipfarm/sprout/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@tulipfarm/sprout/dialog';
import { Field } from '@tulipfarm/sprout/field';
import { Form, FormSection } from '@tulipfarm/sprout/form';
import { SettingsGroup, SettingsRow } from '@tulipfarm/sprout/settings-list';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { Textarea } from '@tulipfarm/sprout/textarea';
import { UnsavedChanges } from '@/features/tables/feedback';
import { TableRequestError } from '@/features/tables/request-state';
import { settingsRequest } from './api';

const groups: Record<MemoryGroup, { title: string; hint: string; empty?: string }> = {
  you: { title: 'You', hint: 'About you and how you like Bud to work with you' },
  topics: {
    title: 'Topics',
    hint: 'Subjects that come up often in your work',
    empty: 'No topics yet. Bud adds them as subjects come up in your chats.',
  },
  areas: {
    title: 'Areas',
    hint: 'Ongoing responsibilities you look after',
    empty: 'No areas yet. Bud adds them as your responsibilities come up in chats.',
  },
  people: {
    title: 'People',
    hint: 'People you work with',
    empty: 'No people yet. Bud adds them as you mention people you work with.',
  },
};

const encoder = new TextEncoder();
const status = (error: unknown) => (error instanceof TableRequestError ? error.status : undefined);
const denied = (error: unknown) => [401, 403, 404].includes(status(error) ?? 0);
const signalFor = (controller: AbortController, ms = 15000) =>
  AbortSignal.any([controller.signal, AbortSignal.timeout(ms)]);

const units: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31_536_000],
  ['month', 2_592_000],
  ['week', 604_800],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
];
/** "3 days ago", "yesterday", "just now". */
export function updatedAgo(at: string, now = Date.now()) {
  const seconds = Math.max(0, (now - Date.parse(at)) / 1000);
  const format = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  for (const [unit, size] of units) if (seconds >= size) return format.format(-Math.floor(seconds / size), unit);
  return 'just now';
}

const list = (names: string[]) => new Intl.ListFormat('en', { type: 'conjunction' }).format(names);
/** "Updated Preferences and Career. Deleted Project Falcon." */
export function describeChanges(changed: MemoryFileChange[], files: MemoryFile[]) {
  const you = new Set(files.filter(file => file.group === 'you').map(file => file.path));
  const words: [string, (change: MemoryFileChange) => boolean][] = [
    ['Updated', change => change.operation === 'updated'],
    ['Added', change => change.operation === 'created'],
    ['Deleted', change => change.operation === 'deleted' && !you.has(change.path)],
    ['Cleared', change => change.operation === 'deleted' && you.has(change.path)],
  ];
  return words
    .map(([word, matches]) => {
      const names = changed.filter(matches).map(change => change.name);
      return names.length ? `${word} ${list(names)}.` : '';
    })
    .filter(Boolean)
    .join(' ');
}

type Load = { kind: 'loading' } | { kind: 'load-error' } | { kind: 'unavailable' } | { kind: 'service-unavailable' };

export function PersonalMemoryEditor({ workspaceId, workspaceName }: { workspaceId: string; workspaceName: string }) {
  const [files, setFiles] = useState<MemoryFile[] | null>(null);
  const [load, setLoad] = useState<Load | null>({ kind: 'loading' });
  const [open, setOpen] = useState<MemoryFile | null>(null);
  const [notice, setNotice] = useState('');
  const active = useRef<AbortController | null>(null);
  const path = `/workspaces/${encodeURIComponent(workspaceId)}/personal-memory`;

  async function read() {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setLoad({ kind: 'loading' });
    try {
      const result = memoryFilesSchema.parse(await settingsRequest(`${path}/files`, signalFor(controller)));
      if (controller.signal.aborted) return;
      setFiles(result.files);
      setLoad(null);
    } catch (error) {
      if (controller.signal.aborted) return;
      setLoad(
        denied(error)
          ? { kind: 'unavailable' }
          : error instanceof TableRequestError && error.code === 'personal-memory-unavailable'
            ? { kind: 'service-unavailable' }
            : { kind: 'load-error' },
      );
    } finally {
      if (active.current === controller) active.current = null;
    }
  }
  useEffect(() => {
    void read();
    return () => {
      active.current?.abort();
      active.current = null;
    };
  }, []);

  const retry = (
    <Button variant="outline" onClick={() => void read()}>
      Try again
    </Button>
  );

  return (
    <FormSection
      title="Memory"
      description={`What Bud knows about you and your work in ${workspaceName}. Bud learns from your chats, keeps this up to date, and uses it in your private chats with Bud. Private to you.`}
    >
      {load?.kind === 'loading' ? (
        <StatePanel kind="loading" heading="h3" title="Loading your memory" description="Getting your memory files." />
      ) : load?.kind === 'load-error' ? (
        <StatePanel
          kind="error"
          heading="h3"
          title="Memory couldn’t load"
          description="Your memory hasn’t changed. Try again."
        >
          {retry}
        </StatePanel>
      ) : load?.kind === 'service-unavailable' ? (
        <StatePanel
          kind="error"
          heading="h3"
          title="Memory can’t be reached"
          description="The memory service isn’t answering. Your memory hasn’t changed."
        >
          {retry}
        </StatePanel>
      ) : load?.kind === 'unavailable' ? (
        <StatePanel
          kind="unavailable"
          heading="h3"
          title="Memory is unavailable"
          description={`Check your access to ${workspaceName}, then reload the page.`}
        />
      ) : (
        files && (
          <div className="grid gap-6">
            {notice && (
              <p role="status" className="text-sm text-muted-foreground">
                {notice}
              </p>
            )}
            {memoryGroups.map(group => (
              <MemoryGroupList
                key={group}
                group={group}
                files={files.filter(file => file.group === group)}
                onOpen={file => {
                  setNotice('');
                  setOpen(file);
                }}
              />
            ))}
            <MemoryInstruction
              path={path}
              onFiles={next => {
                setNotice('');
                setFiles(next);
              }}
              onLost={() => void read()}
            />
          </div>
        )
      )}
      {open && (
        <MemoryFileDialog
          path={path}
          file={open}
          onClose={() => setOpen(null)}
          onFiles={(next, message) => {
            setFiles(next);
            setOpen(null);
            setNotice(message);
          }}
          onSaved={saved => setFiles(current => current && replace(current, saved))}
        />
      )}
    </FormSection>
  );
}

function replace(files: MemoryFile[], saved: MemoryFileContent): MemoryFile[] {
  const { content: _content, ...file } = saved;
  return files.some(entry => entry.path === file.path)
    ? files.map(entry => (entry.path === file.path ? file : entry))
    : [...files, file];
}

function MemoryGroupList({
  group,
  files,
  onOpen,
}: {
  group: MemoryGroup;
  files: MemoryFile[];
  onOpen: (file: MemoryFile) => void;
}) {
  const copy = groups[group];
  const id = `memory-group-${group}`;
  return (
    <SettingsGroup title={copy.title} titleId={id} heading="h3">
      <p className="px-4 py-3 text-sm text-muted-foreground">{copy.hint}</p>
      {files.length === 0 && <p className="px-4 py-3 text-sm">{copy.empty}</p>}
      {files.map(file => (
        <SettingsRow
          key={file.path}
          label={file.name}
          description={
            <>
              {file.description && <span className="line-clamp-1">{file.description}</span>}
              <span className="block text-xs">
                {file.revisionId && file.updatedAt ? `Updated ${updatedAgo(file.updatedAt)}` : 'Empty'}
              </span>
            </>
          }
        >
          <Button variant="outline" size="sm" aria-label={`Open ${file.name}`} onClick={() => onOpen(file)}>
            Open
          </Button>
        </SettingsRow>
      ))}
    </SettingsGroup>
  );
}

type FileState =
  | { kind: 'loading' }
  | { kind: 'load-error' }
  | { kind: 'ready' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'conflict' }
  | { kind: 'error'; message: string };

function MemoryFileDialog({
  path,
  file,
  onClose,
  onFiles,
  onSaved,
}: {
  path: string;
  file: MemoryFile;
  onClose: () => void;
  onFiles: (files: MemoryFile[], message: string) => void;
  onSaved: (file: MemoryFileContent) => void;
}) {
  const [state, setState] = useState<FileState>({ kind: 'loading' });
  const [saved, setSaved] = useState<MemoryFileContent | null>(null);
  const [draft, setDraft] = useState('');
  const [confirming, setConfirming] = useState(false);
  const active = useRef<AbortController | null>(null);
  const you = file.group === 'you';
  const name = saved?.name ?? file.name;
  const size = encoder.encode(draft).length;
  const tooLong = size > memoryFileMaximumBytes;
  const dirty = saved !== null && draft !== saved.content;
  const pending = state.kind === 'saving';

  async function read() {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setState({ kind: 'loading' });
    try {
      const result = memoryFileContentSchema.parse(
        await settingsRequest(`${path}/files/read?path=${encodeURIComponent(file.path)}`, signalFor(controller)),
      );
      if (controller.signal.aborted) return;
      setSaved(result);
      setDraft(result.content);
      setState({ kind: 'ready' });
    } catch {
      if (!controller.signal.aborted) setState({ kind: 'load-error' });
    } finally {
      if (active.current === controller) active.current = null;
    }
  }
  useEffect(() => {
    void read();
    return () => active.current?.abort();
  }, []);

  function failure(error: unknown, action: 'save' | 'delete' | 'clear') {
    const code = status(error);
    if (code === 409) return setState({ kind: 'conflict' });
    setState({
      kind: 'error',
      message:
        code === 503
          ? 'Memory can’t be reached right now. Nothing was saved. Try again in a moment.'
          : action === 'save'
            ? `Couldn’t save ${name}. Your edits are kept. Try again.`
            : `Couldn’t ${action} ${name}. Try again.`,
    });
  }

  async function save() {
    if (!saved || pending || tooLong || !dirty) return;
    const controller = new AbortController();
    active.current = controller;
    setState({ kind: 'saving' });
    try {
      const result = memoryFileContentSchema.parse(
        await settingsRequest(`${path}/files`, signalFor(controller), 'PUT', {
          path: file.path,
          content: draft,
          expectedRevisionId: saved.revisionId,
        }),
      );
      if (controller.signal.aborted) return;
      setSaved(result);
      setDraft(result.content);
      onSaved(result);
      setState({ kind: 'saved' });
    } catch (error) {
      if (!controller.signal.aborted) failure(error, 'save');
    } finally {
      if (active.current === controller) active.current = null;
    }
  }

  async function remove() {
    if (!saved?.revisionId || pending) return;
    const controller = new AbortController();
    active.current = controller;
    setState({ kind: 'saving' });
    try {
      const result = memoryFilesSchema.parse(
        await settingsRequest(`${path}/files`, signalFor(controller), 'DELETE', {
          path: file.path,
          expectedRevisionId: saved.revisionId,
        }),
      );
      if (controller.signal.aborted) return;
      onFiles(result.files, you ? `${name} cleared.` : `${name} deleted.`);
    } catch (error) {
      if (!controller.signal.aborted) failure(error, you ? 'clear' : 'delete');
    } finally {
      if (active.current === controller) active.current = null;
      setConfirming(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={next => {
        if (!next && !pending) onClose();
      }}
    >
      <DialogContent size="form">
        <UnsavedChanges dirty={dirty && !pending} />
        <DialogHeader>
          <DialogTitle>{name}</DialogTitle>
          <DialogDescription>{saved?.description ?? file.description}</DialogDescription>
        </DialogHeader>
        <div className="-mx-4 min-h-0 space-y-4 overflow-y-auto px-4 pb-1">
          {state.kind === 'loading' && (
            <p role="status" className="text-sm text-muted-foreground">
              Loading {name}…
            </p>
          )}
          {state.kind === 'load-error' && (
            <Alert variant="destructive">
              <AlertDescription>Couldn’t load {name}. Try again.</AlertDescription>
            </Alert>
          )}
          {saved && (
            <Form label={name} disabled={pending} onSubmit={() => void save()}>
              <Field
                id="memory-file-content"
                label="Contents"
                optional
                counter={`${size.toLocaleString()} / ${memoryFileMaximumBytes.toLocaleString()} bytes`}
                helper="Markdown is supported. Changes apply as soon as you save."
                error={tooLong ? 'This file is too long. Shorten it to under 8 KB, then save.' : undefined}
              >
                <Textarea
                  rows={14}
                  value={draft}
                  readOnly={state.kind === 'conflict'}
                  onChange={event => {
                    setDraft(event.target.value);
                    if (state.kind === 'saved' || state.kind === 'error') setState({ kind: 'ready' });
                  }}
                />
              </Field>
            </Form>
          )}
          {state.kind === 'saved' && (
            <p role="status" className="text-sm text-muted-foreground">
              Saved. Bud uses the new version from now on.
            </p>
          )}
          {state.kind === 'error' && (
            <Alert variant="destructive">
              <AlertDescription>{state.message}</AlertDescription>
            </Alert>
          )}
          {state.kind === 'conflict' && (
            <Alert>
              <AlertDescription>
                This file changed after you opened it, so nothing was saved. Copy your edits if you want them, then
                reload to see the latest version.
              </AlertDescription>
              <div className="mt-3">
                <Button variant="outline" onClick={() => void read()}>
                  Reload
                </Button>
              </div>
            </Alert>
          )}
        </div>
        <DialogFooter>
          {state.kind === 'load-error' && (
            <Button variant="outline" onClick={() => void read()}>
              Try again
            </Button>
          )}
          {saved?.revisionId && (
            <div className="sm:mr-auto">
              <Button
                variant="ghost-destructive"
                disabled={pending || state.kind === 'conflict'}
                onClick={() => setConfirming(true)}
              >
                {you ? 'Clear' : 'Delete'}
              </Button>
            </div>
          )}
          <Button variant="outline" disabled={pending} onClick={onClose}>
            {dirty ? 'Cancel' : 'Close'}
          </Button>
          {saved && (
            <Button
              disabled={!dirty || tooLong || state.kind === 'conflict'}
              aria-busy={pending}
              onClick={() => void save()}
            >
              {pending ? 'Saving…' : 'Save'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
      {confirming && (
        <AlertDialog
          open
          onOpenChange={next => {
            if (!next && !pending) setConfirming(false);
          }}
        >
          <AlertDialogContent>
            <AlertDialogTitle>{you ? `Clear ${name}?` : `Delete ${name}?`}</AlertDialogTitle>
            <AlertDialogDescription>
              {you
                ? `This removes everything in ${name}. The file stays, and Bud can fill it in again from your chats.`
                : 'Bud will forget everything in this file.'}
            </AlertDialogDescription>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
              <Button variant="destructive" disabled={pending} aria-busy={pending} onClick={() => void remove()}>
                {you ? 'Clear' : 'Delete'}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </Dialog>
  );
}

function instructionError(error: unknown) {
  const code = status(error);
  const reason = error instanceof TableRequestError ? error.code : undefined;
  if (code === 402) return 'Your workspace is out of credits. Ask a workspace admin to add credits. Your text is kept.';
  if (code === 429) return 'Bud is busy right now. Wait a moment, then try again. Your text is kept.';
  if (code === 504) return 'This took too long. Nothing changed. Try again.';
  if (code === 503 || reason === 'model-family-unavailable' || reason === 'not-configured')
    return 'No AI model is available to update memory right now. Try again later, or ask a workspace admin to check models.';
  return 'Couldn’t update memory. Your text is kept. Try again.';
}

function MemoryInstruction({
  path,
  onFiles,
  onLost,
}: {
  path: string;
  onFiles: (files: MemoryFile[]) => void;
  onLost: () => void;
}) {
  const [instruction, setInstruction] = useState('');
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{ kind: 'done' | 'error'; message: string } | null>(null);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);

  async function submit() {
    const text = instruction.trim();
    if (!text || pending) return;
    const controller = new AbortController();
    active.current = controller;
    setPending(true);
    setResult(null);
    try {
      const value = memoryInstructionResultSchema.parse(
        await settingsRequest(`${path}/instruct`, signalFor(controller, 180_000), 'POST', {
          requestId: crypto.randomUUID(),
          instruction: text,
        }),
      );
      if (controller.signal.aborted) return;
      onFiles(value.files);
      setInstruction('');
      setResult({
        kind: 'done',
        message: value.changed.length
          ? describeChanges(value.changed, value.files)
          : 'Nothing needed changing. Your memory is already up to date.',
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      if (!(error instanceof Error && error.name === 'TimeoutError'))
        setResult({ kind: 'error', message: instructionError(error) });
      else {
        setResult({
          kind: 'error',
          message: 'This took too long. Some files may have changed, so check the list before trying again.',
        });
        onLost();
      }
    } finally {
      if (active.current === controller) active.current = null;
      setPending(false);
    }
  }

  return (
    <Form label="Tell Bud what to remember" disabled={pending} onSubmit={() => void submit()}>
      <div className="grid gap-3">
        <Field
          id="memory-instruction"
          label="Tell Bud what to remember"
          optional
          helper="Bud updates the right files at once. Uses workspace credits."
        >
          <Textarea
            rows={2}
            maxLength={2000}
            value={instruction}
            placeholder="For example: I moved to the Berlin office, or Forget everything about Project Falcon"
            onChange={event => {
              setInstruction(event.target.value);
              if (result?.kind === 'done') setResult(null);
            }}
          />
        </Field>
        {result?.kind === 'done' && (
          <p role="status" className="text-sm text-muted-foreground">
            {result.message}
          </p>
        )}
        {result?.kind === 'error' && (
          <Alert variant="destructive">
            <AlertDescription>{result.message}</AlertDescription>
          </Alert>
        )}
        <div>
          <Button type="submit" disabled={!instruction.trim() || pending} aria-busy={pending}>
            {pending ? 'Updating memory…' : 'Update memory'}
          </Button>
        </div>
      </div>
    </Form>
  );
}
