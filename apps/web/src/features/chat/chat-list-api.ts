import { z } from 'zod';
import { apiOrigin } from '@/lib/auth';
import { jsonResponse, readJson, responseError } from '@/lib/http';
import { TableRequestError } from '@/features/tables/request-state';
import { createPageReuse, readPageWindow, type PageReuse } from './page-reuse';

/**
 * The chat list and pinned reads, kept apart from the full conversation API so the workspace sidebar
 * can list recent chats without loading every message and activity contract.
 */
export const chatSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  titleRevision: z.number().int(),
  titleManual: z.boolean().default(false),
  archived: z.boolean(),
  pinned: z.boolean().default(false),
  isClosed: z.boolean().default(false),
  activityAt: z.string(),
  createdAt: z.string(),
  projectId: z.uuid().nullable().default(null),
  model: z.string().nullable().optional(),
});
export const listSchema = z.object({ chats: z.array(chatSchema), nextCursor: z.string().nullable() });
export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const listPagesSchema = z.object({
  pages: z
    .array(z.object({ digest: digestSchema, value: listSchema.optional() }))
    .min(1)
    .max(5),
});
export type Chat = z.infer<typeof chatSchema>;
export type ChatListPage = z.infer<typeof listSchema>;

export type ConversationRequest = (
  path: string,
  method: string,
  signal: AbortSignal,
  body?: unknown,
  interaction?: boolean,
) => Promise<unknown>;

export function conversationRequest(workspaceId: string, denied: (status: number) => void): ConversationRequest {
  const base = `${apiOrigin}/v1/workspaces/${encodeURIComponent(workspaceId)}/conversations`;
  async function request(path: string, method: string, signal: AbortSignal, body?: unknown, interaction = false) {
    const response = await jsonResponse(`${base}${path}`, { method, cache: 'no-store', signal, body });
    if (signal.aborted) throw signal.reason;
    if (response.status === 401 || (!interaction && [403, 404].includes(response.status))) denied(response.status);
    if (!response.ok) {
      const code = responseError(await readJson(response, true), 'conversation-request-failed');
      if (code === 'credits-exhausted')
        throw new TableRequestError(
          response.status,
          code,
          'Your workspace has no available credits. Ask a workspace admin to check credits. Your draft is retained.',
        );
      if (code === 'project-archived')
        throw new TableRequestError(
          response.status,
          code,
          'This project is archived, so its chats are read-only. Ask a project manager to restore it. Your draft is kept.',
        );
      if (code === 'file-unavailable')
        throw new TableRequestError(
          response.status,
          code,
          'You can no longer open a file in this message. Remove it, then send again. Your draft is kept.',
        );
      if (code === 'file-audience')
        throw new TableRequestError(
          response.status,
          code,
          'Someone who can read this project chat can’t open a file in this message. Remove the file, or use it in a personal chat. Your draft is kept.',
        );
      if (code === 'google-file-audience')
        throw new TableRequestError(
          response.status,
          code,
          'Google Drive files can be used only in personal chats, because Google controls who can open them. Move them to a personal chat or remove them. Your draft is kept.',
        );
      if (code === 'google-integration-changed')
        throw new TableRequestError(
          response.status,
          code,
          'Your Google integration changed after you added a Google Drive file. Remove the file and add it again from your current Google account. Your draft is kept.',
        );
      if (code === 'skill-unavailable')
        throw new TableRequestError(
          response.status,
          code,
          'This skill is no longer available. Remove it or choose another skill, then send again. Your draft is kept.',
        );
      if (code === 'compaction-not-found')
        throw new TableRequestError(
          response.status,
          code,
          'This compaction is no longer in this chat. Refresh the chat, then try again.',
        );
      if (code === 'maintenance-not-resumable')
        throw new TableRequestError(
          response.status,
          code,
          'This chat is active or its Knowledge update has already changed. Check its current status before resuming.',
        );
      if (code === 'move-conflict')
        throw new TableRequestError(
          response.status,
          code,
          'This chat was already moved to another project. Refresh the chat to see where it is now.',
        );
      if (code === 'code-steps-unavailable')
        throw new TableRequestError(
          response.status,
          code,
          'Code steps cannot run here yet because no execution backend is configured. Ask chat for a draft without code steps.',
        );
      if (code === 'coding-steps-unavailable')
        throw new TableRequestError(
          response.status,
          code,
          'Coding steps cannot run here yet because no execution backend is configured. Ask chat for a draft without coding steps.',
        );
      if (code === 'memory-unavailable')
        throw new TableRequestError(
          response.status,
          code,
          'This chat is now in a project, where your memory isn’t used, so nothing changed. You can edit your memory in Settings.',
        );
      if (code === 'knowledge-quota')
        throw new TableRequestError(
          response.status,
          code,
          'This is too large for Knowledge, so nothing was added. Ask chat for a shorter note or a smaller file.',
        );
      if (code === 'knowledge-file-unavailable')
        throw new TableRequestError(
          response.status,
          code,
          'Files can’t be read right now, so nothing changed in Knowledge. Try again later.',
        );
      if (code === 'file-restore-destination')
        throw new TableRequestError(
          response.status,
          code,
          'An original folder is gone or you can no longer add to it, so nothing was restored. Ask chat to move the items to another folder instead.',
        );
      if (code === 'limit-reached')
        throw new TableRequestError(
          response.status,
          code,
          'The workflow limit is reached. Delete or reuse a workflow on the Workflows page, then ask chat for a fresh draft.',
        );
      if (code === 'workspace-updating')
        throw new TableRequestError(
          response.status,
          code,
          "TulipFarm is updating your workspace, so your change wasn't saved. Try again in a few minutes. Your draft is kept.",
        );
      if (code.startsWith('model-'))
        throw new TableRequestError(
          response.status,
          code,
          'The selected model is unavailable. Choose an available model and review your retained draft.',
        );
      const message =
        response.status === 409
          ? interaction && /\/(requests|approvals|drafts)\//.test(path)
            ? 'This request or proposal changed. Check its current status before deciding again.'
            : 'This chat changed. Refresh it before trying again. Your draft is kept.'
          : response.status === 429
            ? 'Too many requests. Wait a moment, then retry the same operation.'
            : response.status === 400 || response.status === 413
              ? 'The server rejected this input. Review its length and characters.'
              : 'Could not reach your personal chats. Check your connection and try again.';
      throw new TableRequestError(response.status, code, message);
    }
    return readJson(response);
  }
  return request;
}

export function chatListReads(request: ConversationRequest) {
  return {
    async list(
      signal: AbortSignal,
      archived: boolean,
      query: string,
      pages: number,
      projectId: string | null = null,
      reuse: PageReuse<ChatListPage> = createPageReuse(),
    ) {
      const chats = new Map<string, Chat>();
      let nextCursor: string | null = null;
      if (pages === 1) {
        const generation = ++reuse.generation;
        reuse.pages = [];
        const params = new URLSearchParams({ archived: String(archived), query, ...(projectId ? { projectId } : {}) });
        const result = listSchema
          .extend({ digest: digestSchema.optional() })
          .parse(await request(`?${params}`, 'GET', signal, undefined, !!projectId));
        signal.throwIfAborted();
        if (reuse.generation === generation && result.digest)
          reuse.pages = [{ digest: result.digest, value: listSchema.parse(result) }];
        return { chats: result.chats, nextCursor: result.nextCursor };
      }
      const results = await readPageWindow<ChatListPage, string>(
        pages,
        signal,
        reuse,
        async (cursor, count, known) =>
          listPagesSchema.parse(
            await request(
              '/pages',
              'POST',
              signal,
              { archived, query, ...(projectId ? { projectId } : {}), cursor, count, known },
              !!projectId,
            ),
          ).pages,
        page => page.nextCursor,
      );
      for (const result of results) {
        for (const chat of result.chats) chats.set(chat.id, chat);
        nextCursor = result.nextCursor;
      }
      return { chats: [...chats.values()], nextCursor };
    },
    /** The requester's pinned chats, personal and project, most recently pinned first. */
    async pinned(signal: AbortSignal) {
      return z.object({ chats: z.array(chatSchema) }).parse(await request('/pinned', 'GET', signal, undefined, true))
        .chats;
    },
  };
}
