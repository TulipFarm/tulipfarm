import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { GitHubWebhookError, githubWebhookBodyLimit } from '@tulipfarm/github/event-signature';
import {
  createGitHubKnowledgeEvents,
  GitHubKnowledgeEventConflict,
  type GitHubKnowledgeEvents,
} from '@tulipfarm/github/knowledge-events';

const errorSchema = { type: 'object', properties: { error: { type: 'string' } }, required: ['error'] };

/** The webhook intake is on only when a GitHub App ID and its webhook secret are both configured. */
export function githubKnowledgeEventsFromEnvironment(
  pool: Pool | undefined,
  env: NodeJS.ProcessEnv = process.env,
): GitHubKnowledgeEvents | null {
  const appId = env.GITHUB_WEBHOOK_APP_ID?.trim();
  const signingSecret = env.GITHUB_WEBHOOK_SECRET;
  if (!pool || !appId) return null;
  if (!signingSecret) throw new Error('GITHUB_WEBHOOK_SECRET is required when GITHUB_WEBHOOK_APP_ID is set');
  if (signingSecret.length < 32 || signingSecret.length > 4096)
    throw new Error('GITHUB_WEBHOOK_SECRET must be 32 to 4096 characters');
  return createGitHubKnowledgeEvents({ pool, appId, signingSecret });
}

export function registerGitHubKnowledgeEvents(app: FastifyInstance, events: GitHubKnowledgeEvents | null) {
  app.register(async routes => {
    routes.removeContentTypeParser('application/json');
    routes.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer', bodyLimit: githubWebhookBodyLimit },
      (_request, body, done) => done(null, body),
    );
    const intake = (path: string, operationId: string, summary: string, keepBody: boolean) =>
      routes.post(
        path,
        {
          bodyLimit: githubWebhookBodyLimit,
          schema: {
            operationId,
            summary,
            tags: ['Knowledge'],
            response: {
              202: {
                type: 'object',
                properties: {
                  deliveryId: { type: 'string' },
                  status: { type: 'string' },
                  reason: { type: ['string', 'null'] },
                  duplicate: { type: 'boolean' },
                },
                required: ['deliveryId', 'status', 'reason', 'duplicate'],
              },
              400: errorSchema,
              401: errorSchema,
              409: errorSchema,
              413: errorSchema,
              415: errorSchema,
              503: errorSchema,
            },
          },
        },
        async (request, reply) => {
          if (!events) return reply.code(503).send({ error: 'github-webhooks-disabled' });
          if (!Buffer.isBuffer(request.body)) return reply.code(400).send({ error: 'invalid-request' });
          try {
            return reply.code(202).send(await events.accept(request.body, request.headers, { keepBody }));
          } catch (error) {
            if (error instanceof GitHubWebhookError)
              return reply
                .code(error.code === 'signature-invalid' ? 401 : error.code === 'payload-too-large' ? 413 : 400)
                .send({ error: error.code });
            if (error instanceof GitHubKnowledgeEventConflict)
              return reply.code(409).send({ error: 'delivery-conflict' });
            request.log.error({ err: error }, 'GitHub webhook delivery was not recorded');
            return reply.code(503).send({ error: 'github-webhook-unavailable' });
          }
        },
      );
    intake(
      '/github/knowledge/events',
      'receiveGitHubKnowledgeEventV1',
      'Record a signed GitHub webhook delivery that marks GitHub Knowledge sources as changed',
      false,
    );
    intake(
      '/github/events',
      'receiveGitHubEventV1',
      'Record any signed GitHub App webhook delivery; its body is kept for one minute',
      true,
    );
  });
}
