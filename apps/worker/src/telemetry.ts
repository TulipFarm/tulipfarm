import type { WorkerOptions } from '@temporalio/worker';
import { captureException, type startTelemetry } from '@tulipfarm/observability';
import { temporalClientInterceptor } from '@tulipfarm/observability/temporal';
import { temporalActivityTracing, temporalSpanSinks, temporalWorkflowInterceptorModule } from './temporal-tracing.ts';

export type WorkerTelemetry = ReturnType<typeof startTelemetry>;

const reportActivityErrors: NonNullable<NonNullable<WorkerOptions['interceptors']>['activity']>[number] = () => ({
  inbound: {
    execute: async (input, next) => {
      try {
        return await next(input);
      } catch (error) {
        try {
          captureException(error);
        } catch {
          /* Reporting failures must not replace the activity error used by Temporal retries. */
        }
        throw error;
      }
    },
  },
});

export function workerTelemetry(telemetry?: WorkerTelemetry): Pick<WorkerOptions, 'sinks' | 'interceptors'> {
  if (!telemetry) return { interceptors: { activity: [reportActivityErrors] } };
  return {
    sinks: temporalSpanSinks(telemetry.spanProcessor, telemetry.resource),
    interceptors: {
      client: { workflow: [temporalClientInterceptor()] },
      workflowModules: [temporalWorkflowInterceptorModule],
      activity: [temporalActivityTracing, reportActivityErrors],
    },
  };
}
