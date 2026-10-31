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

// A message's markdown blocks share a 12,000 character limit; the rest is left for the cut notice.
const reportLimit = 11500;

/** A report as one markdown block, cut at a paragraph when it is longer than a message holds. */
export function reportText(report: string): string {
  if (report.length <= reportLimit) return report;
  const cut = report.lastIndexOf('\n\n', reportLimit);
  return `${report.slice(0, cut > reportLimit / 2 ? cut : reportLimit).trimEnd()}\n\n_The report is cut here. Open it in TulipFarm to read the rest._`;
}

/**
 * The Slack message for a reply laid out with `slack_render`, or `undefined` for a text reply, which is sent as
 * Markdown. A report becomes a canvas when the installation may create one; the reply links it and the chat. When the canvas
 * cannot be made, the reply carries the report itself.
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
  // Without a canvas, such as on a free Slack plan, the full report is posted in the reply instead of its preview.
  const blocks = slack.report && !canvas ? [{ type: 'markdown', text: reportText(slack.report) }] : slack.blocks;
  const build = (echo: boolean, feedback: boolean) =>
    slackReplyMessage({
      summary,
      blocks: [
        ...(echo && input.echo ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: input.echo }] }] : []),
        ...blocks,
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
