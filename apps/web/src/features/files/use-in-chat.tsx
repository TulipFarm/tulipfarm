import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { ChatPlus } from 'reicon-react/icons/ChatPlus';
import { Chat as ChatIcon } from 'reicon-react/icons/Chat';
import { Check } from 'reicon-react/icons/Check';
import { Checklist } from 'reicon-react/icons/Checklist';
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
import { SearchField } from '@tulipfarm/sprout/search-field';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { conversationApi, type ChatDestination, type FileAudience } from '@/features/chat/conversation-api';
import {
  addDraftFiles,
  readDraftFiles,
  referenceLimit,
  type DraftOwner,
  type FileReference,
} from '@/features/chat/draft-files';
import { useFeatureRead } from '@/lib/query';
import { useTaskApi, useTaskDestinations, type TaskDestination } from '@/features/tasks/queries';
import { errorMessage, type FilesApi, type FileSummary } from './api';
import type { GoogleBinding, GoogleFileMetadata } from './google-api';
import { SharingDialog, type FinalFocus } from './sharing';

/**
 * Where the references go, and how far the audience check has got.
 * A personal chat's audience is the sender alone, so only shared (project) chats are checked.
 */
type Step =
  | { kind: 'choose' }
  | { kind: 'checking'; chat: ChatDestination }
  | { kind: 'failed'; chat: ChatDestination; message: string }
  | { kind: 'resolve'; chat: ChatDestination; audience: ReadonlyMap<string, FileAudience> };

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const reference = (file: FileSummary): FileReference => ({
  source: 'tulipfarm',
  id: file.id,
  name: file.name,
  mediaType: file.mediaType ?? '',
  size: file.size,
});
/** A task draft shares the chat draft store under `task:<id>`, so its references survive navigation the same way. */
type Target = { kind: 'new' } | { kind: 'chat'; chat: ChatDestination } | { kind: 'task'; task: TaskDestination };
const draftTarget = (target: Target) =>
  target.kind === 'new' ? 'new' : target.kind === 'chat' ? target.chat.id : `task:${target.task.id}`;
const draftName = (target: Target) =>
  target.kind === 'new'
    ? 'Your new chat draft'
    : target.kind === 'chat'
      ? `The draft in “${target.chat.title}”`
      : `Your next message to “${target.task.title}”`;

/** Adds references to the target's draft and opens it, or explains why the draft has no room. */
function usePlace(owner: DraftOwner, workspaceSlug: string, onClose: () => void) {
  const navigate = useNavigate();
  return (target: Target, references: readonly FileReference[]): string | null => {
    const key = draftTarget(target);
    if (!addDraftFiles(owner, key, references)) {
      const existing = readDraftFiles(owner, key).length;
      return `${draftName(target)} already has ${plural(existing, 'file')}. A message can reference up to ${referenceLimit}. Remove some there first, or choose fewer files.`;
    }
    onClose();
    if (target.kind === 'new') void navigate({ to: '/$workspaceSlug', params: { workspaceSlug }, search: {} });
    else if (target.kind === 'chat')
      void navigate({ to: '/$workspaceSlug/chat/$chatId', params: { workspaceSlug, chatId: target.chat.id } });
    else
      void navigate({ to: '/$workspaceSlug/agent-tasks/$taskId', params: { workspaceSlug, taskId: target.task.id } });
    return null;
  };
}

/** Places Files references into a chat's editable draft. Nothing is sent until the person sends it from the chat. */
export function UseInChatDialog({
  api,
  workspaceId,
  workspaceSlug,
  membershipId,
  items,
  finalFocus,
  onClose,
}: {
  api: FilesApi;
  workspaceId: string;
  workspaceSlug: string;
  membershipId: string;
  items: FileSummary[];
  finalFocus?: FinalFocus;
  onClose: () => void;
}) {
  const placeReferences = usePlace({ workspaceId, membershipId }, workspaceSlug, onClose);
  const chats = useMemo(() => conversationApi(workspaceId, () => undefined), [workspaceId]);
  const [files, setFiles] = useState(() => items.filter(item => item.kind === 'file'));
  const folders = items.length - files.length;
  const [step, setStep] = useState<Step>({ kind: 'choose' });
  const [full, setFull] = useState<string | null>(null);
  const [granting, setGranting] = useState<{
    file: FileSummary;
    people: { membershipId: string; name: string }[];
  } | null>(null);
  const [rechecking, setRechecking] = useState(false);
  const review = useRef<HTMLDivElement>(null);
  const checking = useRef<AbortController | null>(null);
  useEffect(() => () => checking.current?.abort(), []);

  function place(target: Target, selected: FileSummary[]) {
    setFull(placeReferences(target, selected.map(reference)));
  }

  /** `recheck` keeps the review open after a grant so the person sees the result before adding. */
  async function check(chat: ChatDestination, selected: FileSummary[], recheck = false) {
    setFull(null);
    if (!chat.projectId) {
      place({ kind: 'chat', chat }, selected);
      return;
    }
    checking.current?.abort();
    const controller = new AbortController();
    checking.current = controller;
    if (recheck) setRechecking(true);
    else setStep({ kind: 'checking', chat });
    try {
      const result = await chats.fileAudience(
        chat.id,
        selected.map(file => file.id),
        controller.signal,
      );
      if (controller.signal.aborted) return;
      if (!recheck && result.files.every(file => file.status === 'ready')) place({ kind: 'chat', chat }, selected);
      else setStep({ kind: 'resolve', chat, audience: new Map(result.files.map(file => [file.fileId, file])) });
    } catch (error) {
      if (controller.signal.aborted) return;
      setStep({
        kind: 'failed',
        chat,
        message: errorMessage(
          error,
          'Couldn’t check who can open these files. Nothing was added. Check your connection and try again.',
        ),
      });
    } finally {
      if (checking.current === controller) setRechecking(false);
    }
  }

  function remove(file: FileSummary) {
    const next = files.filter(entry => entry.id !== file.id);
    setFiles(next);
    if (!next.length) onClose();
  }

  const title = files.length === 1 ? `Use “${files[0]?.name}” in chat` : `Use ${plural(files.length, 'file')} in chat`;
  let body: ReactNode;
  let footer: ReactNode;
  if (!files.length) {
    body = (
      <StatePanel
        kind="unavailable"
        heading="h3"
        title="No files selected"
        description="Folders can’t be used in chat. Select files instead."
      />
    );
    footer = <Button onClick={onClose}>Close</Button>;
  } else if (files.length > referenceLimit) {
    body = (
      <StatePanel
        kind="unavailable"
        heading="h3"
        title={`Choose up to ${referenceLimit} files`}
        description={`A message can reference up to ${referenceLimit} files. You selected ${files.length}. Clear some, then try again.`}
      />
    );
    footer = <Button onClick={onClose}>Back to Files</Button>;
  } else if (step.kind === 'choose') {
    body = (
      <Destinations
        api={chats}
        newChat={() => place({ kind: 'new' }, files)}
        choose={chat => void check(chat, files)}
        tasks={{ workspaceId, choose: task => place({ kind: 'task', task }, files) }}
      />
    );
    footer = (
      <Button variant="outline" onClick={onClose}>
        Cancel
      </Button>
    );
  } else if (step.kind === 'checking') {
    body = (
      <div role="status" className="space-y-3 py-2">
        <p className="text-sm text-muted-foreground">
          Checking who in “{step.chat.title}” can open {files.length === 1 ? 'it' : 'them'}…
        </p>
        <Skeleton />
        <Skeleton />
      </div>
    );
    footer = (
      <Button
        variant="outline"
        onClick={() => {
          checking.current?.abort();
          setStep({ kind: 'choose' });
        }}
      >
        Choose another chat
      </Button>
    );
  } else if (step.kind === 'failed') {
    body = (
      <StatePanel kind="error" heading="h3" title="Couldn’t check access" description={step.message}>
        <Button variant="outline" onClick={() => void check(step.chat, files)}>
          Check access again
        </Button>
      </StatePanel>
    );
    footer = (
      <Button variant="outline" onClick={() => setStep({ kind: 'choose' })}>
        Choose another chat
      </Button>
    );
  } else {
    const { chat, audience } = step;
    const blocked = files.filter(file => audience.get(file.id)?.status !== 'ready');
    body = (
      <div ref={review} role="group" tabIndex={-1} aria-label="Access review" className="space-y-3 rounded-lg">
        <p role="status" className="sr-only">
          {rechecking
            ? 'Checking access again…'
            : blocked.length
              ? `${plural(blocked.length, 'file')} need${blocked.length === 1 ? 's' : ''} attention.`
              : 'Everyone in this chat can open these files.'}
        </p>
        <p className="text-sm text-muted-foreground">
          Everyone who can read{' '}
          <span className="font-medium text-foreground wrap-anywhere">
            {chat.projectName ? `${chat.projectName} · ` : ''}
            {chat.title}
          </span>{' '}
          sees answers that use these files, so each file must be open to all of them.
        </p>
        <ul aria-label="Files to add" className="divide-y rounded-lg border">
          {files.map(file => (
            <li key={file.id} className="space-y-2 px-3 py-2.5">
              <p className="flex min-w-0 items-center gap-2 text-sm font-medium text-foreground">
                <FileTypeIcon name={file.name} mediaType={file.mediaType ?? ''} />
                <span className="min-w-0 truncate" title={file.name}>
                  {file.name}
                </span>
              </p>
              <FileStatus
                file={file}
                audience={audience.get(file.id)}
                place="this chat"
                fallback=", or use a personal chat"
                grant={people => setGranting({ file, people })}
                remove={() => remove(file)}
              />
            </li>
          ))}
        </ul>
      </div>
    );
    footer = (
      <>
        <Button variant="ghost" onClick={() => setStep({ kind: 'choose' })}>
          Choose another chat
        </Button>
        <Button variant="outline" onClick={() => place({ kind: 'new' }, files)}>
          Use in a new personal chat
        </Button>
        <Button
          disabled={rechecking || blocked.length > 0}
          aria-busy={rechecking}
          onClick={() => place({ kind: 'chat', chat }, files)}
        >
          {rechecking
            ? 'Checking access…'
            : blocked.length
              ? `${plural(blocked.length, 'file')} need${blocked.length === 1 ? 's' : ''} attention`
              : `Add to the draft in “${chat.title}”`}
        </Button>
      </>
    );
  }

  return (
    <>
      <Dialog
        open
        onOpenChange={open => {
          if (!open && !granting) onClose();
        }}
      >
        <DialogContent size="form" finalFocus={finalFocus}>
          <DialogHeader>
            <DialogTitle>
              <span className="wrap-anywhere">{title}</span>
            </DialogTitle>
            <DialogDescription>
              Adds {files.length === 1 ? 'a reference' : 'references'} to a chat’s or agent task’s draft. Nothing is
              sent until you send the message.
              {folders > 0 && ` ${plural(folders, 'folder')} ${folders === 1 ? 'isn’t' : 'aren’t'} included.`}
            </DialogDescription>
          </DialogHeader>
          <div className="-mx-4 min-h-0 space-y-3 overflow-y-auto px-4 pb-1">
            {body}
            {full && (
              <Alert variant="destructive">
                <AlertDescription>{full}</AlertDescription>
              </Alert>
            )}
          </div>
          <DialogFooter>{footer}</DialogFooter>
        </DialogContent>
      </Dialog>
      {granting && step.kind === 'resolve' && (
        <SharingDialog
          api={api}
          item={granting.file}
          membershipId={membershipId}
          workspaceSlug={workspaceSlug}
          invite={{ reason: 'in this chat', people: granting.people }}
          onClose={() => {
            setGranting(null);
            // The review dialog reclaims focus when the nested sharing dialog closes; move it to the review after that.
            setTimeout(() => review.current?.focus());
            void check(step.chat, files, true);
          }}
        />
      )}
    </>
  );
}

/** One file's audience result. `place` names the destination, such as "this chat"; `fallback` adds an alternative to asking a manager. */
export function FileStatus({
  file,
  audience,
  place,
  fallback = '',
  grant,
  remove,
}: {
  file: FileSummary;
  audience: FileAudience | undefined;
  place: string;
  fallback?: string;
  grant: (people: { membershipId: string; name: string }[]) => void;
  remove: () => void;
}) {
  const removeButton = (
    <Button variant="ghost" size="sm" aria-label={`Remove ${file.name}`} onClick={remove}>
      Remove
    </Button>
  );
  if (!audience || audience.status === 'ready')
    return (
      <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Check size={14} aria-hidden="true" />
        Everyone in {place} can open it
      </p>
    );
  if (audience.status === 'unavailable')
    return (
      <div className="flex flex-wrap items-center gap-2">
        <p className="mr-auto text-sm text-destructive">You can no longer open this file.</p>
        {removeButton}
      </div>
    );
  const missing = audience.missing;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <p className="mr-auto min-w-0 basis-56 text-sm text-foreground wrap-anywhere">
        {!missing
          ? `Some people in ${place} can’t open it. Ask someone who manages it to share it${fallback}.`
          : missing.length === 1
            ? `${missing[0]?.name} can’t open it.`
            : `${missing.length} people can’t open it: ${missing.map(person => person.name).join(', ')}.`}
      </p>
      {missing && (
        <Button variant="outline" size="sm" aria-label={`Grant access to ${file.name}`} onClick={() => grant(missing)}>
          Grant access
        </Button>
      )}
      {removeButton}
    </div>
  );
}

/** `tasks` adds the person's own agent tasks as destinations. A task's audience is its owner alone, so Google references may go there too. */
function Destinations({
  api,
  newChat,
  choose,
  privateOnly = false,
  tasks,
}: {
  api: ReturnType<typeof conversationApi>;
  newChat: () => void;
  choose: (chat: ChatDestination) => void;
  privateOnly?: boolean;
  tasks: { workspaceId: string; choose: (task: TaskDestination) => void; google?: boolean };
}) {
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setQuery(draft.trim()), 200);
    return () => clearTimeout(timer);
  }, [draft]);
  const read = useFeatureRead({
    key: ['conversations', 'destinations', query],
    staleTime: 0,
    load: signal => api.destinations(query, signal),
  });
  let list: ReactNode;
  if (read.state.kind === 'loading')
    list = (
      <div role="status" aria-label="Loading chats" className="space-y-3 py-2">
        <Skeleton />
        <Skeleton />
        <Skeleton />
        <span className="sr-only">Loading chats…</span>
      </div>
    );
  else if (read.state.kind === 'error' || read.state.kind === 'unavailable')
    list = (
      <StatePanel
        kind="error"
        heading="h3"
        title="Couldn’t load your chats"
        description="You can still start a new chat. Check your connection and try again."
      >
        <Button variant="outline" onClick={() => void read.refresh()}>
          Retry loading chats
        </Button>
      </StatePanel>
    );
  else if (!(privateOnly ? read.state.data.filter(chat => !chat.projectId) : read.state.data).length)
    list = query ? (
      <p className="py-3 text-sm text-muted-foreground">
        No {privateOnly ? 'personal chats' : 'chats you can post in'} match “{query}”.
      </p>
    ) : (
      <p className="py-3 text-sm text-muted-foreground">No chats yet. Start a new chat instead.</p>
    );
  else
    list = (
      <ul aria-label="Chats you can post in" className="space-y-0.5">
        {(privateOnly ? read.state.data.filter(chat => !chat.projectId) : read.state.data).map(chat => (
          <li key={chat.id}>
            <Button variant="ghost" size="nav" onClick={() => choose(chat)}>
              <ChatIcon size={16} aria-hidden="true" />
              <span className="min-w-0 truncate" title={chat.title}>
                {chat.title}
              </span>
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">{chat.projectName ?? 'Private'}</span>
            </Button>
          </li>
        ))}
      </ul>
    );
  return (
    <>
      <Button variant="outline" onClick={newChat}>
        <ChatPlus size={16} aria-hidden="true" />
        New personal chat
      </Button>
      <section aria-labelledby="use-in-chat-existing" className="space-y-2">
        <h3 id="use-in-chat-existing" className="text-sm font-medium text-foreground">
          {privateOnly ? 'Or add to an existing personal chat' : 'Or add to an existing chat'}
        </h3>
        <SearchField label="Search chats" value={draft} maxLength={640} onChange={setDraft} />
        {read.state.kind === 'ready' && read.state.error && (
          <p role="alert" className="text-sm text-destructive">
            Couldn’t refresh your chats. Showing the last list.
          </p>
        )}
        {list}
      </section>
      <TaskDestinations
        workspaceId={tasks.workspaceId}
        query={query}
        choose={tasks.choose}
        google={tasks.google ?? false}
      />
    </>
  );
}

const taskLabels: Partial<Record<TaskDestination['status'], string>> = {
  completed: 'Finished',
  'waiting-clarification': 'Needs your answer',
  paused: 'Paused',
  failed: 'Stopped',
};

/** Tasks the person started that take a message now. A task is private to its owner, so no audience check applies. */
function TaskDestinations({
  workspaceId,
  query,
  choose,
  google,
}: {
  workspaceId: string;
  query: string;
  choose: (task: TaskDestination) => void;
  google: boolean;
}) {
  const read = useTaskDestinations(useTaskApi(workspaceId), query);
  let list: ReactNode;
  if (read.state.kind === 'loading')
    list = (
      <div role="status" aria-label="Loading agent tasks" className="space-y-3 py-2">
        <Skeleton />
        <Skeleton />
        <span className="sr-only">Loading agent tasks…</span>
      </div>
    );
  else if (read.state.kind === 'error' || read.state.kind === 'unavailable')
    list = (
      <StatePanel
        kind="error"
        heading="h3"
        title="Couldn’t load your agent tasks"
        description="Chats above still work. Check your connection and try again."
      >
        <Button variant="outline" onClick={() => void read.refresh()}>
          Retry loading agent tasks
        </Button>
      </StatePanel>
    );
  else if (!read.state.data.length)
    list = (
      <p className="py-3 text-sm text-muted-foreground">
        {query
          ? `No agent tasks you can message match “${query}”.`
          : 'No agent tasks are waiting for a message. A task takes files when it needs your answer, is paused or stopped, or has finished.'}
      </p>
    );
  else
    list = (
      <ul aria-label="Agent tasks you can message" className="space-y-0.5">
        {read.state.data.map(task => (
          <li key={task.id}>
            <Button variant="ghost" size="nav" onClick={() => choose(task)}>
              <Checklist size={16} aria-hidden="true" />
              <span className="min-w-0 truncate" title={task.title}>
                {task.title}
              </span>
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">{taskLabels[task.status] ?? ''}</span>
            </Button>
          </li>
        ))}
      </ul>
    );
  return (
    <section aria-labelledby="use-in-chat-tasks" className="space-y-2">
      <h3 id="use-in-chat-tasks" className="text-sm font-medium text-foreground">
        Or add to an agent task
      </h3>
      <p className="text-xs text-muted-foreground">
        {google
          ? 'The task reads the file’s current content through your Google account when it works on your next message. If you disconnect or switch accounts first, the task pauses.'
          : 'The task reads each file’s current content with your access when it works on your next message.'}
      </p>
      {read.state.kind === 'ready' && read.state.error && (
        <p role="alert" className="text-sm text-destructive">
          Couldn’t refresh your agent tasks. Showing the last list.
        </p>
      )}
      {list}
    </section>
  );
}

/**
 * Places a Google Drive reference into a personal chat draft. Google controls who can open the file and TulipFarm can check
 * only the sender, so project chats aren't offered. The reference keeps the Google integration it was chosen through.
 */
export function UseGoogleFileInChatDialog({
  workspaceId,
  workspaceSlug,
  membershipId,
  file,
  binding,
  finalFocus,
  onClose,
}: {
  workspaceId: string;
  workspaceSlug: string;
  membershipId: string;
  file: Pick<GoogleFileMetadata, 'id' | 'name' | 'mimeType'>;
  binding: GoogleBinding;
  finalFocus?: FinalFocus;
  onClose: () => void;
}) {
  const place = usePlace({ workspaceId, membershipId }, workspaceSlug, onClose);
  const chats = useMemo(() => conversationApi(workspaceId, () => undefined), [workspaceId]);
  const [full, setFull] = useState<string | null>(null);
  const references: FileReference[] = [
    { source: 'google', id: file.id, name: file.name, mediaType: file.mimeType, binding },
  ];
  return (
    <Dialog
      open
      onOpenChange={open => {
        if (!open) onClose();
      }}
    >
      <DialogContent size="form" finalFocus={finalFocus}>
        <DialogHeader>
          <DialogTitle>
            <span className="wrap-anywhere">Use “{file.name}” in chat</span>
          </DialogTitle>
          <DialogDescription>
            Adds a reference to a personal chat’s or your agent task’s draft. The file’s current content is read from
            Google Drive through your Google account. Google controls who can open it, so it can’t be used in project
            chats. Nothing is sent until you send the message.
          </DialogDescription>
        </DialogHeader>
        <div className="-mx-4 min-h-0 space-y-3 overflow-y-auto px-4 pb-1">
          <Destinations
            api={chats}
            privateOnly
            newChat={() => setFull(place({ kind: 'new' }, references))}
            choose={chat => setFull(place({ kind: 'chat', chat }, references))}
            tasks={{ workspaceId, google: true, choose: task => setFull(place({ kind: 'task', task }, references)) }}
          />
          {full && (
            <Alert variant="destructive">
              <AlertDescription>{full}</AlertDescription>
            </Alert>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
