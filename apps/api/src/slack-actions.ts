import type { FastifyError, FastifyInstance } from 'fastify';
import { fromNodeHeaders } from 'better-auth/node';
import { z } from 'zod';
import { AccessDenied, lockAuthorization, resolveHuman } from '@tulipfarm/access';
import { slackDecisionSchema, slackActionViewSchema, slackConfigurationSchema } from '@tulipfarm/slack';
import { createSlackActions, createSlackActionDecision } from '@tulipfarm/agents/slack-actions';
import { slackActionSettings } from '@tulipfarm/agents/slack-environment';
import { createSlackChannelAgents } from '@tulipfarm/agents/slack-channels';
import { createSlackDefault } from '@tulipfarm/agents/slack-default';
import { qualified, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { authConfig, type registerAuth } from './auth.ts';
import { SlackSignatureError, verifySlackRequest } from './slack-request.ts';

export function registerSlackActions(
  app: FastifyInstance,
  options: {
    auth: ReturnType<typeof registerAuth>['auth'];
    runtime: Parameters<typeof createSlackActions>[0]['runtime'];
    resolveConfirmationCredential: (workspaceId: string) => Promise<string>;
    wakeTaskAction?: (workspaceId: string, actionId: string) => Promise<void>;
  },
) {
  const settings = slackActionSettings();
  if (!settings) return;
  const config = slackConfigurationSchema.parse(JSON.parse(process.env.SLACK_CONFIGURATION ?? ''));
  const channels = createSlackChannelAgents({ ...settings, runtime: options.runtime, model: null });
  const defaults = createSlackDefault({
    ...settings,
    runtime: options.runtime,
    model: null,
    channels,
    reply: () => async () => {
      throw new Error('approval-does-not-infer');
    },
  });
  const serviceOptions = {
    ...settings,
    ...options,
    audienceSources: async (
      tx: Parameters<typeof channels.delivery.sources>[0],
      workspaceId: string,
      actor: Parameters<typeof channels.delivery.sources>[2],
      runId: string,
    ) => {
      const isDefault = (
        await tx.client.query(`SELECT 1 FROM ${qualified(tx.schema, 'tf_slack_default_turns')} WHERE event_id=$1`, [
          runId,
        ])
      ).rowCount;
      if (isDefault) await defaults.actionSources(tx, workspaceId, actor, runId);
      else await channels.delivery.sources(tx, workspaceId, actor, runId, new Set(), true);
    },
  };
  const service = createSlackActions(serviceOptions),
    decide = createSlackActionDecision(serviceOptions);
  app.register(async routes => {
    routes.addHook('onRequest', async (_request, reply) => {
      reply.header('Cache-Control', 'no-store');
    });
    routes.setErrorHandler<FastifyError>((error, _request, reply) => {
      if (error.statusCode === 413 || error.statusCode === 415)
        return reply.code(error.statusCode).send({ error: 'invalid-request' });
      if (error instanceof AccessDenied) return reply.code(404).send({ error: 'slack-action-unavailable' });
      if (error instanceof SlackSignatureError) return reply.code(401).send({ error: 'slack-signature-invalid' });
      if (error instanceof z.ZodError || error instanceof SyntaxError)
        return reply.code(400).send({ error: 'invalid-request' });
      if (error instanceof Error && ['slack-decision-conflict', 'slack-action-stale'].includes(error.message))
        return reply.code(409).send({ error: 'slack-action-changed' });
      return reply.code(503).send({ error: 'slack-action-unavailable' });
    });
    routes.get('/workspaces/:workspaceId/slack/tasks/:taskId/actions', async (request, reply) => {
      const session = await options.auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
      if (!session) return reply.code(401).send({ error: 'sign-in-required' });
      const p = z.object({ workspaceId: z.uuid(), taskId: z.uuid() }).parse(request.params);
      return service.taskActions(p.workspaceId, session.user.id, p.taskId);
    });
    routes.get('/workspaces/:workspaceId/slack/destinations/:destinationId', async (request, reply) => {
      const session = await options.auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
      if (!session) return reply.code(401).send({ error: 'sign-in-required' });
      const p = z.object({ workspaceId: z.uuid(), destinationId: z.uuid() }).parse(request.params);
      return service.destination(p.workspaceId, session.user.id, p.destinationId);
    });
    for (const method of ['GET', 'PUT'] as const)
      routes.route({
        method,
        url: '/workspaces/:workspaceId/slack/destinations',
        handler: async (request, reply) => {
          if (method === 'PUT' && request.headers.origin !== authConfig().webOrigin)
            return reply.code(403).send({ error: 'untrusted-origin' });
          const session = await options.auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
          if (!session) return reply.code(401).send({ error: 'sign-in-required' });
          const { workspaceId } = z.object({ workspaceId: z.uuid() }).parse(request.params);
          return method === 'GET'
            ? service.destinations(workspaceId, session.user.id)
            : service.configureDestination(workspaceId, session.user.id, request.body);
        },
      });
    for (const method of ['GET', 'PUT'] as const)
      routes.route({
        method,
        url: '/workspaces/:workspaceId/slack/actions/:actionId',
        handler: async (request, reply) => {
          if (method === 'PUT' && request.headers.origin !== authConfig().webOrigin)
            return reply.code(403).send({ error: 'untrusted-origin' });
          const session = await options.auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
          if (!session) return reply.code(401).send({ error: 'sign-in-required' });
          const params = z.object({ workspaceId: z.uuid(), actionId: z.uuid() }).parse(request.params);
          const result = slackActionViewSchema.parse(
            method === 'GET'
              ? await service.read(params.workspaceId, session.user.id, params.actionId)
              : await decide(
                  params.workspaceId,
                  session.user.id,
                  params.actionId,
                  slackDecisionSchema.parse(request.body),
                ),
          );
          if (method === 'PUT') await options.wakeTaskAction?.(params.workspaceId, params.actionId);
          return result;
        },
      });
    routes.register(async callbacks => {
      callbacks.addContentTypeParser(
        'application/x-www-form-urlencoded',
        { parseAs: 'buffer', bodyLimit: 131072 },
        (_request, body, done) => done(null, body),
      );
      callbacks.post(
        '/slack/actions',
        { bodyLimit: 131072, schema: { operationId: 'receiveSlackActionV1' } },
        async (request, reply) => {
          if (!Buffer.isBuffer(request.body)) return reply.code(400).send({ error: 'invalid-request' });
          verifySlackRequest({
            body: request.body,
            secret: config.signingSecret,
            timestamp:
              typeof request.headers['x-slack-request-timestamp'] === 'string'
                ? request.headers['x-slack-request-timestamp']
                : undefined,
            signature:
              typeof request.headers['x-slack-signature'] === 'string'
                ? request.headers['x-slack-signature']
                : undefined,
          });
          const form = new URLSearchParams(request.body.toString('utf8'));
          if (form.getAll('payload').length !== 1 || [...form.keys()].some(key => key !== 'payload'))
            throw new SyntaxError();
          const payload = z
            .object({
              type: z.literal('block_actions'),
              api_app_id: z.literal(config.appId),
              team: z.object({ id: z.string() }),
              user: z.object({ id: z.string() }),
              actions: z
                .array(
                  z.object({
                    action_id: z.enum(['slack_action_approve', 'slack_action_reject']),
                    value: z.string().max(512),
                  }),
                )
                .length(1),
            })
            .parse(JSON.parse(form.get('payload') ?? ''));
          const action = payload.actions[0];
          if (!action) throw new SyntaxError();
          const value = z
            .strictObject({ workspaceId: z.uuid(), actionId: z.uuid(), digest: slackDecisionSchema.shape.digest })
            .parse(JSON.parse(action.value));
          const userId = await options.runtime.transaction(value.workspaceId, commonCompatibility, async tx => {
            await lockAuthorization(tx);
            const table = (name: string) => qualified(tx.schema, name);
            const row = z
              .object({ user_id: z.string(), membership_id: z.uuid() })
              .optional()
              .parse(
                (
                  await tx.client.query(
                    `SELECT p.user_id,p.membership_id FROM ${table('tf_slack_actions')} a JOIN ${table('tf_slack_identities')} p ON p.id=a.identity_id AND p.membership_id=a.membership_id JOIN ${table('tf_slack_installations')} i ON i.id=p.installation_id AND i.generation=p.generation WHERE a.id=$1 AND i.app_id=$2 AND i.team_id=$3 AND i.state='active' AND p.state='authorized' AND p.slack_user_id=$4`,
                    [value.actionId, config.appId, payload.team.id, payload.user.id],
                  )
                ).rows[0],
              );
            if (!row || (await resolveHuman(tx, row.user_id)).membershipId !== row.membership_id)
              throw new AccessDenied();
            return row.user_id;
          });
          await decide(value.workspaceId, userId, value.actionId, {
            digest: value.digest,
            decision: action.action_id === 'slack_action_approve' ? 'approve' : 'reject',
          });
          await options.wakeTaskAction?.(value.workspaceId, value.actionId);
          return {};
        },
      );
    });
  });
}
