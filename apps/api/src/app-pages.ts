import { randomUUID } from 'node:crypto';
import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  actionBindings,
  appIdSchema,
  checkAppDefinition,
  type AppAction,
  type AppDefinition,
  type AppId,
  type AppPage,
  type AppSource,
  type MembershipId,
} from '@tulipfarm/apps';
import {
  absentReferences,
  appDefinitionReferences,
  appRole,
  readApp,
  readDraftDefinition,
  readLiveVersion,
  recordBrokenReferences,
  type AppReference,
} from '@tulipfarm/apps/store';
import { AccessDenied, hasWorkflowGrant, requireTaskInvocation } from '@tulipfarm/access';
import { readableTableFiles } from '@tulipfarm/agents/table-sources';
import { recordConversationActivity } from '@tulipfarm/conversations/activity';
import { notifyConversationChange } from '@tulipfarm/conversations/event-publisher';
import {
  layoutActionContextLimit,
  layoutActionLabelsLimit,
  layoutVersion,
} from '@tulipfarm/conversations/layout-contracts';
import { errorAttributes, isFeatureEnabled } from '@tulipfarm/observability';
import type { createTableService } from '@tulipfarm/tables/service';
import { commonCompatibility, qualified, type createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import type { registerAuth } from './auth.ts';
import { authConfig } from './auth.ts';
import { routeValidation } from './route-validation.ts';
import { requestBoundaryError } from './security.ts';

type Runtime = Pick<ReturnType<typeof createWorkspaceRuntime>, 'transaction'>;
type Tx = Parameters<Parameters<Runtime['transaction']>[2]>[0];
type Tables = Pick<ReturnType<typeof createTableService>, 'capabilities' | 'query' | 'read' | 'searchMembers'>;

export type AppPageDependencies = {
  readonly auth: { api: Pick<ReturnType<typeof registerAuth>['auth']['api'], 'getSession'> };
  readonly runtime: Runtime;
  /** Table reads, each run as the viewing member. */
  readonly tables: Tables;
  /** Starts a workflow run as the member. Starting the same request again returns the same run. */
  readonly startWorkflow: (
    workspaceId: string,
    userId: string,
    workflowId: string,
    input: { requestId: string; input: Record<string, unknown> },
  ) => Promise<{ runId: string }>;
  /** Starts a private agent task as the member and returns its id. */
  readonly askAgent: (
    workspaceId: string,
    userId: string,
    input: { requestId: string; agentId: string; text: string },
  ) => Promise<{ taskId: string }>;
};

const pageParams = z.strictObject({ workspaceId: z.uuid(), appId: appIdSchema, page: z.string().max(80) });
const actionParams = pageParams.extend({ action: z.string().max(80) });
const pageQuery = z.strictObject({ draft: z.enum(['true', 'false']).optional() });
const dataBody = z.strictObject({ row: z.uuid().optional() });
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const actionBody = z.strictObject({
  requestId: z.uuid(),
  context: z.record(z.string(), z.unknown()).refine(value => bytes(value) <= layoutActionContextLimit),
  labels: z
    .record(z.string(), z.string().max(1000))
    .refine(value => bytes(value) <= layoutActionLabelsLimit)
    .optional(),
  confirmed: z.boolean().optional(),
});

/** Why a source has no value, or that it has one. */
export type SourceStatus = 'ready' | 'empty' | 'restricted' | 'unavailable' | 'failed';
type SourceState = { status: SourceStatus; loadedAt: string; value: unknown };
type Availability = 'available' | 'restricted' | 'unavailable';

class PageFailure extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

type Member = { membershipId: string; userId: string; admin: boolean };
const human = (member: Member) =>
  ({ kind: 'human', userId: member.userId, membershipId: member.membershipId }) as const;
type Loaded = { appId: AppId; draft: boolean; versionId: string | null; definition: AppDefinition; page: AppPage };

/** Every table, field, file, workflow and agent one page names. */
function pageReferences(page: AppPage): AppReference[] {
  return appDefinitionReferences({ pages: [page] }).map(({ reference }) => reference);
}

function sourceReferences(page: AppPage, source: AppSource): AppReference[] {
  return appDefinitionReferences({ pages: [{ ...page, row: undefined, actions: [], sources: [source] }] }).map(
    ({ reference }) => reference,
  );
}

function actionReference(action: AppAction): AppReference | null {
  if (action.kind === 'run-workflow') return `workflow:${action.workflowId}`;
  if (action.kind === 'ask-agent') return `agent:${action.agentId}`;
  return null;
}

/** The plain text an agent receives: the action's message, then each value the button sent. */
function agentText(action: Extract<AppAction, { kind: 'ask-agent' }>, values: Record<string, unknown>) {
  const lines = Object.entries(values).map(
    ([name, value]) => `${name}: ${typeof value === 'string' ? value : JSON.stringify(value)}`,
  );
  return lines.length ? `${action.message}\n\n${lines.join('\n')}` : action.message;
}

/**
 * Pages of private apps under `/workspaces/:workspaceId/apps/:appId/pages`. Each request reads with the viewing
 * member's own rights; nothing here reads data on the app's behalf. Responses name source and action ids only, never
 * the queries or targets behind them.
 */
export function registerAppPages(app: FastifyInstance, dependencies: AppPageDependencies) {
  const { runtime, tables } = dependencies;
  const transaction = <T>(workspaceId: string, action: (tx: Tx) => Promise<T>) =>
    runtime.transaction(workspaceId, commonCompatibility, action);

  const memberOf = async (tx: Tx, userId: string): Promise<Member> => {
    const { rows } = await tx.client.query(
      `SELECT id, role FROM ${qualified(tx.schema, 'tf_memberships')} WHERE user_id = $1 AND removed_at IS NULL`,
      [userId],
    );
    const row = rows[0] as { id: string; role: string } | undefined;
    if (!row) throw new AccessDenied();
    return { membershipId: row.id, userId, admin: row.role === 'admin' };
  };

  /** The live pages for anyone the app is shared with, or the saved draft for its editors. */
  const load = async (tx: Tx, member: Member, appId: AppId, slug: string, draft: boolean): Promise<Loaded> => {
    const found = await readApp(tx, appId);
    if (!found || found.kind !== 'private' || found.archivedAt || found.stops.disabledAt) throw new AccessDenied();
    const role = await appRole(tx, appId, member.membershipId as MembershipId);
    if (!role && !member.admin) throw new AccessDenied();
    let definition: AppDefinition;
    let versionId: string | null = null;
    if (draft) {
      if (role !== 'edit') throw new PageFailure(403, 'forbidden');
      const checked = checkAppDefinition(await readDraftDefinition(tx, appId));
      if (!checked.ok) throw new PageFailure(422, 'definition-invalid');
      definition = checked.definition;
    } else {
      const live = await readLiveVersion(tx, appId);
      if (!live) throw new AccessDenied();
      definition = live.definition;
      versionId = live.versionId;
    }
    const page = definition.pages.find(candidate => candidate.slug === slug);
    if (!page) throw new AccessDenied();
    return { appId, draft, versionId, definition, page };
  };

  /**
   * Tells editors in the app's chat about references the live version names that no longer exist. A reference is
   * recorded once per version, so editors hear about it once however many members open the page.
   */
  const reportBroken = async (workspaceId: string, tx: Tx, loaded: Loaded, absent: ReadonlySet<AppReference>) => {
    if (!loaded.versionId || !absent.size) return;
    const fresh = await recordBrokenReferences(tx, loaded.versionId, [...absent].sort());
    if (!fresh.length) return;
    const { rows } = await tx.client.query(
      `SELECT id, next_message_sequence FROM ${qualified(tx.schema, 'tf_conversations')}
       WHERE app_id = $1 AND deleted_at IS NULL ORDER BY created_at, id LIMIT 1 FOR UPDATE`,
      [loaded.appId],
    );
    const chat = rows[0] as { id: string; next_message_sequence: string } | undefined;
    if (!chat) return;
    const names = fresh.map(reference => reference.replace(':', ' ')).join(', ');
    const text = `The live version of this app names something that no longer exists: ${names}. Members see that part of "${loaded.page.title}" as unavailable until you fix it and publish again.`;
    const id = randomUUID();
    await tx.client.query(
      `INSERT INTO ${qualified(tx.schema, 'tf_conversation_messages')} (id, conversation_id, sequence, author_kind)
       VALUES ($1, $2, $3, 'assistant')`,
      [id, chat.id, chat.next_message_sequence],
    );
    await tx.client.query(
      `INSERT INTO ${qualified(tx.schema, 'tf_conversation_parts')} (conversation_id, message_id, ordinal, kind, text)
       VALUES ($1, $2, 0, 'text', $3)`,
      [chat.id, id, text],
    );
    await tx.client.query(
      `UPDATE ${qualified(tx.schema, 'tf_conversations')} SET next_message_sequence = next_message_sequence + 1
       WHERE id = $1`,
      [chat.id],
    );
    await recordConversationActivity(tx, chat.id);
    await notifyConversationChange(tx, { workspaceId, conversationId: chat.id });
  };

  const availability = async (
    tx: Tx,
    member: Member,
    action: AppAction,
    absent: ReadonlySet<AppReference>,
  ): Promise<Availability> => {
    const reference = actionReference(action);
    if (reference && absent.has(reference)) return 'unavailable';
    if (action.kind === 'run-workflow')
      return (await hasWorkflowGrant(tx, member.membershipId, action.workflowId, 'invoke'))
        ? 'available'
        : 'restricted';
    if (action.kind === 'ask-agent')
      return requireTaskInvocation(tx, human(member), action.agentId).then(
        () => 'available' as const,
        (error: unknown) => {
          if (error instanceof AccessDenied) return 'restricted' as const;
          throw error;
        },
      );
    return 'available';
  };

  const settle = async (read: () => Promise<{ value: unknown; empty: boolean }>): Promise<SourceState> => {
    const loadedAt = new Date().toISOString();
    try {
      const { value, empty } = await read();
      return { status: empty ? 'empty' : 'ready', loadedAt, value: empty ? null : value };
    } catch (error) {
      if (error instanceof AccessDenied) return { status: 'restricted', loadedAt, value: null };
      return { status: 'failed', loadedAt, value: null };
    }
  };

  const tableQuery = async (
    workspaceId: string,
    userId: string,
    source: Extract<AppSource, { kind: 'rows' | 'summary' }>,
  ) => {
    const { revision } = await tables.capabilities(workspaceId, userId, { tableId: source.tableId });
    const result = await tables.query(workspaceId, userId, {
      tableId: source.tableId,
      revision,
      request: { query: source.query },
    });
    if (result.mode === 'summary')
      return { value: { groups: result.groups, groupCount: result.groupCount }, empty: result.groups.length === 0 };
    return {
      value: { records: result.records, total: result.total, nextCursor: result.nextCursor },
      empty: result.records.length === 0,
    };
  };

  const readSource = (
    workspaceId: string,
    member: Member,
    page: AppPage,
    source: AppSource,
    row: string | undefined,
  ): Promise<SourceState> =>
    settle(async () => {
      switch (source.kind) {
        case 'rows':
        case 'summary':
          return tableQuery(workspaceId, member.userId, source);
        case 'row': {
          if (!page.row || !row) return { value: null, empty: true };
          const tableId = page.row.tableId;
          const { revision } = await tables.capabilities(workspaceId, member.userId, { tableId });
          const record = await tables.read(workspaceId, member.userId, { tableId, revision, recordId: row });
          return { value: record, empty: record === null };
        }
        case 'members': {
          const { choices } = await tables.searchMembers(workspaceId, member.userId, { limit: 50 });
          return { value: { members: choices }, empty: choices.length === 0 };
        }
        case 'file':
          return transaction(workspaceId, async tx => {
            const readable = await readableTableFiles(tx, human(member), [source.fileId]);
            if (!readable.has(source.fileId)) throw new AccessDenied();
            const { rows } = await tx.client.query(
              `SELECT id AS "fileId", name, media_type AS "mediaType", size FROM ${qualified(tx.schema, 'tf_files')}
               WHERE id = $1`,
              [source.fileId],
            );
            return { value: rows[0] ?? null, empty: !rows[0] };
          });
      }
    });

  app.register(async routes => {
    const validation = routeValidation({
      target: 'openapi-3.0',
      missing: 'Missing app page validator',
      invalid: e => e,
    });
    validation.install(routes);
    const users = new WeakMap<FastifyRequest, string>();

    routes.addHook('onRequest', async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers.origin !== authConfig().webOrigin)
        return reply.code(403).send({ error: 'untrusted-origin' });
      const session = await dependencies.auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
      if (!session) return reply.code(401).send({ error: 'sign-in-required' });
      const workspace = z.uuid().safeParse((request.params as { workspaceId?: string }).workspaceId);
      if (!workspace.success || !(await isFeatureEnabled('app-hosting', null, { id: workspace.data })))
        return reply.code(404).send({ error: 'not-found' });
      users.set(request, session.user.id);
    });

    routes.setErrorHandler((error, request, reply) => {
      if (error instanceof PageFailure) return reply.code(error.status).send({ error: error.code });
      if (error instanceof AccessDenied) return reply.code(404).send({ error: 'not-found' });
      if (error instanceof z.ZodError || (typeof error === 'object' && error !== null && 'validation' in error))
        return reply.code(400).send({ error: 'invalid-request' });
      if (requestBoundaryError(error, reply)) return;
      request.log.error(errorAttributes(error), 'app_page_route_failed');
      return reply.code(503).send({ error: 'apps-unavailable' });
    });

    // oxlint-disable-next-line tulipfarm/product-copy -- A stable route, not user-facing copy.
    const base = '/workspaces/:workspaceId/apps/:appId/pages/:page';
    const context = (request: FastifyRequest) => {
      const params = request.params as z.infer<typeof actionParams>;
      return {
        workspaceId: params.workspaceId.toLowerCase(),
        userId: users.get(request)!,
        params,
        draft: (request.query as z.infer<typeof pageQuery>).draft === 'true',
      };
    };

    routes.get(
      base,
      {
        schema: {
          operationId: 'getAppPageV1',
          hide: true,
          params: validation.json(pageParams),
          querystring: validation.json(pageQuery),
        },
      },
      async request => {
        const { workspaceId, userId, params, draft } = context(request);
        return transaction(workspaceId, async tx => {
          const member = await memberOf(tx, userId);
          const loaded = await load(tx, member, params.appId, params.page, draft);
          const absent = await absentReferences(tx, pageReferences(loaded.page));
          const actions = [];
          for (const action of loaded.page.actions)
            actions.push({
              id: action.id,
              label: action.label,
              availability: await availability(tx, member, action, absent),
            });
          return {
            draft,
            navigation: loaded.definition.pages.map(({ slug, title }) => ({ slug, title })),
            page: { slug: loaded.page.slug, title: loaded.page.title, surface: loaded.page.surface, actions },
          };
        });
      },
    );

    routes.post(
      `${base}/data`,
      {
        schema: {
          operationId: 'readAppPageDataV1',
          hide: true,
          params: validation.json(pageParams),
          querystring: validation.json(pageQuery),
          body: validation.json(dataBody),
        },
      },
      async request => {
        const { workspaceId, userId, params, draft } = context(request);
        const body = request.body as z.infer<typeof dataBody>;
        const { member, loaded, absent } = await transaction(workspaceId, async tx => {
          const member = await memberOf(tx, userId);
          const loaded = await load(tx, member, params.appId, params.page, draft);
          const absent = await absentReferences(tx, pageReferences(loaded.page));
          await reportBroken(workspaceId, tx, loaded, absent);
          return { member, loaded, absent };
        });
        const sources: Record<string, SourceState> = {};
        for (const source of loaded.page.sources)
          sources[source.id] = sourceReferences(loaded.page, source).some(reference => absent.has(reference))
            ? { status: 'unavailable', loadedAt: new Date().toISOString(), value: null }
            : await readSource(workspaceId, member, loaded.page, source, body.row);
        return {
          version: layoutVersion,
          updateDataModel: { surfaceId: loaded.page.id, path: '/sources', value: sources },
        };
      },
    );

    routes.post(
      `${base}/actions/:action`,
      {
        schema: {
          operationId: 'runAppPageActionV1',
          hide: true,
          params: validation.json(actionParams),
          querystring: validation.json(pageQuery),
          body: validation.json(actionBody),
        },
      },
      async request => {
        const { workspaceId, userId, params, draft } = context(request);
        const body = request.body as z.infer<typeof actionBody>;
        const { loaded, action, available } = await transaction(workspaceId, async tx => {
          const member = await memberOf(tx, userId);
          const loaded = await load(tx, member, params.appId, params.page, draft);
          const action = loaded.page.actions.find(candidate => candidate.id === params.action);
          if (!action) throw new AccessDenied();
          const reference = actionReference(action);
          const absent = await absentReferences(tx, reference ? [reference] : []);
          await reportBroken(workspaceId, tx, loaded, absent);
          return { loaded, action, available: await availability(tx, member, action, absent) };
        });
        const declared = new Set(actionBindings(action).map(binding => binding.context));
        const sent = Object.keys(body.context);
        if (sent.length !== declared.size || sent.some(key => !declared.has(key)))
          throw new PageFailure(400, 'invalid-context');
        if (available === 'unavailable') throw new PageFailure(409, 'action-unavailable');
        if (available === 'restricted') throw new PageFailure(403, 'forbidden');
        if (loaded.draft && body.confirmed !== true) throw new PageFailure(409, 'confirmation-required');
        const value = (binding: { context: string }) => body.context[binding.context];
        switch (action.kind) {
          case 'open-page': {
            const target = loaded.definition.pages.find(candidate => candidate.id === action.pageId);
            if (!target) throw new PageFailure(409, 'action-unavailable');
            const row = action.row ? z.uuid().safeParse(value(action.row)) : null;
            if (row && !row.success) throw new PageFailure(400, 'invalid-context');
            return { kind: 'open-page', page: target.slug, ...(row ? { row: row.data } : {}) };
          }
          case 'open-record': {
            const target = z.strictObject({ tableId: z.uuid(), recordId: z.uuid() }).safeParse(value(action.target));
            if (!target.success) throw new PageFailure(400, 'invalid-context');
            return { kind: 'open-record', ...target.data };
          }
          case 'run-workflow': {
            const input = Object.fromEntries(
              Object.entries(action.input).map(([name, binding]) => [name, value(binding)]),
            );
            const { runId } = await dependencies.startWorkflow(workspaceId, userId, action.workflowId, {
              requestId: body.requestId,
              input,
            });
            return { kind: 'run-workflow', runId };
          }
          case 'ask-agent': {
            const values = Object.fromEntries(
              Object.entries(action.bindings).map(([name, binding]) => [
                name,
                body.labels?.[binding.context] ?? value(binding),
              ]),
            );
            const { taskId } = await dependencies.askAgent(workspaceId, userId, {
              requestId: body.requestId,
              agentId: action.agentId,
              text: agentText(action, values),
            });
            return { kind: 'ask-agent', taskId };
          }
        }
      },
    );
  });
}
