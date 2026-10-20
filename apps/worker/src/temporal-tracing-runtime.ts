import { inWorkflowContext } from '@temporalio/workflow';

if (inWorkflowContext()) {
  // OpenTelemetry reads these browser globals at import time; the workflow sandbox provides neither.
  Object.assign(globalThis, {
    performance: {
      timeOrigin: Date.now(),
      now() {
        return Date.now() - this.timeOrigin;
      },
    },
    window: globalThis,
  });
}
