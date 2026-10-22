import { proxyActivities } from '@temporalio/workflow';
import type { MaintenanceWork } from '@tulipfarm/conversations/maintenance-contracts';
import type { createConversationMaintenanceActivities } from './conversation-maintenance-activities.ts';

const { processConversationMaintenance } = proxyActivities<ReturnType<typeof createConversationMaintenanceActivities>>({
  startToCloseTimeout: '9 minutes',
  retry: { maximumAttempts: 1 },
});

export async function conversationMaintenance(work: MaintenanceWork) {
  return processConversationMaintenance(work);
}
