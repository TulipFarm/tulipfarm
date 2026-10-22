import { proxyActivities } from '@temporalio/workflow';
import type { HeartbeatWork } from '@tulipfarm/google-workspace/heartbeat-contracts';
import type { createGoogleHeartbeatActivities } from './google-heartbeat-activities.ts';

const { processGmailHeartbeat } = proxyActivities<ReturnType<typeof createGoogleHeartbeatActivities>>({
  startToCloseTimeout: '8 minutes',
  retry: { maximumAttempts: 3, initialInterval: '5 minutes' },
});
export async function gmailHeartbeat(work: HeartbeatWork): Promise<void> {
  await processGmailHeartbeat(work);
}
