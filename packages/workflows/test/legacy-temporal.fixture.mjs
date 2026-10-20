import { continueAsNew, proxyActivities, sleep } from '@temporalio/workflow';

const { advanceWorkflow } = proxyActivities({
  startToCloseTimeout: '30 seconds',
  retry: { initialInterval: '1 second', maximumInterval: '30 seconds' },
});

export async function businessWorkflowV1(work) {
  for (let iteration = 0; iteration < 500; iteration++) {
    const progress = await advanceWorkflow(work);
    if (progress.kind === 'done') return;
    if (progress.kind === 'wait') await sleep(Math.min(30, progress.seconds) * 1000);
  }
  await continueAsNew(work);
}
