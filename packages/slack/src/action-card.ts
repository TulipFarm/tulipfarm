import type { z } from 'zod';
import type { SlackMessage } from '@tulipfarm/slack-presentation';
import type { slackActionViewSchema } from './action-contracts.ts';

export function slackActionCard(workspaceId: string, action: z.infer<typeof slackActionViewSchema>): SlackMessage {
  const content =
    action.action.tool === 'slack.reaction.add'
      ? `Reaction ${action.action.reaction} on message ${action.action.messageTs}`
      : action.action.text;
  const target = `Destination ${action.channel}${action.action.tool === 'slack.thread.reply' ? `, thread ${action.action.threadTs}` : ''}`;
  const value = JSON.stringify({ workspaceId, actionId: action.id, digest: action.digest });
  return {
    kind: 'message',
    text: `Review Slack action. ${target}. ${content}. Status ${action.status}.`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: 'Review Slack action' } },
      { type: 'section', text: { type: 'plain_text', text: target } },
      ...[content.slice(0, 2800), content.slice(2800)]
        .filter(Boolean)
        .map(text => ({ type: 'section' as const, text: { type: 'plain_text' as const, text } })),
      {
        type: 'context',
        elements: [
          {
            type: 'plain_text',
            text: `Status ${action.status}. Approval expires ${action.expiresAt}. Approval is not delivery.`,
          },
        ],
      },
      ...(action.status === 'pending'
        ? [
            {
              type: 'actions' as const,
              elements: [
                {
                  type: 'button' as const,
                  action_id: 'slack_action_approve',
                  text: { type: 'plain_text' as const, text: 'Approve action' },
                  value,
                },
                {
                  type: 'button' as const,
                  action_id: 'slack_action_reject',
                  text: { type: 'plain_text' as const, text: 'Reject action' },
                  value,
                },
              ],
            },
          ]
        : []),
    ],
  };
}
