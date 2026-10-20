import { fromNodeHeaders } from 'better-auth/node';
import { createBackgroundJob } from '@tulipfarm/observability';
import { APIError } from 'better-auth/api';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { workspaceSchema, type Workspace } from '@tulipfarm/workspaces/contracts';
import {
  saveOnboardingSchema,
  resumeOnboardingSchema,
  completeOnboardingSchema,
  onboardingDraftSchema,
} from '@tulipfarm/workspaces/onboarding-contracts';
import {
  saveOnboarding,
  resumeOnboarding,
  expireOnboarding,
  OnboardingConflict,
  OnboardingUnavailable,
} from '@tulipfarm/workspaces/onboarding';
import { createWorkspace, WorkspaceConflict, WorkspaceNotFound } from '@tulipfarm/workspaces/store';
import type { WorkspaceStore } from '@tulipfarm/workspaces/storage';
import { authConfig, type registerAuth } from './auth.ts';
import { createTurnstileVerifier, turnstileConfig } from './turnstile.ts';

const json = (schema: z.ZodType) => z.toJSONSchema(schema, { target: 'openapi-3.0' });
const errorSchema = json(z.object({ error: z.string() }));

export function registerOnboarding(
  app: FastifyInstance,
  { auth, pool }: ReturnType<typeof registerAuth>,
  store: WorkspaceStore | undefined,
  dispatch: (id: string) => Promise<void>,
) {
  const verify = createTurnstileVerifier(turnstileConfig(), authConfig().webOrigin, 'create_workspace');
  let cleanup: Promise<void> | undefined;
  const cleanupJob = createBackgroundJob('onboarding-expiry', 60);
  const timer = setInterval(() => {
    cleanup ??= cleanupJob
      .run(() => expireOnboarding(pool))
      .catch(error => app.log.error({ err: error }, 'Onboarding draft cleanup failed'))
      .finally(() => {
        cleanup = undefined;
      });
  }, 60_000);
  timer.unref();
  app.addHook('onClose', async () => {
    clearInterval(timer);
    await cleanup;
    cleanupJob.close();
  });
  app.register(async routes => {
    routes.addHook('onRequest', async (_request, reply) => {
      reply.header('Cache-Control', 'no-store');
    });
    routes.setErrorHandler((error, _request, reply) => {
      if (error instanceof OnboardingUnavailable || error instanceof WorkspaceNotFound)
        return reply.code(404).send({ error: error.message });
      if (error instanceof OnboardingConflict || error instanceof WorkspaceConflict)
        return reply.code(409).send({ error: error.message });
      if (error instanceof APIError)
        return reply.code(error.statusCode === 503 ? 503 : 403).send({ error: error.message });
      throw error;
    });
    routes.post(
      '/onboarding/drafts',
      {
        bodyLimit: 16_384,
        schema: {
          operationId: 'saveOnboardingV1',
          tags: ['Onboarding'],
          summary: 'Save a temporary onboarding draft before signing in',
          body: json(saveOnboardingSchema),
          response: { 200: json(onboardingDraftSchema), 400: errorSchema, 404: errorSchema, 409: errorSchema },
        },
      },
      async (request, reply) => {
        const input = saveOnboardingSchema.safeParse(request.body);
        if (!input.success)
          return reply.code(400).send({ error: 'Enter valid workspace details and a secure draft token.' });
        return saveOnboarding(pool, input.data.token, input.data.details);
      },
    );
    routes.post(
      '/onboarding/resume',
      {
        schema: {
          operationId: 'resumeOnboardingV1',
          tags: ['Onboarding'],
          summary: 'Claim and read an onboarding draft after signing in',
          body: json(resumeOnboardingSchema),
          response: { 200: json(onboardingDraftSchema), 401: errorSchema, 404: errorSchema },
        },
      },
      async (request, reply) => {
        const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
        if (!session) return reply.code(401).send({ error: 'Sign in to resume onboarding.' });
        return resumeOnboarding(pool, resumeOnboardingSchema.parse(request.body).token, session.user.id);
      },
    );
    routes.post(
      '/onboarding/complete',
      {
        schema: {
          operationId: 'completeOnboardingV1',
          tags: ['Onboarding'],
          summary: 'Create a workspace from the signed-in user and saved draft',
          body: json(completeOnboardingSchema),
          response: {
            200: json(workspaceSchema),
            202: json(workspaceSchema),
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
        if (!session) return reply.code(401).send({ error: 'Sign in to create a workspace.' });
        if (!session.user.name.trim())
          return reply.code(403).send({ error: 'Complete your profile before creating a workspace.' });
        if (!store) return reply.code(503).send({ error: 'Workspace storage is unavailable.' });
        const input = completeOnboardingSchema.parse(request.body);
        const saved = await resumeOnboarding(pool, input.token, session.user.id);
        const workspace: Workspace = await createWorkspace(
          store,
          session.user.id,
          {
            requestId: saved.id,
            name: saved.details.name,
            slug: saved.details.slug,
          },
          () => verify(input.challengeToken ?? null),
        );
        if (workspace.status === 'provisioning') {
          try {
            await dispatch(workspace.id);
          } catch (error) {
            request.log.error({ err: error }, 'Onboarding workspace setup queued for dispatch retry');
          }
        }
        return reply.code(workspace.status === 'ready' ? 200 : 202).send(workspace);
      },
    );
  });
}
