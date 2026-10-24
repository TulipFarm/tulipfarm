import { Pool } from 'pg';
import { Client, Connection } from '@temporalio/client';
import { temporalConnectionOptions } from '@tulipfarm/config/temporal';
import { z } from 'zod';
import {
  createSlackRecovery,
  createSlackLinkPrompts,
  slackPromptWorkSchema,
  slackConfigurationSchema,
  slackCredentialCipher,
  type SlackRuntime,
} from '@tulipfarm/slack';
import { createBackgroundJob, errorAttributes, isFeatureEnabled, log } from '@tulipfarm/observability';
import type { AttachmentBytes } from '@tulipfarm/conversations/attachments';
import { createSlackDirectMessages } from '@tulipfarm/slack';
import { createConversationExecutor } from '@tulipfarm/conversations/runtime';
import { createSlackChannelAgents } from '@tulipfarm/agents/slack-channels';
import { createSlackDefault } from '@tulipfarm/agents/slack-default';
import { meteredReply } from './conversation-activities.ts';
import { conversationCompactor } from './conversation-compactor.ts';
import { conversationModel } from './conversation-model.ts';
import { googleOperations } from './google-composition.ts';
import { integrationCredentialKeyring, createIntegrationService } from '@tulipfarm/integrations';
import type { ModelContinuity } from '@tulipfarm/agents/chat';
import { slackActionSettings } from '@tulipfarm/agents/slack-environment';
import { createSlackInstallationDiscovery } from './slack-installations.ts';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';

export function slackPromptSettings(env: NodeJS.ProcessEnv = process.env) {
  if (env.SLACK_PUBLIC_DELIVERY_ENABLED && !['true', 'false'].includes(env.SLACK_PUBLIC_DELIVERY_ENABLED))
    throw new Error('slack-prompts-configuration-invalid');
  if (env.SLACK_PUBLIC_DELIVERY_ENABLED === 'true' && env.SLACK_CHANNEL_AGENTS_ENABLED !== 'true')
    throw new Error('slack-prompts-configuration-invalid');
  if (env.SLACK_CHANNEL_AGENTS_ENABLED && !['true', 'false'].includes(env.SLACK_CHANNEL_AGENTS_ENABLED))
    throw new Error('slack-prompts-configuration-invalid');
  if (env.SLACK_CHANNEL_AGENTS_ENABLED === 'true' && env.SLACK_LINK_PROMPTS_ENABLED !== 'true')
    throw new Error('slack-prompts-configuration-invalid');
  if (env.SLACK_DIRECT_MESSAGES_ENABLED && !['true', 'false'].includes(env.SLACK_DIRECT_MESSAGES_ENABLED))
    throw new Error('slack-prompts-configuration-invalid');
  if (env.SLACK_DIRECT_MESSAGES_ENABLED === 'true' && env.SLACK_LINK_PROMPTS_ENABLED !== 'true')
    throw new Error('slack-prompts-configuration-invalid');
  if (!env.SLACK_LINK_PROMPTS_ENABLED || env.SLACK_LINK_PROMPTS_ENABLED === 'false') return null;
  if (env.SLACK_LINK_PROMPTS_ENABLED !== 'true') throw new Error('slack-prompts-configuration-invalid');
  try {
    const config = slackConfigurationSchema.parse(JSON.parse(env.SLACK_CONFIGURATION ?? ''));
    if (!config.memberLinking) throw new Error();
    return {
      config,
      cipher: slackCredentialCipher(JSON.parse(env.SLACK_CREDENTIAL_KEYS ?? '')),
      webOrigin: z.url().parse(env.WEB_ORIGIN),
      directMessages: env.SLACK_DIRECT_MESSAGES_ENABLED === 'true',
    };
  } catch {
    throw new Error('slack-prompts-configuration-invalid');
  }
}

export async function createSlackPromptComposition(
  runtime: SlackRuntime,
  model: ModelContinuity | null = null,
  modelFamilyId?: string,
  attachments?: AttachmentBytes,
) {
  const outboundSettings = slackActionSettings();
  const settings = slackPromptSettings();
  if (!settings) return undefined;
  const prompts = createSlackLinkPrompts({ runtime, ...settings, appId: settings.config.appId });
  const recovery = createSlackRecovery({ runtime, ...settings });
  const direct = settings.directMessages
    ? createSlackDirectMessages({
        runtime,
        ...settings,
        appId: settings.config.appId,
        ...(modelFamilyId ? { modelFamilyId } : {}),
        // Files shared in a direct message become its attachments while the `images` flag is on.
        ...(attachments
          ? {
              files: {
                enabled: (workspaceId: string) => isFeatureEnabled('images', null, { id: workspaceId }),
                bytes: attachments,
              },
            }
          : {}),
      })
    : undefined;
  const channelOptions = {
    runtime,
    ...settings,
    appId: settings.config.appId,
    outbound: Boolean(outboundSettings),
    model,
    ...(modelFamilyId ? { modelFamilyId } : {}),
    publicDelivery: process.env.SLACK_PUBLIC_DELIVERY_ENABLED === 'true',
    google: googleOperations,
    integrations: {
      readIssue: ((workspaceId, actor, input) =>
        createIntegrationService({ runtime, keyring: integrationCredentialKeyring() }).readIssue(
          workspaceId,
          actor,
          input,
        )) satisfies ReturnType<typeof createIntegrationService>['readIssue'],
    },
  };
  const channels =
    process.env.SLACK_CHANNEL_AGENTS_ENABLED === 'true' ? createSlackChannelAgents(channelOptions) : undefined;
  // Channel replies compact a long reply's tool results with the workspace policy and summary models, as a chat does.
  const compactor = conversationCompactor(runtime, family => conversationModel(family));
  const defaults = channels
    ? createSlackDefault({
        ...channelOptions,
        channels,
        compactor,
        reply: (guard, slack) => meteredReply(runtime, { externalContext: guard, slack, compactor }),
      })
    : undefined;
  const replies = createConversationExecutor(runtime);
  const pool = new Pool({
    connectionString: z.url().parse(process.env.WORKSPACE_AUTHORING_DATABASE_URL),
    max: 1,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
  });
  pool.on('error', () => log('error', 'dependency', 'database_connection_failed'));
  const installations = createSlackInstallationDiscovery(pool, runtime, settings.config.appId);
  let connection: Connection;
  try {
    connection = await Connection.connect(temporalConnectionOptions());
  } catch (error) {
    await pool.end();
    throw error;
  }
  const client = new Client({ connection, namespace: process.env.TEMPORAL_NAMESPACE ?? 'default' });
  let running: Promise<void> | undefined;
  let stopped = false;
  async function dispatch() {
    const failures: unknown[] = [];
    const report = (error: unknown, stage: string) => {
      failures.push(error);
      log('error', 'dependency', 'dispatch_failed', {
        ...errorAttributes(error),
        operation: 'slack.dispatch',
        'error.stage': stage,
      });
    };
    for (const workspaceId of await installations.next()) {
      if (stopped) return;
      try {
        if (!(await installations.installed(workspaceId))) continue;
        await recovery.refresh(workspaceId);
        if (channels)
          try {
            for (const work of [...(await channels.due(workspaceId)), ...((await defaults?.due(workspaceId)) ?? [])]) {
              try {
                await connection.withDeadline(Date.now() + 5000, () =>
                  client.workflow.start('slackChannelAgent', {
                    workflowId: `slack-channel-agent-${work.workspaceId}-${work.eventId}`,
                    taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? 'tulipfarm',
                    args: [work],
                    workflowIdConflictPolicy: 'USE_EXISTING',
                    workflowIdReusePolicy: 'ALLOW_DUPLICATE',
                  }),
                );
              } catch (error) {
                report(error, 'channel-start');
              }
            }
          } catch (error) {
            report(error, 'channel-discovery');
          }
        for (const work of await prompts.discover(workspaceId)) {
          if (stopped) return;
          await connection.withDeadline(Date.now() + 5000, () =>
            client.workflow.start('slackLinkPrompt', {
              workflowId: `slack-link-prompt-${work.workspaceId}-${work.eventId}`,
              taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? 'tulipfarm',
              args: [work],
              workflowIdConflictPolicy: 'USE_EXISTING',
              workflowIdReusePolicy: 'ALLOW_DUPLICATE',
            }),
          );
        }
        if (direct) {
          try {
            const admission = await direct.admitPending(workspaceId);
            for (const error of admission.failures) report(error, 'direct-admission');
            // Files are downloaded by each message's own workflow, so a slow download holds up no other message.
            for (const work of admission.files) {
              try {
                await connection.withDeadline(Date.now() + 5000, () =>
                  client.workflow.start('slackDirectMessageFiles', {
                    workflowId: `slack-dm-files-${work.workspaceId}-${work.eventId}`,
                    taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? 'tulipfarm',
                    args: [work],
                    workflowIdConflictPolicy: 'USE_EXISTING',
                    workflowIdReusePolicy: 'ALLOW_DUPLICATE',
                  }),
                );
              } catch (error) {
                report(error, 'direct-files-start');
              }
            }
          } catch (error) {
            report(error, 'direct-admission');
          }
          try {
            for (const work of await direct.due(workspaceId)) {
              try {
                await connection.withDeadline(Date.now() + 5000, () =>
                  client.workflow.start('slackDirectMessage', {
                    workflowId: `slack-dm-${work.workspaceId}-${work.eventId}`,
                    taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? 'tulipfarm',
                    args: [work],
                    workflowIdConflictPolicy: 'USE_EXISTING',
                    workflowIdReusePolicy: 'ALLOW_DUPLICATE',
                  }),
                );
              } catch (error) {
                report(error, 'direct-start');
              }
            }
          } catch (error) {
            report(error, 'direct-discovery');
          }
          for (const work of await replies.due(workspaceId)) {
            await connection.withDeadline(Date.now() + 5000, () =>
              client.workflow.start('conversationReply', {
                workflowId: `conversation-reply-v1-${work.workspaceId}-${work.turnId}-${work.generation}`,
                taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? 'tulipfarm',
                args: [work],
                workflowIdConflictPolicy: 'USE_EXISTING',
                workflowIdReusePolicy: 'ALLOW_DUPLICATE',
              }),
            );
            await replies.acknowledge(work);
          }
        }
      } catch (error) {
        report(error, 'workspace-dispatch');
      }
    }
    if (failures.length) throw new AggregateError(failures, 'Slack dispatch incomplete');
  }
  const dispatchJob = createBackgroundJob('slack-dispatch', 2);
  function tick() {
    if (stopped || running) return;
    running = dispatchJob
      .run(dispatch)
      .catch(() => undefined)
      .finally(() => {
        running = undefined;
      });
  }
  const timer = setInterval(tick, 2000);
  timer.unref();
  tick();
  return {
    activities: {
      deliverSlackLinkPrompt: async (value: unknown) => {
        const work = slackPromptWorkSchema.parse(value);
        await installations.requireInstalled(work.workspaceId);
        return prompts.process(work);
      },
      deliverSlackDirectMessage: async (value: unknown) => {
        const work = slackPromptWorkSchema.parse(value);
        if (!direct) throw new Error('slack-workspace-disabled');
        await installations.requireInstalled(work.workspaceId);
        return direct.process(work);
      },
      admitSlackDirectMessageFiles: async (value: unknown) => {
        const work = slackPromptWorkSchema.parse(value);
        if (!direct) throw new Error('slack-workspace-disabled');
        await installations.requireInstalled(work.workspaceId);
        return direct.admitFiles(work);
      },
      deliverSlackChannelAgent: async (value: unknown) => {
        const work = slackPromptWorkSchema.parse(value);
        if (!channels) throw new Error('slack-workspace-disabled');
        await installations.requireInstalled(work.workspaceId);
        const isDefault = await runtime.transaction(work.workspaceId, commonCompatibility, async tx =>
          Boolean(
            (
              await tx.client.query(`SELECT 1 FROM "${tx.schema}".tf_slack_default_turns WHERE event_id=$1`, [
                work.eventId,
              ])
            ).rowCount,
          ),
        );
        return isDefault && defaults ? defaults.process(work) : channels.process(work);
      },
    },
    async close() {
      stopped = true;
      clearInterval(timer);
      await running;
      dispatchJob.close();
      await connection.close();
      await pool.end();
    },
  };
}
