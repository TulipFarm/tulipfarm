import { proxyActivities } from '@temporalio/workflow';
import type { EmailMessage } from '@tulipfarm/email';
import type * as activities from './activities.ts';
import type { createEmailDeliveryComposition } from './email-delivery-composition.ts';
export { executeTableProposal } from './table-execution-workflows.ts';
export { boundedAgentTool } from '@tulipfarm/agents/workflows';
export { prepareAgentSave } from './agent-authoring-workflows.ts';
export { conversationReply } from './conversation-workflows.ts';
export { conversationMaintenance } from './conversation-maintenance-workflows.ts';
export { slackLinkPrompt, slackDirectMessage, slackChannelAgent } from './slack-workflows.ts';
export { gmailHeartbeat } from './google-heartbeat-workflows.ts';
export { businessWorkflowV1 } from '@tulipfarm/workflows/temporal';
export { agentTaskStep, agentTaskRecovery } from './task-workflows.ts';
export { agentPlanStep, agentPlanRecovery } from './plan-workflows.ts';
export { knowledgeIngest } from './knowledge-workflows.ts';
export { skillImport } from './skill-workflows.ts';

const { ping } = proxyActivities<typeof activities>({
  startToCloseTimeout: '2 seconds',
  retry: { maximumAttempts: 1 },
});

export async function healthCheck() {
  return ping();
}

const { sendEmail } = proxyActivities<typeof activities>({
  startToCloseTimeout: '1 minute',
  retry: { maximumAttempts: 5, initialInterval: '2 seconds' },
});
export async function sendEmailWorkflow(to: string, message: EmailMessage) {
  return sendEmail(to, message);
}

const { deliverEmail } = proxyActivities<Awaited<ReturnType<typeof createEmailDeliveryComposition>>['activities']>({
  startToCloseTimeout: '1 minute',
  retry: { maximumAttempts: 1 },
});
export async function deliverEmailWorkflow(id: string): Promise<void> {
  await deliverEmail(id);
}
