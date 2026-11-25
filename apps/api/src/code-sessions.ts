import { PassThrough } from 'node:stream';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AccessDenied, resolveHuman } from '@tulipfarm/access';
import { executionConfiguration } from '@tulipfarm/config/execution';
import { isFeatureEnabled, errorAttributes } from '@tulipfarm/observability';
import { codingAgentLabels, codingAgents } from '@tulipfarm/agents/coding-run-contracts';
import {
  codeModeAvailabilitySchema,
  codeSessionRequestAnswerSchema,
  codeSessionRequestViewSchema,
  codeSessionStartInputSchema,
  codeSessionViewSchema,
  codeTerminalChunkSchema,
  memberCodeSettingsSchema,
  turnModeSchema,
  type CodeModeAvailability,
  type CodeSessionRequestAnswer,
} from '@tulipfarm/agents/code-session-contracts';
import {
  answerCodeSessionRequest,
  CodeSessionError,
  createCodeSession,
  getConversationTurnMode,
  getMemberCodeSettings,
  listCodeSessions,
  listCodeSessionTerminalChunks,
  listOpenCodeSessionRequestsForMember,
  readCodeSession,
  setConversationTurnMode,
  stopCodeSession,
  updateMemberCodeSettings,
} from '@tulipfarm/agents/code-session-store';
import type { WorkspaceRuntime } from '@tulipfarm/workspaces/storage';
import { commonCompatibility, qualified } from '@tulipfarm/workspace-storage/runtime';
import { authConfig } from './auth.ts';
import { devSessionsAllowed } from './dev-session.ts';
import type { ApiCallsHttpAuth } from './api-calls.ts';
import { routeValidation } from './route-validation.ts';
import { requestBoundaryError, sourceCheckUnavailable } from './security.ts';
import { requestSession } from './request-session.ts';
import type { createTemporalClient } from './temporal.ts';

const workspaceParams = z.strictObject({ workspaceId: z.uuid() });
const chatParams = workspaceParams.extend({ chatId: z.uuid() });
const sessionParams = workspaceParams.extend({ sessionId: z.uuid() });
const requestParams = sessionParams.extend({ requestId: z.uuid() });

const startSessionBody = z.strictObject({
  request: z.string().trim().min(1).max(16000),
  title: z.string().trim().min(1).max(240).optional(),
  tableId: z.uuid().optional(),
  rowId: z.uuid().optional(),
  start: codeSessionStartInputSchema,
});

const answerBody = z.strictObject({
  decisionDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  answer: codeSessionRequestAnswerSchema,
});

const turnModeBody = z.strictObject({
  mode: turnModeSchema,
});

export type CodeSessionWorkflowController = {
  start(workspaceId: string, sessionId: string): Promise<void>;
  signalAnswer(sessionId: string, requestId: string, answer: CodeSessionRequestAnswer): Promise<void>;
  signalStop(sessionId: string): Promise<void>;
};

export function createCodeSessionWorkflowController(
  temporal: ReturnType<typeof createTemporalClient> | undefined,
  taskQueue: string,
): CodeSessionWorkflowController {
  return {
    async start(workspaceId, sessionId) {
      if (!temporal) return;
      try {
        await temporal.client.workflow.start('codeSession', {
          taskQueue,
          workflowId: `code-session-${sessionId}`,
          args: [{ workspaceId, sessionId }],
        });
      } catch (error) {
        if (error instanceof Error && error.name === 'WorkflowExecutionAlreadyStartedError') return;
        // Workflow start failures shouldn't fail the HTTP request after DB commit.
      }
    },
    async signalAnswer(sessionId, requestId, answer) {
      if (!temporal) return;
      try {
        const handle = temporal.client.workflow.getHandle(`code-session-${sessionId}`);
        await handle.signal('codeSessionSignal', { kind: 'answer', requestId, answer });
      } catch {
        // Ignore if workflow already finished.
      }
    },
    async signalStop(sessionId) {
      if (!temporal) return;
      try {
        const handle = temporal.client.workflow.getHandle(`code-session-${sessionId}`);
        await handle.signal('codeSessionSignal', { kind: 'stop' });
      } catch {
        // Ignore if workflow already finished.
      }
    },
  };
}

export function createCodeSessionService(options: {
  runtime: WorkspaceRuntime;
  workflows: CodeSessionWorkflowController;
  ensureDevPlans?: (workspaceId: string, userId: string) => Promise<void>;
}) {
  const { runtime, workflows, ensureDevPlans } = options;
  const actorOf = (workspaceId: string, userId: string) =>
    runtime.transaction(workspaceId, commonCompatibility, tx => resolveHuman(tx, userId));

  // Per-member per-repo GitHub read proof is not stored in knowledge tables;
  // fail closed so only the session owner reads private diffs, logs, and terminal output.
  const canReadRepoForMember = (_workspaceId: string, _membershipId: string) => async (_repository: string) => false;

  return {
    workflows,

    async availability(workspaceId: string, userId: string): Promise<CodeModeAvailability> {
      await ensureDevPlans?.(workspaceId, userId);
      const enabled = await isFeatureEnabled('code-sessions', { id: userId }, { id: workspaceId });
      const actor = await actorOf(workspaceId, userId);
      const settings = await getMemberCodeSettings(runtime, workspaceId, actor);
      const execConfig = executionConfiguration();
      const spawnboxReady = execConfig.mode !== 'off' || devSessionsAllowed();

      const { githubAccounts, connectedPlanProviders } = await runtime.transaction(
        workspaceId,
        commonCompatibility,
        async tx => {
          const githubTable = qualified(tx.schema, 'tf_github_accounts');
          const ghRes = await tx.client.query(
            `SELECT id, COALESCE(identity->>'login', identity->>'name', id::text) AS login
             FROM ${githubTable}
             WHERE state = 'active' AND owner_membership_id = $1
             ORDER BY created_at DESC`,
            [actor.membershipId],
          );

          const connectionsTable = qualified(tx.schema, 'tf_subscription_connections');
          const grantsTable = qualified(tx.schema, 'tf_subscription_grants');
          const teamMembersTable = qualified(tx.schema, 'tf_member_teams');
          const planRes = await tx.client.query(
            `SELECT DISTINCT c.provider
             FROM ${connectionsTable} c
             WHERE c.state = 'connected'
               AND (
                 c.owner_membership_id = $1
                 OR EXISTS (
                   SELECT 1 FROM ${grantsTable} g
                   WHERE g.connection_id = c.id
                     AND (
                       g.grantee = 'workspace'
                       OR g.membership_id = $1
                       OR (g.team_id IS NOT NULL AND EXISTS (
                         SELECT 1 FROM ${teamMembersTable} tm
                         WHERE tm.team_id = g.team_id AND tm.membership_id = $1
                       ))
                     )
                 )
               )`,
            [actor.membershipId],
          );

          return {
            githubAccounts: ghRes.rows
              .filter(row => typeof row.id === 'string' && typeof row.login === 'string')
              .map(row => ({ id: row.id, login: row.login })),
            connectedPlanProviders: new Set(planRes.rows.map(row => String(row.provider ?? ''))),
          };
        },
      );

      const providerByAgent = {
        'claude-code': 'claude',
        codex: 'chatgpt',
        copilot: 'copilot',
      } as const;

      const agents = codingAgents.map(agent => {
        const provider = providerByAgent[agent];
        const hasPlan = connectedPlanProviders.has(provider);
        return {
          agent,
          label: codingAgentLabels[agent],
          available: spawnboxReady && hasPlan,
          reason: !spawnboxReady
            ? 'Code execution sandbox is not configured on this deployment.'
            : !hasPlan
              ? `Connect your ${codingAgentLabels[agent]} plan in Settings → Models to run this agent.`
              : null,
        };
      });

      return {
        enabled,
        spawnboxReady,
        unavailableReason: !enabled
          ? 'Code sessions are not enabled for this workspace.'
          : !spawnboxReady
            ? 'This deployment does not have a code execution sandbox configured yet.'
            : null,
        agents,
        githubConnected: githubAccounts.length > 0,
        githubAccounts,
        settings,
      };
    },

    async getSettings(workspaceId: string, userId: string) {
      const actor = await actorOf(workspaceId, userId);
      return getMemberCodeSettings(runtime, workspaceId, actor);
    },

    async updateSettings(workspaceId: string, userId: string, input: z.infer<typeof memberCodeSettingsSchema>) {
      const actor = await actorOf(workspaceId, userId);
      return updateMemberCodeSettings(runtime, workspaceId, actor, input);
    },

    async getTurnMode(workspaceId: string, userId: string, chatId: string) {
      const actor = await actorOf(workspaceId, userId);
      const mode = await getConversationTurnMode(runtime, workspaceId, actor, chatId);
      return { mode };
    },

    async setTurnMode(workspaceId: string, userId: string, chatId: string, mode: z.infer<typeof turnModeSchema>) {
      const actor = await actorOf(workspaceId, userId);
      const saved = await setConversationTurnMode(runtime, workspaceId, actor, chatId, mode);
      return { mode: saved };
    },

    async list(
      workspaceId: string,
      userId: string,
      filters?: { conversationId?: string; rowId?: string; scope?: 'mine' | 'workspace' },
    ) {
      const actor = await actorOf(workspaceId, userId);
      const sessions = await listCodeSessions(runtime, workspaceId, actor, filters);
      return { sessions };
    },

    async read(workspaceId: string, userId: string, sessionId: string) {
      const actor = await actorOf(workspaceId, userId);
      return readCodeSession(runtime, workspaceId, actor, sessionId, {
        canReadRepo: canReadRepoForMember(workspaceId, actor.membershipId),
      });
    },

    async start(workspaceId: string, userId: string, input: z.infer<typeof startSessionBody>) {
      const avail = await this.availability(workspaceId, userId);
      if (!avail.enabled) {
        throw new CodeSessionError(
          'code-session-invalid-transition',
          'Code sessions are not enabled for this workspace.',
        );
      }
      if (!avail.spawnboxReady) {
        throw new CodeSessionError(
          'code-session-invalid-transition',
          'Code sessions require an active execution sandbox.',
        );
      }
      const chosenAgent = avail.agents.find(a => a.agent === input.start.agent);
      if (!chosenAgent?.available) {
        throw new CodeSessionError(
          'code-session-invalid-transition',
          chosenAgent?.reason ?? `Connect a ${input.start.agent} plan before starting a code session.`,
        );
      }
      const actor = await actorOf(workspaceId, userId);
      const session = await createCodeSession(runtime, workspaceId, actor, {
        request: input.request,
        ...(input.title ? { title: input.title } : {}),
        tableId: input.tableId ?? null,
        rowId: input.rowId ?? null,
        start: input.start,
      });
      await workflows.start(workspaceId, session.id);
      return session;
    },

    async stop(workspaceId: string, userId: string, sessionId: string) {
      const actor = await actorOf(workspaceId, userId);
      const session = await stopCodeSession(runtime, workspaceId, actor, sessionId);
      await workflows.signalStop(sessionId);
      return session;
    },

    async answer(
      workspaceId: string,
      userId: string,
      sessionId: string,
      requestId: string,
      input: z.infer<typeof answerBody>,
    ) {
      const actor = await actorOf(workspaceId, userId);
      const result = await answerCodeSessionRequest(runtime, workspaceId, actor, {
        sessionId,
        requestId,
        ...(input.decisionDigest ? { decisionDigest: input.decisionDigest } : {}),
        answer: input.answer,
      });
      await workflows.signalAnswer(sessionId, requestId, input.answer);
      return result;
    },

    async openRequests(workspaceId: string, userId: string) {
      const actor = await actorOf(workspaceId, userId);
      const items = await listOpenCodeSessionRequestsForMember(runtime, workspaceId, actor);
      return { items };
    },

    async repositories(workspaceId: string, userId: string) {
      const actor = await actorOf(workspaceId, userId);
      const items = await runtime.transaction(workspaceId, commonCompatibility, async tx => {
        const reposTable = qualified(tx.schema, 'tf_knowledge_github_repositories');
        const membersTable = qualified(tx.schema, 'tf_knowledge_github_members');
        const sourcesTable = qualified(tx.schema, 'tf_knowledge_sources');
        const res = await tx.client.query(
          `SELECT DISTINCT r.repository_id AS "repositoryId",
                  r.full_name AS "fullName",
                  COALESCE(r.visibility, 'private') AS visibility
           FROM ${reposTable} r
           JOIN ${membersTable} m ON m.source_id = r.source_id
           JOIN ${sourcesTable} s ON s.id = r.source_id
           WHERE r.state = 'active'
             AND r.excluded = false
             AND m.membership_id = $1
             AND s.state IN ('active', 'paused')
           ORDER BY "fullName"
           LIMIT 500`,
          [actor.membershipId],
        );
        return res.rows.map(row => ({
          repositoryId: String(row.repositoryId),
          fullName: String(row.fullName),
          visibility:
            row.visibility === 'public' || row.visibility === 'internal'
              ? (row.visibility as 'public' | 'internal')
              : ('private' as const),
        }));
      });
      return { items };
    },

    async terminal(workspaceId: string, userId: string, sessionId: string, afterId = 0) {
      const actor = await actorOf(workspaceId, userId);
      const canReadRepo = canReadRepoForMember(workspaceId, actor.membershipId);
      const [session, chunks] = await Promise.all([
        readCodeSession(runtime, workspaceId, actor, sessionId, { canReadRepo }),
        listCodeSessionTerminalChunks(runtime, workspaceId, actor, sessionId, { afterId, canReadRepo }),
      ]);
      return { session, chunks };
    },
  };
}

export function registerCodeSessions(
  app: FastifyInstance,
  auth: ApiCallsHttpAuth,
  service: ReturnType<typeof createCodeSessionService>,
) {
  app.register(async routes => {
    const validation = routeValidation({
      target: 'openapi-3.0',
      missing: 'Missing code session validator',
      invalid: error => error,
    });
    validation.install(routes, true);
    const sessions = new WeakMap<FastifyRequest, string>();

    routes.addHook('onRequest', async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      reply.header('Referrer-Policy', 'no-referrer');
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers.origin !== authConfig().webOrigin) {
        return reply.code(403).send({ error: 'untrusted-origin' });
      }
      const session = await requestSession(request, auth);
      if (!session) return reply.code(401).send({ error: 'sign-in-required' });
      sessions.set(request, session.user.id);
    });

    routes.setErrorHandler((error, request, reply) => {
      if (error instanceof z.ZodError || (typeof error === 'object' && error !== null && 'validation' in error)) {
        return reply.code(400).send({ error: 'invalid-code-session-request' });
      }
      if (requestBoundaryError(error, reply)) return;
      if (sourceCheckUnavailable(error, reply, 'code-sessions-unavailable')) return;
      if (error instanceof AccessDenied) return reply.code(404).send({ error: 'code-session-not-found' });
      if (error instanceof CodeSessionError) {
        const status =
          error.code === 'code-session-not-found' || error.code === 'code-session-request-not-found'
            ? 404
            : error.code === 'code-session-not-owner'
              ? 403
              : error.code === 'code-session-invalid-answer'
                ? 400
                : 409;
        return reply.code(status).send({ error: error.code, message: error.message });
      }
      request.log.error(errorAttributes(error), 'Code session request failed');
      return reply.code(500).send({ error: 'code-sessions-unavailable' });
    });

    const userIdOf = (request: FastifyRequest) => sessions.get(request)!;

    const codeRepositoriesResponseSchema = z.object({
      items: z.array(
        z.object({
          repositoryId: z.string(),
          fullName: z.string(),
          visibility: z.enum(['public', 'private', 'internal']),
        }),
      ),
    });

    routes.get(
      '/workspaces/:workspaceId/code-mode/availability',
      {
        schema: {
          params: validation.json(workspaceParams),
          response: { 200: validation.json(codeModeAvailabilitySchema) },
        },
      },
      request => {
        const { workspaceId } = workspaceParams.parse(request.params);
        return service.availability(workspaceId, userIdOf(request));
      },
    );

    routes.get(
      '/workspaces/:workspaceId/code-mode/repositories',
      {
        schema: {
          params: validation.json(workspaceParams),
          response: { 200: validation.json(codeRepositoriesResponseSchema) },
        },
      },
      request => {
        const { workspaceId } = workspaceParams.parse(request.params);
        return service.repositories(workspaceId, userIdOf(request));
      },
    );

    routes.get(
      '/workspaces/:workspaceId/members/me/code-settings',
      {
        schema: {
          params: validation.json(workspaceParams),
          response: { 200: validation.json(memberCodeSettingsSchema) },
        },
      },
      request => {
        const { workspaceId } = workspaceParams.parse(request.params);
        return service.getSettings(workspaceId, userIdOf(request));
      },
    );

    routes.put(
      '/workspaces/:workspaceId/members/me/code-settings',
      {
        schema: {
          params: validation.json(workspaceParams),
          body: validation.json(memberCodeSettingsSchema),
          response: { 200: validation.json(memberCodeSettingsSchema) },
        },
      },
      request => {
        const { workspaceId } = workspaceParams.parse(request.params);
        const body = memberCodeSettingsSchema.parse(request.body);
        return service.updateSettings(workspaceId, userIdOf(request), body);
      },
    );

    routes.get(
      '/workspaces/:workspaceId/chats/:chatId/turn-mode',
      {
        schema: {
          params: validation.json(chatParams),
          response: { 200: validation.json(turnModeBody) },
        },
      },
      request => {
        const { workspaceId, chatId } = chatParams.parse(request.params);
        return service.getTurnMode(workspaceId, userIdOf(request), chatId);
      },
    );

    routes.put(
      '/workspaces/:workspaceId/chats/:chatId/turn-mode',
      {
        schema: {
          params: validation.json(chatParams),
          body: validation.json(turnModeBody),
          response: { 200: validation.json(turnModeBody) },
        },
      },
      request => {
        const { workspaceId, chatId } = chatParams.parse(request.params);
        const body = turnModeBody.parse(request.body);
        return service.setTurnMode(workspaceId, userIdOf(request), chatId, body.mode);
      },
    );

    const sessionRequestPairSchema = z.strictObject({
      session: codeSessionViewSchema,
      request: codeSessionRequestViewSchema,
    });
    const openRequestsResponse = z.strictObject({
      items: z.array(sessionRequestPairSchema),
    });
    const sessionsListResponse = z.strictObject({
      sessions: z.array(codeSessionViewSchema),
    });

    routes.get(
      '/workspaces/:workspaceId/code-sessions/open-requests',
      {
        schema: {
          params: validation.json(workspaceParams),
          response: { 200: validation.json(openRequestsResponse) },
        },
      },
      request => {
        const { workspaceId } = workspaceParams.parse(request.params);
        return service.openRequests(workspaceId, userIdOf(request));
      },
    );

    routes.get(
      '/workspaces/:workspaceId/code-sessions',
      {
        schema: {
          params: validation.json(workspaceParams),
          response: { 200: validation.json(sessionsListResponse) },
        },
      },
      request => {
        const { workspaceId } = workspaceParams.parse(request.params);
        const query = z
          .object({
            conversationId: z.uuid().optional(),
            rowId: z.uuid().optional(),
            scope: z.enum(['mine', 'workspace']).optional(),
          })
          .parse(request.query);
        return service.list(workspaceId, userIdOf(request), {
          ...(query.conversationId ? { conversationId: query.conversationId } : {}),
          ...(query.rowId ? { rowId: query.rowId } : {}),
          ...(query.scope ? { scope: query.scope } : {}),
        });
      },
    );

    routes.post(
      '/workspaces/:workspaceId/code-sessions',
      {
        schema: {
          params: validation.json(workspaceParams),
          body: validation.json(startSessionBody),
          response: { 200: validation.json(codeSessionViewSchema) },
        },
      },
      request => {
        const { workspaceId } = workspaceParams.parse(request.params);
        const body = startSessionBody.parse(request.body);
        return service.start(workspaceId, userIdOf(request), body);
      },
    );

    routes.get(
      '/workspaces/:workspaceId/code-sessions/:sessionId',
      {
        schema: {
          params: validation.json(sessionParams),
          response: { 200: validation.json(codeSessionViewSchema) },
        },
      },
      request => {
        const { workspaceId, sessionId } = sessionParams.parse(request.params);
        return service.read(workspaceId, userIdOf(request), sessionId);
      },
    );

    routes.post(
      '/workspaces/:workspaceId/code-sessions/:sessionId/stop',
      {
        schema: {
          params: validation.json(sessionParams),
          response: { 200: validation.json(codeSessionViewSchema) },
        },
      },
      request => {
        const { workspaceId, sessionId } = sessionParams.parse(request.params);
        return service.stop(workspaceId, userIdOf(request), sessionId);
      },
    );

    routes.post(
      '/workspaces/:workspaceId/code-sessions/:sessionId/requests/:requestId/answer',
      {
        schema: {
          params: validation.json(requestParams),
          body: validation.json(answerBody),
          response: { 200: validation.json(sessionRequestPairSchema) },
        },
      },
      request => {
        const { workspaceId, sessionId, requestId } = requestParams.parse(request.params);
        const body = answerBody.parse(request.body);
        return service.answer(workspaceId, userIdOf(request), sessionId, requestId, body);
      },
    );

    const terminalQuery = z.object({
      afterId: z.coerce.number().int().nonnegative().optional(),
    });
    const terminalSnapshotResponse = z.strictObject({
      session: codeSessionViewSchema,
      chunks: z.array(codeTerminalChunkSchema),
    });

    routes.get(
      '/workspaces/:workspaceId/code-sessions/:sessionId/terminal',
      {
        schema: {
          params: validation.json(sessionParams),
          response: { 200: validation.json(terminalSnapshotResponse) },
        },
      },
      request => {
        const { workspaceId, sessionId } = sessionParams.parse(request.params);
        const { afterId } = terminalQuery.parse(request.query);
        return service.terminal(workspaceId, userIdOf(request), sessionId, afterId ?? 0);
      },
    );

    routes.get(
      '/workspaces/:workspaceId/code-sessions/:sessionId/terminal/stream',
      {
        logLevel: 'silent',
        schema: {
          params: validation.json(sessionParams),
          response: {
            200: {
              description: 'Live terminal output stream',
              content: { 'text/event-stream': { schema: { type: 'string' } } },
            },
          },
        },
      },
      async (request, reply) => {
        const { workspaceId, sessionId } = sessionParams.parse(request.params);
        const { afterId } = terminalQuery.parse(request.query);
        const userId = userIdOf(request);
        const initial = await service.terminal(workspaceId, userId, sessionId, afterId ?? 0);
        const stream = new PassThrough();
        let closed = false;
        let lastChunkId = initial.chunks.at(-1)?.id ?? afterId ?? 0;
        let lastSessionKey = JSON.stringify({
          stage: initial.session.stage,
          runState: initial.session.runState,
          updatedAt: initial.session.updatedAt,
          openRequestId: initial.session.openRequest?.id ?? null,
          pullRequestUrl: initial.session.pullRequestUrl,
        });

        const writeEvent = async (event: string, data: unknown) => {
          if (closed) return;
          const ok = stream.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
          if (!ok && !closed) {
            await new Promise<void>(resolve => {
              const onDrain = () => {
                stream.off('close', onDrain);
                resolve();
              };
              stream.once('drain', onDrain);
              stream.once('close', onDrain);
            });
          }
        };

        let pollTimer: ReturnType<typeof setTimeout> | null = null;
        const close = () => {
          if (closed) return;
          closed = true;
          if (pollTimer) clearTimeout(pollTimer);
          clearInterval(keepAliveTimer);
          clearTimeout(lifetimeTimer);
          stream.end();
        };

        const runPoll = async () => {
          if (closed) return;
          try {
            const next = await service.terminal(workspaceId, userId, sessionId, lastChunkId);
            for (const chunk of next.chunks) {
              if (closed) return;
              lastChunkId = Math.max(lastChunkId, chunk.id);
              await writeEvent('chunk', chunk);
            }
            const nextSessionKey = JSON.stringify({
              stage: next.session.stage,
              runState: next.session.runState,
              updatedAt: next.session.updatedAt,
              openRequestId: next.session.openRequest?.id ?? null,
              pullRequestUrl: next.session.pullRequestUrl,
            });
            if (!closed && nextSessionKey !== lastSessionKey) {
              lastSessionKey = nextSessionKey;
              await writeEvent('session', next.session);
            }
          } catch {
            close();
            return;
          }
          if (!closed) {
            pollTimer = setTimeout(() => void runPoll(), 500);
          }
        };

        void (async () => {
          await writeEvent('session', initial.session);
          for (const chunk of initial.chunks) {
            if (closed) return;
            await writeEvent('chunk', chunk);
          }
          if (!closed) {
            pollTimer = setTimeout(() => void runPoll(), 500);
          }
        })();

        const keepAliveTimer = setInterval(() => {
          if (!closed) stream.write(': keepalive\n\n');
        }, 15_000);

        const lifetimeTimer = setTimeout(close, 180_000);
        reply.raw.once('close', close);

        return reply
          .header('Content-Type', 'text/event-stream; charset=utf-8')
          .header('Cache-Control', 'no-cache, no-transform')
          .header('X-Accel-Buffering', 'no')
          .header('Connection', 'keep-alive')
          .send(stream);
      },
    );
  });
}
