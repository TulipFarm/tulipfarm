import { authenticateRoutes } from './authenticated-routes.ts';
import { routeValidation } from './route-validation.ts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { PassThrough } from 'node:stream';
import type { Pool } from 'pg';
import { z } from 'zod';
import { AccessDenied } from '@tulipfarm/access';
import { ConversationConflict, moveChatSchema, type createConversations } from '@tulipfarm/conversations';
import {
  archiveChatSchema,
  chatDestinationSchema,
  chatSchema,
  controlResultSchema,
  controlTurnSchema,
  cursorSchema,
  deleteChatSchema,
  fileAudienceQuerySchema,
  historySchema,
  conversationModelSchema,
  defaultConversationModel,
  renameChatSchema,
  sendMessageSchema,
} from '@tulipfarm/conversations/contracts';
import { modelRoleDefault } from '@tulipfarm/config';
import { StorageUnavailableError } from '@tulipfarm/workspace-storage/runtime';
import { authConfig, type registerAuth } from './auth.ts';
import { requestBoundaryError } from './security.ts';
import {
  AttachmentError,
  attachmentLimit,
  attachmentMetadataSchema,
  reserveAttachmentSchema,
  type createAttachments,
} from '@tulipfarm/conversations/attachments';
import type { createConversationRequests } from '@tulipfarm/conversations/requests';
import {
  answerRequestSchema,
  cancelRequestSchema,
  requestOutcomeSchema,
  requestViewSchema,
} from '@tulipfarm/conversations/request-contracts';
import {
  approvalDecisionSchema,
  approvalOutcomeSchema,
  approvalViewSchema,
} from '@tulipfarm/conversations/approval-contracts';
import type {
  createTableApprovalRequests,
  createTableApprovalResolver,
} from '@tulipfarm/tables/conversation-approvals';
import { TableError } from '@tulipfarm/tables/service-contracts';
import { compactionDetailSchema } from '@tulipfarm/conversations/compaction';
import { maintenanceViewSchema } from '@tulipfarm/conversations/maintenance-contracts';
import type { ConversationEventHub, ConversationStreamEvent } from './conversation-events.ts';
import { conversationPage, conversationPages } from './conversation-pages.ts';

const workspaceParams = z.strictObject({ workspaceId: z.uuid() });
const chatParams = workspaceParams.extend({ chatId: z.uuid() });
const messageParams = chatParams.extend({ messageId: z.uuid() });
const turnParams = chatParams.extend({ turnId: z.uuid() });
const requestParams = chatParams.extend({ requestId: z.uuid() });
const responseParams = requestParams.extend({ responseId: z.uuid() });
const uploadParams = chatParams.extend({ uploadId: z.uuid() });
const compactionParams = chatParams.extend({ compactionId: z.uuid() });
const commandBody = z.strictObject({ commandId: z.uuid() });
const createBody = commandBody.extend({ projectId: z.uuid().optional() });
const moveBody = moveChatSchema;
// A message without a model uses the server's default-chat role.
const sendBody = (model = modelRoleDefault('default-chat')?.familyId ?? defaultConversationModel) =>
  sendMessageSchema.omit({ messageId: true }).extend({ model: conversationModelSchema.default(model) });
const patchBody = z.union([renameChatSchema, archiveChatSchema]);
const listQuery = z.strictObject({
  projectId: z.uuid().optional(),
  archived: z.enum(['true', 'false']).optional(),
  query: z.string().max(640).optional(),
  cursor: z
    .string()
    .max(512)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
});
const historyQuery = z.strictObject({
  before: z
    .string()
    .regex(/^[1-9]\d{0,9}$/)
    .optional(),
});
const listResult = z.object({ chats: z.array(chatSchema), nextCursor: z.string().nullable() });
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const pageRead = z.strictObject({
  count: z.number().int().min(1).max(5),
  known: z.array(digestSchema.nullable()).max(5).default([]),
});
const listPagesBody = pageRead.extend({
  archived: z.boolean(),
  query: z.string().max(640),
  projectId: z.uuid().optional(),
  cursor: z
    .string()
    .max(512)
    .regex(/^[A-Za-z0-9_-]+$/)
    .nullable(),
});
const historyPagesBody = pageRead.extend({ before: z.number().int().positive().max(2147483647).nullable() });
const listPagesResult = z.object({
  pages: z
    .array(z.object({ digest: digestSchema, value: listResult.optional() }))
    .min(1)
    .max(5),
});
const historyPagesResult = z.object({
  chat: chatSchema.optional(),
  pages: z
    .array(z.object({ digest: digestSchema, value: historySchema.optional() }))
    .min(1)
    .max(5),
});
const destinationQuery = z.strictObject({ query: z.string().max(640).optional() });
const destinationResult = z.object({ chats: z.array(chatDestinationSchema) });
const audienceResult = z.object({
  projectId: z.uuid().nullable(),
  files: z.array(
    z.discriminatedUnion('status', [
      z.object({ fileId: z.uuid(), status: z.literal('ready') }),
      z.object({ fileId: z.uuid(), status: z.literal('unavailable') }),
      z.object({
        fileId: z.uuid(),
        status: z.literal('audience'),
        missing: z.array(z.object({ membershipId: z.uuid(), name: z.string() })).nullable(),
      }),
    ]),
  ),
});
const errorSchema = {
  type: 'object',
  properties: { error: { type: 'string' } },
  required: ['error'],
  additionalProperties: false,
};
const validation = routeValidation({
  missing: 'Missing conversation request validator',
  invalid: () => new Error('invalid-request'),
});
const { json } = validation;
function schema(
  operationId: string,
  summary: string,
  params: z.ZodType,
  response: z.ZodType,
  body?: z.ZodType,
  query?: z.ZodType,
) {
  return {
    operationId,
    summary,
    tags: ['Conversations'],
    params: json(params),
    ...(body ? { body: json(body) } : {}),
    ...(query ? { querystring: json(query) } : {}),
    response: {
      200: json(response),
      400: errorSchema,
      401: errorSchema,
      403: errorSchema,
      404: errorSchema,
      409: errorSchema,
      413: errorSchema,
      415: errorSchema,
      429: errorSchema,
      500: errorSchema,
      503: errorSchema,
      504: errorSchema,
    },
  };
}
type EventTiming = { heartbeatMs: number; recheckMs: number; lifetimeMs: number; maxBufferedBytes: number };
// Azure Container Apps ingress ends a request after 240 s, so the stream ends first and EventSource reconnects.
const eventTiming: EventTiming = {
  heartbeatMs: 15_000,
  recheckMs: 30_000,
  lifetimeMs: 180_000,
  maxBufferedBytes: 1_048_576,
};
function decodeCursor(value: string | undefined) {
  if (!value) return undefined;
  try {
    return cursorSchema.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
  } catch {
    throw new Error('invalid-cursor');
  }
}

export function registerConversations(
  app: FastifyInstance,
  dependencies: {
    auth: Pick<ReturnType<typeof registerAuth>['auth'], 'api'>;
    service: ReturnType<typeof createConversations>;
    requests?: ReturnType<typeof createConversationRequests>;
    approvals?: {
      read: ReturnType<typeof createTableApprovalRequests>['read'];
      decide: ReturnType<typeof createTableApprovalResolver>['decide'];
    };
    attachments?: ReturnType<typeof createAttachments> | undefined;
    identity?: Pick<Pool, 'query'>;
    events?: ConversationEventHub;
    eventTiming?: Partial<EventTiming>;
  },
) {
  const { service } = dependencies;
  const send = sendBody();
  const timing = { ...eventTiming, ...dependencies.eventTiming };
  const streams = new Set<() => void>();
  app.addHook('preClose', async () => {
    for (const end of streams) end();
  });
  async function names(userIds: string[]) {
    if (!dependencies.identity || !userIds.length) return new Map<string, string>();
    const rows = z
      .array(z.object({ id: z.string(), name: z.string() }))
      .parse((await dependencies.identity.query('SELECT id, name FROM app.users WHERE id = ANY($1)', [userIds])).rows);
    return new Map(rows.map(row => [row.id, row.name.trim() || 'Unnamed member']));
  }
  const origin = authConfig().webOrigin;
  app.register(async routes => {
    routes.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_request, body, done) =>
      done(null, body),
    );
    let byteRequests = 0;
    const admitted = new WeakSet<FastifyRequest>();
    routes.addHook('onResponse', async request => {
      if (admitted.delete(request)) byteRequests--;
    });
    routes.addHook('onRequestAbort', async request => {
      if (admitted.delete(request)) byteRequests--;
    });
    validation.install(routes);
    const user = authenticateRoutes(routes, dependencies.auth, { origin });
    routes.addHook('onRequest', async (request, reply) => {
      if (
        request.routeOptions.schema?.operationId === 'uploadConversationBytesV1' ||
        request.routeOptions.schema?.operationId === 'downloadConversationBytesV1'
      ) {
        if (byteRequests >= 4) return reply.code(503).send({ error: 'attachment-busy' });
        byteRequests++;
        admitted.add(request);
        const { workspaceId, chatId, uploadId } = uploadParams.parse(request.params);
        if (!dependencies.attachments) return reply.code(503).send({ error: 'attachments-unavailable' });
        await dependencies.attachments.status(workspaceId, user(request), chatId, uploadId);
      }
    });
    routes.setErrorHandler((error, _request, reply) => {
      if (requestBoundaryError(error, reply)) return;
      if (error instanceof AccessDenied) return reply.code(404).send({ error: 'conversation-not-found' });
      if (error instanceof ConversationConflict) return reply.code(409).send({ error: error.code });
      if (error instanceof TableError) return reply.code(error.status).send({ error: error.code });
      if (error instanceof AttachmentError)
        return reply
          .code(error.code === 'attachment-busy' ? 503 : error.code === 'attachment-size' ? 413 : 409)
          .send({ error: error.code });
      if (error instanceof StorageUnavailableError) return reply.code(503).send({ error: 'conversations-unavailable' });
      if (
        error instanceof z.ZodError ||
        (error instanceof Error && error.message === 'invalid-cursor') ||
        (typeof error === 'object' && error !== null && 'validation' in error)
      )
        return reply.code(400).send({ error: 'invalid-request' });
      return reply.code(500).send({ error: 'conversation-operation-failed' });
    });
    const base = '/workspaces/:workspaceId/conversations';
    routes.get(
      `${base}/:chatId/maintenance`,
      {
        logLevel: 'silent',
        schema: schema(
          'getConversationMaintenanceV1',
          'Read inactive-chat maintenance',
          chatParams,
          maintenanceViewSchema,
        ),
      },
      request => {
        const { workspaceId, chatId } = chatParams.parse(request.params);
        return service.maintenance(workspaceId, user(request), chatId);
      },
    );
    routes.put(
      `${base}/:chatId/maintenance`,
      {
        logLevel: 'silent',
        schema: schema(
          'resumeConversationMaintenanceV1',
          'Resume maintenance with current member access',
          chatParams,
          maintenanceViewSchema,
          commandBody,
        ),
      },
      request => {
        const { workspaceId, chatId } = chatParams.parse(request.params);
        return service.resumeMaintenance(workspaceId, user(request), chatId, request.body);
      },
    );
    const approvals = () => {
      if (!dependencies.approvals) throw new StorageUnavailableError('closed');
      return dependencies.approvals;
    };
    routes.get(
      `${base}/:chatId/approvals/:requestId`,
      {
        logLevel: 'silent',
        schema: schema(
          'getConversationApprovalV1',
          'Read a private action-bound approval',
          requestParams,
          approvalViewSchema,
        ),
      },
      request => {
        const { workspaceId, chatId, requestId } = requestParams.parse(request.params);
        return approvals().read(workspaceId, user(request), chatId, requestId);
      },
    );
    routes.put(
      `${base}/:chatId/approvals/:requestId/decision`,
      {
        logLevel: 'silent',
        schema: schema(
          'decideConversationApprovalV1',
          'Record a protected human decision',
          requestParams,
          approvalOutcomeSchema,
          approvalDecisionSchema,
        ),
      },
      request => {
        const { workspaceId, chatId, requestId } = requestParams.parse(request.params);
        return approvals().decide(workspaceId, user(request), chatId, requestId, request.body);
      },
    );
    const requests = () => {
      if (!dependencies.requests) throw new StorageUnavailableError('closed');
      return dependencies.requests;
    };
    routes.get(
      `${base}/:chatId/compactions/:compactionId`,
      {
        logLevel: 'silent',
        schema: schema(
          'getConversationCompactionV1',
          'Read a compaction status and its handoff',
          compactionParams,
          compactionDetailSchema,
        ),
      },
      request => {
        const { workspaceId, chatId, compactionId } = compactionParams.parse(request.params);
        return service.compaction(workspaceId, user(request), chatId, compactionId);
      },
    );
    routes.get(
      `${base}/:chatId/requests/:requestId`,
      {
        logLevel: 'silent',
        schema: schema(
          'getConversationRequestV1',
          'Read an authoritative private information request',
          requestParams,
          requestViewSchema,
        ),
      },
      request => {
        const { workspaceId, chatId, requestId } = requestParams.parse(request.params);
        return requests().read(workspaceId, user(request), chatId, requestId);
      },
    );
    routes.put(
      `${base}/:chatId/requests/:requestId/responses/:responseId`,
      {
        logLevel: 'silent',
        schema: schema(
          'answerConversationRequestV1',
          'Answer a specific information request',
          responseParams,
          requestOutcomeSchema,
          answerRequestSchema,
        ),
      },
      request => {
        const { workspaceId, chatId, requestId, responseId } = responseParams.parse(request.params);
        return requests().answer(workspaceId, user(request), chatId, requestId, responseId, request.body);
      },
    );
    routes.post(
      `${base}/:chatId/requests/:requestId/cancel`,
      {
        logLevel: 'silent',
        schema: schema(
          'cancelConversationRequestV1',
          'Cancel a pending information request',
          requestParams,
          requestOutcomeSchema,
          cancelRequestSchema,
        ),
      },
      request => {
        const { workspaceId, chatId, requestId } = requestParams.parse(request.params);
        return requests().cancel(workspaceId, user(request), chatId, requestId, request.body);
      },
    );
    const attachments = () => {
      if (!dependencies.attachments) throw new StorageUnavailableError('closed');
      return dependencies.attachments;
    };
    routes.put(
      `${base}/:chatId/uploads/:uploadId`,
      {
        logLevel: 'silent',
        schema: schema(
          'reserveConversationUploadV1',
          'Reserve a private attachment',
          uploadParams,
          attachmentMetadataSchema,
          reserveAttachmentSchema,
        ),
      },
      request => {
        const { workspaceId, chatId, uploadId } = uploadParams.parse(request.params);
        return attachments().reserve(workspaceId, user(request), chatId, uploadId, request.body);
      },
    );
    routes.get(
      `${base}/:chatId/uploads/:uploadId`,
      {
        logLevel: 'silent',
        schema: schema(
          'getConversationUploadV1',
          'Read private upload metadata',
          uploadParams,
          attachmentMetadataSchema,
        ),
      },
      request => {
        const { workspaceId, chatId, uploadId } = uploadParams.parse(request.params);
        return attachments().status(workspaceId, user(request), chatId, uploadId);
      },
    );
    routes.put(
      `${base}/:chatId/uploads/:uploadId/content`,
      {
        logLevel: 'silent',
        bodyLimit: attachmentLimit,
        schema: schema(
          'uploadConversationBytesV1',
          'Upload immutable attachment bytes',
          uploadParams,
          attachmentMetadataSchema,
        ),
      },
      request => {
        const { workspaceId, chatId, uploadId } = uploadParams.parse(request.params);
        if (!Buffer.isBuffer(request.body)) throw new AttachmentError('attachment-size');
        return attachments().upload(workspaceId, user(request), chatId, uploadId, request.body);
      },
    );
    routes.get(
      `${base}/:chatId/attachments/:uploadId/content`,
      {
        logLevel: 'silent',
        schema: {
          ...schema('downloadConversationBytesV1', 'Download an authorized bound attachment', uploadParams, z.string()),
          response: {
            200: { type: 'string', format: 'binary' },
            401: errorSchema,
            404: errorSchema,
            409: errorSchema,
            503: errorSchema,
          },
        },
      },
      async (request, reply) => {
        const { workspaceId, chatId, uploadId } = uploadParams.parse(request.params);
        const result = await attachments().download(workspaceId, user(request), chatId, uploadId);
        const filename = encodeURIComponent(result.filename).replaceAll("'", '%27');
        return reply
          .header('X-Content-Type-Options', 'nosniff')
          .header('Content-Disposition', `attachment; filename="attachment"; filename*=UTF-8''${filename}`)
          .type('application/octet-stream')
          .send(Buffer.from(result.bytes));
      },
    );
    routes.put(
      `${base}/:chatId`,
      {
        logLevel: 'silent',
        schema: schema(
          'createConversationV1',
          'Create a private or project chat',
          chatParams,
          z.object({ id: z.uuid() }),
          createBody,
        ),
      },
      request => {
        const { workspaceId, chatId } = chatParams.parse(request.params);
        return service.create(workspaceId, user(request), { ...createBody.parse(request.body), chatId });
      },
    );
    routes.post(
      `${base}/:chatId/move`,
      {
        logLevel: 'silent',
        schema: schema(
          'moveConversationV1',
          'Move a private chat into a project',
          chatParams,
          z.object({ projectId: z.uuid() }),
          moveBody,
        ),
      },
      request => {
        const { workspaceId, chatId } = chatParams.parse(request.params);
        return service.move(workspaceId, user(request), chatId, moveBody.parse(request.body));
      },
    );
    routes.get(
      base,
      {
        logLevel: 'silent',
        schema: schema(
          'listConversationsV1',
          'List private chats by recent activity',
          workspaceParams,
          listResult.extend({ digest: digestSchema }),
          undefined,
          listQuery,
        ),
      },
      async request => {
        const { workspaceId } = workspaceParams.parse(request.params);
        const query = listQuery.parse(request.query);
        const result = await service.list(workspaceId, user(request), {
          archived: query.archived === 'true',
          query: query.query ?? '',
          cursor: decodeCursor(query.cursor),
          ...(query.projectId ? { projectId: query.projectId } : {}),
        });
        const value = {
          chats: result.chats,
          nextCursor: result.nextCursor ? Buffer.from(JSON.stringify(result.nextCursor)).toString('base64url') : null,
        };
        return { ...value, digest: conversationPage(value).digest };
      },
    );
    routes.post(
      `${base}/pages`,
      {
        logLevel: 'silent',
        schema: schema(
          'readConversationPagesV1',
          'Revalidate a bounded window of chat pages',
          workspaceParams,
          listPagesResult,
          listPagesBody,
        ),
      },
      async (request, reply) => {
        const { workspaceId } = workspaceParams.parse(request.params);
        const input = listPagesBody.parse(request.body);
        reply.header('Cache-Control', 'no-store');
        return conversationPages(
          input.count,
          input.cursor,
          input.known,
          async cursor => {
            const result = await service.list(workspaceId, user(request), {
              archived: input.archived,
              query: input.query,
              cursor: decodeCursor(cursor ?? undefined),
              ...(input.projectId ? { projectId: input.projectId } : {}),
            });
            return {
              chats: result.chats,
              nextCursor: result.nextCursor
                ? Buffer.from(JSON.stringify(result.nextCursor)).toString('base64url')
                : null,
            };
          },
          value => value.nextCursor,
        );
      },
    );
    routes.post(
      `${base}/:chatId/messages/pages`,
      {
        logLevel: 'silent',
        schema: schema(
          'readConversationHistoryPagesV1',
          'Revalidate a bounded window of message pages',
          chatParams,
          historyPagesResult,
          historyPagesBody,
        ),
      },
      async (request, reply) => {
        const { workspaceId, chatId } = chatParams.parse(request.params);
        const input = historyPagesBody.parse(request.body);
        reply.header('Cache-Control', 'no-store');
        const [chat, result] = await Promise.all([
          input.before === null ? service.read(workspaceId, user(request), chatId) : undefined,
          conversationPages(
            input.count,
            input.before,
            input.known,
            before => service.history(workspaceId, user(request), chatId, before === null ? {} : { before }),
            value => value.nextBefore,
          ),
        ]);
        return { ...(chat ? { chat } : {}), ...result };
      },
    );
    routes.get(
      `${base}/destinations`,
      {
        logLevel: 'silent',
        schema: schema(
          'listConversationDestinationsV1',
          'List chats the requester can post in',
          workspaceParams,
          destinationResult,
          undefined,
          destinationQuery,
        ),
      },
      request => {
        const { workspaceId } = workspaceParams.parse(request.params);
        return service.destinations(workspaceId, user(request), {
          query: destinationQuery.parse(request.query).query ?? '',
        });
      },
    );
    routes.post(
      `${base}/:chatId/file-audience`,
      {
        logLevel: 'silent',
        schema: schema(
          'checkConversationFileAudienceV1',
          'Check whether everyone who reads a chat can open each file',
          chatParams,
          audienceResult,
          fileAudienceQuerySchema,
        ),
      },
      async request => {
        const { workspaceId, chatId } = chatParams.parse(request.params);
        const result = await service.fileAudience(workspaceId, user(request), chatId, request.body);
        const found = await names(
          result.files.flatMap(file =>
            file.status === 'audience' && file.missing ? file.missing.map(member => member.userId) : [],
          ),
        );
        return {
          projectId: result.projectId,
          files: result.files.map(file =>
            file.status !== 'audience'
              ? file
              : {
                  fileId: file.fileId,
                  status: file.status,
                  missing:
                    file.missing?.map(member => ({
                      membershipId: member.membershipId,
                      name: found.get(member.userId) ?? 'Workspace member',
                    })) ?? null,
                },
          ),
        };
      },
    );
    routes.get(
      `${base}/:chatId`,
      { logLevel: 'silent', schema: schema('getConversationV1', 'Read private chat metadata', chatParams, chatSchema) },
      request => {
        const { workspaceId, chatId } = chatParams.parse(request.params);
        return service.read(workspaceId, user(request), chatId);
      },
    );
    routes.get(
      `${base}/:chatId/events`,
      {
        logLevel: 'silent',
        schema: {
          operationId: 'streamConversationEventsV1',
          summary: 'Stream partial reply text and change signals as server-sent events',
          tags: ['Conversations'],
          params: json(chatParams),
          response: { 401: errorSchema, 404: errorSchema, 503: errorSchema },
        },
      },
      async (request, reply) => {
        const { workspaceId, chatId } = chatParams.parse(request.params);
        const userId = user(request);
        await service.read(workspaceId, userId, chatId);
        const hub = dependencies.events;
        if (!hub?.healthy()) return reply.code(503).send({ error: 'conversation-events-unavailable' });
        const stream = new PassThrough();
        const timers: NodeJS.Timeout[] = [];
        let ended = false;
        const write = (chunk: string) => {
          if (ended) return;
          stream.write(chunk);
          // A reader that stops consuming reconnects and starts from a snapshot instead of growing this buffer.
          if (stream.writableLength > timing.maxBufferedBytes) end();
        };
        const send = ({ event, data }: ConversationStreamEvent) =>
          write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        const unsubscribe = hub.subscribe(workspaceId, chatId, send);
        function end() {
          if (ended) return;
          ended = true;
          for (const timer of timers) clearTimeout(timer);
          unsubscribe();
          streams.delete(end);
          stream.end();
        }
        streams.add(end);
        reply.raw.once('close', end);
        timers.push(
          setInterval(() => write(': keepalive\n\n'), timing.heartbeatMs),
          setTimeout(end, timing.lifetimeMs),
        );
        const recheck = () =>
          timers.push(
            setTimeout(async () => {
              try {
                await service.read(workspaceId, userId, chatId);
              } catch (error) {
                if (error instanceof AccessDenied || error instanceof StorageUnavailableError) return end();
              }
              if (!ended) recheck();
            }, timing.recheckMs),
          );
        recheck();
        // Subscribing and writing the snapshot in one synchronous step keeps live events from arriving before or between snapshot events.
        write('retry: 2000\n\n');
        for (const event of hub.snapshot(workspaceId, chatId)) send(event);
        return reply
          .header('Content-Type', 'text/event-stream; charset=utf-8')
          .header('Cache-Control', 'no-cache, no-transform')
          .header('X-Accel-Buffering', 'no')
          .header('Connection', 'keep-alive')
          .send(stream);
      },
    );
    routes.get(
      `${base}/:chatId/messages`,
      {
        logLevel: 'silent',
        schema: schema(
          'getConversationMessagesV1',
          'Read ordered private messages',
          chatParams,
          historySchema.extend({ digest: digestSchema }),
          undefined,
          historyQuery,
        ),
      },
      async request => {
        const { workspaceId, chatId } = chatParams.parse(request.params);
        const { before } = historyQuery.parse(request.query);
        const value = await service.history(
          workspaceId,
          user(request),
          chatId,
          before ? { before: Number(before) } : {},
        );
        return { ...value, digest: conversationPage(value).digest };
      },
    );
    routes.put(
      `${base}/:chatId/messages/:messageId`,
      {
        logLevel: 'silent',
        schema: schema(
          'sendConversationMessageV1',
          'Persist a message and queue its reply',
          messageParams,
          z.object({ messageId: z.uuid(), turnId: z.uuid(), sequence: z.number().int() }),
          send,
        ),
      },
      async request => {
        const { workspaceId, chatId, messageId } = messageParams.parse(request.params);
        const input = send.parse(request.body);
        let recorded = false;
        const sent = await service.send(workspaceId, user(request), chatId, { ...input, messageId }, () => {
          recorded = true;
        });
        // Only the request that records the send publishes, so replaying it after the person deleted the file forever cannot bring the file back.
        if (recorded && dependencies.attachments && input.parts.some(part => part.kind === 'attachment')) {
          try {
            await dependencies.attachments.publishSent(workspaceId, user(request), chatId, messageId);
          } catch (error) {
            app.log.warn(
              { error: error instanceof Error ? error.name : 'unknown' },
              'Sent attachments were not published to Files',
            );
          }
        }
        return sent;
      },
    );
    routes.patch(
      `${base}/:chatId`,
      {
        logLevel: 'silent',
        schema: schema(
          'updateConversationV1',
          'Rename, archive, or restore a private chat',
          chatParams,
          z.union([z.object({ titleRevision: z.number().int() }), z.object({ archived: z.boolean() })]),
          patchBody,
        ),
      },
      request => {
        const { workspaceId, chatId } = chatParams.parse(request.params);
        const input = patchBody.parse(request.body);
        return 'title' in input
          ? service.rename(workspaceId, user(request), chatId, input)
          : service.archive(workspaceId, user(request), chatId, input);
      },
    );
    routes.delete(
      `${base}/:chatId`,
      {
        logLevel: 'silent',
        schema: schema(
          'deleteConversationV1',
          'Delete a private chat and cancel active reply work',
          chatParams,
          z.object({ deleted: z.literal(true) }),
          deleteChatSchema,
        ),
      },
      request => {
        const { workspaceId, chatId } = chatParams.parse(request.params);
        return service.remove(workspaceId, user(request), chatId, deleteChatSchema.parse(request.body));
      },
    );
    for (const operation of ['retry', 'cancel'] as const) {
      routes.post(
        `${base}/:chatId/turns/:turnId/${operation}`,
        {
          logLevel: 'silent',
          schema: schema(
            operation === 'retry' ? 'retryConversationTurnV1' : 'cancelConversationTurnV1',
            `${operation === 'retry' ? 'Retry failed' : 'Cancel pending'} deterministic reply work`,
            turnParams,
            controlResultSchema,
            controlTurnSchema,
          ),
        },
        request => {
          const { workspaceId, chatId, turnId } = turnParams.parse(request.params);
          return service[operation](workspaceId, user(request), chatId, turnId, controlTurnSchema.parse(request.body));
        },
      );
    }
  });
}
