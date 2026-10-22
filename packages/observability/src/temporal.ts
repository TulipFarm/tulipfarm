// Temporal tracing shared by clients, activities and the workflow sandbox. Imports must stay sandbox-safe.
import {
  context,
  defaultTextMapGetter,
  defaultTextMapSetter,
  isSpanContextValid,
  propagation,
  SpanStatusCode,
  trace,
  type Context,
  type Span,
  type Tracer,
} from '@opentelemetry/api';
import {
  ApplicationFailure,
  ApplicationFailureCategory,
  defaultPayloadConverter,
  type Headers,
} from '@temporalio/common';
import type { WorkflowClientInterceptor } from '@temporalio/client';

// Run IDs are omitted because `run_id` is an exportable attribute elsewhere.
// Header, span names and attribute keys match @temporalio/interceptors-opentelemetry so traces and in-flight headers stay compatible.
export const TRACE_HEADER = '_tracer-data';
export const WORKFLOW_ID_ATTR_KEY = 'temporalWorkflowId';
export const ACTIVITY_ID_ATTR_KEY = 'temporalActivityId';
export const UPDATE_ID_ATTR_KEY = 'temporalUpdateId';
export const TERMINATE_REASON_ATTR_KEY = 'temporalTerminateReason';

export const SpanName = {
  WORKFLOW_START: 'StartWorkflow',
  WORKFLOW_SIGNAL: 'SignalWorkflow',
  WORKFLOW_SIGNAL_WITH_START: 'SignalWithStartWorkflow',
  WORKFLOW_QUERY: 'QueryWorkflow',
  WORKFLOW_START_UPDATE: 'StartWorkflowUpdate',
  WORKFLOW_UPDATE_WITH_START: 'UpdateWithStartWorkflow',
  WORKFLOW_HANDLE_SIGNAL: 'HandleSignal',
  WORKFLOW_HANDLE_QUERY: 'HandleQuery',
  WORKFLOW_HANDLE_UPDATE: 'HandleUpdate',
  WORKFLOW_VALIDATE_UPDATE: 'ValidateUpdate',
  WORKFLOW_TERMINATE: 'TerminateWorkflow',
  WORKFLOW_CANCEL: 'CancelWorkflow',
  WORKFLOW_DESCRIBE: 'DescribeWorkflow',
  WORKFLOW_EXECUTE: 'RunWorkflow',
  CHILD_WORKFLOW_START: 'StartChildWorkflow',
  ACTIVITY_START: 'StartActivity',
  ACTIVITY_EXECUTE: 'RunActivity',
  CONTINUE_AS_NEW: 'ContinueAsNew',
} as const;

export const spanName = (kind: string, target: string) => `${kind}:${target}`;

export function extractContextFromHeaders(headers: Headers): Context | undefined {
  const encoded = headers[TRACE_HEADER];
  if (encoded === undefined) return undefined;
  const carrier = defaultPayloadConverter.fromPayload<Record<string, string>>(encoded);
  return propagation.extract(context.active(), carrier, defaultTextMapGetter);
}

export function headersWithContext(headers: Headers): Headers {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier, defaultTextMapSetter);
  return { ...headers, [TRACE_HEADER]: defaultPayloadConverter.toPayload(carrier) };
}

type InstrumentOptions<T> = {
  tracer: Tracer;
  spanName: string;
  fn: (span: Span) => T;
  context?: Context | undefined;
  acceptableErrors?: ((error: unknown) => boolean) | undefined;
};

function recordError(span: Span, error: unknown, acceptableErrors?: (error: unknown) => boolean) {
  if (acceptableErrors?.(error)) {
    span.setStatus({ code: SpanStatusCode.OK });
    return;
  }
  const benign = error instanceof ApplicationFailure && error.category === ApplicationFailureCategory.BENIGN;
  const message = error instanceof Error ? error.message : String(error);
  span.setStatus({ code: benign ? SpanStatusCode.UNSET : SpanStatusCode.ERROR, message });
  span.recordException(error instanceof Error ? error : message);
}

function withParent<T>(parent: Context | undefined, fn: () => T): T {
  return parent ? context.with(parent, fn) : fn();
}

export function instrument<T>(options: InstrumentOptions<Promise<T>>): Promise<T> {
  return withParent(options.context, () =>
    options.tracer.startActiveSpan(options.spanName, async span => {
      try {
        const result = await options.fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        recordError(span, error, options.acceptableErrors);
        throw error;
      } finally {
        span.end();
      }
    }),
  );
}

export function instrumentSync<T>(options: InstrumentOptions<T>): T {
  return withParent(options.context, () =>
    options.tracer.startActiveSpan(options.spanName, span => {
      try {
        const result = options.fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        recordError(span, error, options.acceptableErrors);
        throw error;
      } finally {
        span.end();
      }
    }),
  );
}

export function traceLogAttributes<T extends Record<string, unknown>>(input: T): T {
  const spanContext = trace.getSpan(context.active())?.spanContext();
  if (!spanContext || !isSpanContextValid(spanContext)) return input;
  return {
    trace_id: spanContext.traceId,
    span_id: spanContext.spanId,
    trace_flags: `0${spanContext.traceFlags.toString(16)}`,
    ...input,
  };
}

function setExecution(span: Span, execution: { workflowId: string }) {
  span.setAttribute(WORKFLOW_ID_ATTR_KEY, execution.workflowId);
}

/** Starts client spans and passes their context to workflows through Temporal headers. */
export function temporalClientInterceptor(
  tracer: Tracer = trace.getTracer('@temporalio/interceptor-client'),
): WorkflowClientInterceptor {
  return {
    start: (input, next) =>
      instrument({
        tracer,
        spanName: spanName(SpanName.WORKFLOW_START, input.workflowType),
        fn: async span => {
          span.setAttribute(WORKFLOW_ID_ATTR_KEY, input.options.workflowId);
          return await next({ ...input, headers: headersWithContext(input.headers) });
        },
      }),
    startWithDetails: (input, next) =>
      instrument({
        tracer,
        spanName: spanName(SpanName.WORKFLOW_START, input.workflowType),
        fn: async span => {
          span.setAttribute(WORKFLOW_ID_ATTR_KEY, input.options.workflowId);
          return await next({ ...input, headers: headersWithContext(input.headers) });
        },
      }),
    signal: (input, next) =>
      instrument({
        tracer,
        spanName: spanName(SpanName.WORKFLOW_SIGNAL, input.signalName),
        fn: async span => {
          span.setAttribute(WORKFLOW_ID_ATTR_KEY, input.workflowExecution.workflowId);
          await next({ ...input, headers: headersWithContext(input.headers) });
        },
      }),
    signalWithStart: (input, next) =>
      instrument({
        tracer,
        spanName: spanName(SpanName.WORKFLOW_SIGNAL_WITH_START, input.workflowType),
        fn: async span => {
          span.setAttribute(WORKFLOW_ID_ATTR_KEY, input.options.workflowId);
          return await next({ ...input, headers: headersWithContext(input.headers) });
        },
      }),
    startUpdate: (input, next) =>
      instrument({
        tracer,
        spanName: spanName(SpanName.WORKFLOW_START_UPDATE, input.updateName),
        fn: async span => {
          span.setAttribute(WORKFLOW_ID_ATTR_KEY, input.workflowExecution.workflowId);
          if (input.options.updateId) span.setAttribute(UPDATE_ID_ATTR_KEY, input.options.updateId);
          return await next({ ...input, headers: headersWithContext(input.headers) });
        },
      }),
    startUpdateWithStart: (input, next) =>
      instrument({
        tracer,
        spanName: spanName(SpanName.WORKFLOW_UPDATE_WITH_START, input.updateName),
        fn: async span => {
          span.setAttribute(WORKFLOW_ID_ATTR_KEY, input.workflowStartOptions.workflowId);
          if (input.updateOptions.updateId) span.setAttribute(UPDATE_ID_ATTR_KEY, input.updateOptions.updateId);
          return await next({
            ...input,
            workflowStartHeaders: headersWithContext(input.workflowStartHeaders),
            updateHeaders: headersWithContext(input.updateHeaders),
          });
        },
      }),
    query: (input, next) =>
      instrument({
        tracer,
        spanName: spanName(SpanName.WORKFLOW_QUERY, input.queryType),
        fn: async span => {
          setExecution(span, input.workflowExecution);
          return await next({ ...input, headers: headersWithContext(input.headers) });
        },
      }),
    terminate: (input, next) =>
      instrument({
        tracer,
        spanName: SpanName.WORKFLOW_TERMINATE,
        fn: async span => {
          setExecution(span, input.workflowExecution);
          if (input.reason) span.setAttribute(TERMINATE_REASON_ATTR_KEY, input.reason);
          return await next(input);
        },
      }),
    cancel: (input, next) =>
      instrument({
        tracer,
        spanName: SpanName.WORKFLOW_CANCEL,
        fn: async span => {
          setExecution(span, input.workflowExecution);
          return await next(input);
        },
      }),
    describe: (input, next) =>
      instrument({
        tracer,
        spanName: SpanName.WORKFLOW_DESCRIBE,
        fn: async span => {
          setExecution(span, input.workflowExecution);
          return await next(input);
        },
      }),
  };
}
