import {
  createSlackInbox,
  createSlackInstallations,
  createSlackMemberLinking,
  slackConfigurationSchema,
  slackCredentialCipher,
} from '@tulipfarm/slack';
import { createSlackChannelAgents } from '@tulipfarm/agents/slack-channels';
import type { WorkspaceRuntime } from '@tulipfarm/workspaces/storage';
import type { registerAuth } from './auth.ts';
import type { SlackDependencies } from './slack.ts';
import type { DefaultKnowledgeHook } from '@tulipfarm/integrations/authorization';

export function slackDependencies(
  pool: ReturnType<typeof registerAuth>['pool'],
  runtime: WorkspaceRuntime | undefined,
  defaultKnowledge?: DefaultKnowledgeHook,
): SlackDependencies | null {
  if (!process.env.SLACK_INTAKE_ENABLED || process.env.SLACK_INTAKE_ENABLED === 'false') return null;
  try {
    if (process.env.SLACK_INTAKE_ENABLED !== 'true' || !runtime) throw new Error();
    const config = slackConfigurationSchema.parse(JSON.parse(process.env.SLACK_CONFIGURATION ?? ''));
    if (
      process.env.SLACK_CHANNEL_AGENTS_ENABLED &&
      !['true', 'false'].includes(process.env.SLACK_CHANNEL_AGENTS_ENABLED)
    )
      throw new Error();
    if (process.env.SLACK_CHANNEL_AGENTS_ENABLED === 'true' && !config.memberLinking) throw new Error();
    if (
      process.env.SLACK_PUBLIC_DELIVERY_ENABLED &&
      !['true', 'false'].includes(process.env.SLACK_PUBLIC_DELIVERY_ENABLED)
    )
      throw new Error();
    if (process.env.SLACK_PUBLIC_DELIVERY_ENABLED === 'true' && process.env.SLACK_CHANNEL_AGENTS_ENABLED !== 'true')
      throw new Error();
    const cipher = slackCredentialCipher(JSON.parse(process.env.SLACK_CREDENTIAL_KEYS ?? ''));
    const installations = createSlackInstallations({ pool, runtime, config, cipher });
    const channels =
      process.env.SLACK_CHANNEL_AGENTS_ENABLED === 'true'
        ? createSlackChannelAgents({
            runtime,
            appId: config.appId,
            cipher,
            model: null,
            publicDelivery: process.env.SLACK_PUBLIC_DELIVERY_ENABLED === 'true',
          })
        : undefined;
    return {
      config,
      installations,
      inbox: createSlackInbox(runtime, channels?.freeze),
      memberLinking: createSlackMemberLinking({
        runtime,
        config,
        cipher,
        installations,
        ...(defaultKnowledge ? { defaultKnowledge } : {}),
      }),
      ...(channels ? { channels } : {}),
    };
  } catch {
    throw new Error('Slack intake requires qualified configuration, encryption keys and isolated storage');
  }
}
