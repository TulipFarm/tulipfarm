import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AccessDenied, lockAuthorization, resolveHuman } from '@tulipfarm/access';
import {
  createTableProposals,
  createTableProposalDecisions,
  type TableProposalOptions,
} from '@tulipfarm/tables/proposals';
import {
  blockedTableProposalSchema,
  proposalControlSchema,
  proposalDecisionSchema,
  proposalEffectsPageSchema,
  proposalPageSchema,
  proposalStatusSchema,
  proposalViewSchema,
  TableProposalError,
  TableProposalValidationError,
} from '@tulipfarm/tables/proposal-contracts';
import { authConfig, type registerAuth } from './auth.ts';
import { authenticateRoutes } from './authenticated-routes.ts';
import { routeValidation } from './route-validation.ts';
import { requestBoundaryError } from './security.ts';
import { executionCompatibility } from '@tulipfarm/tables/execution';
import { createTableService, mutationSchema } from '@tulipfarm/tables/service';
import { GenerationError } from '@tulipfarm/tables/store';
import { WorkspaceMemberError } from '@tulipfarm/tables/workspace-members';
import {
  definitionSchema,
  recordQuerySchema,
  cursorSchema,
  sortDirectionSchema,
  TableValidationError,
  valuesSchema,
} from '@tulipfarm/tables/definition';
import { proposeTableSchema } from '@tulipfarm/tables/proposal-contracts';
import {
  queryCapabilitiesSchema,
  queryErrorSchema,
  queryResultSchema,
  queryValidationSchema,
  referenceChoicesSchema,
  TableQueryError,
} from '@tulipfarm/tables/query';
import { humanReadableTableFiles } from '@tulipfarm/agents/table-sources';
import {
  createRecordRequests,
  recordMutationResultSchema,
  recordRequestStatusSchema,
} from './table-record-requests.ts';
import { TableError } from '@tulipfarm/tables/service-contracts';
import { createTableSchemaHistory, definitionStateSchema, schemaHistorySchema } from './table-schema-history.ts';

export function registerTableChanges(
  app: FastifyInstance,
  dependencies: TableProposalOptions & {
    auth: ReturnType<typeof registerAuth>['auth'];
    resolveConfirmationCredential(workspaceId: string): Promise<string>;
  },
) {
  const proposals = createTableProposals(dependencies);
  const decisions = createTableProposalDecisions(dependencies);
  const records = createTableService(
    dependencies.runtime,
    { readableFiles: humanReadableTableFiles },
    executionCompatibility,
  );
  const recordRequests = createRecordRequests(dependencies.runtime);
  const schemaHistory = createTableSchemaHistory(dependencies);
  const params = z.object({ workspaceId: z.uuid(), chatId: z.uuid(), proposalId: z.uuid() });
  const validation = routeValidation({
    missing: 'Missing table proposal validator',
    invalid: () => new Error('invalid-request'),
  });
  const errors = Object.fromEntries(
    [400, 401, 403, 404, 409, 503].map(status => [
      status,
      validation.json(
        status === 409
          ? z.union([blockedTableProposalSchema, z.object({ error: z.string() })])
          : status === 400
            ? z.union([queryErrorSchema, z.object({ error: z.string() })])
            : z.object({ error: z.string() }),
      ),
    ]),
  );
  const response = (schema: z.ZodType) => ({ 200: validation.json(schema), ...errors });
  app.register(async routes => {
    validation.install(routes, true);
    const user = authenticateRoutes(routes, dependencies.auth, { origin: authConfig().webOrigin });
    routes.setErrorHandler((error, _request, reply) => {
      if (requestBoundaryError(error, reply)) return;
      if (error instanceof AccessDenied) return reply.code(404).send({ error: 'proposal-unavailable' });
      if (error instanceof TableProposalValidationError) return reply.code(409).send(error.validation);
      if (error instanceof TableProposalError)
        return reply.code(error.code === 'proposal-storage-unavailable' ? 503 : 409).send({ error: error.code });
      if (error instanceof GenerationError) return reply.code(409).send({ error: error.code });
      if (error instanceof WorkspaceMemberError) return reply.code(error.status).send({ error: error.code });
      if (error instanceof TableQueryError)
        return reply.code(400).send({ error: 'invalid-query', issues: error.issues });
      if (error instanceof TableValidationError) return reply.code(400).send({ error: 'invalid-table-values' });
      if (error instanceof TableError) return reply.code(error.status).send({ error: error.code });
      if (error instanceof z.ZodError || (typeof error === 'object' && error !== null && 'validation' in error))
        return reply.code(400).send({ error: 'invalid-request' });
      return reply.code(503).send({ error: 'proposal-unavailable' });
    });
    const base = '/workspaces/:workspaceId/conversations/:chatId/table-changes';
    routes.get(
      `${base}/:proposalId/outcome`,
      {
        logLevel: 'silent',
        schema: {
          operationId: 'tableProposalOutcomeV1',
          params: validation.json(params),
          response: response(
            z.discriminatedUnion('kind', [
              z.object({ kind: z.literal('blocked'), report: blockedTableProposalSchema }),
              z.object({ kind: z.literal('proposal') }),
            ]),
          ),
        },
      },
      request => {
        const p = params.parse(request.params);
        return proposals.outcome(p.workspaceId, user(request), p.chatId, p.proposalId);
      },
    );
    const createBody = z.object({ turnId: z.uuid(), input: proposeTableSchema });
    routes.put(
      `${base}/:proposalId`,
      {
        logLevel: 'silent',
        schema: {
          operationId: 'proposeTableChangesV1',
          params: validation.json(params),
          body: validation.json(createBody),
          response: {
            202: validation.json(
              z.object({ id: z.uuid(), digest: z.string(), expiresAt: z.string(), status: z.string() }),
            ),
            ...errors,
          },
        },
      },
      async (request, reply) => {
        const p = params.parse(request.params),
          body = createBody.parse(request.body);
        const actor = await dependencies.runtime.transaction(p.workspaceId, executionCompatibility, async tx => {
          await lockAuthorization(tx);
          return resolveHuman(tx, user(request));
        });
        return reply.code(202).send(
          await proposals.propose(
            p.workspaceId,
            actor,
            p.proposalId,
            {
              conversationId: p.chatId,
              turnId: body.turnId,
              sources: [{ kind: 'private-conversation', conversationId: p.chatId }],
            },
            body.input,
          ),
        );
      },
    );
    routes.get(
      base,
      {
        logLevel: 'silent',
        schema: {
          operationId: 'listTableProposalsV1',
          params: validation.json(params.omit({ proposalId: true })),
          querystring: validation.json(z.object({ after: z.uuid().optional() })),
          response: response(z.object({ items: z.array(proposalStatusSchema), nextCursor: z.uuid().nullable() })),
        },
      },
      request => {
        const p = params.omit({ proposalId: true }).parse(request.params);
        return proposals.list(
          p.workspaceId,
          user(request),
          p.chatId,
          z.object({ after: z.uuid().optional() }).parse(request.query).after,
        );
      },
    );
    routes.get(
      `${base}/:proposalId`,
      {
        logLevel: 'silent',
        schema: {
          operationId: 'readTableProposalV1',
          params: validation.json(params),
          response: response(proposalViewSchema),
        },
      },
      request => {
        const p = params.parse(request.params);
        return proposals.read(p.workspaceId, user(request), p.chatId, p.proposalId);
      },
    );
    routes.get(
      `${base}/:proposalId/status`,
      {
        logLevel: 'silent',
        schema: {
          operationId: 'tableProposalStatusV1',
          params: validation.json(params),
          response: response(proposalStatusSchema),
        },
      },
      request => {
        const p = params.parse(request.params);
        return proposals.status(p.workspaceId, user(request), p.chatId, p.proposalId);
      },
    );
    routes.get(
      `${base}/:proposalId/tables/:tableId/effects`,
      {
        logLevel: 'silent',
        schema: {
          operationId: 'tableProposalEffectsV1',
          params: validation.json(params.extend({ tableId: z.uuid() })),
          querystring: validation.json(proposalPageSchema),
          response: response(proposalEffectsPageSchema),
        },
      },
      request => {
        const p = params.extend({ tableId: z.uuid() }).parse(request.params);
        return proposals.effects(p.workspaceId, user(request), p.chatId, p.proposalId, p.tableId, request.query);
      },
    );
    routes.put(
      `${base}/:proposalId/decision`,
      {
        logLevel: 'silent',
        schema: {
          operationId: 'decideTableProposalV1',
          params: validation.json(params),
          body: validation.json(proposalDecisionSchema),
          response: response(proposalStatusSchema),
        },
      },
      request => {
        const p = params.parse(request.params);
        return decisions.decide(p.workspaceId, user(request), p.chatId, p.proposalId, request.body);
      },
    );
    routes.put(
      `${base}/:proposalId/control`,
      {
        logLevel: 'silent',
        schema: {
          operationId: 'controlTableProposalV1',
          params: validation.json(params),
          body: validation.json(proposalControlSchema),
          response: response(proposalStatusSchema),
        },
      },
      request => {
        const p = params.parse(request.params);
        return decisions.control(p.workspaceId, user(request), p.chatId, p.proposalId, request.body);
      },
    );
    const tableBase = '/workspaces/:workspaceId/tables';
    const workspaceParams = z.object({ workspaceId: z.uuid() });
    const recordParams = workspaceParams.extend({ tableId: z.uuid() });
    const page = z.object({ after: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) });
    const recordPage = page.extend({
      revision: z.string().regex(/^[a-f0-9]{40}$/),
      ids: z
        .string()
        .regex(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}(,[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}){0,99}$/i)
        .optional(),
    });
    const search = z.string().trim().min(1).max(255).optional(),
      tablePage = page.extend({
        after: z.string().max(40).optional(),
        search,
        archived: z.coerce.boolean().default(false),
        sort: z.enum(['name', 'records', 'changed']).optional(),
        direction: z.enum(['asc', 'desc']).optional(),
      });
    const recordQueryPage = page.extend({
      revision: z.string().regex(/^[a-f0-9]{40}$/),
      after: cursorSchema.optional(),
      search,
      sort: z.uuid().optional(),
      direction: sortDirectionSchema.default('asc'),
      filters: z.string().max(4000).optional(),
    });
    const filtersJson = z
      .string()
      .transform((text, context) => {
        try {
          return JSON.parse(text);
        } catch {
          context.addIssue({ code: 'custom', message: 'Expected JSON filters' });
          return z.NEVER;
        }
      })
      .pipe(recordQuerySchema.shape.filters);
    const record = z.object({
      id: z.uuid(),
      token: z.uuid(),
      values: valuesSchema,
      unavailableFileIds: z.array(z.uuid()).optional(),
    });
    routes.get(
      `${tableBase}/:tableId`,
      {
        logLevel: 'silent',
        schema: {
          operationId: 'tableDefinitionState',
          params: validation.json(recordParams),
          response: response(definitionStateSchema),
        },
      },
      request => {
        const p = recordParams.parse(request.params);
        return schemaHistory.state(p.workspaceId, user(request), p.tableId);
      },
    );
    routes.get(
      `${tableBase}/:tableId/schema-history`,
      {
        logLevel: 'silent',
        schema: {
          operationId: 'tableSchemaHistory',
          params: validation.json(recordParams),
          querystring: validation.json(page),
          response: response(schemaHistorySchema),
        },
      },
      request => {
        const p = recordParams.parse(request.params),
          query = page.parse(request.query);
        return schemaHistory.history(p.workspaceId, user(request), p.tableId, {
          limit: query.limit,
          ...(query.after ? { after: query.after } : {}),
        });
      },
    );
    routes.get(
      `${tableBase}/:tableId/deleted-rows`,
      {
        logLevel: 'silent',
        schema: {
          operationId: 'deletedTableRecords',
          params: validation.json(recordParams),
          querystring: validation.json(page),
          response: response(
            z.object({
              records: z.array(
                z.object({
                  id: z.uuid(),
                  token: z.uuid(),
                  deletedAt: z.iso.datetime(),
                  recoverableUntil: z.iso.datetime().nullable(),
                }),
              ),
              nextCursor: z.uuid().nullable(),
            }),
          ),
        },
      },
      async request => {
        const p = recordParams.parse(request.params),
          query = page.parse(request.query);
        const result = await records.deletedRecords(p.workspaceId, user(request), {
          tableId: p.tableId,
          limit: query.limit,
          ...(query.after ? { after: query.after } : {}),
        });
        return {
          ...result,
          records: result.records.map(record => ({
            ...record,
            deletedAt: record.deletedAt.toISOString(),
            recoverableUntil: record.recoverableUntil?.toISOString() ?? null,
          })),
        };
      },
    );
    routes.get(
      tableBase,
      {
        logLevel: 'silent',
        schema: {
          operationId: 'listTableDefinitions',
          params: validation.json(workspaceParams),
          querystring: validation.json(tablePage),
          response: response(
            z.object({
              tables: z.array(
                z.object({
                  id: z.uuid(),
                  revision: z.string(),
                  definition: definitionSchema,
                  systemKind: z.literal('workspace-members').optional(),
                  appliedAt: z.iso.datetime().nullable(),
                  recordCount: z.string(),
                }),
              ),
              nextCursor: z.string().nullable(),
            }),
          ),
        },
      },
      request => {
        const p = workspaceParams.parse(request.params),
          query = tablePage.parse(request.query);
        return records
          .definitions(p.workspaceId, user(request), {
            limit: query.limit,
            archived: query.archived,
            ...(query.after ? { after: query.after } : {}),
            ...(query.search ? { search: query.search } : {}),
            ...(query.sort ? { sort: query.sort } : {}),
            ...(query.direction ? { direction: query.direction } : {}),
          })
          .then(result => ({
            ...result,
            tables: result.tables.map(item => ({ ...item, appliedAt: item.appliedAt?.toISOString() ?? null })),
          }));
      },
    );
    routes.get(
      `${tableBase}/:tableId/rows/page`,
      {
        logLevel: 'silent',
        schema: {
          operationId: 'listTableRecordPage',
          params: validation.json(recordParams),
          querystring: validation.json(recordQueryPage),
          response: response(
            z.object({ records: z.array(record), total: z.string().nullable(), nextCursor: z.string().nullable() }),
          ),
        },
      },
      request => {
        const p = recordParams.parse(request.params),
          { revision, after, limit, search, sort, direction, filters } = recordQueryPage.parse(request.query);
        const query = {
          filters: filters === undefined ? [] : filtersJson.parse(filters),
          limit,
          ...(after ? { after } : {}),
          ...(search ? { search } : {}),
          ...(sort ? { sort: { fieldId: sort, direction } } : {}),
        };
        return records.listPage(p.workspaceId, user(request), { tableId: p.tableId, revision, query });
      },
    );
    const revision = z.string().regex(/^[a-f0-9]{40}$/);
    const queryBody = z.object({ revision, request: z.unknown() });
    routes.get(
      `${tableBase}/:tableId/query-capabilities`,
      {
        logLevel: 'silent',
        schema: {
          operationId: 'tableQueryCapabilities',
          params: validation.json(recordParams),
          response: response(queryCapabilitiesSchema),
        },
      },
      request => {
        const p = recordParams.parse(request.params);
        return records.capabilities(p.workspaceId, user(request), { tableId: p.tableId });
      },
    );
    routes.post(
      `${tableBase}/:tableId/query/validate`,
      {
        logLevel: 'silent',
        schema: {
          operationId: 'validateTableQuery',
          params: validation.json(recordParams),
          body: validation.json(queryBody),
          response: response(queryValidationSchema),
        },
      },
      request => {
        const p = recordParams.parse(request.params),
          body = queryBody.parse(request.body);
        return records.validateQuery(p.workspaceId, user(request), {
          tableId: p.tableId,
          revision: body.revision,
          request: body.request,
        });
      },
    );
    routes.post(
      `${tableBase}/:tableId/query`,
      {
        logLevel: 'silent',
        schema: {
          operationId: 'queryTableRecords',
          params: validation.json(recordParams),
          body: validation.json(queryBody),
          response: response(queryResultSchema),
        },
      },
      request => {
        const p = recordParams.parse(request.params),
          body = queryBody.parse(request.body);
        return records.query(p.workspaceId, user(request), {
          tableId: p.tableId,
          revision: body.revision,
          request: body.request,
        });
      },
    );
    const referenceQuery = z.object({
      fieldId: z.uuid(),
      search: z.string().trim().min(1).max(255).optional(),
      ids: z.string().max(3700).optional(),
      limit: z.coerce.number().int().min(1).max(50).default(20),
    });
    routes.get(
      `${tableBase}/:tableId/query/references`,
      {
        logLevel: 'silent',
        schema: {
          operationId: 'tableQueryReferences',
          params: validation.json(recordParams),
          querystring: validation.json(referenceQuery),
          response: response(referenceChoicesSchema),
        },
      },
      request => {
        const p = recordParams.parse(request.params),
          query = referenceQuery.parse(request.query);
        return records.references(p.workspaceId, user(request), {
          tableId: p.tableId,
          fieldId: query.fieldId,
          limit: query.limit,
          ...(query.search ? { search: query.search } : {}),
          ...(query.ids ? { ids: query.ids.toLowerCase().split(',') } : {}),
        });
      },
    );
    routes.get(
      `${tableBase}/:tableId/rows`,
      {
        logLevel: 'silent',
        schema: {
          operationId: 'listTableRecords',
          params: validation.json(recordParams),
          querystring: validation.json(recordPage),
          response: response(z.array(record)),
        },
      },
      request => {
        const p = recordParams.parse(request.params),
          query = recordPage.parse(request.query);
        return records.list(p.workspaceId, user(request), {
          tableId: p.tableId,
          revision: query.revision,
          limit: query.limit,
          ...(query.after ? { after: query.after } : {}),
          ...(query.ids ? { ids: query.ids.toLowerCase().split(',') } : {}),
        });
      },
    );
    const rowParams = recordParams.extend({ rowId: z.uuid() });
    const reverseParams = rowParams.extend({ fieldId: z.uuid() });
    const reverseFieldPage = z.object({
      fields: z.array(
        z.object({ fieldId: z.uuid(), tableId: z.uuid(), label: z.string(), cardinality: z.enum(['one', 'many']) }),
      ),
      nextCursor: z.uuid().nullable(),
    });
    const reversePage = z.object({
      kind: z.literal('relationship'),
      tableId: z.uuid(),
      cardinality: z.enum(['one', 'many']),
      recordIds: z.array(z.uuid()),
      nextCursor: z.uuid().nullable(),
    });
    routes.get(
      `${tableBase}/:tableId/rows/:rowId/reverse-fields`,
      {
        logLevel: 'silent',
        schema: {
          operationId: 'listTableReverseFields',
          params: validation.json(rowParams),
          querystring: validation.json(page),
          response: response(reverseFieldPage),
        },
      },
      request => {
        const p = rowParams.parse(request.params),
          query = page.parse(request.query);
        return records.reverseFields(p.workspaceId, user(request), {
          tableId: p.tableId,
          limit: query.limit,
          ...(query.after ? { after: query.after } : {}),
        });
      },
    );
    routes.get(
      `${tableBase}/:tableId/rows/:rowId/reverse/:fieldId`,
      {
        logLevel: 'silent',
        schema: {
          operationId: 'listTableReverseRecords',
          params: validation.json(reverseParams),
          querystring: validation.json(page),
          response: response(reversePage),
        },
      },
      request => {
        const p = reverseParams.parse(request.params),
          query = page.parse(request.query);
        return records.reverse(p.workspaceId, user(request), {
          tableId: p.tableId,
          recordId: p.rowId,
          fieldId: p.fieldId,
          limit: query.limit,
          ...(query.after ? { after: query.after } : {}),
        });
      },
    );
    const requestMutation = z.discriminatedUnion('kind', [
      mutationSchema.options[0].extend({ requestId: z.uuid() }),
      mutationSchema.options[1].extend({ requestId: z.uuid() }),
      mutationSchema.options[2].extend({ requestId: z.uuid() }),
      mutationSchema.options[3].extend({ requestId: z.uuid() }),
    ]);
    routes.post(
      `${tableBase}/:tableId/rows`,
      {
        logLevel: 'silent',
        schema: {
          operationId: 'mutateTableRecord',
          params: validation.json(recordParams),
          body: validation.json(requestMutation),
          response: response(recordMutationResultSchema),
        },
      },
      request => {
        const p = recordParams.parse(request.params),
          { requestId, ...input } = requestMutation.parse(request.body);
        if (input.tableId !== p.tableId) throw new z.ZodError([]);
        return recordRequests.mutate(p.workspaceId, user(request), { requestId, mutation: input });
      },
    );
    const requestParams = recordParams.extend({ requestId: z.uuid() });
    routes.get(
      `${tableBase}/:tableId/requests/:requestId`,
      {
        logLevel: 'silent',
        schema: {
          operationId: 'tableRecordRequest',
          params: validation.json(requestParams),
          response: response(recordRequestStatusSchema),
        },
      },
      request => {
        const p = requestParams.parse(request.params);
        return recordRequests.status(p.workspaceId, user(request), p.tableId, p.requestId);
      },
    );
    const historyParams = recordParams.extend({ rowId: z.uuid() });
    const history = z.object({
      id: z.uuid(),
      token: z.uuid(),
      actor: z.unknown(),
      operation: z.enum(['create', 'update', 'delete', 'restore', 'transform']),
      field_ids: z.array(z.uuid()),
      outcome: z.literal('applied'),
      created_at: z.iso.datetime(),
      recoverable_until: z.iso.datetime(),
      values: valuesSchema.nullable(),
      before_values: valuesSchema.nullable(),
      unavailable_file_ids: z.array(z.uuid()).optional(),
    });
    routes.get(
      `${tableBase}/:tableId/rows/:rowId/history`,
      {
        logLevel: 'silent',
        schema: {
          operationId: 'tableRecordHistory',
          params: validation.json(historyParams),
          querystring: validation.json(page),
          response: response(z.array(history)),
        },
      },
      async request => {
        const p = historyParams.parse(request.params),
          query = page.parse(request.query);
        const entries = await records.history(p.workspaceId, user(request), {
          tableId: p.tableId,
          recordId: p.rowId,
          limit: query.limit,
          ...(query.after ? { after: query.after } : {}),
        });
        return entries.map(entry => ({
          ...entry,
          created_at: entry.created_at.toISOString(),
          recoverable_until: entry.recoverable_until.toISOString(),
        }));
      },
    );
  });
}
