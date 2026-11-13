import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AccessDenied } from '@tulipfarm/access';
import { ConversationConflict, type createConversations } from '@tulipfarm/conversations';
import {
  agentFunctionArgsSchemas,
  agentFunctionItemLimit,
  agentFunctionNames,
  layoutActionRequestSchema,
  layoutActionResultSchema,
  layoutVersion,
  tulipfarmCatalogId,
  type AgentFunctionName,
  type LookupItem,
} from '@tulipfarm/conversations/layout-contracts';
import { log } from '@tulipfarm/observability';
import type { createTableService } from '@tulipfarm/tables/service';
import { StorageUnavailableError } from '@tulipfarm/workspace-storage/runtime';
import { authConfig, type registerAuth } from './auth.ts';
import { authenticateRoutes } from './authenticated-routes.ts';
import type { ReplyDispatch } from './conversation-dispatch.ts';
import { routeValidation } from './route-validation.ts';
import { requestBoundaryError } from './security.ts';

const params = z.strictObject({ workspaceId: z.uuid(), chatId: z.uuid(), messageId: z.uuid() });
const callSchema = z.strictObject({
  version: z.literal(layoutVersion),
  callAgentFunction: z.strictObject({
    surfaceId: z.string().min(1).max(200),
    functionCallId: z.string().min(1).max(200),
    callFunction: z.strictObject({
      '@call': z.string().min(1).max(100),
      args: z.record(z.string(), z.unknown()).optional(),
      catalogId: z.string().max(200).optional(),
    }),
  }),
});
const functionResultSchema = z.strictObject({
  version: z.literal(layoutVersion),
  agentFunctionResponse: z.strictObject({
    functionCallId: z.string(),
    value: z.unknown().optional(),
    error: z.strictObject({ code: z.string(), message: z.string() }).optional(),
  }),
});
const errorSchema = z.object({ error: z.string() });
const validation = routeValidation({
  missing: 'Missing layout interaction validator',
  invalid: () => new Error('invalid-request'),
});
const errors = Object.fromEntries(
  [400, 401, 403, 404, 409, 429, 500, 503].map(status => [status, validation.json(errorSchema)]),
);
// Action names come from the model, so only plain identifiers are logged.
const loggedName = (name: string) => (/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(name) ? name : 'custom');

/**
 * Buttons and lookups in assistant layouts. An action sends the person's next message, with the action stored beside
 * it, and starts a reply like the composer. A lookup reads tables or members under the viewer's own access; it never
 * starts a reply or calls a model.
 */
export function registerLayoutInteractions(
  app: FastifyInstance,
  dependencies: {
    auth: Pick<ReturnType<typeof registerAuth>['auth'], 'api'>;
    service: Pick<ReturnType<typeof createConversations>, 'sendLayoutAction' | 'readLayout'>;
    tables: Pick<ReturnType<typeof createTableService>, 'search' | 'searchMembers'>;
    replies?: Pick<ReplyDispatch, 'sent'>;
  },
) {
  const { service, tables } = dependencies;
  app.register(async routes => {
    validation.install(routes);
    const user = authenticateRoutes(routes, dependencies.auth, { origin: () => authConfig().webOrigin });
    routes.setErrorHandler((error, _request, reply) => {
      if (requestBoundaryError(error, reply)) return;
      if (error instanceof AccessDenied) return reply.code(404).send({ error: 'layout-not-found' });
      if (error instanceof ConversationConflict) return reply.code(409).send({ error: error.code });
      if (error instanceof StorageUnavailableError) return reply.code(503).send({ error: 'layouts-unavailable' });
      if (error instanceof z.ZodError || (typeof error === 'object' && error !== null && 'validation' in error))
        return reply.code(400).send({ error: 'invalid-request' });
      return reply.code(500).send({ error: 'layout-operation-failed' });
    });
    const path = '/workspaces/:workspaceId/conversations/:chatId/layouts/:messageId';
    routes.post(
      `${path}/actions`,
      {
        logLevel: 'silent',
        config: { alwaysSampleTrace: true },
        schema: {
          operationId: 'sendConversationLayoutActionV1',
          summary: 'Send a button press in an assistant layout as your next message',
          tags: ['Conversations'],
          params: validation.json(params),
          body: validation.json(layoutActionRequestSchema),
          response: { 200: validation.json(layoutActionResultSchema), ...errors },
        },
      },
      async (request, reply) => {
        const { workspaceId, chatId, messageId } = params.parse(request.params);
        const started = performance.now();
        const name = z.object({ name: z.string() }).safeParse(request.body).data?.name ?? '';
        const outcome = (value: string) =>
          log(value === 'sent' ? 'info' : 'warn', 'activity', value === 'sent' ? 'call_completed' : 'call_failed', {
            operation: 'chat.layout-action',
            tool: loggedName(name),
            outcome: value,
            duration_ms: Math.round(performance.now() - started),
          });
        try {
          const sent = await service.sendLayoutAction(
            workspaceId,
            user(request),
            chatId,
            messageId,
            request.body,
            performance.now() - reply.elapsedTime,
          );
          dependencies.replies?.sent(workspaceId, chatId);
          outcome('sent');
          return sent;
        } catch (error) {
          outcome(error instanceof ConversationConflict ? error.code : 'failed');
          throw error;
        }
      },
    );
    routes.post(
      `${path}/functions`,
      {
        logLevel: 'silent',
        schema: {
          operationId: 'callConversationLayoutFunctionV1',
          summary: 'Run a read-only lookup for a form in an assistant layout',
          tags: ['Conversations'],
          params: validation.json(params),
          body: validation.json(callSchema),
          response: { 200: validation.json(functionResultSchema), ...errors },
        },
      },
      async request => {
        const { workspaceId, chatId, messageId } = params.parse(request.params);
        const { callAgentFunction: call } = callSchema.parse(request.body);
        const started = performance.now();
        const name = call.callFunction['@call'];
        const userId = user(request);
        const respond = (outcome: string, value: { value: unknown } | { code: string; message: string }) => {
          log(outcome === 'ok' ? 'info' : 'warn', 'activity', outcome === 'ok' ? 'call_completed' : 'call_failed', {
            operation: 'chat.layout-function',
            tool: (agentFunctionNames as readonly string[]).includes(name) ? name : 'unknown',
            outcome,
            duration_ms: Math.round(performance.now() - started),
          });
          return {
            version: layoutVersion,
            agentFunctionResponse: {
              functionCallId: call.functionCallId,
              ...('value' in value ? { value: value.value } : { error: value }),
            },
          };
        };
        if (call.surfaceId !== messageId)
          return respond('invalid', { code: 'VALIDATION_FAILED', message: 'The call is not from this reply.' });
        if (
          !(agentFunctionNames as readonly string[]).includes(name) ||
          (call.callFunction.catalogId ?? tulipfarmCatalogId) !== tulipfarmCatalogId
        )
          return respond('unknown', { code: 'INVALID_FUNCTION_CALL', message: `${name} is not available.` });
        if (!(await service.readLayout(workspaceId, userId, chatId, messageId)))
          return respond('not-found', { code: 'EXECUTION_ERROR', message: 'The reply is not available.' });
        const functionName = name as AgentFunctionName;
        const args = agentFunctionArgsSchemas[functionName].safeParse(call.callFunction.args ?? {});
        if (!args.success)
          return respond('invalid', { code: 'VALIDATION_FAILED', message: 'The lookup arguments are not valid.' });
        try {
          const query = args.data.query?.trim() || undefined;
          const found =
            functionName === 'searchRows'
              ? await tables.search(workspaceId, userId, {
                  tableId: (args.data as { tableId: string }).tableId,
                  ...(query ? { search: query } : {}),
                  limit: agentFunctionItemLimit,
                })
              : await tables.searchMembers(workspaceId, userId, {
                  ...(query ? { search: query } : {}),
                  limit: agentFunctionItemLimit,
                });
          const items: LookupItem[] = found.choices
            .slice(0, agentFunctionItemLimit)
            .map(choice => ({ value: choice.id, label: choice.label }));
          return respond('ok', { value: items });
        } catch (error) {
          if (error instanceof AccessDenied)
            return respond('denied', { code: 'EXECUTION_ERROR', message: 'You cannot read that.' });
          if (error instanceof StorageUnavailableError) throw error;
          return respond('failed', { code: 'EXECUTION_ERROR', message: 'The lookup failed.' });
        }
      },
    );
  });
}
