import { condition, continueAsNew, defineSignal, proxyActivities, setHandler } from '@temporalio/workflow';
import type { Work, Progress } from './contracts.ts';

const { advanceWorkflow } = proxyActivities<{ advanceWorkflow(work: Work): Promise<Progress> }>({
  startToCloseTimeout: '30 seconds',
  retry: { initialInterval: '1 second', maximumInterval: '30 seconds' },
});
const wake = defineSignal('wakeBusinessWorkflow');

export async function businessWorkflowV1(work: Work): Promise<void> {
  let woken = false;
  setHandler(wake, () => {
    woken = true;
  });
  for (let iteration = 0; iteration < 500; iteration++) {
    woken = false;
    const progress = await advanceWorkflow(work);
    if (progress.kind === 'done') return;
    if (progress.kind === 'wait') await condition(() => woken, progress.seconds * 1000);
  }
  await continueAsNew<typeof businessWorkflowV1>(work);
}
