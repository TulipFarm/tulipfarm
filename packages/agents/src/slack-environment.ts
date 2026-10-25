import { slackConfigurationSchema, slackCredentialCipher } from '@tulipfarm/slack';
import { isFeatureEnabled } from '@tulipfarm/observability';
import { createSlackActions, type SlackActionsFactory } from './slack-actions.ts';
import { createSlackChannelAgents } from './slack-channels.ts';
import type { AgentSetupOptions } from './setup.ts';
import type { WorkspaceRuntime } from '@tulipfarm/workspaces/storage';
import { chatObjectStore } from '@tulipfarm/workspaces/chat-objects';
import { createFiles } from '@tulipfarm/files';

export function slackAgentSetupFromEnvironment(
  runtime: Pick<WorkspaceRuntime, 'transaction'>,
  env: NodeJS.ProcessEnv = process.env,
): AgentSetupOptions {
  if (!env.SLACK_CHANNEL_AGENTS_ENABLED || env.SLACK_CHANNEL_AGENTS_ENABLED === 'false') return {};
  if (env.SLACK_CHANNEL_AGENTS_ENABLED !== 'true' || env.SLACK_LINK_PROMPTS_ENABLED !== 'true')
    throw new Error('slack-channel-setup-configuration-invalid');
  const config = slackConfigurationSchema.parse(JSON.parse(env.SLACK_CONFIGURATION ?? ''));
  if (
    !config.memberLinking ||
    (env.SLACK_PUBLIC_DELIVERY_ENABLED && !['true', 'false'].includes(env.SLACK_PUBLIC_DELIVERY_ENABLED))
  )
    throw new Error('slack-channel-setup-configuration-invalid');
  const channels = createSlackChannelAgents({
    runtime,
    appId: config.appId,
    cipher: slackCredentialCipher(JSON.parse(env.SLACK_CREDENTIAL_KEYS ?? '')),
    model: null,
    publicDelivery: env.SLACK_PUBLIC_DELIVERY_ENABLED === 'true',
  });
  return { attachSlack: channels.attachSetup, inspectSlack: channels.inspectSetup };
}

export function slackActionSettings(env: NodeJS.ProcessEnv = process.env) {
  if (!env.SLACK_OUTBOUND_ENABLED || env.SLACK_OUTBOUND_ENABLED === 'false') return null;
  if (env.SLACK_OUTBOUND_ENABLED !== 'true') throw new Error('slack-outbound-configuration-invalid');
  const config = slackConfigurationSchema.parse(JSON.parse(env.SLACK_CONFIGURATION ?? ''));
  if (!config.memberLinking) throw new Error('slack-outbound-configuration-invalid');
  return {
    appId: config.appId,
    outbound: true,
    cipher: slackCredentialCipher(JSON.parse(env.SLACK_CREDENTIAL_KEYS ?? '')),
    appSenderEnabled: (workspaceId: string, userId: string) =>
      isFeatureEnabled('slack-app-sender', { id: userId }, { id: workspaceId }),
  };
}
let objects: ReturnType<typeof chatObjectStore> | undefined;
/** Slack actions as configured. With file storage configured, a delivered message carries the images its run saved. */
export function slackActionsFromEnvironment(): SlackActionsFactory | undefined {
  const settings = slackActionSettings();
  if (!settings) return undefined;
  return runtime => {
    objects ??= chatObjectStore();
    return createSlackActions({ ...settings, runtime, ...(objects ? { images: createFiles(runtime, objects) } : {}) });
  };
}
