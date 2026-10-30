import { z } from 'zod';
import { log } from '@tulipfarm/observability';
import type { SlackBlock, SlackMessage } from '@tulipfarm/slack-presentation';
import { slackId } from './contracts.ts';
import { callSlackApi } from './web-api.ts';

/** The bot scope that lets a reply save a long report as a Slack canvas. */
export const slackFeedbackActionId = 'tf_feedback';

/**
 * A laid-out reply as a Slack message: the model's blocks, link buttons to the canvas report and the chat in
 * TulipFarm, then the feedback buttons. `summary` is the notification and fallback text.
 */
export function slackReplyMessage(input: {
  summary: string;
  blocks: readonly unknown[];
  links: { canvas?: string | undefined; app?: string | undefined };
  feedback: boolean;
}): SlackMessage {
  const links = [
    input.links.canvas ? { label: 'Open report', url: input.links.canvas, primary: true } : undefined,
    input.links.app ? { label: 'Open in TulipFarm', url: input.links.app, primary: false } : undefined,
  ].filter(link => link !== undefined);
  return {
    kind: 'message',
    text: input.summary,
    blocks: [
      ...(input.blocks as SlackBlock[]),
      ...(links.length
        ? [
            {
              type: 'actions' as const,
              block_id: 'tf_links',
              elements: links.map((link, index) => ({
                type: 'button' as const,
                action_id: `tf_open:${index}`,
                text: { type: 'plain_text' as const, text: link.label },
                url: link.url,
                ...(link.primary ? { style: 'primary' as const } : {}),
              })),
            },
          ]
        : []),
      ...(input.feedback
        ? [
            {
              type: 'context_actions' as const,
              block_id: 'tf_feedback',
              elements: [
                {
                  type: 'feedback_buttons' as const,
                  action_id: slackFeedbackActionId,
                  positive_button: {
                    text: { type: 'plain_text' as const, text: 'Good reply' },
                    accessibility_label: 'Mark this reply as helpful',
                    value: 'positive',
                  },
                  negative_button: {
                    text: { type: 'plain_text' as const, text: 'Bad reply' },
                    accessibility_label: 'Mark this reply as not helpful',
                    value: 'negative',
                  },
                },
              ],
            },
          ]
        : []),
    ],
  };
}

/**
 * Saves a report as a standalone Slack canvas readable by the reply's audience: the channel, or the one person in a
 * DM. Returns its link, or `undefined` when Slack refuses, so the reply still goes out with its TulipFarm link.
 */
export async function createSlackCanvas(input: {
  token: string;
  title: string;
  markdown: string;
  audience: { channel: string } | { user: string };
  fetcher?: typeof fetch;
}): Promise<string | undefined> {
  const fetcher = input.fetcher ?? fetch;
  try {
    const created = z.object({ canvas_id: slackId }).parse(
      await callSlackApi({
        token: input.token,
        method: 'canvases.create',
        params: {
          title: input.title,
          document_content: JSON.stringify({ type: 'markdown', markdown: input.markdown }),
        },
        fetcher,
        effect: true,
      }),
    );
    await callSlackApi({
      token: input.token,
      method: 'canvases.access.set',
      params: {
        canvas_id: created.canvas_id,
        access_level: 'read',
        ...('channel' in input.audience
          ? { channel_ids: JSON.stringify([slackId.parse(input.audience.channel)]) }
          : { user_ids: JSON.stringify([slackId.parse(input.audience.user)]) }),
      },
      fetcher,
      effect: true,
    });
    const team = z
      .object({ url: z.url().refine(url => new URL(url).protocol === 'https:'), team_id: slackId })
      .parse(await callSlackApi({ token: input.token, method: 'auth.test', params: {}, fetcher }));
    return new URL(`docs/${team.team_id}/${created.canvas_id}`, team.url).href;
  } catch (error) {
    log('warn', 'dependency', 'call_failed', {
      operation: 'slack.canvas.create',
      'error.type': error instanceof Error ? error.message : 'unknown',
    });
    return undefined;
  }
}

/** Opens a modal for the person who pressed a button. Slack's trigger expires three seconds after the press. */
export async function openSlackModal(input: {
  token: string;
  triggerId: string;
  view: Record<string, unknown>;
  fetcher?: typeof fetch;
}) {
  await callSlackApi({
    token: input.token,
    method: 'views.open',
    params: { trigger_id: input.triggerId, view: JSON.stringify(input.view) },
    fetcher: input.fetcher ?? fetch,
  });
}

const optionSchema = z.object({ text: z.object({ text: z.string() }).optional(), value: z.string().optional() });
const pickedSchema = z.object({
  value: z.string().nullish(),
  selected_option: optionSchema.nullish(),
  selected_options: z.array(optionSchema).nullish(),
  selected_date: z.string().nullish(),
  selected_time: z.string().nullish(),
  selected_date_time: z.number().nullish(),
  selected_user: z.string().nullish(),
  selected_users: z.array(z.string()).nullish(),
  selected_conversation: z.string().nullish(),
  selected_conversations: z.array(z.string()).nullish(),
  selected_channel: z.string().nullish(),
  selected_channels: z.array(z.string()).nullish(),
});

/** What a person picked or typed in one Slack element, as text, or `undefined` when they left it empty. */
export function slackPickedText(value: unknown): string | undefined {
  const parsed = pickedSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const picked = parsed.data;
  const option = (item: z.infer<typeof optionSchema>) => item.text?.text ?? item.value ?? '';
  const mention = (id: string, kind: '@' | '#') => `<${kind}${id}>`;
  const values = [
    picked.value ?? undefined,
    picked.selected_option ? option(picked.selected_option) : undefined,
    picked.selected_options?.length ? picked.selected_options.map(option).join(', ') : undefined,
    picked.selected_date ?? undefined,
    picked.selected_time ?? undefined,
    picked.selected_date_time ? new Date(picked.selected_date_time * 1000).toISOString() : undefined,
    picked.selected_user ? mention(picked.selected_user, '@') : undefined,
    picked.selected_users?.length ? picked.selected_users.map(id => mention(id, '@')).join(', ') : undefined,
    picked.selected_conversation ? mention(picked.selected_conversation, '#') : undefined,
    picked.selected_conversations?.length
      ? picked.selected_conversations.map(id => mention(id, '#')).join(', ')
      : undefined,
    picked.selected_channel ? mention(picked.selected_channel, '#') : undefined,
    picked.selected_channels?.length ? picked.selected_channels.map(id => mention(id, '#')).join(', ') : undefined,
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  return values[0];
}

/**
 * A submitted form as text, one "Label: answer" line per input block, in the order the blocks appear. Labels come from
 * the blocks Slack sends back with the submission.
 */
export function slackFormAnswers(
  values: Record<string, Record<string, unknown>>,
  blocks: readonly {
    type?: string | undefined;
    block_id?: string | undefined;
    label?: { text?: string | undefined } | undefined;
  }[],
) {
  const lines: string[] = [];
  for (const block of blocks) {
    if (block.type !== 'input' || !block.block_id) continue;
    const answers = Object.values(values[block.block_id] ?? {});
    const text = answers.map(slackPickedText).find(Boolean);
    lines.push(`${block.label?.text ?? 'Answer'}: ${text ?? '(left empty)'}`);
  }
  return lines.join('\n');
}

/** A reply's modal as a Slack view. `metadata` routes its submission back to the reply that offered it. */
export function slackModalView(
  modal: { title: string; submit: string; blocks: readonly unknown[] },
  metadata: string,
): Record<string, unknown> {
  return {
    type: 'modal',
    callback_id: slackFormCallbackId,
    private_metadata: metadata,
    title: { type: 'plain_text', text: modal.title },
    submit: { type: 'plain_text', text: modal.submit },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: modal.blocks,
  };
}
export const slackFormCallbackId = 'tf_form';
