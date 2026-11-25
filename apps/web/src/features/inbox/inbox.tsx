import { z } from 'zod';
import { Badge } from '@tulipfarm/sprout/badge';
import { apiOrigin } from '@/lib/auth';
import { jsonResponse, readJson, responseError } from '@/lib/http';
import { useFeatureRead } from '@/lib/query';
import { TableRequestError } from '@/features/tables/request-state';

const inboxSchema = z.object({
  items: z.array(
    z.object({
      id: z.uuid(),
      kind: z.enum(['assigned', 'waiting', 'finished', 'mention', 'reminder']),
      tableId: z.uuid(),
      tableName: z.string(),
      rowId: z.uuid(),
      taskId: z.uuid().optional(),
      reminderId: z.uuid().optional(),
      /** The task's key, such as TUL-007, for items about a task. */
      taskKey: z.string().optional(),
      summary: z.string().nullable(),
      createdAt: z.string(),
    }),
  ),
  open: z.number(),
});
export type Inbox = z.infer<typeof inboxSchema>;

const inboxUrl = (workspaceId: string) => `${apiOrigin}/v1/workspaces/${encodeURIComponent(workspaceId)}/inbox`;

async function readInbox(workspaceId: string, signal: AbortSignal) {
  const response = await jsonResponse(inboxUrl(workspaceId), { method: 'GET', signal, cache: 'no-store' });
  const value = await readJson(response, true);
  if (!response.ok)
    throw new TableRequestError(
      response.status,
      responseError(value, 'inbox-unavailable'),
      'Your Inbox could not be loaded. Try again.',
    );
  return inboxSchema.parse(value);
}

export async function markDone(workspaceId: string, itemId: string) {
  const response = await jsonResponse(`${inboxUrl(workspaceId)}/${encodeURIComponent(itemId)}/done`, {
    method: 'POST',
    signal: AbortSignal.timeout(30_000),
    cache: 'no-store',
  });
  if (!response.ok)
    throw new TableRequestError(
      response.status,
      responseError(await readJson(response, true), 'inbox-unavailable'),
      'The item could not be marked done. Try again.',
    );
}

export function useInbox(workspaceId: string) {
  return useFeatureRead({
    key: ['inbox', workspaceId] as const,
    load: signal => readInbox(workspaceId, signal),
    staleTime: 15_000,
  });
}

/** Open Inbox items, shown as a count beside the sidebar's Inbox link. */
export function InboxCount({ workspaceId }: { workspaceId: string }) {
  const read = useInbox(workspaceId);
  const open = read.state.kind === 'ready' ? read.state.data.open : 0;
  if (!open) return null;
  return (
    <Badge variant="secondary" aria-label={`${open} open`}>
      {open > 99 ? '99+' : open}
    </Badge>
  );
}
