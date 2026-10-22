import { createTraceState, trace, type SpanContext } from '@opentelemetry/api';
import type { Resource } from '@opentelemetry/resources';
import type { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CompleteAsyncError } from '@temporalio/common';
import type {
  ActivityExecuteInput,
  ActivityInboundCallsInterceptor,
  ActivityInterceptorsFactory,
  InjectedSinks,
} from '@temporalio/worker';
import type { Sinks } from '@temporalio/workflow';
import {
  ACTIVITY_ID_ATTR_KEY,
  extractContextFromHeaders,
  instrument,
  SpanName,
  spanName,
  traceLogAttributes,
  WORKFLOW_ID_ATTR_KEY,
} from '@tulipfarm/observability/temporal';

type SerializedSpanContext = Omit<SpanContext, 'traceState'> & { traceState?: string | undefined };
export type SerializedSpan = Omit<ReadableSpan, 'spanContext' | 'parentSpanContext' | 'resource'> & {
  spanContext: SerializedSpanContext;
  parentSpanContext?: SerializedSpanContext;
};
export interface TemporalTracingSinks extends Sinks {
  temporalSpanExporter: { export(spans: SerializedSpan[]): void };
}

const restoreContext = ({ traceState, ...rest }: SerializedSpanContext): SpanContext => ({
  ...rest,
  ...(traceState ? { traceState: createTraceState(traceState) } : {}),
});

export function temporalSpanSinks(processor: SpanProcessor, resource: Resource): InjectedSinks<TemporalTracingSinks> {
  return {
    temporalSpanExporter: {
      export: {
        fn: (_info, spans) => {
          for (const { spanContext, parentSpanContext, ...rest } of spans) {
            const context = restoreContext(spanContext);
            processor.onEnd({
              ...rest,
              resource,
              spanContext: () => context,
              ...(parentSpanContext ? { parentSpanContext: restoreContext(parentSpanContext) } : {}),
            });
          }
        },
      },
    },
  };
}

type ActivityContext = Parameters<ActivityInterceptorsFactory>[0];

export const temporalWorkflowInterceptorModule = fileURLToPath(
  new URL(`./temporal-tracing-workflow${extname(import.meta.filename)}`, import.meta.url),
);

class TracingActivityInbound implements ActivityInboundCallsInterceptor {
  private ctx: ActivityContext;
  constructor(ctx: ActivityContext) {
    this.ctx = ctx;
  }
  execute(input: ActivityExecuteInput, next: (input: ActivityExecuteInput) => Promise<unknown>) {
    const { info } = this.ctx;
    return instrument({
      tracer: trace.getTracer('@temporalio/interceptor-activity'),
      spanName: spanName(SpanName.ACTIVITY_EXECUTE, info.activityType),
      fn: span => {
        span.setAttribute(ACTIVITY_ID_ATTR_KEY, info.activityId);
        if (info.workflowExecution) span.setAttribute(WORKFLOW_ID_ATTR_KEY, info.workflowExecution.workflowId);
        return next(input);
      },
      context: extractContextFromHeaders(input.headers),
      acceptableErrors: error => error instanceof CompleteAsyncError,
    });
  }
}

export const temporalActivityTracing: ActivityInterceptorsFactory = ctx => ({
  inbound: new TracingActivityInbound(ctx),
  outbound: { getLogAttributes: (input, next) => next(traceLogAttributes(input)) },
});
