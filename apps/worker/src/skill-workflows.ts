import { proxyActivities } from '@temporalio/workflow';
import type { createSkillActivities } from './skill-activities.ts';

const { prepareSkillImport } = proxyActivities<ReturnType<typeof createSkillActivities>>({
  startToCloseTimeout: '20 minutes',
  retry: { maximumAttempts: 1 },
});
export async function skillImport(workspaceId: string, importId: string) {
  await prepareSkillImport(workspaceId, importId);
}
