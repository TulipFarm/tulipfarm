import type { Worker, WorkerOptions } from '@temporalio/worker';
import {
  captureException,
  recordTemporalScheduleToStart,
  type startTelemetry,
  type TemporalSlotReading,
} from '@tulipfarm/observability';
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

const recordQueueWait: NonNullable<NonNullable<WorkerOptions['interceptors']>['activity']>[number] = context => ({
  inbound: {
    execute: async (input, next) => {
      const { taskQueue, currentAttemptScheduledTimestampMs } = context.info;
      recordTemporalScheduleToStart(taskQueue, (Date.now() - currentAttemptScheduledTimestampMs) / 1000);
      return next(input);
    },
  },
});

function fixedSlots(supplier: unknown) {
  const slots = (supplier as { type?: string; numSlots?: unknown } | undefined) ?? {};
  return slots.type === 'fixed-size' && typeof slots.numSlots === 'number' ? slots.numSlots : Number.NaN;
}

/** Used and configured slots of each running worker; the limit is NaN for resource-based tuners. */
export function temporalSlotReadings(workers: readonly Worker[]): TemporalSlotReading[] {
  return workers
    .filter(worker => worker.getState() === 'RUNNING')
    .flatMap(worker => {
      const status = worker.getStatus();
      const { taskQueue, tuner } = worker.options;
      return [
        {
          taskQueue,
          kind: 'activity' as const,
          used: status.numInFlightNonLocalActivities,
          limit: fixedSlots(tuner.activityTaskSlotSupplier),
        },
        {
          taskQueue,
          kind: 'workflow' as const,
          used: status.numInFlightWorkflowActivations,
          limit: fixedSlots(tuner.workflowTaskSlotSupplier),
        },
      ];
    });
}

export function workerTelemetry(telemetry?: WorkerTelemetry): Pick<WorkerOptions, 'sinks' | 'interceptors'> {
  if (!telemetry) return { interceptors: { activity: [reportActivityErrors] } };
  return {
    sinks: temporalSpanSinks(telemetry.spanProcessor, telemetry.resource),
    interceptors: {
      client: { workflow: [temporalClientInterceptor()] },
      workflowModules: [temporalWorkflowInterceptorModule],
      activity: [temporalActivityTracing, recordQueueWait, reportActivityErrors],
    },
  };
}
