import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from 'cn';
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
import { Field } from '@tulipfarm/sprout/field';
import { Form, FormSection } from '@tulipfarm/sprout/form';
import { MessageResponse } from '@tulipfarm/sprout/message-response';
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
  const [files, setFiles] = useState<MemoryFileContent[] | null>(null);
  const [load, setLoad] = useState<Load | null>({ kind: 'loading' });
  const [editing, setEditing] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const active = useRef<AbortController | null>(null);
  const path = `/workspaces/${encodeURIComponent(workspaceId)}/personal-memory`;

  async function read(quiet = false) {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    if (!quiet) setLoad({ kind: 'loading' });
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
              <MemoryGroupList key={group} group={group} empty={files.every(file => file.group !== group)}>
                {files
                  .filter(file => file.group === group)
                  .map(file => (
                    <MemoryFileItem
                      key={file.path}
                      path={path}
                      file={file}
                      editing={editing === file.path}
                      locked={editing !== null && editing !== file.path}
                      onEditing={next => {
                        setNotice('');
                        setEditing(next ? file.path : null);
                      }}
                      onSaved={saved => setFiles(current => current && replace(current, saved))}
                      onFiles={(next, message) => {
                        setEditing(null);
                        setFiles(next);
                        setNotice(message);
                      }}
                    />
                  ))}
              </MemoryGroupList>
            ))}
            <MemoryInstruction
              path={path}
              onChanged={() => {
                setNotice('');
                void read(true);
              }}
              onLost={() => void read()}
            />
          </div>
        )
      )}
    </FormSection>
  );
}

function replace(files: MemoryFileContent[], saved: MemoryFileContent) {
  return files.some(entry => entry.path === saved.path)
    ? files.map(entry => (entry.path === saved.path ? saved : entry))
    : [...files, saved];
}

function MemoryGroupList({ group, empty, children }: { group: MemoryGroup; empty: boolean; children: ReactNode }) {
  const copy = groups[group];
  return (
    <SettingsGroup title={copy.title} titleId={`memory-group-${group}`} heading="h3">
      <p className="px-4 py-3 text-sm text-muted-foreground">{copy.hint}</p>
      {empty && <p className="px-4 py-3 text-sm">{copy.empty}</p>}
      {children}
    </SettingsGroup>
  );
}

/** Matches `max-h-40`. */
const clampHeight = 160;

/** The file's text as Markdown, cut to a few lines until the reader asks for the rest. */
function MemoryText({ id, content }: { id: string; content: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [long, setLong] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const measure = () => setLong(element.scrollHeight > clampHeight + 8);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [content]);
  const clamped = long && !expanded;
  return (
    <div className="grid justify-items-start gap-1">
      <div
        ref={box}
        id={id}
        className={cn('w-full overflow-hidden', clamped && 'max-h-40 mask-b-from-60% mask-b-to-100%')}
      >
        <MessageResponse>{content}</MessageResponse>
      </div>
      {long && (
        <Button
          variant="link"
          size="sm"
          aria-controls={id}
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? 'Show less' : 'Show more'}
        </Button>
      )}
    </div>
  );
}

type FileState =
  | { kind: 'ready' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'reloading' }
  | { kind: 'conflict' }
  | { kind: 'error'; message: string };

function MemoryFileItem({
  path,
  file,
  editing,
  locked,
  onEditing,
  onSaved,
  onFiles,
}: {
  path: string;
  file: MemoryFileContent;
  editing: boolean;
  locked: boolean;
  onEditing: (editing: boolean) => void;
  onSaved: (file: MemoryFileContent) => void;
  onFiles: (files: MemoryFileContent[], message: string) => void;
}) {
  const [state, setState] = useState<FileState>({ kind: 'ready' });
  const [base, setBase] = useState(file);
  const [draft, setDraft] = useState('');
  const [confirming, setConfirming] = useState(false);
  const active = useRef<AbortController | null>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  useEffect(() => () => active.current?.abort(), []);
  const you = file.group === 'you';
  const name = file.name;
  const size = encoder.encode(draft).length;
  const tooLong = size > memoryFileMaximumBytes;
  const dirty = editing && draft !== base.content;
  const pending = state.kind === 'saving' || state.kind === 'reloading';
  const editorId = `memory-file-${file.path.replace(/[^a-z0-9]+/gi, '-')}`;

  function start() {
    setBase(file);
    setDraft(file.content);
    setState({ kind: 'ready' });
    onEditing(true);
  }
  function stop() {
    active.current?.abort();
    setState({ kind: 'ready' });
    onEditing(false);
    requestAnimationFrame(() => editButton.current?.focus());
  }

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

  async function reload() {
    const controller = new AbortController();
    active.current = controller;
    setState({ kind: 'reloading' });
    try {
      const result = memoryFileContentSchema.parse(
        await settingsRequest(`${path}/files/read?path=${encodeURIComponent(file.path)}`, signalFor(controller)),
      );
      if (controller.signal.aborted) return;
      setBase(result);
      setDraft(result.content);
      onSaved(result);
      setState({ kind: 'ready' });
    } catch {
      if (!controller.signal.aborted) setState({ kind: 'error', message: `Couldn’t load ${name}. Try again.` });
    } finally {
      if (active.current === controller) active.current = null;
    }
  }

  async function save() {
    if (pending || tooLong || !dirty || state.kind === 'conflict') return;
    const controller = new AbortController();
    active.current = controller;
    setState({ kind: 'saving' });
    try {
      const result = memoryFileContentSchema.parse(
        await settingsRequest(`${path}/files`, signalFor(controller), 'PUT', {
          path: file.path,
          content: draft,
          expectedRevisionId: base.revisionId,
        }),
      );
      if (controller.signal.aborted) return;
      onSaved(result);
      onEditing(false);
      setState({ kind: 'saved' });
      requestAnimationFrame(() => editButton.current?.focus());
    } catch (error) {
      if (!controller.signal.aborted) failure(error, 'save');
    } finally {
      if (active.current === controller) active.current = null;
    }
  }

  async function remove() {
    if (!base.revisionId || pending) return;
    const controller = new AbortController();
    active.current = controller;
    setState({ kind: 'saving' });
    try {
      const result = memoryFilesSchema.parse(
        await settingsRequest(`${path}/files`, signalFor(controller), 'DELETE', {
          path: file.path,
          expectedRevisionId: base.revisionId,
        }),
      );
      if (controller.signal.aborted) return;
      setState({ kind: 'ready' });
      onFiles(result.files, you ? `${name} cleared.` : `${name} deleted.`);
    } catch (error) {
      if (!controller.signal.aborted) failure(error, you ? 'clear' : 'delete');
    } finally {
      if (active.current === controller) active.current = null;
      setConfirming(false);
    }
  }

  return (
    <div data-memory-file={file.path}>
      <SettingsRow
        label={name}
        description={
          <>
            {file.description && <span className="line-clamp-1">{file.description}</span>}
            {file.revisionId && file.updatedAt && (
              <span className="block text-xs">Updated {updatedAgo(file.updatedAt)}</span>
            )}
          </>
        }
      >
        {!editing && (
          <Button
            ref={editButton}
            variant="outline"
            size="sm"
            aria-label={`Edit ${name}`}
            disabled={locked}
            onClick={start}
          >
            Edit
          </Button>
        )}
      </SettingsRow>
      <div className="grid gap-3 px-4 pb-3">
        {!editing ? (
          <>
            {file.content.trim() ? (
              <MemoryText id={`${editorId}-text`} content={file.content} />
            ) : (
              <p className="text-sm text-muted-foreground">Empty</p>
            )}
            {state.kind === 'saved' && (
              <p role="status" className="text-sm text-muted-foreground">
                Saved. Bud uses the new version from now on.
              </p>
            )}
          </>
        ) : (
          <Form label={name} disabled={pending} onSubmit={() => void save()}>
            <UnsavedChanges dirty={dirty && !pending} />
            <div className="grid gap-3">
              <Field
                id={editorId}
                label={`${name} contents`}
                optional
                counter={`${size.toLocaleString()} / ${memoryFileMaximumBytes.toLocaleString()} bytes`}
                helper="Markdown is supported. Changes apply as soon as you save."
                error={tooLong ? 'This file is too long. Shorten it to under 8 KB, then save.' : undefined}
              >
                <Textarea
                  rows={Math.min(14, Math.max(4, draft.split('\n').length + 1))}
                  value={draft}
                  autoFocus
                  readOnly={state.kind === 'conflict'}
                  onChange={event => {
                    setDraft(event.target.value);
                    if (state.kind === 'error') setState({ kind: 'ready' });
                  }}
                  onKeyDown={event => {
                    if (event.key === 'Escape' && !dirty && !pending) {
                      event.preventDefault();
                      stop();
                    }
                  }}
                />
              </Field>
              {state.kind === 'error' && (
                <Alert variant="destructive">
                  <AlertDescription>{state.message}</AlertDescription>
                </Alert>
              )}
              {state.kind === 'conflict' && (
                <Alert>
                  <AlertDescription>
                    This file changed after you started editing, so nothing was saved. Copy your edits if you want them,
                    then reload to see the latest version.
                  </AlertDescription>
                  <div className="mt-3">
                    <Button variant="outline" onClick={() => void reload()}>
                      Reload
                    </Button>
                  </div>
                </Alert>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="submit"
                  disabled={!dirty || tooLong || state.kind === 'conflict'}
                  aria-busy={state.kind === 'saving'}
                >
                  {state.kind === 'saving' ? 'Saving…' : 'Save'}
                </Button>
                <Button variant="outline" disabled={pending} onClick={stop}>
                  Cancel
                </Button>
                {base.revisionId && (
                  <div className="ml-auto">
                    <Button
                      variant="ghost-destructive"
                      disabled={pending || state.kind === 'conflict'}
                      onClick={() => setConfirming(true)}
                    >
                      {you ? 'Clear' : 'Delete'}
                    </Button>
                  </div>
                )}
              </div>
            </div>
          </Form>
        )}
      </div>
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
    </div>
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

function MemoryInstruction({ path, onChanged, onLost }: { path: string; onChanged: () => void; onLost: () => void }) {
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
      if (value.changed.length) onChanged();
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
