// Bundled into the Temporal workflow sandbox: spans leave the isolate only through the `temporalSpanExporter` sink.
import './temporal-tracing-runtime.ts';
import { context, propagation, ROOT_CONTEXT, trace, type Context, type ContextManager } from '@opentelemetry/api';
import {
  CompositePropagator,
  ExportResultCode,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
  type ExportResult,
} from '@opentelemetry/core';
import { emptyResource } from '@opentelemetry/resources';
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
  type ReadableSpan,
  type SpanExporter,
} from '@opentelemetry/sdk-trace-base';
import {
  AsyncLocalStorage,
  ContinueAsNew,
  proxySinks,
  workflowInfo,
  type ActivityInput,
  type ContinueAsNewInput,
  type LocalActivityInput,
  type Next,
  type QueryInput,
  type SignalInput,
  type SignalWorkflowInput,
  type StartChildWorkflowExecutionInput,
  type UpdateInput,
  type WorkflowExecuteInput,
  type WorkflowInboundCallsInterceptor,
  type WorkflowInterceptors,
  type WorkflowInternalsInterceptor,
  type WorkflowOutboundCallsInterceptor,
} from '@temporalio/workflow';
import {
  extractContextFromHeaders,
  headersWithContext,
  instrument,
  instrumentSync,
  SpanName,
  spanName,
  traceLogAttributes,
  UPDATE_ID_ATTR_KEY,
} from '@tulipfarm/observability/temporal';
import type { SerializedSpan, TemporalTracingSinks } from './temporal-tracing.ts';

class WorkflowContextManager implements ContextManager {
  private storage = new AsyncLocalStorage<Context>();
  active() {
    return this.storage.getStore() ?? ROOT_CONTEXT;
  }
  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    value: Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ) {
    return this.storage.run(value, () => fn.apply(thisArg, args));
  }
  bind<T>(value: Context, target: T): T {
    if (typeof target !== 'function') throw new TypeError(`Only function binding is supported, got ${typeof target}`);
    const fn = target as (...args: unknown[]) => unknown;
    // The bound function needs its own `this`, so the manager is captured explicitly.
    // oxlint-disable-next-line typescript/no-this-alias
    const manager = this;
    return function bound(this: unknown, ...args: unknown[]) {
      return manager.with(value, () => fn.apply(this, args));
    } as T;
  }
  enable() {
    return this;
  }
  disable() {
    this.storage.disable();
    return this;
  }
}

class SinkSpanExporter implements SpanExporter {
  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void) {
    proxySinks<TemporalTracingSinks>().temporalSpanExporter.export(spans.map(serializeSpan));
    resultCallback({ code: ExportResultCode.SUCCESS });
  }
  async shutdown() {}
}

function serializeSpan(span: ReadableSpan): SerializedSpan {
  // TraceState loses its prototype across the isolate boundary, so it crosses as a string.
  const { traceState, ...spanContext } = span.spanContext();
  return {
    name: span.name,
    kind: span.kind,
    spanContext: { ...spanContext, traceState: traceState?.serialize() },
    ...(span.parentSpanContext
      ? { parentSpanContext: { ...span.parentSpanContext, traceState: span.parentSpanContext.traceState?.serialize() } }
      : {}),
    startTime: span.startTime,
    endTime: span.endTime,
    duration: span.duration,
    ended: span.ended,
    status: span.status,
    attributes: span.attributes,
    links: [],
    events: span.events,
    instrumentationScope: span.instrumentationScope,
    droppedAttributesCount: span.droppedAttributesCount,
    droppedEventsCount: span.droppedEventsCount,
    droppedLinksCount: span.droppedLinksCount,
  };
}

let tracer: ReturnType<BasicTracerProvider['getTracer']> | undefined;
let contextManager: WorkflowContextManager | undefined;

function getTracer() {
  if (!tracer) {
    contextManager = new WorkflowContextManager();
    context.setGlobalContextManager(contextManager);
    propagation.setGlobalPropagator(
      new CompositePropagator({ propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()] }),
    );
    const provider = new BasicTracerProvider({
      resource: emptyResource(),
      spanProcessors: [new SimpleSpanProcessor(new SinkSpanExporter())],
    });
    trace.setGlobalTracerProvider(provider);
    tracer = provider.getTracer('@temporalio/interceptor-workflow');
  }
  return tracer;
}

const isContinueAsNew = (error: unknown) => error instanceof ContinueAsNew;

class TracingInbound implements WorkflowInboundCallsInterceptor {
  private tracer = getTracer();
  execute(input: WorkflowExecuteInput, next: Next<WorkflowInboundCallsInterceptor, 'execute'>) {
    return instrument({
      tracer: this.tracer,
      spanName: spanName(SpanName.WORKFLOW_EXECUTE, workflowInfo().workflowType),
      fn: () => next(input),
      context: extractContextFromHeaders(input.headers),
      acceptableErrors: isContinueAsNew,
    });
  }
  handleSignal(input: SignalInput, next: Next<WorkflowInboundCallsInterceptor, 'handleSignal'>) {
    return instrument({
      tracer: this.tracer,
      spanName: spanName(SpanName.WORKFLOW_HANDLE_SIGNAL, input.signalName),
      fn: () => next(input),
      context: extractContextFromHeaders(input.headers),
    });
  }
  handleUpdate(input: UpdateInput, next: Next<WorkflowInboundCallsInterceptor, 'handleUpdate'>) {
    return instrument({
      tracer: this.tracer,
      spanName: spanName(SpanName.WORKFLOW_HANDLE_UPDATE, input.name),
      fn: span => {
        span.setAttribute(UPDATE_ID_ATTR_KEY, input.updateId);
        return next(input);
      },
      context: extractContextFromHeaders(input.headers),
    });
  }
  validateUpdate(input: UpdateInput, next: Next<WorkflowInboundCallsInterceptor, 'validateUpdate'>) {
    instrumentSync({
      tracer: this.tracer,
      spanName: spanName(SpanName.WORKFLOW_VALIDATE_UPDATE, input.name),
      fn: span => {
        span.setAttribute(UPDATE_ID_ATTR_KEY, input.updateId);
        next(input);
      },
      context: extractContextFromHeaders(input.headers),
    });
  }
  handleQuery(input: QueryInput, next: Next<WorkflowInboundCallsInterceptor, 'handleQuery'>) {
    return instrument({
      tracer: this.tracer,
      spanName: spanName(SpanName.WORKFLOW_HANDLE_QUERY, input.queryName),
      fn: () => next(input),
      context: extractContextFromHeaders(input.headers),
    });
  }
}

class TracingOutbound implements WorkflowOutboundCallsInterceptor {
  private tracer = getTracer();
  private propagate<I extends { headers: ActivityInput['headers'] }, O>(
    name: string,
    input: I,
    next: (input: I) => Promise<O>,
    acceptableErrors?: (error: unknown) => boolean,
  ) {
    return instrument({
      tracer: this.tracer,
      spanName: name,
      fn: () => next({ ...input, headers: headersWithContext(input.headers) }),
      acceptableErrors,
    });
  }
  scheduleActivity(input: ActivityInput, next: Next<WorkflowOutboundCallsInterceptor, 'scheduleActivity'>) {
    return this.propagate(spanName(SpanName.ACTIVITY_START, input.activityType), input, next);
  }
  scheduleLocalActivity(
    input: LocalActivityInput,
    next: Next<WorkflowOutboundCallsInterceptor, 'scheduleLocalActivity'>,
  ) {
    return this.propagate(spanName(SpanName.ACTIVITY_START, input.activityType), input, next);
  }
  startChildWorkflowExecution(
    input: StartChildWorkflowExecutionInput,
    next: Next<WorkflowOutboundCallsInterceptor, 'startChildWorkflowExecution'>,
  ) {
    return this.propagate(spanName(SpanName.CHILD_WORKFLOW_START, input.workflowType), input, next);
  }
  continueAsNew(input: ContinueAsNewInput, next: Next<WorkflowOutboundCallsInterceptor, 'continueAsNew'>) {
    return this.propagate(
      spanName(SpanName.CONTINUE_AS_NEW, input.options.workflowType ?? workflowInfo().workflowType),
      input,
      next,
      isContinueAsNew,
    );
  }
  signalWorkflow(input: SignalWorkflowInput, next: Next<WorkflowOutboundCallsInterceptor, 'signalWorkflow'>) {
    return this.propagate(spanName(SpanName.WORKFLOW_SIGNAL, input.signalName), input, next);
  }
  getLogAttributes(input: Record<string, unknown>, next: Next<WorkflowOutboundCallsInterceptor, 'getLogAttributes'>) {
    return next(traceLogAttributes(input));
  }
}

class TracingInternals implements WorkflowInternalsInterceptor {
  dispose(input: Record<string, never>, next: Next<WorkflowInternalsInterceptor, 'dispose'>) {
    contextManager?.disable();
    next(input);
  }
}

export const interceptors = (): WorkflowInterceptors => ({
  inbound: [new TracingInbound()],
  outbound: [new TracingOutbound()],
  internals: [new TracingInternals()],
});
