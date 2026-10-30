import type { FastifyError, FastifyInstance } from 'fastify';
import { fromNodeHeaders } from 'better-auth/node';
import { z } from 'zod';
import { AccessDenied, lockAuthorization, resolveHuman } from '@tulipfarm/access';
import {
  openSlackModal,
  slackActionViewSchema,
  slackConfigurationSchema,
  slackDecisionSchema,
  slackFormAnswers,
  slackFormCallbackId,
  slackModalView,
  slackPickedText,
} from '@tulipfarm/slack';
import { log } from '@tulipfarm/observability';
import { createSlackActions, createSlackActionDecision } from '@tulipfarm/agents/slack-actions';
import { slackActionSettings } from '@tulipfarm/agents/slack-environment';
import { createSlackChannelAgents } from '@tulipfarm/agents/slack-channels';
import {
  createSlackDefault,
  slackReplyRetryAction,
  slackRowDraftApprove,
  slackRowDraftDismiss,
  slackRowDraftValueSchema,
} from '@tulipfarm/agents/slack-default';
import { qualified, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { authConfig, type registerAuth } from './auth.ts';
import { SlackSignatureError, verifySlackRequest } from './slack-request.ts';

// Tells only the person who pressed a button what happened; the thread itself stays unchanged.
async function respondEphemeral(responseUrl: string | undefined, text: string) {
  if (!responseUrl || new URL(responseUrl).origin !== 'https://hooks.slack.com') return;
  try {
    await fetch(responseUrl, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response_type: 'ephemeral', replace_original: false, text }),
    });
  } catch {
    // The retry is already recorded; a missed confirmation only hides the status from the person who pressed it.
  }
}

const rowDraftReplies = {
  created: 'Row added.',
  updated: 'Row updated.',
  deleted: 'Row deleted.',
  dismissed: 'Draft dismissed. No row was changed.',
  stale: 'The table or row changed after this draft. Nothing was changed. Ask again for a fresh draft.',
  decided: 'This row change was already decided. Nothing else was changed.',
} as const;

export function registerSlackActions(
  app: FastifyInstance,
  options: {
    auth: ReturnType<typeof registerAuth>['auth'];
    pool: Pick<ReturnType<typeof registerAuth>['pool'], 'query'>;
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
    // Presses on a laid-out reply: follow-up buttons, choices, forms, modals, links and feedback.
    const clicker = (team: string, user: string) => ({ appId: config.appId, teamId: team, slackUserId: user });
    const workspaceFor = async (team: string) =>
      z
        .object({ workspace_id: z.uuid() })
        .optional()
        .parse(
          (
            await options.pool.query(
              `SELECT workspace_id FROM app.slack_workspace_links WHERE app_id=$1 AND team_id=$2 AND state='active'`,
              [config.appId, team],
            )
          ).rows[0],
        )?.workspace_id;
    const followUp = async (
      team: string,
      user: string,
      reply: { channel: string; messageTs: string },
      text: string,
    ): Promise<string> => {
      const workspaceId = await workspaceFor(team);
      if (!workspaceId) return 'This Slack workspace is no longer connected to TulipFarm.';
      try {
        const outcome = await defaults.followUp(workspaceId, reply, clicker(team, user), text.slice(0, 4000));
        return outcome === 'busy' ? 'Wait for the current reply to finish, then try again.' : 'Working on it.';
      } catch (error) {
        if (!(error instanceof AccessDenied)) throw error;
        return 'Only the person who asked can answer this reply.';
      }
    };
    const pickedSchema = z.looseObject({
      action_id: z.string().max(255),
      block_id: z.string().max(255).optional(),
    });
    const blocksSchema = z
      .array(
        z.looseObject({
          type: z.string().optional(),
          block_id: z.string().optional(),
          label: z.object({ text: z.string().optional() }).optional(),
        }),
      )
      .max(100);
    const stateSchema = z.object({ values: z.record(z.string(), z.record(z.string(), z.looseObject({}))) });
    const interactionSchema = z.discriminatedUnion('type', [
      z.object({
        type: z.literal('block_actions'),
        api_app_id: z.literal(config.appId),
        team: z.object({ id: z.string() }),
        user: z.object({ id: z.string() }),
        trigger_id: z.string().max(255).optional(),
        response_url: z.url().optional(),
        container: z.object({ message_ts: z.string(), channel_id: z.string() }),
        message: z.object({ blocks: blocksSchema.optional() }).optional(),
        state: stateSchema.optional(),
        actions: z.array(pickedSchema).length(1),
      }),
      z.object({
        type: z.literal('view_submission'),
        api_app_id: z.literal(config.appId),
        team: z.object({ id: z.string() }),
        user: z.object({ id: z.string() }),
        view: z.object({
          callback_id: z.literal(slackFormCallbackId),
          private_metadata: z.string().max(3000),
          title: z.object({ text: z.string() }),
          blocks: blocksSchema,
          state: stateSchema,
        }),
      }),
    ]);
    const isReplyInteraction = (value: unknown) => {
      const probe = z
        .object({
          type: z.string(),
          actions: z.array(z.object({ action_id: z.string() })).optional(),
          view: z.object({ callback_id: z.string().optional() }).optional(),
        })
        .safeParse(value);
      if (!probe.success) return false;
      if (probe.data.type === 'view_submission') return probe.data.view?.callback_id === slackFormCallbackId;
      return probe.data.type === 'block_actions' && Boolean(probe.data.actions?.[0]?.action_id.startsWith('tf_'));
    };
    const replyInteraction = async (value: unknown): Promise<Record<string, unknown> | undefined> => {
      const payload = interactionSchema.parse(value);
      if (payload.type === 'view_submission') {
        const origin = z
          .strictObject({ channel: z.string(), messageTs: z.string() })
          .parse(JSON.parse(payload.view.private_metadata));
        const answers = slackFormAnswers(payload.view.state.values, payload.view.blocks);
        const text = await followUp(
          payload.team.id,
          payload.user.id,
          origin,
          `Form "${payload.view.title.text}":\n${answers}`,
        );
        const field = payload.view.blocks.find(block => block.type === 'input' && block.block_id)?.block_id;
        return text === 'Working on it.' || !field
          ? undefined
          : { response_action: 'errors', errors: { [field]: text } };
      }
      const action = payload.actions[0];
      if (!action) throw new SyntaxError();
      const reply = { channel: payload.container.channel_id, messageTs: payload.container.message_ts };
      const [kind, modalId] = action.action_id.split(':');
      let text: string | undefined;
      if (kind === 'tf_feedback') {
        log('info', 'activity', 'call_completed', {
          operation: 'slack.reply.feedback',
          outcome: action.value === 'positive' ? 'positive' : 'negative',
        });
        text = 'Thanks for the feedback.';
      } else if (kind === 'tf_followup' && typeof action.value === 'string')
        text = await followUp(payload.team.id, payload.user.id, reply, action.value);
      else if (kind === 'tf_choice') {
        const picked = slackPickedText(action);
        if (picked) text = await followUp(payload.team.id, payload.user.id, reply, picked);
      } else if (kind === 'tf_submit') {
        const answers = slackFormAnswers(payload.state?.values ?? {}, payload.message?.blocks ?? []);
        text = answers
          ? await followUp(payload.team.id, payload.user.id, reply, `Form answers:\n${answers}`)
          : 'Fill in the form first.';
      } else if (kind === 'tf_modal' && modalId && payload.trigger_id) {
        const workspaceId = await workspaceFor(payload.team.id);
        const found = workspaceId
          ? await defaults
              .replyModal(workspaceId, reply, clicker(payload.team.id, payload.user.id), modalId)
              .catch((error: unknown) => {
                if (error instanceof AccessDenied) return null;
                throw error;
              })
          : undefined;
        if (found)
          await openSlackModal({
            token: found.token,
            triggerId: payload.trigger_id,
            view: slackModalView(found.modal, JSON.stringify(reply)),
          });
        else
          text =
            found === null ? 'Only the person who asked can answer this reply.' : 'This form is no longer available.';
      }
      if (text) await respondEphemeral(payload.response_url, text);
      return {};
    };
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
          const raw: unknown = JSON.parse(form.get('payload') ?? '');
          if (isReplyInteraction(raw)) {
            const answer = await replyInteraction(raw);
            return answer === undefined ? reply.code(200).send() : answer;
          }
          const payload = z
            .object({
              type: z.literal('block_actions'),
              api_app_id: z.literal(config.appId),
              team: z.object({ id: z.string() }),
              user: z.object({ id: z.string() }),
              response_url: z.url().optional(),
              actions: z
                .array(
                  z.object({
                    action_id: z.enum([
                      'slack_action_approve',
                      'slack_action_reject',
                      slackReplyRetryAction,
                      slackRowDraftApprove,
                      slackRowDraftDismiss,
                    ]),
                    value: z.string().max(512),
                  }),
                )
                .length(1),
            })
            .parse(raw);
          const action = payload.actions[0];
          if (!action) throw new SyntaxError();
          if (action.action_id === slackReplyRetryAction) {
            const value = z.strictObject({ workspaceId: z.uuid(), eventId: z.uuid() }).parse(JSON.parse(action.value));
            let text: string;
            try {
              text =
                (await defaults.retry(value.workspaceId, value.eventId, {
                  appId: config.appId,
                  teamId: payload.team.id,
                  slackUserId: payload.user.id,
                })) === 'retrying'
                  ? 'Retrying your request now.'
                  : 'This request was already retried.';
            } catch (error) {
              if (!(error instanceof AccessDenied)) throw error;
              text = 'Only the person who asked can retry this request.';
            }
            await respondEphemeral(payload.response_url, text);
            return {};
          }
          if (action.action_id === slackRowDraftApprove || action.action_id === slackRowDraftDismiss) {
            const value = slackRowDraftValueSchema.parse(JSON.parse(action.value));
            let text: string;
            try {
              text =
                rowDraftReplies[
                  await defaults.decideRowDraft(value, action.action_id === slackRowDraftApprove ? 'save' : 'dismiss', {
                    appId: config.appId,
                    teamId: payload.team.id,
                    slackUserId: payload.user.id,
                  })
                ];
            } catch (error) {
              if (!(error instanceof AccessDenied)) throw error;
              text =
                'Nothing was changed. Only the person who asked can decide this row change, while they can still see this thread and the table.';
            }
            await respondEphemeral(payload.response_url, text);
            return {};
          }
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
