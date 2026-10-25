import { ActivityFailure, proxyActivities } from '@temporalio/workflow';
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
  // The workflow stays open while it backs off, so dispatch passes, which start it only when none is open, do not
  // download a message that keeps failing every two seconds.
  retry: { initialInterval: '10 seconds', backoffCoefficient: 2, maximumInterval: '10 minutes', maximumAttempts: 10 },
});
const { admitSlackDirectMessageUnreadFiles } = proxyActivities<{
  admitSlackDirectMessageUnreadFiles: ReturnType<typeof createSlackDirectMessages>['admitUnreadFiles'];
}>({
  startToCloseTimeout: '30 seconds',
  retry: { initialInterval: '10 seconds', backoffCoefficient: 2, maximumInterval: '10 minutes', maximumAttempts: 10 },
});
/**
 * Downloads the files shared in one held direct message and admits it, outside the dispatch pass. When every attempt
 * fails, the message is admitted with its files named as not read, so it does not hold its thread forever.
 */
export async function slackDirectMessageFiles(work: SlackPromptWork) {
  try {
    return await admitSlackDirectMessageFiles(work);
  } catch (error) {
    if (!(error instanceof ActivityFailure)) throw error;
    return admitSlackDirectMessageUnreadFiles(work);
  }
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
