import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { isIPv4, isIPv6 } from 'node:net';
import { buildInfoSchema, productionBuildSchema, type BuildInfo } from '@tulipfarm/build-info';
import {
  configuredFeatureFlag,
  featureFlagNames,
  isFeatureFlag,
  type FeatureFlag,
  type FeatureFlagSnapshot,
} from '@tulipfarm/config/feature-flags';
import {
  captureAnalytics,
  flagProvider,
  flushExtensions,
  reportError,
  shutdownExtensions,
} from '@tulipfarm/extensions';
import {
  context,
  metrics,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Span,
} from '@opentelemetry/api';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
  type ReadableSpan,
  type SpanExporter,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { AggregationType, PeriodicExportingMetricReader, type ViewOptions } from '@opentelemetry/sdk-metrics';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-proto';
import {
  errorAttributes,
  safeDiagnosticNumber,
  safeErrorReason,
  safeErrorStage,
  safeErrorType,
  telemetryErrorCode,
} from './error-codes.ts';

export { context, ROOT_CONTEXT, SpanStatusCode, trace };
export { errorAttributes, telemetryErrorCode };
export { withErrorStage, type ErrorStage } from './error-codes.ts';

const scope = 'tulipfarm';
const spanAttributes = new Set([
  'http.request.method',
  'http.route',
  'http.response.status_code',
  'category',
  'operation',
  'outcome',
  'tool',
  'runtime',
  'status',
  'gen_ai.provider.name',
  'gen_ai.request.model',
  'gen_ai.operation.name',
  'build.commit',
  'gen_ai.usage.input_tokens',
  'gen_ai.usage.output_tokens',
  'error.type',
  'error.code',
  'error.reason',
  'error.issues',
  'error.stage',
  'duration_ms',
  'chat.purpose',
  'chat.request.sequence',
  'chat.request.wire_bytes',
  'chat.request.system_bytes',
  'chat.request.messages_bytes',
  'chat.request.tools_bytes',
  'chat.request.reminder_bytes',
  'chat.request.history_bytes',
  'chat.request.completion-evidence_bytes',
  'chat.request.candidate_bytes',
  'chat.discovery.offered',
  'chat.discovery.loaded',
  'chat.discovery.added',
  'chat.discovery.matched',
  'provider',
  'status_class',
  'job',
  'entryPoint',
  'run_id',
  'dependency.endpoint',
  'catalog.http_status',
  'catalog.page_bytes',
  'catalog.received_bytes',
  'catalog.completed_pages',
  'catalog.attempts',
  'parser.elapsedMs',
  'parser.exitCode',
  'parser.signalNumber',
  'parser.rssBytes',
  'parser.outputBytes',
  'parser.diagnosticBytes',
]);

const dependencyEndpoints = [
  'github-repository',
  'github-repository-selection',
  'github-repositories',
  'github-head',
  'github-tree',
  'github-issues',
  'github-issue',
  'github-comments',
  'github-content',
  'github-graphql',
] as const;
export type DependencyEndpoint = (typeof dependencyEndpoints)[number];
const endpoints = new Set<string>(dependencyEndpoints);

function safeAttribute(key: string, value: unknown): boolean {
  if (!spanAttributes.has(key)) return false;
  if (key === 'error.reason') return safeErrorReason(value);
  if (key === 'error.stage') return safeErrorStage(value);
  if (key === 'dependency.endpoint') return typeof value === 'string' && endpoints.has(value);
  if (key === 'http.response.status_code' || key.startsWith('catalog.')) return safeDiagnosticNumber(key, value);
  return true;
}

export function sanitizeSpan(span: ReadableSpan): ReadableSpan {
  return {
    name: span.name,
    kind: span.kind,
    spanContext: () => span.spanContext(),
    ...(span.parentSpanContext ? { parentSpanContext: span.parentSpanContext } : {}),
    startTime: span.startTime,
    endTime: span.endTime,
    duration: span.duration,
    ended: span.ended,
    status: { code: span.status.code },
    attributes: Object.fromEntries(Object.entries(span.attributes).filter(([key, value]) => safeAttribute(key, value))),
    links: [],
    events: [],
    resource: span.resource,
    instrumentationScope: span.instrumentationScope,
    droppedAttributesCount: span.droppedAttributesCount,
    droppedEventsCount: span.droppedEventsCount,
    droppedLinksCount: span.droppedLinksCount,
  };
}

export function privateSpanExporter(exporter: SpanExporter): SpanExporter {
  return {
    export: (spans, callback) => exporter.export(spans.map(sanitizeSpan), callback),
    shutdown: () => exporter.shutdown(),
    forceFlush: async () => {
      await exporter.forceFlush?.();
    },
  };
}

/** Names only the setting at fault: telemetry values can hold credentials and are never echoed. */
export class TelemetryConfigError extends Error {
  readonly setting: string;
  constructor(setting: string) {
    super(`Invalid telemetry setting ${setting}`);
    this.name = 'TelemetryConfigError';
    this.setting = setting;
  }
}

export type TelemetryConfig = {
  ratio: number;
  headers: Record<string, string>;
  traces?: string;
  metrics?: string;
  logs?: string;
};

const headerToken = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
// Set by the exporter or by HTTP framing; an operator value would corrupt the request.
const reservedHeaders = new Set([
  'connection',
  'content-encoding',
  'content-length',
  'content-type',
  'host',
  'keep-alive',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function setting(value: string | undefined) {
  return value === undefined || value.trim() === '' ? undefined : value.trim();
}

function telemetryFlag(value: string | undefined, name: string) {
  const flag = setting(value);
  if (flag === undefined || flag === 'true') return true;
  if (flag === 'false') return false;
  throw new TelemetryConfigError(name);
}

// Plain HTTP stays on loopback, private addresses, and names that public DNS never resolves.
function privateHost(hostname: string) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIPv4(host)) {
    const [a = 0, b = 0] = host.split('.').map(Number);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (isIPv6(host)) return host === '::1' || /^f[cd][0-9a-f]{0,2}:/.test(host);
  return (
    !host.includes('.') ||
    host === 'localhost' ||
    ['.localhost', '.local', '.internal'].some(suffix => host.endsWith(suffix))
  );
}

function otlpUrl(value: string, name: string, allowHttp: boolean) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TelemetryConfigError(name);
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    /[?#]/.test(url.href) ||
    !(url.protocol === 'https:' || (url.protocol === 'http:' && (allowHttp || privateHost(url.hostname))))
  )
    throw new TelemetryConfigError(name);
  return url.href;
}

// OTEL_EXPORTER_OTLP_HEADERS format: comma-separated key=value pairs with percent-encoded values.
function otlpHeaders(value: string | undefined, authorization: string | undefined) {
  const name = 'CLOUD_TELEMETRY_OTLP_HEADERS';
  const headers: Record<string, string> = {};
  const seen = new Set<string>();
  if (authorization !== undefined) {
    headers.Authorization = authorization;
    seen.add('authorization');
  }
  for (const pair of (value ?? '').split(',')) {
    if (pair.trim() === '') continue;
    const separator = pair.indexOf('=');
    if (separator < 0) throw new TelemetryConfigError(name);
    const key = pair.slice(0, separator).trim();
    let header: string;
    try {
      header = decodeURIComponent(pair.slice(separator + 1).trim());
    } catch {
      throw new TelemetryConfigError(name);
    }
    const lower = key.toLowerCase();
    if (
      !headerToken.test(key) ||
      reservedHeaders.has(lower) ||
      seen.has(lower) ||
      !/^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/.test(header)
    )
      throw new TelemetryConfigError(name);
    seen.add(lower);
    headers[key] = header;
  }
  return headers;
}

/**
 * Reads the OTLP/HTTP export settings. Only the CLOUD_TELEMETRY_* names configure export:
 * standard OTEL_* variables injected for other processes must not redirect or enable it.
 */
export function telemetryConfig(env: NodeJS.ProcessEnv): TelemetryConfig | undefined {
  if (env.NODE_ENV !== 'production' || env.CLOUD_TELEMETRY_ENABLED !== 'true') return undefined;
  const allowHttp = setting(env.CLOUD_TELEMETRY_OTLP_ALLOW_HTTP);
  if (allowHttp !== undefined && allowHttp !== 'true' && allowHttp !== 'false')
    throw new TelemetryConfigError('CLOUD_TELEMETRY_OTLP_ALLOW_HTTP');
  const base = setting(env.CLOUD_TELEMETRY_OTLP_ENDPOINT);
  const baseUrl =
    base === undefined
      ? undefined
      : otlpUrl(base, 'CLOUD_TELEMETRY_OTLP_ENDPOINT', allowHttp === 'true').replace(/\/$/, '');
  const signal = (
    enabled: string | undefined,
    enabledName: string,
    endpoint: string | undefined,
    endpointName: string,
    path: string,
  ) => {
    if (!telemetryFlag(enabled, enabledName)) return undefined;
    const own = setting(endpoint);
    if (own !== undefined) return otlpUrl(own, endpointName, allowHttp === 'true');
    if (baseUrl === undefined) throw new TelemetryConfigError('CLOUD_TELEMETRY_OTLP_ENDPOINT');
    return `${baseUrl}/v1/${path}`;
  };
  const traces = signal(
    env.CLOUD_TELEMETRY_TRACES_ENABLED,
    'CLOUD_TELEMETRY_TRACES_ENABLED',
    env.CLOUD_TELEMETRY_OTLP_TRACES_ENDPOINT,
    'CLOUD_TELEMETRY_OTLP_TRACES_ENDPOINT',
    'traces',
  );
  const metrics = signal(
    env.CLOUD_TELEMETRY_METRICS_ENABLED,
    'CLOUD_TELEMETRY_METRICS_ENABLED',
    env.CLOUD_TELEMETRY_OTLP_METRICS_ENDPOINT,
    'CLOUD_TELEMETRY_OTLP_METRICS_ENDPOINT',
    'metrics',
  );
  const logs = signal(
    env.CLOUD_TELEMETRY_LOGS_ENABLED,
    'CLOUD_TELEMETRY_LOGS_ENABLED',
    env.CLOUD_TELEMETRY_OTLP_LOGS_ENDPOINT,
    'CLOUD_TELEMETRY_OTLP_LOGS_ENDPOINT',
    'logs',
  );
  if (!traces && !metrics && !logs) throw new TelemetryConfigError('CLOUD_TELEMETRY_ENABLED');
  const authorization = setting(env.CLOUD_TELEMETRY_OTLP_AUTHORIZATION);
  if (
    authorization !== undefined &&
    !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+ [\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/.test(authorization)
  )
    throw new TelemetryConfigError('CLOUD_TELEMETRY_OTLP_AUTHORIZATION');
  const headers = otlpHeaders(env.CLOUD_TELEMETRY_OTLP_HEADERS, authorization);
  const rawRatio = setting(env.CLOUD_TELEMETRY_SAMPLE_RATIO) ?? '0.1';
  const ratio = Number(rawRatio);
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(rawRatio) || !(ratio >= 0 && ratio <= 1))
    throw new TelemetryConfigError('CLOUD_TELEMETRY_SAMPLE_RATIO');
  return {
    ratio,
    headers,
    ...(traces ? { traces } : {}),
    ...(metrics ? { metrics } : {}),
    ...(logs ? { logs } : {}),
  };
}

let dimensions: Attributes = {};
let buildCommit = 'development';

export function telemetryIdentity(build: BuildInfo, production = process.env.NODE_ENV === 'production') {
  const identity = (production ? productionBuildSchema : buildInfoSchema).parse(build);
  const service = `tulipfarm-${identity.app}`;
  buildCommit = identity.commit;
  dimensions = {
    application: scope,
    environment: production ? 'production' : 'development',
    service,
    service_version: identity.version,
  };
  return resourceFromAttributes({
    'service.name': service,
    'service.namespace': scope,
    'service.version': identity.version,
    'service.instance.id': randomUUID(),
    'deployment.environment': dimensions.environment,
  });
}

export function startTelemetry(build: BuildInfo) {
  const resource = telemetryIdentity(build);
  const service = `tulipfarm-${build.app}`;
  let config: TelemetryConfig | undefined;
  try {
    config = telemetryConfig(process.env);
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        level: 'error',
        event: 'telemetry_configuration_invalid',
        ...(error instanceof TelemetryConfigError ? { setting: error.setting } : {}),
      })}\n`,
    );
    return undefined;
  }
  if (!config) return undefined;
  const exportCounts = new Map<string, number>();
  const reportExport = (signal: string, target: string) => {
    let firstSuccess = true;
    let warningAfter = 0;
    return ({ code, error }: { code: number; error?: Error }) => {
      const outcome = code === 0 ? 'sent' : 'failed';
      const key = `${signal}:${outcome}:${target}`;
      exportCounts.set(key, (exportCounts.get(key) ?? 0) + 1);
      if ((code === 0 && firstSuccess) || (code !== 0 && Date.now() >= warningAfter)) {
        process.stdout.write(
          `${JSON.stringify({
            level: code === 0 ? 'info' : 'warn',
            event: 'telemetry_export',
            signal,
            target,
            outcome,
            service,
            version: build.version,
            commit: build.commit,
            ...(code === 0 ? {} : errorAttributes(error)),
          })}\n`,
        );
        if (code === 0) firstSuccess = false;
        else warningAfter = Date.now() + 60000;
      }
    };
  };
  const target = 'otlp';
  const headers = config.headers;
  const transport = (url: string) => ({ headers: { ...headers }, timeoutMillis: 2000, concurrencyLimit: 1, url });
  class TraceExporter extends OTLPTraceExporter {
    report = reportExport('traces', target);
    override export(
      spans: Parameters<OTLPTraceExporter['export']>[0],
      callback: Parameters<OTLPTraceExporter['export']>[1],
    ) {
      super.export(spans, result => {
        this.report(result);
        callback(result);
      });
    }
  }
  class LogExporter extends OTLPLogExporter {
    report = reportExport('logs', target);
    override export(
      records: Parameters<OTLPLogExporter['export']>[0],
      callback: Parameters<OTLPLogExporter['export']>[1],
    ) {
      super.export(records, result => {
        this.report(result);
        callback(result);
      });
    }
  }
  class MetricExporter extends OTLPMetricExporter {
    report = reportExport('metrics', target);
    override export(
      data: Parameters<OTLPMetricExporter['export']>[0],
      callback: Parameters<OTLPMetricExporter['export']>[1],
    ) {
      super.export(data, result => {
        this.report(result);
        callback(result);
      });
    }
  }
  const spanProcessors = config.traces
    ? [
        new BatchSpanProcessor(privateSpanExporter(new TraceExporter(transport(config.traces))), {
          maxQueueSize: 512,
          maxExportBatchSize: 64,
          scheduledDelayMillis: 5000,
          exportTimeoutMillis: 3000,
        }),
      ]
    : [];
  // Temporal workflow spans arrive through one sink processor, so they reach the exporter through this one.
  const spanProcessor: SpanProcessor = {
    onStart: (span, parent) => spanProcessors.forEach(processor => processor.onStart(span, parent)),
    onEnd: span => spanProcessors.forEach(processor => processor.onEnd(span)),
    forceFlush: async () => {
      await Promise.all(spanProcessors.map(processor => processor.forceFlush()));
    },
    shutdown: async () => {
      await Promise.all(spanProcessors.map(processor => processor.shutdown()));
    },
  };
  const logProcessors = config.logs
    ? [
        new BatchLogRecordProcessor({
          exporter: new LogExporter(transport(config.logs)),
          maxQueueSize: 512,
          maxExportBatchSize: 64,
          scheduledDelayMillis: 5000,
          exportTimeoutMillis: 3000,
        }),
      ]
    : [];
  const metricReaders = config.metrics
    ? [
        new PeriodicExportingMetricReader({
          exporter: new MetricExporter(transport(config.metrics)),
          // One point per series per minute: Grafana Cloud bills faster exports as extra series.
          exportIntervalMillis: 60000,
          exportTimeoutMillis: 3000,
        }),
      ]
    : [];
  // Empty lists, not undefined: NodeSDK would otherwise build exporters from OTEL_* variables.
  const sdk = new NodeSDK({
    resource,
    autoDetectResources: false,
    instrumentations: [],
    sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(config.ratio) }),
    spanProcessors: config.traces ? [spanProcessor] : [],
    metricReaders,
    logRecordProcessors: logProcessors,
    views: [
      ...[
        'call_time',
        'cloud_http_request_duration',
        'gen_ai_client_operation_duration',
        'gen_ai_client_time_to_first_token',
        'cloud_chat_stage_duration',
        'cloud_chat_detail_duration',
        'cloud_workspace_connection_duration',
        'cloud_background_job_duration',
        'cloud_dependency_duration',
      ].map((instrumentName): ViewOptions => ({
        instrumentName,
        aggregation: {
          type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
          options: { boundaries: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 120] },
        },
      })),
      {
        instrumentName: 'cloud_chat_request_size',
        aggregation: {
          type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
          options: { boundaries: [1024, 4096, 16384, 65536, 262144, 1048576, 4194304] },
        },
      },
      {
        instrumentName: 'cloud_chat_discovery_schemas',
        aggregation: {
          type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
          options: { boundaries: [0, 1, 2, 4, 8, 16, 32, 64, 128, 256, 512] },
        },
      },
    ],
  });
  sdk.start();
  const meter = metrics.getMeter(scope);
  meter.createObservableCounter('cloud_telemetry_batches').addCallback(result => {
    for (const [key, count] of exportCounts) {
      const [signal, outcome, target] = key.split(':');
      result.observe(count, { ...dimensions, signal, outcome, target });
    }
  });
  meter.createObservableGauge('cloud_process_heartbeat', { unit: 's' }).addCallback(result => {
    result.observe(Date.now() / 1000, dimensions);
  });
  meter.createObservableGauge('cloud_process_memory', { unit: 'By' }).addCallback(result => {
    result.observe(process.memoryUsage().rss, dimensions);
  });
  log('info', 'lifecycle', 'service_started');
  return {
    resource,
    spanProcessor,
    flush: () =>
      Promise.all([
        spanProcessor.forceFlush(),
        ...metricReaders.map(reader => reader.forceFlush()),
        ...logProcessors.map(processor => processor.forceFlush()),
        flushExtensions(),
      ]),
    shutdown: async () => {
      log('info', 'lifecycle', 'service_stopped');
      await Promise.all([sdk.shutdown(), shutdownExtensions()]);
    },
  };
}

type Category = 'http' | 'dependency' | 'activity' | 'inference' | 'tool' | 'task' | 'lifecycle';
type Event =
  | 'request_completed'
  | 'request_aborted'
  | 'service_started'
  | 'service_stopped'
  | 'startup_failed'
  | 'shutdown_failed'
  | 'database_connection_failed'
  | 'dispatch_failed'
  | 'call_completed'
  | 'call_failed'
  | 'task_status_changed';
type Level = 'debug' | 'info' | 'warn' | 'error';
const severity = {
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
};
const backgroundContext = new AsyncLocalStorage<{ job: string; entryPoint: 'scheduler'; run_id: string }>();

export function errorType(error: unknown) {
  return safeErrorType(error);
}

export function retryError(reason: string, error: unknown) {
  const state = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  return new Error(/^[0-9A-Z]{5}$/.test(state) ? `${reason}.${state.toLowerCase()}` : reason);
}

const knowledgeImportReasons = new Set([
  'permission-expired',
  'resource-limited',
  'provider',
  'quota',
  'integrity',
  'superseded',
  'conflict',
  'unsupported',
  'encrypted',
  'malformed',
  'ocr-required',
  'forbidden',
  'unauthenticated',
  'insufficient-scope',
  'not-linked',
  'stale-integration',
  'reconnect-required',
  'not-configured',
  'rate-limited',
  'transient',
  'not-found',
  'outside-selection',
  'source-changed',
  'response-too-large',
  'too-large',
  'invalid-cursor',
  'invalid-response',
  'invalid-selection',
  'content-limit',
  'document-rejected',
  'timeout',
  'rss-limit',
  'memory-monitor',
  'spawn',
  'abnormal-exit',
  'output-limit',
  'diagnostic-limit',
  'cancelled',
  'invalid-output',
  'unsupported-platform',
]);

export function recordKnowledgeImport(
  stage: 'item' | 'source',
  outcome: 'ready' | 'error',
  reason?: string,
  diagnostics: {
    elapsedMs?: number;
    exitCode?: number;
    signalNumber?: number;
    rssBytes?: number;
    outputBytes?: number;
    diagnosticBytes?: number;
    error?: unknown;
  } = {},
) {
  const errorCode = reason && knowledgeImportReasons.has(reason) ? reason : 'unclassified';
  const labels = {
    ...dimensions,
    provider: 'github',
    stage,
    outcome,
    ...(outcome === 'error' ? { error_code: errorCode } : {}),
  };
  metrics.getMeter(scope).createCounter('cloud_knowledge_imports').add(1, labels);
  const details: Attributes = {};
  for (const key of ['elapsedMs', 'exitCode', 'signalNumber', 'rssBytes', 'outputBytes', 'diagnosticBytes'] as const) {
    const value = diagnostics[key];
    if (typeof value === 'number' && Number.isSafeInteger(value) && (key === 'exitCode' || value >= 0))
      details[`parser.${key}`] = value;
  }
  if (outcome === 'error')
    log('error', 'activity', 'call_failed', {
      operation: `knowledge.github.${stage}`,
      provider: 'github',
      outcome,
      'error.type': errorCode,
      'error.code': errorCode,
      ...(diagnostics.error === undefined ? {} : errorAttributes(diagnostics.error)),
      ...details,
    });
}

export interface KnowledgeSyncSnapshot {
  failedItems: number;
  failedSources: number;
  stalledSources: number;
}

export function createKnowledgeSyncMetrics() {
  const meter = metrics.getMeter(scope);
  const labels = { ...dimensions, provider: 'github' };
  let snapshot: KnowledgeSyncSnapshot | undefined;
  let completedAt = 0;
  const failedItems = meter.createObservableGauge('cloud_knowledge_failed_items');
  const failedSources = meter.createObservableGauge('cloud_knowledge_failed_sources');
  const stalledSources = meter.createObservableGauge('cloud_knowledge_stalled_sources');
  const scan = meter.createObservableGauge('cloud_knowledge_scan_completed', { unit: 's' });
  const instruments = [failedItems, failedSources, stalledSources, scan];
  const callback: Parameters<typeof meter.addBatchObservableCallback>[0] = result => {
    result.observe(scan, completedAt, labels);
    if (!snapshot) return;
    result.observe(failedItems, snapshot.failedItems, labels);
    result.observe(failedSources, snapshot.failedSources, labels);
    result.observe(stalledSources, snapshot.stalledSources, labels);
  };
  meter.addBatchObservableCallback(callback, instruments);
  return {
    publish(value: KnowledgeSyncSnapshot) {
      if (Object.values(value).some(count => !Number.isSafeInteger(count) || count < 0))
        throw new Error('invalid-knowledge-sync-snapshot');
      snapshot = { ...value };
      completedAt = Date.now() / 1000;
    },
    close() {
      meter.removeBatchObservableCallback(callback, instruments);
    },
  };
}

export function log(level: Level, category: Category, event: Event, attributes: Attributes = {}) {
  const safe = Object.fromEntries(Object.entries(attributes).filter(([key, value]) => safeAttribute(key, value)));
  const active = trace.getSpan(context.active())?.spanContext();
  const fields = { ...dimensions, ...backgroundContext.getStore(), ...safe, category, commit: buildCommit };
  process.stdout.write(
    `${JSON.stringify({ level, event, ...fields, trace_id: active?.traceId, span_id: active?.spanId })}\n`,
  );
  logs.getLogger(scope).emit({
    severityNumber: severity[level],
    severityText: level.toUpperCase(),
    body: event,
    attributes: fields,
    context: context.active(),
  });
  metrics
    .getMeter(scope)
    .createCounter('cloud_log_records')
    .add(1, { ...dimensions, category, level });
}

function callMetrics(
  category: Category,
  operation: string,
  outcome: string,
  seconds: number,
  attributes: Attributes = {},
) {
  const labels = { ...dimensions, category, operation, outcome, ...attributes };
  const meter = metrics.getMeter(scope);
  meter.createCounter('call_count', { description: 'Completed calls, including failures' }).add(1, labels);
  meter.createHistogram('call_time', { unit: 's', description: 'End-to-end call latency' }).record(seconds, labels);
}

export async function observeWorkspaceConnection<T>(phase: 'wait' | 'hold', call: () => Promise<T>): Promise<T> {
  const start = performance.now();
  let outcome: 'success' | 'error' | 'timeout' = 'success';
  let span: Span | undefined;
  try {
    span = trace.getTracer(scope).startSpan(`workspace.connection.${phase}`, {
      attributes: { category: 'dependency', operation: `workspace.connection.${phase}`, 'build.commit': buildCommit },
    });
  } catch {
    /* Diagnostics must not prevent checkout or release. */
  }
  try {
    return await call();
  } catch (error) {
    outcome =
      error instanceof Error &&
      (error.message === 'timeout exceeded when trying to connect' ||
        error.message === 'Connection terminated due to connection timeout' ||
        ('code' in error && error.code === 'wait_timeout'))
        ? 'timeout'
        : 'error';
    throw error;
  } finally {
    const seconds = (performance.now() - start) / 1000;
    try {
      metrics
        .getMeter(scope)
        .createHistogram('cloud_workspace_connection_duration', { unit: 's' })
        .record(seconds, { ...dimensions, phase, outcome });
      span?.setAttribute('outcome', outcome);
      span?.setAttribute('duration_ms', seconds * 1000);
      if (outcome !== 'success') span?.setStatus({ code: SpanStatusCode.ERROR });
    } catch {
      /* Preserve the transaction result if telemetry fails. */
    } finally {
      try {
        span?.end();
      } catch {
        /* Export failures must not replace storage errors. */
      }
    }
  }
}

export const backgroundJobs = [
  'agent-chat-discovery',
  'agent-setup-discovery',
  'conversation-discovery',
  'table-dispatch',
  'workflow-dispatch',
  'provider-dispatch',
  'knowledge-dispatch',
  'knowledge-google-dispatch',
  'knowledge-slack-dispatch',
  'knowledge-github-dispatch',
  'knowledge-atlassian-dispatch',
  'knowledge-defaults-dispatch',
  'knowledge-embedding-dispatch',
  'skill-import-dispatch',
  'google-heartbeat-dispatch',
  'recommendation-dispatch',
  'chat-latency-scan',
  'workspace-provisioning-dispatch',
  'onboarding-expiry',
  'abuse-expiry',
  'mcp-catalog-refresh',
  'conversation-stream-expiry',
  'object-cleanup',
  'table-search',
  'table-names',
  'invitation-expiry',
  'table-cleanup',
  'email-dispatch',
  'slack-dispatch',
  'recommendation-spend-projection',
  'member-profile-dispatch',
  'member-profile-projection',
] as const;
export type BackgroundJob = (typeof backgroundJobs)[number];

export function createBackgroundJob(job: BackgroundJob, intervalSeconds: number) {
  const meter = metrics.getMeter(scope);
  const labels = { ...dimensions, background_job: job };
  const started = Date.now() / 1000;
  let lastCompletion = 0;
  let lastSuccess = 0;
  const expected = meter.createObservableGauge('cloud_background_job_expected');
  const interval = meter.createObservableGauge('cloud_background_job_interval', { unit: 's' });
  const registration = meter.createObservableGauge('cloud_background_job_started_at', { unit: 's' });
  const completion = meter.createObservableGauge('cloud_background_job_last_completion', { unit: 's' });
  const success = meter.createObservableGauge('cloud_background_job_last_success', { unit: 's' });
  const successAge = meter.createObservableGauge('cloud_background_job_success_age', { unit: 's' });
  const instruments = [expected, interval, registration, completion, success, successAge];
  const callback: Parameters<typeof meter.addBatchObservableCallback>[0] = result => {
    result.observe(expected, 1, labels);
    result.observe(interval, intervalSeconds, labels);
    result.observe(registration, started, labels);
    result.observe(completion, lastCompletion, labels);
    result.observe(success, lastSuccess, labels);
    result.observe(successAge, Math.max(0, Date.now() / 1000 - (lastSuccess || started)), labels);
  };
  meter.addBatchObservableCallback(callback, instruments);
  function start() {
    const attributes = { job, entryPoint: 'scheduler' as const, run_id: randomUUID() };
    const span = trace
      .getTracer(scope)
      .startSpan(`job.${job}`, { attributes: { ...attributes, 'build.commit': buildCommit } }, ROOT_CONTEXT);
    const startedAt = performance.now();
    return {
      attributes,
      parent: trace.setSpan(ROOT_CONTEXT, span),
      finish(outcome: 'success' | 'error', error?: unknown) {
        lastCompletion = Date.now() / 1000;
        if (outcome === 'success') lastSuccess = lastCompletion;
        const seconds = (performance.now() - startedAt) / 1000;
        meter.createCounter('cloud_background_job_runs').add(1, { ...labels, outcome });
        meter.createHistogram('cloud_background_job_duration', { unit: 's' }).record(seconds, { ...labels, outcome });
        span.setAttribute('outcome', outcome);
        if (outcome === 'error') {
          const details = errorAttributes(error);
          span.setAttributes(details);
          span.setStatus({ code: SpanStatusCode.ERROR });
          log('error', 'activity', 'call_failed', {
            operation: `job.${job}`,
            outcome,
            duration_ms: seconds * 1000,
            ...details,
          });
          // Scheduled jobs run outside HTTP requests and Temporal activities, so nothing else reports them.
          captureException(error);
        }
        span.end();
      },
    };
  }
  return {
    async run<T>(call: () => Promise<T>): Promise<T> {
      const run = start();
      return backgroundContext.run(run.attributes, () =>
        context.with(run.parent, async () => {
          let outcome: 'success' | 'error' = 'error';
          let failure: unknown;
          try {
            const result = await call();
            outcome = 'success';
            return result;
          } catch (error) {
            failure = error;
            throw error;
          } finally {
            run.finish(outcome, failure);
          }
        }),
      );
    },
    runSync<T>(call: () => T): T {
      const run = start();
      return backgroundContext.run(run.attributes, () =>
        context.with(run.parent, () => {
          let outcome: 'success' | 'error' = 'error';
          let failure: unknown;
          try {
            const result = call();
            outcome = 'success';
            return result;
          } catch (error) {
            failure = error;
            throw error;
          } finally {
            run.finish(outcome, failure);
          }
        }),
      );
    },
    close() {
      meter.removeBatchObservableCallback(callback, instruments);
    },
  };
}

export type DependencyProvider = 'google' | 'github' | 'slack' | 'atlassian' | 'mcp' | 'email' | 'turnstile';
export type DependencyOperation = 'request' | 'oauth' | 'rpc' | 'send' | 'verify' | 'download';
export async function observeDependency<T>(
  provider: DependencyProvider,
  operation: DependencyOperation,
  call: () => Promise<T>,
  statusOf: (result: T) => number | undefined = () => undefined,
  diagnostics: { endpoint?: DependencyEndpoint } = {},
): Promise<T> {
  const attributes = {
    provider,
    operation,
    category: 'dependency',
    ...(diagnostics.endpoint && endpoints.has(diagnostics.endpoint)
      ? { 'dependency.endpoint': diagnostics.endpoint }
      : {}),
  };
  return trace
    .getTracer(scope)
    .startActiveSpan(`dependency.${provider}.${operation}`, { kind: SpanKind.CLIENT, attributes }, async span => {
      const start = performance.now();
      let outcome = 'error';
      let statusClass = 'none';
      let statusCode: number | undefined;
      try {
        const result = await call();
        const status = statusOf(result);
        if (status !== undefined && status >= 100 && status < 600) statusClass = `${Math.floor(status / 100)}xx`;
        if (typeof status === 'number' && safeDiagnosticNumber('http.response.status_code', status)) {
          statusCode = status;
        }
        outcome = status !== undefined && status >= 400 ? 'error' : 'success';
        return result;
      } finally {
        const seconds = (performance.now() - start) / 1000;
        const labels = { ...dimensions, provider, operation, status_class: statusClass, outcome };
        metrics.getMeter(scope).createCounter('cloud_dependency_requests').add(1, labels);
        metrics.getMeter(scope).createHistogram('cloud_dependency_duration', { unit: 's' }).record(seconds, labels);
        const responseAttributes = statusCode === undefined ? {} : { 'http.response.status_code': statusCode };
        span.setAttributes({ outcome, status_class: statusClass, ...responseAttributes });
        if (outcome === 'error') {
          span.setStatus({ code: SpanStatusCode.ERROR });
          log('warn', 'dependency', 'call_failed', {
            ...attributes,
            ...responseAttributes,
            status_class: statusClass,
            outcome,
            duration_ms: seconds * 1000,
          });
        }
        span.end();
      }
    });
}

/** Measures each HTTP attempt through response headers without reading or wrapping its body. */
const dependencyFetchContext = new AsyncLocalStorage<boolean>();
export function observeFetch(
  provider: DependencyProvider,
  operation: DependencyOperation,
  fetcher: typeof fetch = globalThis.fetch,
  diagnostics: { endpoint?: DependencyEndpoint } = {},
): typeof fetch {
  return (input, init) =>
    dependencyFetchContext.getStore()
      ? fetcher(input, init)
      : dependencyFetchContext.run(true, () =>
          observeDependency(
            provider,
            operation,
            () => fetcher(input, init),
            response => response.status,
            diagnostics,
          ),
        );
}

export type ChatStage =
  | 'resume'
  | 'claim'
  | 'context'
  | 'prepare'
  | 'compaction'
  | 'files'
  | 'model'
  | 'memory'
  | 'tool'
  | 'tool-recovery'
  | 'delivery'
  | 'dispatch'
  | 'recovery';
export async function observeChatStage<T>(phase: ChatStage, call: () => Promise<T>): Promise<T> {
  const start = performance.now();
  let outcome = 'success';
  try {
    return await call();
  } catch (error) {
    outcome = 'error';
    throw error;
  } finally {
    const seconds = (performance.now() - start) / 1000;
    metrics
      .getMeter(scope)
      .createHistogram('cloud_chat_stage_duration', { unit: 's' })
      .record(seconds, { ...dimensions, phase, outcome });
    log('info', 'activity', 'call_completed', { operation: `chat.${phase}`, outcome, duration_ms: seconds * 1000 });
  }
}

export type ChatModelPurpose = 'reply' | 'completion' | 'title' | 'calendar' | 'compaction';
export type ChatDetailPhase =
  | 'turn'
  | 'request'
  | 'resume'
  | 'requester'
  | 'publisher-close'
  | 'history'
  | 'render'
  | 'context-measure'
  | 'round-prepare'
  | 'catalog'
  | 'memory'
  | 'inventory'
  | 'tool-schemas'
  | 'serialize'
  | 'authorize'
  | 'reserve'
  | 'provider'
  | 'response-parse'
  | 'settle'
  | 'decision-parse'
  | 'discovery'
  | 'completion-context'
  | 'storage-admission'
  | 'storage-credentials'
  | 'storage-pool'
  | 'storage-connect'
  | 'storage-identity'
  | 'storage-fence'
  | 'storage-version'
  | 'storage-operation'
  | 'storage-begin'
  | 'storage-settings'
  | 'storage-commit'
  | 'storage-rollback'
  | 'storage-reset'
  | 'credit-account-lock'
  | 'credit-usage-lock';
type ChatMeasurement = { counter: { value: number }; purpose: ChatModelPurpose | 'turn'; sequence?: number };
const chatMeasurement = new AsyncLocalStorage<ChatMeasurement>();

export function withChatMeasurements<T>(call: () => Promise<T>): Promise<T> {
  if (chatMeasurement.getStore()) return call();
  return chatMeasurement.run({ counter: { value: 0 }, purpose: 'turn' }, call);
}

function chatDetailAttributes(state: ChatMeasurement): Attributes {
  return {
    'chat.purpose': state.purpose,
    ...(state.sequence === undefined ? {} : { 'chat.request.sequence': state.sequence }),
  };
}

function finishChatDetail(phase: ChatDetailPhase, state: ChatMeasurement, start: number, outcome: string) {
  const seconds = (performance.now() - start) / 1000;
  metrics
    .getMeter(scope)
    .createHistogram('cloud_chat_detail_duration', { unit: 's' })
    .record(seconds, { ...dimensions, phase, purpose: state.purpose, outcome });
  log('info', 'activity', 'call_completed', {
    operation: `chat.detail.${phase}`,
    ...chatDetailAttributes(state),
    outcome,
    duration_ms: seconds * 1000,
  });
}

export async function observeChatDetail<T>(phase: ChatDetailPhase, call: () => Promise<T>): Promise<T> {
  const state = chatMeasurement.getStore();
  if (!state) return call();
  return trace.getTracer(scope).startActiveSpan(
    `chat.detail.${phase}`,
    {
      attributes: { operation: `chat.detail.${phase}`, ...chatDetailAttributes(state), 'build.commit': buildCommit },
    },
    async span => {
      const start = performance.now();
      let outcome = 'success';
      try {
        return await call();
      } catch (error) {
        outcome = 'error';
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.setAttribute('outcome', outcome);
        finishChatDetail(phase, state, start, outcome);
        span.end();
      }
    },
  );
}

export function observeChatDetailSync<T>(phase: ChatDetailPhase, call: () => T): T {
  const state = chatMeasurement.getStore();
  if (!state) return call();
  return trace.getTracer(scope).startActiveSpan(
    `chat.detail.${phase}`,
    {
      attributes: { operation: `chat.detail.${phase}`, ...chatDetailAttributes(state), 'build.commit': buildCommit },
    },
    span => {
      const start = performance.now();
      let outcome = 'success';
      try {
        return call();
      } catch (error) {
        outcome = 'error';
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.setAttribute('outcome', outcome);
        finishChatDetail(phase, state, start, outcome);
        span.end();
      }
    },
  );
}

export function withChatModelRequest<T>(purpose: ChatModelPurpose, call: () => Promise<T>): Promise<T> {
  const state = chatMeasurement.getStore();
  if (!state) return call();
  return chatMeasurement.run({ counter: state.counter, purpose, sequence: ++state.counter.value }, async () => {
    let outcome = 'success';
    try {
      return await observeChatDetail('request', call);
    } catch (error) {
      outcome = 'error';
      throw error;
    } finally {
      metrics
        .getMeter(scope)
        .createCounter('cloud_chat_model_requests')
        .add(1, { ...dimensions, purpose, outcome });
    }
  });
}

const chatRequestComponents = [
  'wire',
  'system',
  'messages',
  'tools',
  'reminder',
  'history',
  'completion-evidence',
  'candidate',
] as const;
export function recordChatRequestSizes(sizes: Partial<Record<(typeof chatRequestComponents)[number], number>>) {
  const state = chatMeasurement.getStore();
  if (!state) return;
  const attributes: Attributes = chatDetailAttributes(state);
  for (const component of chatRequestComponents) {
    const bytes = sizes[component];
    if (bytes === undefined) continue;
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError('invalid-chat-request-size');
    attributes[`chat.request.${component}_bytes`] = bytes;
    metrics
      .getMeter(scope)
      .createHistogram('cloud_chat_request_size', { unit: 'By' })
      .record(bytes, { ...dimensions, purpose: state.purpose, component });
  }
  log('info', 'inference', 'call_completed', { operation: 'chat.request-size', ...attributes });
}

export function recordChatDiscovery(counts: { offered: number; loaded: number; added: number; matched: number }) {
  const state = chatMeasurement.getStore();
  if (!state) return;
  const attributes: Attributes = chatDetailAttributes(state);
  for (const component of ['offered', 'loaded', 'added', 'matched'] as const) {
    const count = counts[component];
    if (!Number.isSafeInteger(count) || count < 0) throw new RangeError('invalid-chat-discovery-count');
    attributes[`chat.discovery.${component}`] = count;
    metrics
      .getMeter(scope)
      .createHistogram('cloud_chat_discovery_schemas')
      .record(count, { ...dimensions, component });
  }
  metrics.getMeter(scope).createCounter('cloud_chat_discoveries').add(1, dimensions);
  log('info', 'inference', 'call_completed', { operation: 'chat.discovery', ...attributes });
}

export const chatLatencyPhases = [
  'wall',
  'active',
  'queue',
  'processing',
  'human-wait',
  'external-wait',
  'first-text',
  'dispatch',
  'worker-start',
] as const;
export const chatLatencyBounds = [1, 2, 5, 10, 30, 60, 120, 300, 900, Infinity] as const;
export const chatLatencyStates = [
  'queued',
  'processing',
  'human-wait',
  'external-wait',
  'reconciling',
  'failed',
  'completed',
  'cancelled',
  'blocked',
] as const;
export const chatLatencyAlerts = ['queue', 'first-text', 'active'] as const;
export type ChatLatencySnapshot = {
  durations: { phase: (typeof chatLatencyPhases)[number]; buckets: number[]; count: number; total: number }[];
  states: { state: (typeof chatLatencyStates)[number]; count: number }[];
  oldest: { phase: (typeof chatLatencyAlerts)[number]; seconds: number }[];
  slow: { phase: (typeof chatLatencyAlerts)[number]; at: number }[];
  attempts: number;
};

/** Each snapshot replaces the previous full scan; it is not a stream of new observations. */
export function createChatLatencyMetrics() {
  let latest: { snapshot: ChatLatencySnapshot; at: number } | undefined;
  const meter = metrics.getMeter(scope);
  const buckets = meter.createObservableGauge('cloud_chat_latency_window_bucket', {
    description: 'Cumulative duration buckets over the last 24 hours; use histogram_quantile without rate',
  });
  const counts = meter.createObservableGauge('cloud_chat_latency_window_count');
  const totals = meter.createObservableGauge('cloud_chat_latency_window_sum', { unit: 's' });
  const states = meter.createObservableGauge('cloud_chat_turns_window');
  const oldest = meter.createObservableGauge('cloud_chat_oldest', { unit: 's' });
  const slow = meter.createObservableGauge('cloud_chat_slow_last_seen', { unit: 's' });
  const attempts = meter.createObservableGauge('cloud_chat_attempts_window');
  const freshness = meter.createObservableGauge('cloud_chat_scan_completed', { unit: 's' });
  const instruments = [buckets, counts, totals, states, oldest, slow, attempts, freshness];
  const callback: Parameters<typeof meter.addBatchObservableCallback>[0] = result => {
    if (!latest) return;
    const { snapshot, at } = latest;
    result.observe(freshness, at, dimensions);
    for (const item of snapshot.durations) {
      for (const [index, bound] of chatLatencyBounds.entries())
        result.observe(buckets, item.buckets[index]!, {
          ...dimensions,
          phase: item.phase,
          le: Number.isFinite(bound) ? String(bound) : '+Inf',
        });
      result.observe(counts, item.count, { ...dimensions, phase: item.phase });
      result.observe(totals, item.total, { ...dimensions, phase: item.phase });
    }
    for (const item of snapshot.states) result.observe(states, item.count, { ...dimensions, status: item.state });
    for (const item of snapshot.oldest) result.observe(oldest, item.seconds, { ...dimensions, phase: item.phase });
    for (const item of snapshot.slow) result.observe(slow, item.at, { ...dimensions, phase: item.phase });
    result.observe(attempts, snapshot.attempts, dimensions);
  };
  meter.addBatchObservableCallback(callback, instruments);
  return {
    publish(snapshot: ChatLatencySnapshot) {
      latest = { snapshot, at: Date.now() / 1000 };
    },
    close() {
      meter.removeBatchObservableCallback(callback, instruments);
    },
  };
}

export async function observeCall<T>(
  category: 'dependency' | 'activity',
  operation: string,
  call: () => Promise<T>,
): Promise<T> {
  return trace
    .getTracer(scope)
    .startActiveSpan(operation, { attributes: { category, operation, 'build.commit': buildCommit } }, async span => {
      const start = performance.now();
      let outcome = 'success';
      try {
        return await call();
      } catch (error) {
        outcome = 'error';
        const details = errorAttributes(error);
        span.setAttributes(details);
        span.setStatus({ code: SpanStatusCode.ERROR });
        log('error', category, 'call_failed', { operation, ...details });
        throw error;
      } finally {
        span.setAttribute('outcome', outcome);
        callMetrics(category, operation, outcome, (performance.now() - start) / 1000);
        span.end();
      }
    });
}

export type ToolRuntime = 'chat' | 'task' | 'slack' | 'agent';
export type ToolOutcome = 'success' | 'error' | 'waiting' | 'blocked';
/** `errorType` names a failure that the dispatcher caught and reported as a returned outcome. */
export type ToolObservation = { outcome: ToolOutcome; errorCode?: unknown; errorType?: string };

const loggedToolFailures = new WeakSet<object>();
/** True when `observeTool` already logged this thrown error, so a caller that catches it must not log it again. */
export function toolFailureLogged(error: unknown) {
  return typeof error === 'object' && error !== null && loggedToolFailures.has(error);
}

function issueCodes(error: unknown) {
  if (!(error instanceof Error) || error.name !== 'ZodError' || !('issues' in error) || !Array.isArray(error.issues))
    return undefined;
  return error.issues.map(
    (issue: { path?: unknown; code?: unknown }) =>
      `${Array.isArray(issue.path) ? issue.path.join('.') : ''}:${String(issue.code)}`,
  );
}

export async function observeTool<T>(
  tool: string,
  runtime: ToolRuntime,
  call: () => Promise<T>,
  outcomeOf: (result: T) => ToolOutcome | ToolObservation = () => 'success',
): Promise<T> {
  const attributes = { tool, runtime, category: 'tool', operation: tool };
  return trace
    .getTracer(scope)
    .startActiveSpan(tool, { attributes: { ...attributes, 'build.commit': buildCommit } }, async span => {
      const start = performance.now();
      let outcome: ToolOutcome = 'error';
      let failure: string | undefined;
      let errorCode: string | undefined;
      let issues: string[] | undefined;
      let details: Partial<ReturnType<typeof errorAttributes>> = {};
      try {
        const result = await call();
        const observation = outcomeOf(result);
        outcome = typeof observation === 'string' ? observation : observation.outcome;
        if (typeof observation !== 'string') {
          errorCode = telemetryErrorCode(observation.errorCode);
          if (observation.errorType !== undefined)
            failure = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(observation.errorType) ? observation.errorType : 'Error';
        }
        return result;
      } catch (error) {
        details = errorAttributes(error);
        failure = details['error.type'];
        issues = issueCodes(error);
        if (typeof error === 'object' && error !== null) loggedToolFailures.add(error);
        errorCode = details['error.code'];
        span.setAttributes(details);
        throw error;
      } finally {
        const failed = outcome === 'error' || outcome === 'blocked';
        const seconds = (performance.now() - start) / 1000;
        if (failed) {
          errorCode ??= 'unclassified';
          span.setStatus({ code: SpanStatusCode.ERROR });
          span.setAttribute('error.code', errorCode);
          metrics
            .getMeter(scope)
            .createCounter('cloud_tool_failures')
            .add(1, { ...dimensions, tool, runtime, outcome, error_code: errorCode });
        }
        span.setAttribute('outcome', outcome);
        callMetrics('tool', tool, outcome, seconds, { tool, runtime });
        log(failed ? 'error' : 'info', 'tool', failed ? 'call_failed' : 'call_completed', {
          ...attributes,
          ...details,
          outcome,
          duration_ms: seconds * 1000,
          ...(failed ? { 'error.code': errorCode } : {}),
          ...(failure ? { 'error.type': failure } : {}),
          ...(issues ? { 'error.issues': issues } : {}),
        });
        span.end();
      }
    });
}

export function recordTaskTransition(status: 'started' | 'paused' | 'failed' | 'completed') {
  const attributes = { runtime: 'task', status };
  metrics
    .getMeter(scope)
    .createCounter('cloud_agent_task_transitions')
    .add(1, { ...dimensions, ...attributes });
  log(status === 'failed' ? 'error' : 'info', 'task', 'task_status_changed', attributes);
}

export function startHttp(method: string, route: string) {
  const safeMethod = /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|TRACE|CONNECT)$/.test(method) ? method : '_OTHER';
  const attributes = { 'http.request.method': safeMethod, 'http.route': route, 'build.commit': buildCommit };
  const span = trace
    .getTracer(scope)
    .startSpan(`${safeMethod} ${route}`, { kind: SpanKind.SERVER, attributes }, ROOT_CONTEXT);
  const spanContext = trace.setSpan(ROOT_CONTEXT, span);
  const start = performance.now();
  let finished = false;
  return {
    context: spanContext,
    finish(status: number, aborted = false, code?: unknown, error?: unknown) {
      if (finished) return;
      finished = true;
      context.with(spanContext, () => {
        const seconds = (performance.now() - start) / 1000;
        const outcome = aborted ? 'aborted' : status >= 500 ? 'error' : 'success';
        const details: Partial<ReturnType<typeof errorAttributes>> =
          !aborted && status >= 500 && error !== undefined ? errorAttributes(error) : {};
        const errorCode = aborted
          ? 'request-aborted'
          : status >= 400
            ? (details['error.code'] ?? telemetryErrorCode(code) ?? 'unclassified')
            : undefined;
        span.setAttributes(details);
        const labels = {
          ...dimensions,
          method: safeMethod,
          route,
          status_code: String(status),
          status_class: `${Math.floor(status / 100)}xx`,
        };
        const meter = metrics.getMeter(scope);
        meter.createCounter('cloud_http_requests').add(1, labels);
        meter.createHistogram('cloud_http_request_duration', { unit: 's' }).record(seconds, labels);
        if (errorCode) {
          meter.createCounter('cloud_http_errors').add(1, { ...labels, error_code: errorCode });
          span.setAttribute('error.code', errorCode);
        }
        callMetrics('http', route, outcome, seconds, labels);
        span.setAttribute('http.response.status_code', status);
        if (status >= 500 || aborted) span.setStatus({ code: SpanStatusCode.ERROR });
        if (!route.startsWith('/v1/health') || status >= 400 || aborted) {
          log(
            aborted ? 'warn' : status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info',
            'http',
            aborted ? 'request_aborted' : 'request_completed',
            {
              ...attributes,
              ...details,
              'http.response.status_code': status,
              duration_ms: seconds * 1000,
              ...(errorCode ? { 'error.code': errorCode } : {}),
            },
          );
        }
        span.end();
      });
    },
  };
}

// Error reporting, product analytics, and flags go to @tulipfarm/extensions slots; each is a no-op by default.
export function captureException(error: unknown, distinctId?: string) {
  reportError(error, distinctId);
}

export function captureEvent(
  event: string,
  distinctId: string,
  properties: Record<string, unknown> = {},
  groups?: Record<string, string>,
) {
  captureAnalytics({ event, distinctId, properties, ...(groups ? { groups } : {}) });
}

type FlagUser = { id: string; email?: string };
type FlagWorkspace = { id: string; name?: string };

/**
 * Resolves a flag: the registered flag provider when it returns a boolean, else the flag's env
 * override, FEATURE_FLAGS_OFF, and its declared default (see @tulipfarm/config/feature-flags).
 * A provider failure is logged and falls back. Unknown flags are off.
 */
export async function isFeatureEnabled(
  flag: FeatureFlag,
  user: FlagUser,
  workspace?: FlagWorkspace,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (!isFeatureFlag(flag)) return false;
  const provider = flagProvider();
  if (provider) {
    try {
      const answer = await provider.isEnabled(flag, { user, ...(workspace ? { workspace } : {}) });
      if (typeof answer === 'boolean') return answer;
    } catch (error) {
      log('warn', 'dependency', 'call_failed', {
        operation: `feature-flag.${flag}`,
        outcome: 'fallback',
        ...errorAttributes(error),
      });
    }
  }
  return configuredFeatureFlag(flag, env);
}

/** Every registered flag for one subject, as a serializable snapshot for a client such as the web app. */
export async function featureFlagSnapshot(
  user: FlagUser,
  workspace?: FlagWorkspace,
  env: NodeJS.ProcessEnv = process.env,
): Promise<FeatureFlagSnapshot> {
  const values = await Promise.all(featureFlagNames.map(flag => isFeatureEnabled(flag, user, workspace, env)));
  return Object.fromEntries(featureFlagNames.map((flag, index) => [flag, values[index]])) as FeatureFlagSnapshot;
}

export function withTelemetryContext<T>(parent: Context, call: () => T): T {
  return context.with(parent, call);
}

export async function observeInference<T>(
  model: { provider: string; model: string; operation: 'chat' | 'embeddings' },
  call: (report: {
    firstToken: () => void;
    usage: (input: number, output: number) => void;
    error: () => void;
  }) => Promise<T>,
): Promise<T> {
  const attributes = {
    'gen_ai.provider.name': model.provider,
    'gen_ai.request.model': model.model,
    'gen_ai.operation.name': model.operation,
  };
  return trace
    .getTracer(scope)
    .startActiveSpan(
      `${model.operation} ${model.model}`,
      { kind: SpanKind.CLIENT, attributes: { ...attributes, 'build.commit': buildCommit } },
      async span => {
        const start = performance.now();
        let outcome = 'success';
        let firstToken = false;
        let usage: { input: number; output: number } | undefined;
        const meter = metrics.getMeter(scope);
        const fail = (error?: unknown) => {
          if (outcome === 'error') return;
          outcome = 'error';
          const details = error === undefined ? {} : errorAttributes(error);
          span.setAttributes(details);
          span.setStatus({ code: SpanStatusCode.ERROR });
          log('error', 'inference', 'call_failed', { ...attributes, ...details });
        };
        try {
          return await call({
            firstToken() {
              if (firstToken) return;
              firstToken = true;
              meter
                .createHistogram('gen_ai_client_time_to_first_token', { unit: 's' })
                .record((performance.now() - start) / 1000, { ...dimensions, ...attributes });
            },
            usage(input, output) {
              if (Number.isSafeInteger(input) && input >= 0 && Number.isSafeInteger(output) && output >= 0)
                usage = { input, output };
            },
            error: fail,
          });
        } catch (error) {
          fail(error);
          throw error;
        } finally {
          const seconds = (performance.now() - start) / 1000;
          const labels = { ...dimensions, ...attributes, outcome };
          callMetrics('inference', model.operation, outcome, seconds, attributes);
          meter.createHistogram('gen_ai_client_operation_duration', { unit: 's' }).record(seconds, labels);
          if (usage) {
            const tokens = meter.createCounter('gen_ai_client_tokens');
            tokens.add(usage.input, { ...labels, token_type: 'input' });
            tokens.add(usage.output, { ...labels, token_type: 'output' });
            span.setAttributes({
              'gen_ai.usage.input_tokens': usage.input,
              'gen_ai.usage.output_tokens': usage.output,
            });
          }
          span.setAttribute('outcome', outcome);
          const { traceId, spanId } = span.spanContext();
          // Prompt, completion, and tool text are never sent.
          captureAnalytics({
            event: model.operation === 'embeddings' ? '$ai_embedding' : '$ai_generation',
            distinctId: traceId,
            properties: {
              $process_person_profile: false,
              $ai_trace_id: traceId,
              $ai_span_id: spanId,
              $ai_provider: model.provider,
              $ai_model: model.model,
              $ai_latency: seconds,
              $ai_is_error: outcome === 'error',
              ...(usage ? { $ai_input_tokens: usage.input, $ai_output_tokens: usage.output } : {}),
              service: dimensions.service,
              service_version: dimensions.service_version,
            },
          });
          span.end();
        }
      },
    );
}
