import { proxyActivities } from '@temporalio/workflow';
import type { createSlackLinkPrompts, SlackPromptWork } from '@tulipfarm/slack';
import type { createSlackDirectMessages } from '@tulipfarm/slack';
import type { createSlackChannelAgents } from '@tulipfarm/agents/slack-channels';

const { deliverSlackLinkPrompt } = proxyActivities<{
  deliverSlackLinkPrompt: ReturnType<typeof createSlackLinkPrompts>['process'];
}>({
  startToCloseTimeout: '30 seconds',
  retry: { maximumAttempts: 1 },
});

export async function slackLinkPrompt(work: SlackPromptWork) {
  return deliverSlackLinkPrompt(work);
}

const { deliverSlackDirectMessage } = proxyActivities<{
  deliverSlackDirectMessage: ReturnType<typeof createSlackDirectMessages>['process'];
}>({
  startToCloseTimeout: '30 seconds',
  retry: { maximumAttempts: 1 },
});
export async function slackDirectMessage(work: SlackPromptWork) {
  return deliverSlackDirectMessage(work);
}
const { deliverSlackChannelAgent } = proxyActivities<{
  deliverSlackChannelAgent: ReturnType<typeof createSlackChannelAgents>['process'];
}>({
  startToCloseTimeout: '120 seconds',
  retry: { maximumAttempts: 1 },
});
export async function slackChannelAgent(work: SlackPromptWork) {
  return deliverSlackChannelAgent(work);
}
