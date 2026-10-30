import { z } from 'zod';
import { isFeatureEnabled, log } from '@tulipfarm/observability';
import { qualified } from '@tulipfarm/workspace-storage/runtime';
import { lockAuthorization } from '@tulipfarm/access';
import type { SlackEvent } from './contracts.ts';
import { slackAssistantScope, slackId } from './contracts.ts';
import type { slackCredentialCipher } from './credentials.ts';
import { slackCompatibility, type SlackRuntime, type createSlackInstallations } from './installations.ts';
import { callSlackApi } from './web-api.ts';

type Route = NonNullable<Awaited<ReturnType<ReturnType<typeof createSlackInstallations>['route']>>>;

/** Prompts offered when someone opens a new conversation with TulipFarm in Slack's agent view. */
export const slackSuggestedPrompts = [
  {
    title: 'Summarize this channel',
    message: 'Summarize the recent discussion in this channel and list open questions.',
  },
  { title: 'What changed this week?', message: 'What changed in our workspace this week? Group it by project.' },
  { title: 'Draft a plan', message: 'Help me draft a plan. Ask me what the goal is first.' },
  { title: 'Find in my knowledge', message: 'Search my knowledge sources and tell me what you find about ' },
] as const;

/** The App Home tab: what TulipFarm can do in Slack and how to start. */
export function slackHomeView(appUrl: string | undefined) {
  return {
    type: 'home',
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: 'TulipFarm in Slack' } },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: 'Ask me anything about your workspace: send me a direct message, or mention me in a channel thread. I answer with tables, charts and buttons, and put long reports in a canvas.',
        },
      },
      { type: 'divider' },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*Try asking*\n' + slackSuggestedPrompts.map(prompt => `• ${prompt.message}`).join('\n'),
        },
      },
      ...(appUrl
        ? [
            {
              type: 'actions',
              elements: [
                {
                  type: 'button',
                  action_id: 'tf_open:home',
                  text: { type: 'plain_text', text: 'Open TulipFarm' },
                  url: appUrl,
                  style: 'primary',
                },
              ],
            },
          ]
        : []),
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: 'Only people linked to a TulipFarm workspace get answers. Buttons in a reply work for the person who asked.',
          },
        ],
      },
    ],
  };
}

const threadStartedSchema = z.object({
  type: z.literal('assistant_thread_started'),
  assistant_thread: z.object({ user_id: slackId, channel_id: slackId, thread_ts: z.string() }),
});
const homeOpenedSchema = z.object({ type: z.literal('app_home_opened'), user: slackId, tab: z.string() });

/**
 * Answers Slack's agent and App Home events: suggested prompts and a title when someone starts a conversation in the
 * agent view, and the Home tab when they open it. Both are best effort and need the `generative-ui` flag.
 */
export function createSlackWelcome(options: {
  runtime: SlackRuntime;
  cipher: ReturnType<typeof slackCredentialCipher>;
  appUrl?: string | undefined;
  fetcher?: typeof fetch;
}) {
  const fetcher = options.fetcher ?? fetch;
  async function bot(route: Route) {
    return options.runtime.transaction(route.workspaceId, slackCompatibility, async tx => {
      await lockAuthorization(tx);
      const row = z
        .object({ bot_credential: z.unknown(), scopes: z.array(z.string()) })
        .optional()
        .parse(
          (
            await tx.client.query(
              `SELECT bot_credential,scopes FROM ${qualified(tx.schema, 'tf_slack_installations')} WHERE id=$1 AND generation=$2 AND state='active' AND bot_credential IS NOT NULL`,
              [route.installationId, route.generation],
            )
          ).rows[0],
        );
      if (!row) return undefined;
      return {
        scopes: row.scopes,
        token: options.cipher.decrypt(
          {
            workspaceId: route.workspaceId,
            installationId: route.installationId,
            generation: route.generation,
            kind: 'bot',
          },
          row.bot_credential,
        ),
      };
    });
  }
  async function handle(route: Route, envelope: SlackEvent) {
    const started = threadStartedSchema.safeParse(envelope.event);
    const home = homeOpenedSchema.safeParse(envelope.event);
    if (!started.success && !(home.success && home.data.tab === 'home')) return;
    try {
      if (!(await isFeatureEnabled('generative-ui', null, { id: route.workspaceId }))) return;
      const credentials = await bot(route);
      if (!credentials) return;
      if (started.success) {
        if (!credentials.scopes.includes(slackAssistantScope)) return;
        const thread = started.data.assistant_thread;
        await callSlackApi({
          token: credentials.token,
          method: 'assistant.threads.setSuggestedPrompts',
          params: {
            channel_id: thread.channel_id,
            thread_ts: thread.thread_ts,
            title: 'What can I help with?',
            prompts: JSON.stringify(slackSuggestedPrompts),
          },
          fetcher,
        });
        return;
      }
      if (home.success)
        await callSlackApi({
          token: credentials.token,
          method: 'views.publish',
          params: { user_id: home.data.user, view: JSON.stringify(slackHomeView(options.appUrl)) },
          fetcher,
        });
    } catch (error) {
      log('warn', 'dependency', 'call_failed', {
        operation: started.success ? 'slack.assistant.prompts' : 'slack.home.publish',
        'error.type': error instanceof Error ? error.message : 'unknown',
      });
    }
  }
  return { handle };
}

/** Names a conversation in Slack's agent view after its first request. Best effort. */
export async function setSlackThreadTitle(input: {
  token: string;
  channel: string;
  threadTs: string;
  title: string;
  fetcher?: typeof fetch;
}) {
  const title = input.title.replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!title) return;
  try {
    await callSlackApi({
      token: input.token,
      method: 'assistant.threads.setTitle',
      params: { channel_id: slackId.parse(input.channel), thread_ts: input.threadTs, title },
      fetcher: input.fetcher ?? fetch,
    });
  } catch (error) {
    log('warn', 'dependency', 'call_failed', {
      operation: 'slack.assistant.title',
      'error.type': error instanceof Error ? error.message : 'unknown',
    });
  }
}
