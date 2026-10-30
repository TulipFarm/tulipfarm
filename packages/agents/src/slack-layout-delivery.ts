import { z } from 'zod';
import { log } from '@tulipfarm/observability';
import { layoutSchema } from '@tulipfarm/conversations/layout-contracts';
import { createSlackCanvas, slackReplyMessage } from '@tulipfarm/slack';
import { parseSlackSurface, type SlackMessage } from '@tulipfarm/slack-presentation';

/** What a follow-up event carries besides the request it continues: the reply it came from and the text it sends. */
export const followUpSchema = z.strictObject({
  parentEventId: z.uuid(),
  text: z.string().min(1).max(4000),
});
export type FollowUp = z.infer<typeof followUpSchema>;

/**
 * The Slack message for a reply laid out with `slack_render`, or `undefined` for a text reply, which is sent as
 * Markdown. A report becomes a canvas when the installation may create one; the reply links it and the chat.
 * `reserve` leaves room for blocks the caller adds, such as review cards.
 */
export async function slackLayoutPresentation(input: {
  layout: unknown;
  token: string;
  canvas: boolean;
  audience: { channel: string } | { user: string };
  app?: string | undefined;
  echo?: string | undefined;
  feedback?: boolean;
  reserve?: number;
  fetcher?: typeof fetch | undefined;
}): Promise<SlackMessage | undefined> {
  const parsed = layoutSchema.safeParse(input.layout);
  if (!parsed.success || !parsed.data.slack) return undefined;
  const { title, summary, slack } = parsed.data;
  const canvas =
    slack.report && input.canvas
      ? await createSlackCanvas({
          token: input.token,
          title,
          markdown: slack.report,
          audience: input.audience,
          ...(input.fetcher ? { fetcher: input.fetcher } : {}),
        })
      : undefined;
  const room = 50 - (input.reserve ?? 0);
  const build = (echo: boolean, feedback: boolean) =>
    slackReplyMessage({
      summary,
      blocks: [
        ...(echo && input.echo ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: input.echo }] }] : []),
        ...slack.blocks,
      ],
      links: { canvas, app: input.app },
      feedback,
    });
  const feedback = input.feedback ?? true;
  for (const message of [build(true, feedback), build(false, feedback), build(false, false)]) {
    if (message.blocks.length > room) continue;
    try {
      return parseSlackSurface(message) as SlackMessage;
    } catch {
      break;
    }
  }
  log('warn', 'activity', 'call_failed', { operation: 'slack.layout.deliver', 'error.type': 'slack-layout-invalid' });
  return undefined;
}
