import { z } from 'zod';
import {
  activityStatusSchema,
  toolPresentationSchema,
  workflowReferenceSchema,
} from '@tulipfarm/conversations/tool-activity';
import { publicWebReceiptSchema } from '@tulipfarm/conversations/public-web';
import { knowledgeActivitySchema } from '@tulipfarm/conversations/knowledge-activity';
import { rowChangeSchema, rowViewSchema } from '@tulipfarm/conversations/row-view';
import { calendarHistoryResultSchema } from '@tulipfarm/google-workspace/calendar-events';
import { draftViewSchema, draftOutcomeSchema, type draftDecisionSchema } from '@tulipfarm/agents/draft-contracts';
import { chatDocumentSchema } from '@tulipfarm/conversations/rich-content';
import {
  compactCommandPartSchema,
  compactionDetailSchema,
  compactionPartSchema,
} from '@tulipfarm/conversations/compaction-contracts';
import { maintenanceViewSchema } from '@tulipfarm/conversations/maintenance-contracts';
import { subagentResultSchema } from '@tulipfarm/conversations/events';
import { apiOrigin } from '@/lib/auth';
import { jsonResponse, readJson, responseError } from '@/lib/http';
import { TableRequestError } from '@/features/tables/request-state';
import {
  approvalSchema,
  informationSchema,
  approvalOutcomeSchema,
  requestOutcomeSchema,
  type Interaction,
  type InteractionCommand,
  type InteractionReference,
} from './interaction-contracts';
import { createPageReuse, readPageWindow, type PageReuse } from './page-reuse';

const chatSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  titleRevision: z.number().int(),
  titleManual: z.boolean().default(false),
  archived: z.boolean(),
  isClosed: z.boolean().default(false),
  activityAt: z.string(),
  createdAt: z.string(),
  projectId: z.uuid().nullable().default(null),
});
const turnSchema = z.object({
  id: z.uuid(),
  status: z.enum(['queued', 'processing', 'waiting', 'reconciling', 'failed', 'completed', 'cancelled', 'blocked']),
  generation: z.number().int().nonnegative(),
  epoch: z.number().int().nonnegative().optional(),
  errorCode: z.string().nullable().optional(),
  mode: z.literal('plan').optional(),
});
const attachmentSchema = z.object({
  id: z.uuid(),
  filename: z.string(),
  mediaType: z.string(),
  size: z.number().int(),
  sha256: z.string(),
  state: z.enum(['reserved', 'ready', 'bound', 'abandoned']),
  expiresAt: z.string(),
});
const skillReference = { skillId: z.string().min(1), revision: z.string().min(1), name: z.string().min(1) };
const partSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string(), content: chatDocumentSchema.optional() }),
  z.object({ kind: z.literal('attachment'), attachmentId: z.uuid() }),
  z.object({ kind: z.literal('file'), fileId: z.uuid() }),
  z.object({ kind: z.literal('google-file'), fileId: z.string(), name: z.string(), mimeType: z.string() }),
  z.object({ kind: z.literal('request'), requestId: z.uuid() }),
  z.object({ kind: z.literal('response'), responseId: z.uuid() }),
  z.object({ kind: z.literal('approval'), approvalId: z.uuid() }),
  z.object({ kind: z.literal('approval-resolution'), approvalId: z.uuid() }),
  z.object({ kind: z.literal('skill'), ...skillReference }),
  z.object({ kind: z.literal('skill-use'), ...skillReference }),
  compactCommandPartSchema,
  compactionPartSchema,
]);
const messageSchema = z.object({
  id: z.uuid(),
  sequence: z.number().int().positive(),
  author: z.enum(['human', 'assistant']),
  createdAt: z.string(),
  parts: z.array(partSchema),
  turn: turnSchema.nullable(),
  tools: z
    .array(
      z.object({
        id: z.uuid(),
        tool: z.string(),
        status: z.enum(['running', 'completed', 'blocked', 'failed']),
        activityStatus: activityStatusSchema.optional(),
        activity: z.string().nullable().optional(),
        presentation: toolPresentationSchema.optional(),
        web: publicWebReceiptSchema.nullable().optional(),
        knowledge: knowledgeActivitySchema.nullable().optional(),
        fileId: z.uuid().optional(),
        fileIds: z.array(z.uuid()).max(64).optional(),
        importId: z.uuid().optional(),
        googleProposalId: z.uuid().optional(),
        rowDraftId: z.uuid().optional(),
        rowView: rowViewSchema.optional(),
        rowChange: rowChangeSchema.optional(),
        workflows: z.array(workflowReferenceSchema).optional(),
        subagents: subagentResultSchema.optional(),
      }),
    )
    .default([]),
  calendarResults: z.array(calendarHistoryResultSchema).default([]),
});
const historySchema = z.object({
  messages: z.array(messageSchema),
  nextBefore: z.number().int().positive().nullable(),
  hasGitHubProposals: z.boolean().optional(),
});
const listSchema = z.object({ chats: z.array(chatSchema), nextCursor: z.string().nullable() });
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const listPagesSchema = z.object({
  pages: z
    .array(z.object({ digest: digestSchema, value: listSchema.optional() }))
    .min(1)
    .max(5),
});
const historyPagesSchema = z.object({
  chat: chatSchema.optional(),
  pages: z
    .array(z.object({ digest: digestSchema, value: historySchema.optional() }))
    .min(1)
    .max(5),
});
export type ChatListPage = z.infer<typeof listSchema>;
export type ChatHistoryPage = z.infer<typeof historySchema>;
const destinationSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  activityAt: z.string(),
  projectId: z.uuid().nullable(),
  projectName: z.string().nullable(),
});
const fileAudienceSchema = z.discriminatedUnion('status', [
  z.object({ fileId: z.uuid(), status: z.literal('ready') }),
  z.object({ fileId: z.uuid(), status: z.literal('unavailable') }),
  z.object({
    fileId: z.uuid(),
    status: z.literal('audience'),
    missing: z.array(z.object({ membershipId: z.uuid(), name: z.string() })).nullable(),
  }),
]);
export type ChatDestination = z.infer<typeof destinationSchema>;
export type FileAudience = z.infer<typeof fileAudienceSchema>;
export type Chat = z.infer<typeof chatSchema>;
export type ConversationMessage = z.infer<typeof messageSchema>;
export type SkillReference = Omit<Extract<z.infer<typeof partSchema>, { kind: 'skill' }>, 'kind'>;
export type ConversationPart =
  | Extract<z.infer<typeof partSchema>, { kind: 'text' | 'attachment' | 'file' }>
  | {
      kind: 'google-file';
      fileId: string;
      name: string;
      mimeType: string;
      expectedIntegration: { integrationId: string; accountId: string; generation: number };
    }
  | { kind: 'skill'; skillId: string; revision: string }
  | { kind: 'compact'; prompt?: string; compactionId?: string };
export type CompactionDetail = z.infer<typeof compactionDetailSchema>;
export type CompactionPart = z.infer<typeof compactionPartSchema>;
export type MaintenanceView = z.infer<typeof maintenanceViewSchema>;
export type ConversationCommand =
  | ({ kind: 'draft-decision'; chatId: string; draftId: string } & z.infer<typeof draftDecisionSchema>)
  | InteractionCommand
  | { kind: 'create'; chatId: string; commandId: string; projectId?: string | null }
  | { kind: 'move'; chatId: string; commandId: string; projectId: string }
  | {
      kind: 'send';
      chatId: string;
      commandId: string;
      messageId: string;
      model: string;
      parts: ConversationPart[];
      timeZone?: string;
      mode?: 'normal' | 'plan';
    }
  | { kind: 'rename'; chatId: string; commandId: string; title: string; expectedRevision: number }
  | { kind: 'archive'; chatId: string; commandId: string; archived: boolean }
  | { kind: 'delete'; chatId: string; commandId: string }
  | { kind: 'resume-maintenance'; chatId: string; commandId: string }
  | { kind: 'retry' | 'cancel'; chatId: string; commandId: string; turnId: string; expectedGeneration: number };

function unsupportedText(text: string) {
  return text.includes('\0') || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text);
}

export function textError(text: string) {
  if (!text.trim()) return null;
  if (unsupportedText(text)) return 'Remove unsupported characters before sending.';
  return new TextEncoder().encode(text).length > 65536 ? 'Keep this message under 64 KiB of text.' : null;
}

export function titleError(title: string) {
  const trimmed = title.trim();
  if (!trimmed || unsupportedText(trimmed)) return 'Enter a valid chat title.';
  return trimmed.length > 640 ||
    [...new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(trimmed)].length > 50
    ? 'Use at most 50 characters in the title.'
    : null;
}

export function conversationApi(workspaceId: string, denied: (status: number) => void) {
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
          'JavaScript and Python steps cannot run here yet because no isolated code runner is configured. Ask chat for a draft without code steps.',
        );
      if (code === 'limit-reached')
        throw new TableRequestError(
          response.status,
          code,
          'The workflow limit is reached. Delete or reuse a workflow on the Workflows page, then ask chat for a fresh draft.',
        );
      if (code.startsWith('model-'))
        throw new TableRequestError(
          response.status,
          code,
          'The selected model is unavailable. Choose an available model and review your retained draft.',
        );
      const message =
        response.status === 409
          ? 'This request or proposal changed. Check its current status before deciding again.'
          : response.status === 429
            ? 'Too many requests. Wait a moment, then retry the same operation.'
            : response.status === 400 || response.status === 413
              ? 'The server rejected this input. Review its length and characters.'
              : 'Could not reach your personal chats. Check your connection and try again.';
      throw new TableRequestError(response.status, code, message);
    }
    return readJson(response);
  }
  async function fileResponse(chatId: string, path: string, method: string, signal: AbortSignal, body?: File | string) {
    const response = await fetch(`${base}/${chatId}${path}`, {
      method,
      credentials: 'include',
      cache: 'no-store',
      signal,
      ...(body === undefined
        ? {}
        : {
            headers: { 'Content-Type': typeof body === 'string' ? 'application/json' : 'application/octet-stream' },
            body,
          }),
    });
    signal.throwIfAborted();
    if ([401, 403].includes(response.status)) denied(response.status);
    if (response.status === 404) await request(`/${chatId}`, 'GET', signal);
    if (!response.ok) {
      const error = z.object({ error: z.string() }).safeParse(await response.json().catch(() => null));
      const code = error.success ? error.data.error : 'attachment-request-failed';
      throw new TableRequestError(
        response.status,
        code,
        code === 'attachment-quota'
          ? 'Workspace attachment capacity is full. Keep this draft and retry this file after capacity becomes available. Removing and selecting the file again will not free workspace capacity.'
          : response.status === 409
            ? 'This file expired or changed. Remove it and select it again.'
            : response.status === 413
              ? 'The file is too large. Choose a file no larger than 10 MiB.'
              : 'The file is unavailable. Retry, or remove it from your draft.',
      );
    }
    return response;
  }
  return {
    eventsUrl: (chatId: string) => `${base}/${chatId}/events`,
    async prepareChat(signal: AbortSignal, _create?: (requestId: string) => Promise<unknown>) {
      signal.throwIfAborted();
    },
    async draft(chatId: string, id: string, signal: AbortSignal) {
      return draftViewSchema.parse(await request(`/${chatId}/drafts/${id}`, 'GET', signal, undefined, true));
    },
    async upload(chatId: string, id: string, file: File, signal: AbortSignal) {
      const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
      signal.throwIfAborted();
      const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
      const metadata = {
        filename: file.name,
        mediaType: file.type || 'application/octet-stream',
        size: file.size,
        sha256,
      };
      const reserved = attachmentSchema.parse(
        await (await fileResponse(chatId, `/uploads/${id}`, 'PUT', signal, JSON.stringify(metadata))).json(),
      );
      if (reserved.state === 'ready' && Date.parse(reserved.expiresAt) > Date.now()) return reserved;
      if (reserved.state !== 'reserved')
        throw new Error('This file is no longer available for sending. Remove it and select it again.');
      const uploaded = attachmentSchema.parse(
        await (await fileResponse(chatId, `/uploads/${id}/content`, 'PUT', signal, file)).json(),
      );
      if (uploaded.state !== 'ready') throw new Error('This file is no longer available for sending.');
      return uploaded;
    },
    async attachment(chatId: string, id: string, signal: AbortSignal) {
      return attachmentSchema.parse(await (await fileResponse(chatId, `/uploads/${id}`, 'GET', signal)).json());
    },
    async download(chatId: string, id: string, signal: AbortSignal) {
      return (await fileResponse(chatId, `/attachments/${id}/content`, 'GET', signal)).blob();
    },
    async compaction(chatId: string, compactionId: string, signal: AbortSignal): Promise<CompactionDetail> {
      return compactionDetailSchema.parse(
        await request(`/${chatId}/compactions/${compactionId}`, 'GET', signal, undefined, true),
      );
    },
    /** Asks a running reply to stop one sub-agent. Its card turns to stopped with partial output. */
    async stopSubagent(chatId: string, turnId: string, id: string, key: string, signal: AbortSignal) {
      return z
        .object({ requested: z.boolean() })
        .parse(await request(`/${chatId}/turns/${turnId}/subagents/stop`, 'POST', signal, { id, key }, true));
    },
    async maintenance(chatId: string, signal: AbortSignal): Promise<MaintenanceView> {
      return maintenanceViewSchema.parse(await request(`/${chatId}/maintenance`, 'GET', signal, undefined, true));
    },
    async interaction(chatId: string, reference: InteractionReference, signal: AbortSignal): Promise<Interaction> {
      if (reference.kind === 'request')
        return {
          kind: 'information',
          request: informationSchema.parse(
            await request(`/${chatId}/requests/${reference.requestId}`, 'GET', signal, undefined, true),
          ),
        };
      return {
        kind: 'approval',
        request: approvalSchema.parse(
          await request(`/${chatId}/approvals/${reference.approvalId}`, 'GET', signal, undefined, true),
        ),
      };
    },
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
    /** Unarchived chats the requester can post in, most recent first. */
    async destinations(query: string, signal: AbortSignal) {
      return z
        .object({ chats: z.array(destinationSchema) })
        .parse(await request(`/destinations?${new URLSearchParams({ query })}`, 'GET', signal, undefined, true)).chats;
    },
    /** Whether everyone who reads the chat can open each file. Names come back only for files the requester manages. */
    async fileAudience(chatId: string, fileIds: readonly string[], signal: AbortSignal) {
      return z
        .object({ projectId: z.uuid().nullable(), files: z.array(fileAudienceSchema) })
        .parse(await request(`/${chatId}/file-audience`, 'POST', signal, { fileIds }, true));
    },
    async history(
      chatId: string,
      signal: AbortSignal,
      pages: number,
      reuse: PageReuse<ChatHistoryPage> = createPageReuse(),
    ) {
      const messages = new Map<string, ConversationMessage>();
      let nextBefore: number | null = null;
      let hasGitHubProposals = false;
      if (pages === 1) {
        const generation = ++reuse.generation;
        reuse.pages = [];
        const [result, chat] = await Promise.all([
          request(`/${chatId}/messages`, 'GET', signal).then(value =>
            historySchema.extend({ digest: digestSchema.optional() }).parse(value),
          ),
          request(`/${chatId}`, 'GET', signal).then(value => chatSchema.parse(value)),
        ]);
        signal.throwIfAborted();
        if (reuse.generation === generation && result.digest)
          reuse.pages = [{ digest: result.digest, value: historySchema.parse(result) }];
        return {
          chat,
          messages: result.messages,
          nextBefore: result.nextBefore,
          hasGitHubProposals: result.hasGitHubProposals ?? true,
        };
      }
      let chat: Chat | undefined;
      const results = await readPageWindow<ChatHistoryPage, number>(
        pages,
        signal,
        reuse,
        async (before, count, known) => {
          const result = historyPagesSchema.parse(
            await request(`/${chatId}/messages/pages`, 'POST', signal, { before, count, known }),
          );
          if (before === null && !result.chat) throw new Error('Missing chat metadata');
          if (result.chat) chat = result.chat;
          return result.pages;
        },
        page => page.nextBefore,
      );
      for (const result of results) {
        hasGitHubProposals ||= result.hasGitHubProposals ?? true;
        for (const message of result.messages) messages.set(message.id, message);
        nextBefore = result.nextBefore;
      }
      if (!chat) throw new Error('Missing chat metadata');
      return {
        chat,
        messages: [...messages.values()].sort((a, b) => a.sequence - b.sequence),
        nextBefore,
        hasGitHubProposals,
      };
    },
    async command(command: ConversationCommand, signal: AbortSignal) {
      const path = `/${command.chatId}`;
      const commandId = command.commandId;
      switch (command.kind) {
        case 'draft-decision':
          return draftOutcomeSchema.parse(
            await request(
              `${path}/drafts/${command.draftId}/decision`,
              'PUT',
              signal,
              {
                commandId,
                digest: command.digest,
                decision: command.decision,
                ...(command.consent ? { consent: command.consent } : {}),
              },
              true,
            ),
          );
        case 'answer':
          return requestOutcomeSchema.parse(
            await request(
              `${path}/requests/${command.requestId}/responses/${command.responseId}`,
              'PUT',
              signal,
              { commandId, expectedRevision: command.expectedRevision, answer: command.answer },
              true,
            ),
          );
        case 'cancel-request':
          return requestOutcomeSchema.parse(
            await request(
              `${path}/requests/${command.requestId}/cancel`,
              'POST',
              signal,
              { commandId, expectedRevision: command.expectedRevision },
              true,
            ),
          );
        case 'decide':
          return approvalOutcomeSchema.parse(
            await request(
              `${path}/approvals/${command.requestId}/decision`,
              'PUT',
              signal,
              { commandId, expectedRevision: command.expectedRevision, decision: command.decision },
              true,
            ),
          );
        case 'create':
          return z.object({ id: z.uuid() }).parse(
            await request(path, 'PUT', signal, {
              commandId,
              ...(command.projectId ? { projectId: command.projectId } : {}),
            }),
          );
        case 'move':
          return z.object({ projectId: z.uuid() }).parse(
            await request(`${path}/move`, 'POST', signal, {
              commandId,
              projectId: command.projectId,
              confirmFullHistoryIncludingAdmins: true,
            }),
          );
        case 'send':
          return z.object({ messageId: z.uuid(), turnId: z.uuid(), sequence: z.number().int() }).parse(
            await request(`${path}/messages/${command.messageId}`, 'PUT', signal, {
              commandId,
              model: command.model,
              parts: command.parts,
              timeZone: command.timeZone,
              mode: command.mode,
            }),
          );
        case 'rename':
          return z.object({ titleRevision: z.number().int() }).parse(
            await request(path, 'PATCH', signal, {
              commandId,
              title: command.title,
              expectedRevision: command.expectedRevision,
            }),
          );
        case 'archive':
          return z
            .object({ archived: z.boolean() })
            .parse(await request(path, 'PATCH', signal, { commandId, archived: command.archived }));
        case 'delete':
          return z.object({ deleted: z.literal(true) }).parse(await request(path, 'DELETE', signal, { commandId }));
        case 'resume-maintenance':
          return maintenanceViewSchema.parse(await request(`${path}/maintenance`, 'PUT', signal, { commandId }, true));
        case 'retry':
        case 'cancel':
          return z
            .object({ turnId: z.uuid(), status: z.enum(['queued', 'cancelled']), generation: z.number().int() })
            .parse(
              await request(`${path}/turns/${command.turnId}/${command.kind}`, 'POST', signal, {
                commandId,
                expectedGeneration: command.expectedGeneration,
              }),
            );
      }
    },
  };
}
export type ConversationApi = ReturnType<typeof conversationApi>;
export function draftConversationApi(
  api: ConversationApi,
  chatId: string,
  onCreated: () => void = () => {},
  projectId: string | null = null,
): ConversationApi {
  const commandId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  let created = false;
  let creating: Promise<void> | null = null;
  async function ensureCreated(signal: AbortSignal, create?: (requestId: string) => Promise<unknown>) {
    if (created) return;
    creating ??= (create ? create(commandId) : api.command({ kind: 'create', chatId, commandId, projectId }, signal))
      .then(() => {
        created = true;
        onCreated();
      })
      .finally(() => {
        creating = null;
      });
    await creating;
    signal.throwIfAborted();
  }
  return {
    ...api,
    prepareChat: ensureCreated,
    async history(id, signal, pages, reuse) {
      if (created) return api.history(id, signal, pages, reuse);
      return {
        chat: {
          id: chatId,
          title: 'New chat',
          titleRevision: 0,
          titleManual: false,
          archived: false,
          isClosed: false,
          activityAt: createdAt,
          createdAt,
          projectId,
        },
        messages: [],
        nextBefore: null,
        hasGitHubProposals: false,
      };
    },
    async command(command, signal) {
      await ensureCreated(signal);
      return api.command(command, signal);
    },
    async upload(id, attachmentId, file, signal) {
      await ensureCreated(signal);
      return api.upload(id, attachmentId, file, signal);
    },
  };
}
export type ConversationHistory = Awaited<ReturnType<ConversationApi['history']>>;
export function hasPendingReplies(history: ConversationHistory) {
  return history.messages.some(
    message => message.turn && ['queued', 'processing', 'reconciling'].includes(message.turn.status),
  );
}
