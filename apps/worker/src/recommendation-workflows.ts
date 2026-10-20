import { defineSignal, proxyActivities, setHandler } from '@temporalio/workflow';

const { generateRecommendations } = proxyActivities<{
  generateRecommendations(workspaceId: string, membershipId: string): Promise<string>;
}>({
  startToCloseTimeout: '2 minutes',
  retry: { maximumAttempts: 3, initialInterval: '2 seconds', maximumInterval: '10 seconds' },
});

export async function rebuildRecommendations(workspaceId: string, membershipId: string) {
  let wake = true;
  setHandler(defineSignal('wakeRecommendations'), () => {
    wake = true;
  });
  while (wake) {
    wake = false;
    await generateRecommendations(workspaceId, membershipId);
  }
}
