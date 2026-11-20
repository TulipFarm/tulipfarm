import { useState } from 'react';
import { z } from 'zod';
import { Badge, type BadgeVariant } from '@tulipfarm/sprout/badge';
import { Button } from '@tulipfarm/sprout/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@tulipfarm/sprout/collapsible';
import { MessageResponse } from '@tulipfarm/sprout/message-response';
import { Textarea } from '@tulipfarm/sprout/textarea';
import { apiOrigin } from '@/lib/auth';
import { jsonResponse, readJson, responseError } from '@/lib/http';
import { useFeatureRead } from '@/lib/query';
import { ActorName } from './actors';
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
    comment: (body: string) => send('/thread/comments', 'POST', { body, mentions: [] }),
    edit: (itemId: string, body: string) =>
      send(`/thread/comments/${encodeURIComponent(itemId)}`, 'PATCH', { body, mentions: [] }),
    remove: (itemId: string) => send(`/thread/comments/${encodeURIComponent(itemId)}`, 'DELETE'),
    runNow: () => send('/run-now', 'POST'),
    clearWake: () => send('/wake', 'DELETE'),
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

function eventText(event: Record<string, unknown> | null) {
  switch (event?.type) {
    case 'assigned':
      return 'assigned this row';
    case 'reassigned':
      return 'reassigned this row';
    case 'unassigned':
      return 'unassigned this row';
    case 'run-stopped':
      return 'run stopped';
    case 'approval-requested':
      return 'asked for approval';
    default:
      return typeof event?.type === 'string' ? event.type.replaceAll('-', ' ') : 'updated this row';
  }
}

/** A row's conversation with people and its assigned agent: Run state, progress notes, events and comments. */
export function RowThreadPanel({
  workspaceId,
  tableId,
  rowId,
}: {
  workspaceId: string;
  tableId: string;
  rowId: string;
}) {
  const api = rowThreadApi(workspaceId, tableId, rowId);
  const read = useFeatureRead({
    key: ['tables', 'row-thread', workspaceId, tableId, rowId] as const,
    load: api.read,
    pollWhile: data => data.assignment?.runState === 'queued' || data.assignment?.runState === 'working',
    interval: 3000,
    maxChecks: 200,
  });
  const [latest, setLatest] = useState<RowThread | null>(null);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loaded = read.state.kind === 'ready' ? read.state.data : undefined;
  const thread = loaded ?? latest;
  const act = async (operation: () => Promise<RowThread>) => {
    setBusy(true);
    setError(null);
    try {
      setLatest(await operation());
      await read.refresh();
      return true;
    } catch (failure) {
      setError(failure instanceof TableRequestError ? failure.message : 'The row thread could not be updated.');
      return false;
    } finally {
      setBusy(false);
    }
  };
  const assignment = thread?.assignment;
  return (
    <section aria-label="Row thread" className="space-y-4 border-t pt-4">
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
      {assignment?.reason && <p className="text-sm text-muted-foreground">{assignment.reason}</p>}
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
        {thread?.items.map(item => (
          <li
            key={item.id}
            className={item.kind === 'event' ? 'text-sm text-muted-foreground' : 'rounded-md border p-3'}
          >
            <div className="mb-1 flex flex-wrap items-center gap-2 text-sm">
              {item.author ? <ActorName workspaceId={workspaceId} actor={item.author} compact /> : <span>System</span>}
              {item.kind === 'event' && <span>{eventText(item.event)}</span>}
              {item.kind === 'progress' && <Badge variant="secondary">Progress note</Badge>}
              <span className="text-muted-foreground">{time(item.createdAt)}</span>
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
                      void act(() => api.edit(item.id, editing.body)).then(saved => saved && setEditing(null))
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
      <div className="space-y-2">
        <Textarea
          aria-label="Comment"
          placeholder={
            assignment ? 'Comment, or give the agent more direction. Markdown works.' : 'Add a comment. Markdown works.'
          }
          value={draft}
          maxLength={20000}
          disabled={busy}
          onChange={event => setDraft(event.target.value)}
        />
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <Button
          size="sm"
          disabled={busy || !draft.trim()}
          onClick={() => void act(() => api.comment(draft)).then(saved => saved && setDraft(''))}
        >
          Comment
        </Button>
      </div>
      {thread && thread.runs.length > 0 && (
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
