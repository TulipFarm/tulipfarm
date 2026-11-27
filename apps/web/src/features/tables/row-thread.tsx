import { useRef, useState } from 'react';
import { z } from 'zod';
import { Badge, type BadgeVariant } from '@tulipfarm/sprout/badge';
import { Button } from '@tulipfarm/sprout/button';
import { Input } from '@tulipfarm/sprout/input';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@tulipfarm/sprout/collapsible';
import { MessageResponse } from '@tulipfarm/sprout/message-response';
import { ArrowUpIcon, PaperclipIcon } from '@tulipfarm/icons';
import { BareText } from '@/components/ui/bare-text';
import { Textarea } from '@tulipfarm/sprout/textarea';
import { apiOrigin } from '@/lib/auth';
import { jsonResponse, readJson, responseError } from '@/lib/http';
import { useFeatureRead } from '@/lib/query';
import { ActorName } from './actors';
import { commentFileLimit, pastedFiles, RowFiles, rowAttachmentSchema, useRowUploads } from './row-attachments';
import { TableRequestError } from './request-state';

const runStateSchema = z.enum(['queued', 'working', 'waiting', 'done', 'failed', 'stopped']);
export const rowThreadSchema = z.object({
  items: z.array(
    z.object({
      id: z.uuid(),
      kind: z.enum(['comment', 'progress', 'event']),
      author: z.object({ type: z.enum(['member', 'agent']), id: z.uuid() }).nullable(),
      body: z.string().nullable(),
      event: z.record(z.string(), z.unknown()).nullable(),
      mentions: z.array(z.uuid()),
      createdAt: z.string(),
      editedAt: z.string().nullable(),
      deleted: z.boolean(),
      mine: z.boolean(),
      attachments: z.array(rowAttachmentSchema),
    }),
  ),
  assignment: z
    .object({
      agentId: z.uuid(),
      sponsorMembershipId: z.uuid(),
      runState: runStateSchema,
      reason: z.string().nullable(),
      wakeAt: z.string().nullable(),
      canRunNow: z.boolean(),
    })
    .nullable(),
  runs: z.array(
    z.object({
      taskId: z.uuid(),
      agentId: z.uuid(),
      startedAt: z.string(),
      endedAt: z.string().nullable(),
      outcome: z.string().nullable(),
    }),
  ),
});
export type RowThread = z.infer<typeof rowThreadSchema>;

export function rowThreadApi(workspaceId: string, tableId: string, rowId: string) {
  const base = `${apiOrigin}/v1/workspaces/${encodeURIComponent(workspaceId)}/tables/${encodeURIComponent(tableId)}/rows/${encodeURIComponent(rowId)}`;
  const send = async (path: string, method: string, body?: unknown, signal = AbortSignal.timeout(30_000)) => {
    const response = await jsonResponse(`${base}${path}`, { method, body, signal, cache: 'no-store' });
    const value = await readJson(response, true);
    if (!response.ok)
      throw new TableRequestError(
        response.status,
        responseError(value, 'row-work-unavailable'),
        'The row thread could not be updated. Try again.',
      );
    return rowThreadSchema.parse(value);
  };
  return {
    read: (signal: AbortSignal) => send('/thread', 'GET', undefined, signal),
    comment: (body: string, attachmentIds: string[] = []) =>
      send('/thread/comments', 'POST', { body, mentions: [], attachmentIds }),
    edit: (itemId: string, body: string, attachmentIds: string[]) =>
      send(`/thread/comments/${encodeURIComponent(itemId)}`, 'PATCH', { body, mentions: [], attachmentIds }),
    remove: (itemId: string) => send(`/thread/comments/${encodeURIComponent(itemId)}`, 'DELETE'),
    runNow: () => send('/run-now', 'POST'),
    clearWake: () => send('/wake', 'DELETE'),
    markDone: () => send('/done', 'POST'),
    reopen: () => send('/done', 'DELETE'),
  };
}

const runStateLabels: Record<z.infer<typeof runStateSchema>, [string, BadgeVariant]> = {
  queued: ['Queued', 'secondary'],
  working: ['Working', 'info'],
  waiting: ['Waiting', 'warning'],
  done: ['Done', 'success'],
  failed: ['Failed', 'destructive'],
  stopped: ['Stopped', 'outline'],
};

const time = (value: string) => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function eventText(event: Record<string, unknown> | null, noun = 'record') {
  switch (event?.type) {
    case 'assigned':
      return `assigned this ${noun}`;
    case 'reassigned':
      return `reassigned this ${noun}`;
    case 'unassigned':
      return `unassigned this ${noun}`;
    case 'run-stopped':
      return 'run stopped';
    case 'approval-requested':
      return 'asked for approval';
    case 'marked-done':
      return 'marked this done';
    case 'reopened':
      return 'reopened this';
    default:
      return typeof event?.type === 'string' ? event.type.replaceAll('-', ' ') : `updated this ${noun}`;
  }
}

/** Reads a row's thread; every reader of the same row shares one request and its polling. */
export function useRowThread(workspaceId: string, tableId: string, rowId: string) {
  const api = rowThreadApi(workspaceId, tableId, rowId);
  const read = useFeatureRead({
    key: ['tables', 'row-thread', workspaceId, tableId, rowId] as const,
    load: api.read,
    pollWhile: data => data.assignment?.runState === 'queued' || data.assignment?.runState === 'working',
    interval: 3000,
    maxChecks: 200,
  });
  return { api, read };
}

type ThreadItem = RowThread['items'][number];

/** Folds an agent's identical progress notes in a row into one, counting the repeats. */
export function foldRepeats(items: ThreadItem[]) {
  const folded: { item: ThreadItem; repeats: number }[] = [];
  for (const item of items) {
    const last = folded.at(-1);
    if (
      last &&
      item.kind === 'progress' &&
      last.item.kind === 'progress' &&
      item.body === last.item.body &&
      item.author?.id === last.item.author?.id
    )
      folded[folded.length - 1] = { item, repeats: last.repeats + 1 };
    else folded.push({ item, repeats: 1 });
  }
  return folded;
}

/** A row's conversation with people and its assigned agent: Run state, progress notes, events and comments. */
export function RowThreadPanel({
  workspaceId,
  tableId,
  rowId,
  changed,
  conversationOnly = false,
  noun = 'record',
}: {
  workspaceId: string;
  tableId: string;
  rowId: string;
  /** Called after this panel changes the thread, such as a comment or Run now. */
  changed?: () => void;
  /** Leaves out the agent's state, wake-up, Run now and run history for a page that shows them itself. */
  conversationOnly?: boolean;
  /** Human label used in thread events, such as "task" on the Tasks board. */
  noun?: string;
}) {
  const { api, read } = useRowThread(workspaceId, tableId, rowId);
  const [latest, setLatest] = useState<RowThread | null>(null);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const uploads = useRowUploads(workspaceId, tableId, commentFileLimit);
  const canSend = !busy && Boolean(draft.trim()) && uploads.ready;
  const send = () =>
    void act(() => api.comment(draft, uploads.ids())).then(saved => {
      if (!saved) return;
      setDraft('');
      uploads.clear();
    });
  const picker = useRef<HTMLInputElement>(null);
  const loaded = read.state.kind === 'ready' ? read.state.data : undefined;
  const thread = loaded ?? latest;
  const act = async (operation: () => Promise<RowThread>) => {
    setBusy(true);
    setError(null);
    try {
      setLatest(await operation());
      await read.refresh();
      changed?.();
      return true;
    } catch (failure) {
      setError(failure instanceof TableRequestError ? failure.message : 'The row thread could not be updated.');
      return false;
    } finally {
      setBusy(false);
    }
  };
  const assignment = conversationOnly ? null : thread?.assignment;
  return (
    <section
      aria-label="Row thread"
      className="space-y-4 border-t pt-4"
      data-compact-text={conversationOnly || undefined}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Thread</h3>
        {assignment && (
          <div className="flex flex-wrap items-center gap-2">
            <ActorName workspaceId={workspaceId} actor={{ type: 'agent', id: assignment.agentId }} compact />
            <Badge variant={runStateLabels[assignment.runState][1]}>{runStateLabels[assignment.runState][0]}</Badge>
            {assignment.canRunNow && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy || assignment.runState === 'working'}
                onClick={() => void act(api.runNow)}
              >
                Run now
              </Button>
            )}
          </div>
        )}
      </div>
      {assignment?.reason === 'Waiting for approval' ? (
        <p className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
          Waiting for approval from
          <ActorName workspaceId={workspaceId} actor={{ type: 'member', id: assignment.sponsorMembershipId }} compact />
        </p>
      ) : (
        assignment?.reason && <p className="text-sm text-muted-foreground">{assignment.reason}</p>
      )}
      {assignment?.wakeAt && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span>Wakes {time(assignment.wakeAt)}</span>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(api.clearWake)}>
            Clear wake-up
          </Button>
        </div>
      )}
      {!thread && read.state.kind !== 'ready' && <p className="text-sm text-muted-foreground">Loading thread…</p>}
      {thread && thread.items.length === 0 && <p className="text-sm text-muted-foreground">No comments yet.</p>}
      <ol className="space-y-3">
        {foldRepeats(thread?.items ?? []).map(({ item, repeats }) => (
          <li
            key={item.id}
            className={item.kind === 'event' ? 'text-sm text-muted-foreground' : 'rounded-md border p-3'}
          >
            <div className="mb-1 flex flex-wrap items-center gap-2 text-sm">
              {item.author ? <ActorName workspaceId={workspaceId} actor={item.author} compact /> : <span>System</span>}
              {item.kind === 'event' && <span>{eventText(item.event, noun)}</span>}
              {item.kind === 'progress' && <Badge variant="secondary">Progress note</Badge>}
              <span className="text-muted-foreground">{time(item.createdAt)}</span>
              {repeats > 1 && <span className="text-muted-foreground">{repeats} times</span>}
              {item.editedAt && !item.deleted && <span className="text-muted-foreground">edited</span>}
            </div>
            {item.deleted ? (
              <p className="text-sm text-muted-foreground italic">Comment deleted</p>
            ) : editing?.id === item.id ? (
              <div className="space-y-2">
                <Textarea
                  aria-label="Edit comment"
                  value={editing.body}
                  maxLength={20000}
                  onChange={event => setEditing({ id: item.id, body: event.target.value })}
                />
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    disabled={busy || !editing.body.trim()}
                    onClick={() =>
                      void act(() =>
                        api.edit(
                          item.id,
                          editing.body,
                          item.attachments.map(file => file.id),
                        ),
                      ).then(saved => saved && setEditing(null))
                    }
                  >
                    Save comment
                  </Button>
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => setEditing(null)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              item.body && <MessageResponse>{item.body}</MessageResponse>
            )}
            {!item.deleted && (
              <RowFiles workspaceId={workspaceId} tableId={tableId} rowId={rowId} saved={item.attachments} />
            )}
            {item.mine && item.kind === 'comment' && !item.deleted && editing?.id !== item.id && (
              <div className="mt-2 flex gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setEditing({ id: item.id, body: item.body ?? '' })}
                >
                  Edit
                </Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(() => api.remove(item.id))}>
                  Delete
                </Button>
              </div>
            )}
          </li>
        ))}
      </ol>
      <div
        className="space-y-2 rounded-lg border bg-card p-3 focus-within:border-ring"
        onDragOver={event => event.preventDefault()}
        onDrop={event => {
          if (!event.dataTransfer.files.length) return;
          event.preventDefault();
          void uploads.add([...event.dataTransfer.files]);
        }}
      >
        <BareText
          aria-label="Comment"
          placeholder={thread?.assignment ? 'Leave a comment, or give the agent more direction…' : 'Leave a comment…'}
          value={draft}
          maxLength={20000}
          disabled={busy}
          onChange={event => setDraft(event.target.value)}
          onPaste={event => {
            const files = pastedFiles(event);
            if (files.length) void uploads.add(files);
          }}
          onKeyDown={event => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && canSend) send();
          }}
        />
        <RowFiles workspaceId={workspaceId} tableId={tableId} rowId={null} saved={[]} uploads={uploads} />
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex items-center justify-end gap-1">
          <Input
            ref={picker}
            type="file"
            multiple
            hidden
            onChange={event => {
              void uploads.add([...(event.target.files ?? [])]);
              event.target.value = '';
            }}
          />
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Attach files"
            title="Attach files"
            disabled={busy}
            onClick={() => picker.current?.click()}
          >
            <PaperclipIcon aria-hidden />
          </Button>
          <Button size="icon-sm" aria-label="Comment" title="Comment · ⌘Enter" disabled={!canSend} onClick={send}>
            <ArrowUpIcon aria-hidden />
          </Button>
        </div>
      </div>
      {!conversationOnly && thread && thread.runs.length > 0 && (
        <Collapsible>
          <CollapsibleTrigger render={<Button variant="link" size="sm" />}>
            Run history ({thread.runs.length})
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul className="mt-2 space-y-1 text-sm">
              {thread.runs.map(run => (
                <li key={run.taskId} className="text-muted-foreground">
                  {time(run.startedAt)}: {run.endedAt ? (run.outcome ?? 'ended') : 'working'}
                </li>
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      )}
    </section>
  );
}
