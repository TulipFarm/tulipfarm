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
const { admitSlackDirectMessageFiles } = proxyActivities<{
  admitSlackDirectMessageFiles: ReturnType<typeof createSlackDirectMessages>['admitFiles'];
}>({
  // Five files of 10 MiB each within the 25-second download deadline, then storing them and admitting the message.
  startToCloseTimeout: '90 seconds',
  retry: { maximumAttempts: 1 },
});
/** Downloads the files shared in one held direct message and admits it, outside the dispatch pass. */
export async function slackDirectMessageFiles(work: SlackPromptWork) {
  return admitSlackDirectMessageFiles(work);
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
