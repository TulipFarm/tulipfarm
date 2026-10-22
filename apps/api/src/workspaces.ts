import { fromNodeHeaders } from 'better-auth/node';
import { APIError } from 'better-auth/api';
import { createBackgroundJob, log } from '@tulipfarm/observability';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  createWorkspaceSchema,
  workspaceSchema,
  workspaceListSchema,
  workspaceSetupSchema,
} from '@tulipfarm/workspaces/contracts';
import {
  createWorkspace,
  getWorkspace,
  getWorkspaceSetup,
  listWorkspaces,
  pendingWorkspaceIds,
  rememberLastWorkspace,
  WorkspaceConflict,
  WorkspaceNotFound,
  WorkspaceDiscoveryUnavailable,
} from '@tulipfarm/workspaces/store';
import { isolatedStorageEnabled, workspaceRuntime } from '@tulipfarm/workspaces/storage';
import { authConfig, type registerAuth } from './auth.ts';
import { createTurnstileVerifier, turnstileConfig } from './turnstile.ts';
import type { createTemporalClient } from './temporal.ts';
import { registerOnboarding } from './onboarding.ts';

const errorSchema = { type: 'object', properties: { error: { type: 'string' } }, required: ['error'] };

function failure(error: unknown) {
  const detail = (value: unknown) =>
    value instanceof Error
      ? { name: value.name, code: (value as { code?: unknown }).code, message: value.message.slice(0, 300) }
      : { value: String(value).slice(0, 300) };
  return {
    failure: detail(error),
    cause: error instanceof Error && error.cause !== undefined ? detail(error.cause) : undefined,
  };
}

export function registerWorkspaces(
  app: FastifyInstance,
  dependencies: ReturnType<typeof registerAuth>,
  temporal: ReturnType<typeof createTemporalClient>,
) {
  const { auth, pool } = dependencies;
  const verifyChallenge = createTurnstileVerifier(turnstileConfig(), authConfig().webOrigin, 'create_workspace');
  const creationRequest = createWorkspaceSchema.extend({ challengeToken: z.string().max(2048).optional() });
  const jsonWorkspace = z.toJSONSchema(workspaceSchema, { target: 'openapi-3.0' });
  const enabled = isolatedStorageEnabled();
  const runtime = enabled ? workspaceRuntime(pool) : undefined;
  const store = runtime ? { pool, runtime } : undefined;

  async function dispatch(id: string) {
    await temporal.connection.withDeadline(Date.now() + 10000, () =>
      temporal.client.workflow.start('initializeIsolatedWorkspace', {
        workflowId: `workspace-storage-v1-${id}`,
        taskQueue: process.env.TEMPORAL_STORAGE_TASK_QUEUE ?? 'tulipfarm-storage-v1',
        args: [id],
        workflowIdConflictPolicy: 'USE_EXISTING',
        workflowIdReusePolicy: 'ALLOW_DUPLICATE',
      }),
    );
  }
  let stopping = false;
  let pending: Promise<void> | undefined;
  const dispatchJob = enabled ? createBackgroundJob('workspace-provisioning-dispatch', 5) : undefined;
  const dispatchPending = async () => {
    if (!enabled) return;
    for (const id of await pendingWorkspaceIds(pool)) {
      if (stopping) break;
      try {
        await dispatch(id);
      } catch {
        app.log.error({ workspaceId: id }, 'Workspace setup queued for dispatch retry');
      }
    }
  };
  const timer = setInterval(() => {
    if (pending || stopping) return;
    pending = (dispatchJob ? dispatchJob.run(dispatchPending) : dispatchPending())
      .catch(() => log('error', 'activity', 'dispatch_failed'))
      .finally(() => {
        pending = undefined;
      });
  }, 5000);
  timer.unref();
  app.addHook('onClose', async () => {
    stopping = true;
    clearInterval(timer);
    await pending;
    dispatchJob?.close();
    await runtime?.close();
  });

  app.register(async routes => {
    routes.addHook('onRequest', async (_request, reply) => {
      if (!store) return reply.code(503).send({ error: 'Workspace storage is unavailable' });
    });
    routes.post(
      '/workspaces',
      {
        schema: {
          operationId: 'createWorkspaceV1',
          summary: 'Create a workspace and initialize its Soul',
          tags: ['Workspaces'],
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['requestId', 'name', 'slug'],
            properties: {
              requestId: { type: 'string', format: 'uuid' },
              name: { type: 'string', minLength: 1, maxLength: 80 },
              slug: { type: 'string', minLength: 3, maxLength: 48, pattern: '^[a-z0-9]+(-[a-z0-9]+)*$' },
              challengeToken: { type: 'string', maxLength: 2048 },
              icon: { type: 'string', maxLength: 45000 },
            },
          },
          response: {
            200: jsonWorkspace,
            202: jsonWorkspace,
            400: errorSchema,
            401: errorSchema,
            403: errorSchema,
            404: errorSchema,
            409: errorSchema,
            503: errorSchema,
          },
        },
      },
      async (request, reply) => {
        const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
        if (!session) return reply.code(401).send({ error: 'Sign in to create a workspace' });
        const parsed = creationRequest.safeParse(request.body);
        if (!parsed.success)
          return reply.code(400).send({ error: 'Enter a workspace name and a valid, unreserved URL' });
        try {
          if (!store) return reply.code(503).send({ error: 'Workspace storage is unavailable' });
          const workspace = await createWorkspace(store, session.user.id, parsed.data, () =>
            verifyChallenge(parsed.data.challengeToken ?? null),
          );
          if (workspace.status === 'provisioning') {
            try {
              await dispatch(workspace.id);
            } catch {
              log('error', 'activity', 'dispatch_failed');
            }
          }
          return reply.code(workspace.status === 'ready' ? 200 : 202).send(workspace);
        } catch (error) {
          if (error instanceof APIError)
            return reply.code(error.statusCode === 503 ? 503 : 403).send({ error: error.message });
          if (error instanceof WorkspaceNotFound) return reply.code(404).send({ error: error.message });
          if (error instanceof WorkspaceConflict) return reply.code(409).send({ error: error.message });
          throw error;
        }
      },
    );
    routes.get(
      '/workspaces',
      {
        schema: {
          operationId: 'listWorkspacesV1',
          summary: 'List your workspaces',
          tags: ['Workspaces'],
          response: {
            200: z.toJSONSchema(workspaceListSchema, { target: 'openapi-3.0' }),
            401: errorSchema,
            503: errorSchema,
          },
        },
      },
      async (request, reply) => {
        const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
        if (!session) return reply.code(401).send({ error: 'Sign in to list workspaces' });
        if (!store) return reply.code(503).send({ error: 'Workspace storage is unavailable' });
        try {
          return await listWorkspaces(store, session.user.id);
        } catch (error) {
          if (error instanceof WorkspaceDiscoveryUnavailable) {
            request.log.error(failure(error), 'Workspace list unavailable');
            return reply.code(503).send({ error: error.message });
          }
          throw error;
        }
      },
    );
    routes.get<{ Params: { id: string } }>(
      '/workspace-setups/:id',
      {
        schema: {
          operationId: 'getWorkspaceSetupV1',
          summary: 'Get your workspace provisioning status',
          tags: ['Workspaces'],
          params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] },
          response: {
            200: z.toJSONSchema(workspaceSetupSchema, { target: 'openapi-3.0' }),
            401: errorSchema,
            404: errorSchema,
            503: errorSchema,
          },
        },
      },
      async (request, reply) => {
        const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
        if (!session) return reply.code(401).send({ error: 'Sign in to check workspace setup' });
        return (
          (await getWorkspaceSetup(pool, session.user.id, request.params.id)) ??
          reply.code(404).send({ error: 'Workspace setup not found' })
        );
      },
    );
    routes.put<{ Params: { slug: string } }>(
      '/workspaces/:slug/last-used',
      {
        schema: {
          hide: true,
          params: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
        },
      },
      async (request, reply) => {
        const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
        if (!session) return reply.code(401).send({ error: 'Sign in to remember a workspace' });
        if (!store) return reply.code(503).send({ error: 'Workspace storage is unavailable' });
        try {
          await rememberLastWorkspace(store, session.user.id, request.params.slug);
          return reply.code(204).send();
        } catch (error) {
          if (error instanceof WorkspaceNotFound) return reply.code(404).send({ error: error.message });
          throw error;
        }
      },
    );
    routes.get<{ Params: { slug: string } }>(
      '/workspaces/:slug',
      {
        schema: {
          operationId: 'getWorkspaceV1',
          summary: 'Get a workspace through current membership',
          tags: ['Workspaces'],
          params: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
          response: { 200: jsonWorkspace, 401: errorSchema, 404: errorSchema, 503: errorSchema },
        },
      },
      async (request, reply) => {
        const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
        if (!session) return reply.code(401).send({ error: 'Sign in to open a workspace' });
        if (!store) return reply.code(503).send({ error: 'Workspace storage is unavailable' });
        try {
          const workspace = await getWorkspace(store, session.user.id, request.params.slug);
          return workspace ?? reply.code(404).send({ error: 'Workspace not found' });
        } catch (error) {
          request.log.error(failure(error), 'Workspace open unavailable');
          return reply.code(503).send({ error: 'Workspace storage is unavailable. Retry.' });
        }
      },
    );
  });
  registerOnboarding(app, dependencies, store, dispatch);
  return runtime;
}
