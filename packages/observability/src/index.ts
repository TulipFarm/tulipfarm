import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { isIPv4, isIPv6 } from 'node:net';
import { buildInfoSchema, productionBuildSchema, type BuildInfo } from '@tulipfarm/build-info';
import {
  emailDomain,
  flagSubject,
  resolveFlagContext,
  type FlagUserInput,
  type FlagWorkspaceInput,
} from './flag-subjects.ts';
import {
  configuredFeatureFlag,
  featureFlagNames,
  featureFlags,
  isFeatureFlag,
  type FeatureFlag,
  type FeatureFlagScope,
  type FeatureFlagSnapshot,
} from '@tulipfarm/config/feature-flags';
import {
  analyticsEventProperties,
  isAnalyticsEvent,
  type AnalyticsEventName,
  type AnalyticsEventProperties,
} from '@tulipfarm/config/analytics-events';
import {
  captureAnalytics,
  flagProvider,
  identifyAnalyticsGroup,
  identifyAnalyticsPerson,
  flushExtensions,
  reportError,
  shutdownExtensions,
} from '@tulipfarm/extensions';
import {
  context,
  metrics,
  isSpanContextValid,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  TraceFlags,
  type Attributes,
  type Context,
  type Span,
} from '@opentelemetry/api';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BatchSpanProcessor,
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
import {
  modelCallDiagnostics,
  modelErrorClasses,
  modelFallbackOutcomes,
  modelUsageOutcomes,
  modelUsageUnknownReasons,
  providerMessageLimit,
  safeProviderCode,
  safeUsageShape,
  usageShape,
  type ModelFallbackOutcome,
  type ModelUsageUnknownReason,
} from './model-errors.ts';
import { alwaysSample, chatTurnSpan, telemetrySampler } from './sampling.ts';

export { context, ROOT_CONTEXT, SpanStatusCode, trace };
export { alwaysSample, chatTurnSpan, TelemetryRootSampler, telemetrySampler } from './sampling.ts';
export { errorAttributes, telemetryErrorCode };
export { withErrorStage, type ErrorStage } from './error-codes.ts';
export {
  registerFlagSubjectResolver,
  resetFlagSubjects,
  type FlagSubjectResolver,
  type FlagUserInput,
  type FlagWorkspaceInput,
  type ResolvedFlagContext,
} from './flag-subjects.ts';
export {
  fallbackEligibleClasses,
  ModelCallError,
  modelCallDiagnostics,
  modelErrorClass,
  modelErrorClasses,
  modelFailureClasses,
  modelFallbackOutcomes,
  modelUsageOutcomes,
  modelUsageUnknownReasons,
  sanitizeProviderMessage,
  usageShape,
  type ModelCallDiagnostics,
  type ModelErrorClass,
  type ModelFallbackOutcome,
  type ModelUsageOutcome,
  type ModelUsageUnknownReason,
} from './model-errors.ts';

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
  'title_generation',
  'dispatch_source',
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
  'chat.compaction.trigger_tokens',
  'chat.compaction.window',
  'chat.compaction.after_tokens',
  'chat.compaction.summarised',
  'chat.compaction.stubbed',
  'chat.compaction.pruned',
  'chat.compaction.outcome',
  'chat.reply.tools',
  'chat.reply.attempts',
  'chat.reply.total_seconds',
  'chat.reply.first_text_seconds',
  'chat.reply.send_seconds',
  'chat.reply.queue_seconds',
  'chat.reply.model_seconds',
  'chat.reply.tools_seconds',
  'chat.reply.db_seconds',
  'chat.reply.overhead_seconds',
  'chat.stop.reason',
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
  'output_started',
  'model_fallback',
  'fallback.provider',
  'fallback.model',
  'model_usage',
  'usage.unknown_reason',
]);
// Provider error details help diagnose a failed model call but are free text, so they stay on log lines only.
const logOnlyAttributes = new Set([
  'provider.error_code',
  'provider.error_message',
  'usage.shape',
  'slack.event_id',
  'github.ratelimit_remaining',
  'github.retry_after_s',
  'github.ratelimit_resource',
]);
// A stored Slack event's own row id: it locates the event in the database and carries no Slack content.
const rowIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
  'github-blob',
  'github-commits',
  'github-commit',
  'github-compare',
  'github-graphql',
] as const;
export type DependencyEndpoint = (typeof dependencyEndpoints)[number];
const endpoints = new Set<string>(dependencyEndpoints);
const titleGenerationOutcomeValues = ['generated', 'skipped', 'failed', 'timeout'] as const;
export type TitleGenerationOutcome = (typeof titleGenerationOutcomeValues)[number];
const titleGenerationOutcomes = new Set<string>(titleGenerationOutcomeValues);

function safeAttribute(key: string, value: unknown, logLine = false): boolean {
  if (logLine && logOnlyAttributes.has(key)) {
    if (key === 'provider.error_code') return safeProviderCode(value) === value;
    if (key === 'usage.shape') return safeUsageShape(value);
    if (key === 'slack.event_id') return typeof value === 'string' && rowIdPattern.test(value);
    if (key === 'github.ratelimit_resource') return typeof value === 'string' && /^[a-z_]{1,32}$/.test(value);
    if (key.startsWith('github.')) return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
    return typeof value === 'string' && value.length > 0 && value.length <= providerMessageLimit;
  }
  if (!spanAttributes.has(key)) return false;
  if (key === 'output_started') return typeof value === 'boolean';
  if (key === 'model_fallback') return (modelFallbackOutcomes as readonly unknown[]).includes(value);
  if (key === 'model_usage') return (modelUsageOutcomes as readonly unknown[]).includes(value);
  if (key === 'usage.unknown_reason') return (modelUsageUnknownReasons as readonly unknown[]).includes(value);
  if (key === 'error.reason') return safeErrorReason(value);
  if (key === 'error.stage') return safeErrorStage(value);
  if (key === 'dependency.endpoint') return typeof value === 'string' && endpoints.has(value);
  if (key === 'title_generation') return typeof value === 'string' && titleGenerationOutcomes.has(value);
  if (key === 'chat.stop.reason') return (chatStopReasons as readonly unknown[]).includes(value);
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
    // A link is only a span context; its attributes could carry anything, so they are dropped.
    links: span.links.map(link => ({ context: link.context })),
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
  jobRatio: number;
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
  const ratio = sampleRatio(env.CLOUD_TELEMETRY_SAMPLE_RATIO, '0.1', 'CLOUD_TELEMETRY_SAMPLE_RATIO');
  const jobRatio = sampleRatio(env.CLOUD_TELEMETRY_JOB_SAMPLE_RATIO, '0.01', 'CLOUD_TELEMETRY_JOB_SAMPLE_RATIO');
  if (setting(env.CLOUD_TELEMETRY_ENVIRONMENT) !== undefined && !telemetryEnvironment(env))
    throw new TelemetryConfigError('CLOUD_TELEMETRY_ENVIRONMENT');
  return {
    ratio,
    jobRatio,
    headers,
    ...(traces ? { traces } : {}),
    ...(metrics ? { metrics } : {}),
    ...(logs ? { logs } : {}),
  };
}

function sampleRatio(value: string | undefined, fallback: string, name: string) {
  const raw = setting(value) ?? fallback;
  const ratio = Number(raw);
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw) || !(ratio >= 0 && ratio <= 1)) throw new TelemetryConfigError(name);
  return ratio;
}

// A bounded label: it becomes the deployment.environment resource attribute and the environment metric dimension.
function telemetryEnvironment(env: NodeJS.ProcessEnv) {
  const value = setting(env.CLOUD_TELEMETRY_ENVIRONMENT);
  return value !== undefined && /^[a-z][a-z0-9-]{0,31}$/.test(value) ? value : undefined;
}

let dimensions: Attributes = {};
let buildCommit = 'development';

export function telemetryIdentity(build: BuildInfo, production = process.env.NODE_ENV === 'production') {
  const identity = (production ? productionBuildSchema : buildInfoSchema).parse(build);
  const service = `tulipfarm-${identity.app}`;
  buildCommit = identity.commit;
  dimensions = {
    application: scope,
    environment: production ? (telemetryEnvironment(process.env) ?? 'production') : 'development',
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
    sampler: telemetrySampler(config.ratio, config.jobRatio),
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
          // Each bucket is a billed series per label set; keep the list short.
          options: { boundaries: [0.05, 0.25, 0.5, 1, 2.5, 10, 60] },
        },
      })),
      {
        instrumentName: 'cloud_chat_reply_duration',
        aggregation: {
          type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
          options: { boundaries: [...chatReplyBuckets] },
        },
      },
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
  | 'integration_unconfigured'
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
  // Sources whose owner must reconnect the account, and repositories that need permission or lost access.
  reconnectSources: number;
  permissionRepositories: number;
  lostRepositories: number;
}

export function createKnowledgeSyncMetrics() {
  const meter = metrics.getMeter(scope);
  const labels = { ...dimensions, provider: 'github' };
  let snapshot: KnowledgeSyncSnapshot | undefined;
  let completedAt = 0;
  const failedItems = meter.createObservableGauge('cloud_knowledge_failed_items');
  const failedSources = meter.createObservableGauge('cloud_knowledge_failed_sources');
  const stalledSources = meter.createObservableGauge('cloud_knowledge_stalled_sources');
  const reconnectSources = meter.createObservableGauge('cloud_knowledge_reconnect_sources');
  const permissionRepositories = meter.createObservableGauge('cloud_knowledge_permission_repositories');
  const lostRepositories = meter.createObservableGauge('cloud_knowledge_lost_repositories');
  const scan = meter.createObservableGauge('cloud_knowledge_scan_completed', { unit: 's' });
  const instruments = [
    failedItems,
    failedSources,
    stalledSources,
    reconnectSources,
    permissionRepositories,
    lostRepositories,
    scan,
  ];
  const callback: Parameters<typeof meter.addBatchObservableCallback>[0] = result => {
    result.observe(scan, completedAt, labels);
    if (!snapshot) return;
    result.observe(failedItems, snapshot.failedItems, labels);
    result.observe(failedSources, snapshot.failedSources, labels);
    result.observe(stalledSources, snapshot.stalledSources, labels);
    result.observe(reconnectSources, snapshot.reconnectSources, labels);
    result.observe(permissionRepositories, snapshot.permissionRepositories, labels);
    result.observe(lostRepositories, snapshot.lostRepositories, labels);
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
  const safe = Object.fromEntries(Object.entries(attributes).filter(([key, value]) => safeAttribute(key, value, true)));
  const active = trace.getSpan(context.active())?.spanContext();
  // trace_sampled says whether trace_id can be found in the trace backend; unsampled ids were never exported.
  const sampled = active ? { trace_sampled: (active.traceFlags & TraceFlags.SAMPLED) === TraceFlags.SAMPLED } : {};
  const fields = { ...dimensions, ...backgroundContext.getStore(), ...safe, category, commit: buildCommit, ...sampled };
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
  // HTTP latency is already in cloud_http_request_duration; a second histogram would double its series.
  if (category === 'http') return;
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
  'github-delivery-retention',
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
  'social-publisher',
  'social-refresh',
] as const;
export type BackgroundJob = (typeof backgroundJobs)[number];

/** True inside a scheduled background job run, so shared resources can serve requests ahead of it. */
export function inBackgroundJob() {
  return backgroundContext.getStore() !== undefined;
}

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

export type DependencyProvider = 'google' | 'github' | 'slack' | 'atlassian' | 'social' | 'mcp' | 'email' | 'turnstile';
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
export async function observeChatStage<T>(
  phase: ChatStage,
  call: () => Promise<T>,
  attributes: { dispatch_source?: ChatDispatchSource } = {},
): Promise<T> {
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
    log('info', 'activity', 'call_completed', {
      operation: `chat.${phase}`,
      outcome,
      duration_ms: seconds * 1000,
      ...attributes,
    });
  }
}

/** `send` starts a reply from the send request; `sweep` is the background recovery path. */
export type ChatDispatchSource = 'send' | 'sweep';
/** The active trace id and whether it was sampled, for storing beside the record it produced. */
export function activeTrace(): { traceId: string; sampled: boolean } | undefined {
  const active = trace.getSpan(context.active())?.spanContext();
  if (!active || !isSpanContextValid(active)) return undefined;
  return { traceId: active.traceId, sampled: (active.traceFlags & TraceFlags.SAMPLED) === TraceFlags.SAMPLED };
}

/**
 * Runs a reply dispatch under a trace that is always kept. A send already runs in a kept request trace and continues
 * it; a sweep, or any unsampled caller, starts a `chat.turn` root linked to the span that dispatched it.
 */
export async function withChatTurnRoot<T>(source: ChatDispatchSource, call: () => Promise<T>): Promise<T> {
  const parent = trace.getSpan(context.active())?.spanContext();
  const valid = parent !== undefined && isSpanContextValid(parent);
  if (source === 'send' && valid && (parent.traceFlags & TraceFlags.SAMPLED) === TraceFlags.SAMPLED) return call();
  const span = trace.getTracer(scope).startSpan(
    chatTurnSpan,
    {
      attributes: { dispatch_source: source, 'build.commit': buildCommit },
      ...(valid ? { links: [{ context: parent }] } : {}),
    },
    ROOT_CONTEXT,
  );
  try {
    return await context.with(trace.setSpan(ROOT_CONTEXT, span), call);
  } catch (error) {
    span.setAttributes(errorAttributes(error));
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw error;
  } finally {
    span.end();
  }
}
/**
 * Why a turn was due: `undispatched` never started; `unclaimed` started but no worker claimed it within the grace;
 * `retry` waits out a failed attempt; `expired` lost its worker lease; `waiting` polls an external action.
 */
export const chatDispatchReasons = ['undispatched', 'unclaimed', 'retry', 'expired', 'waiting'] as const;
export type ChatDispatchReason = (typeof chatDispatchReasons)[number];
export function recordChatDispatch(
  source: ChatDispatchSource,
  outcome: 'success' | 'error',
  reason: ChatDispatchReason = 'undispatched',
) {
  metrics
    .getMeter(scope)
    .createCounter('cloud_chat_dispatches', { description: 'Reply workflow starts by dispatch path' })
    .add(1, { ...dimensions, dispatch_source: source, dispatch_reason: reason, outcome });
}

export type DispatchSkipper = 'github' | 'slack' | 'google' | 'atlassian' | 'embedding' | 'defaults' | 'knowledge';
/**
 * A background dispatcher skipped a workspace because its storage schema is outside the running release's
 * compatibility window. Work for that workspace stalls until it is migrated, so any sustained rate needs attention.
 */
export function recordDispatchSkip(
  dispatcher: DispatchSkipper,
  reason: 'incompatible_version' = 'incompatible_version',
) {
  metrics
    .getMeter(scope)
    .createCounter('cloud_dispatch_skipped_workspaces', {
      description: 'Workspaces a background dispatcher skipped, by dispatcher and reason',
    })
    .add(1, { ...dimensions, dispatcher, reason });
}

export type ChatModelPurpose = 'reply' | 'completion' | 'title' | 'calendar' | 'compaction';
export type ChatDetailPhase =
  | 'turn'
  | 'send-request'
  | 'send-write'
  | 'actor'
  | 'request'
  | 'resume'
  | 'requester'
  | 'reply-start'
  | 'checkpoint'
  | 'credit-top-up'
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
type ChatReplyCategory = 'model' | 'tools' | 'db';
type ChatReplySums = Record<ChatReplyCategory, number> & { tools_used: boolean };
/** Final turn timing read from tf_conversation_turns after the transition that ended the reply. */
export type ChatReplyFinal = {
  status: 'completed' | 'failed' | 'blocked' | 'cancelled';
  totalSeconds: number;
  /** From the send request reaching the API until its message was saved; null when no send request was recorded. */
  sendSeconds: number | null;
  queueSeconds: number;
  firstTextSeconds: number | null;
  attempts: number;
  /** The turn's stored error code, a fixed machine code; only its bounded class becomes a label. */
  errorCode?: string | null | undefined;
  runtime?: ChatReplyRuntime | undefined;
};
export type ChatReplyRuntime = 'chat' | 'slack';
type ChatReplyClock = {
  key: string | undefined;
  since: number;
  active: Record<ChatReplyCategory, number>;
  sums: ChatReplySums;
  final?: ChatReplyFinal | undefined;
  /** Bounded code of this attempt's failure, used when the turn stores only a generic code. */
  cause?: string | undefined;
};
type ChatDatabase = { transactions: number; milliseconds: number };
type ChatMeasurement = {
  counter: { value: number };
  database: ChatDatabase;
  purpose: ChatModelPurpose | 'turn' | 'send';
  sequence?: number;
  reply: ChatReplyClock;
};
const chatMeasurement = new AsyncLocalStorage<ChatMeasurement>();
export const chatReplySegments = ['total', 'first_text', 'send', 'queue', 'model', 'tools', 'db', 'overhead'] as const;
export const chatReplyBuckets = [0.1, 0.25, 0.5, 1, 1.5, 2, 3, 5, 8, 12, 20, 30, 60, 120, 300] as const;

/**
 * Sums are a union of intervals: nested or concurrent phases of one category count once, and tool time excludes model
 * calls made inside a tool, so `model` and `tools` never overlap. Database time may overlap tools.
 */
function tickChatReply(clock: ChatReplyClock) {
  const now = performance.now();
  const seconds = (now - clock.since) / 1000;
  clock.since = now;
  if (clock.active.model > 0) clock.sums.model += seconds;
  else if (clock.active.tools > 0) clock.sums.tools += seconds;
  if (clock.active.db > 0) clock.sums.db += seconds;
}

async function inChatReplyCategory<T>(category: ChatReplyCategory | undefined, call: () => Promise<T>) {
  const clock = chatMeasurement.getStore()?.reply;
  if (!clock || !category) return call();
  tickChatReply(clock);
  clock.active[category]++;
  try {
    return await call();
  } finally {
    tickChatReply(clock);
    clock.active[category]--;
  }
}

function chatReplyCategory(phase: ChatDetailPhase): ChatReplyCategory | undefined {
  if (phase === 'provider') return 'model';
  if (
    phase === 'reserve' ||
    phase === 'settle' ||
    phase === 'reply-start' ||
    phase === 'checkpoint' ||
    phase.startsWith('storage-') ||
    phase.startsWith('credit-')
  )
    return 'db';
  return undefined;
}

// A retried attempt usually lands on the same worker; carry its sums so the final record covers every attempt.
const chatReplyCarry = new Map<string, ChatReplySums & { at: number }>();
const chatReplyCarryLimit = 1000;
const chatReplyCarryMs = 60 * 60 * 1000;

function carryChatReply(key: string, sums: ChatReplySums) {
  const now = Date.now();
  for (const [stored, value] of chatReplyCarry) {
    if (now - value.at <= chatReplyCarryMs && chatReplyCarry.size < chatReplyCarryLimit) break;
    chatReplyCarry.delete(stored);
  }
  chatReplyCarry.delete(key);
  chatReplyCarry.set(key, { ...sums, at: now });
}

function finishChatReply(clock: ChatReplyClock) {
  tickChatReply(clock);
  const carried = clock.key === undefined ? undefined : chatReplyCarry.get(clock.key);
  const sums: ChatReplySums = {
    model: clock.sums.model + (carried?.model ?? 0),
    tools: clock.sums.tools + (carried?.tools ?? 0),
    db: clock.sums.db + (carried?.db ?? 0),
    tools_used: clock.sums.tools_used || Boolean(carried?.tools_used),
  };
  if (!clock.final) {
    if (clock.key !== undefined && (sums.model || sums.tools || sums.db || sums.tools_used))
      carryChatReply(clock.key, sums);
    return;
  }
  if (clock.key !== undefined) chatReplyCarry.delete(clock.key);
  const { status, totalSeconds: total, sendSeconds, queueSeconds: queue, firstTextSeconds, attempts } = clock.final;
  const outcome = status === 'completed' ? 'success' : status === 'cancelled' ? 'cancelled' : 'failed';
  const tools = sums.tools_used ? 'yes' : 'no';
  const values: Partial<Record<(typeof chatReplySegments)[number], number>> = {
    total,
    ...(firstTextSeconds === null ? {} : { first_text: firstTextSeconds }),
    ...(sendSeconds === null ? {} : { send: sendSeconds }),
    queue,
    model: sums.model,
    tools: sums.tools,
    db: sums.db,
    overhead: Math.max(0, total - queue - sums.model - sums.tools),
  };
  const histogram = metrics.getMeter(scope).createHistogram('cloud_chat_reply_duration', {
    unit: 's',
    description: 'Chat reply time by segment, recorded once per reply at its final state',
    advice: { explicitBucketBoundaries: [...chatReplyBuckets] },
  });
  const fields: Attributes = {};
  for (const segment of chatReplySegments) {
    const value = values[segment];
    if (value === undefined) continue;
    histogram.record(value, { ...dimensions, segment, outcome, tools });
    fields[`chat.reply.${segment}_seconds`] = value;
  }
  log('info', 'activity', 'call_completed', {
    operation: 'chat.reply.summary',
    outcome,
    'chat.reply.tools': tools,
    'chat.reply.attempts': attempts,
    ...fields,
  });
  if (status === 'failed') recordChatReplyStopped(clock.final.errorCode, clock.final.runtime ?? 'chat', clock.cause);
}

export const chatStopReasons = [
  'context',
  'provider-timeout',
  'provider-error',
  'database',
  'credits',
  'other',
] as const;
export type ChatStopReason = (typeof chatStopReasons)[number];
const genericStopCodes = new Set(['attempts-exhausted', 'transient-failure']);
const databaseStopCodes = new Set([
  'closed',
  'queue_full',
  'wait_timeout',
  'pool_capacity',
  'stale_credential',
  'incompatible_version',
  'runtime_unavailable',
]);

function stopReasonOf(code: string): ChatStopReason | undefined {
  if (code === 'credits-exhausted' || code === 'credit-limit') return 'credits';
  if (
    code === 'context-limit' ||
    code === 'context_too_long' ||
    code === 'model-context-overflow' ||
    code === 'conversation-context-overflow' ||
    code === 'project-context-too-large' ||
    code.startsWith('compaction-')
  )
    return 'context';
  if (code === 'model-timeout' || code === 'model-transport' || code === 'timeout' || code === 'network')
    return 'provider-timeout';
  if (
    code.startsWith('model-') ||
    code.startsWith('conversation-model-') ||
    (modelErrorClasses as readonly string[]).includes(code)
  )
    return 'provider-error';
  // PostgreSQL SQLSTATE classes for connections, transaction rollback, resources, lock state and shutdown.
  if (databaseStopCodes.has(code) || /^(08|25|40|53|55|57)[0-9A-Z]{3}$/.test(code)) return 'database';
  return undefined;
}

/**
 * Bounded reason a chat reply ended without an answer. The turn's stored code wins; a generic code such as
 * `attempts-exhausted` falls back to the bounded code of the failure that ended the last attempt.
 */
export function chatStopReason(errorCode: string | null | undefined, cause?: string): ChatStopReason {
  const stored = typeof errorCode === 'string' ? stopReasonOf(errorCode) : undefined;
  if (stored) return stored;
  if ((errorCode == null || genericStopCodes.has(errorCode)) && cause) return stopReasonOf(cause) ?? 'other';
  return 'other';
}

/** One chat reply that ended failed, without a final answer. Labels are the bounded reason and runtime only. */
function recordChatReplyStopped(errorCode: string | null | undefined, runtime: ChatReplyRuntime, cause?: string) {
  const reason = chatStopReason(errorCode, cause);
  const code = telemetryErrorCode(errorCode) ?? telemetryErrorCode(cause);
  log('warn', 'activity', 'call_failed', {
    operation: 'chat.reply-stopped',
    outcome: 'failed',
    'chat.stop.reason': reason,
    runtime,
    ...(code ? { 'error.code': code } : {}),
  });
}

/** Notes the bounded code of the failure that ended this reply attempt, for `chat.reply-stopped`. */
export function noteChatReplyCause(code: string | undefined) {
  const clock = chatMeasurement.getStore()?.reply;
  if (clock && code) clock.cause = code;
}

/**
 * Measures one reply attempt and records its database transaction count and time when it ends. `reply` is an in-process key, such as the turn ID, that joins retried attempts; it is
 * never exported. The reply duration is recorded only after `noteChatReplyFinal`.
 */
export async function withChatMeasurements<T>(call: () => Promise<T>, reply?: string): Promise<T> {
  if (chatMeasurement.getStore()) return call();
  const clock: ChatReplyClock = {
    key: reply,
    since: performance.now(),
    active: { model: 0, tools: 0, db: 0 },
    sums: { model: 0, tools: 0, db: 0, tools_used: false },
  };
  const database: ChatDatabase = { transactions: 0, milliseconds: 0 };
  return chatMeasurement.run({ counter: { value: 0 }, database, purpose: 'turn', reply: clock }, async () => {
    try {
      return await call();
    } finally {
      recordChatDatabase(database);
      finishChatReply(clock);
    }
  });
}

/**
 * Measures one chat send request: records `send-request` for the `waitedMs` the request spent before its handler
 * (authentication, session and body parsing), then the storage and write phases inside `call` with purpose `send`.
 */
export async function withChatSendMeasurements<T>(waitedMs: number, call: () => Promise<T>): Promise<T> {
  if (chatMeasurement.getStore()) return call();
  const state: ChatMeasurement = {
    counter: { value: 0 },
    database: { transactions: 0, milliseconds: 0 },
    purpose: 'send',
    reply: {
      key: undefined,
      since: performance.now(),
      active: { model: 0, tools: 0, db: 0 },
      sums: { model: 0, tools: 0, db: 0, tools_used: false },
    },
  };
  finishChatDetail('send-request', state, performance.now() - Math.max(0, waitedMs), 'success');
  return chatMeasurement.run(state, call);
}

export function chatReplyMeasured() {
  const state = chatMeasurement.getStore();
  return state !== undefined && state.purpose !== 'send';
}

/** Call inside the transaction that moved the turn to a final state; `guardChatReplyFinal` drops it on rollback. */
export function noteChatReplyFinal(final: ChatReplyFinal) {
  const state = chatMeasurement.getStore();
  if (state) state.reply.final = final;
}

/** Timing columns of a finished tf_conversation_turns row, as written by its timing trigger. */
export type ChatReplyTiming = {
  status: ChatReplyFinal['status'];
  /** When the send request reached the API; null for turns saved without one or before it was recorded. */
  requestedAt: Date | null;
  startedAt: Date;
  claimedAt: Date | null;
  finishedAt: Date;
  firstTextSeconds: number | null;
  humanWaitSeconds: number;
  externalWaitSeconds: number;
  inactiveSeconds: number;
  attempts: number;
  errorCode?: string | null | undefined;
  runtime?: ChatReplyRuntime | undefined;
};

/**
 * Total runs from the send request reaching the API (or the saved user message when no request was recorded) to the
 * final state, minus time waiting on a person (approvals, questions), on Slack or MCP, and while inactive, so `total`
 * and `overhead` only hold time the reply could make progress. `send` is the request's time before the message was
 * saved; `queue` starts at the save, so `send` counts toward `overhead`.
 */
export function chatReplyFinal(timing: ChatReplyTiming): ChatReplyFinal {
  const started = timing.startedAt.getTime();
  const sendSeconds = timing.requestedAt === null ? null : Math.max(0, (started - timing.requestedAt.getTime()) / 1000);
  const wall = (timing.finishedAt.getTime() - started) / 1000 + (sendSeconds ?? 0);
  const waits = timing.humanWaitSeconds + timing.externalWaitSeconds + timing.inactiveSeconds;
  const totalSeconds = Math.max(0, wall - waits);
  const afterSave = Math.max(0, totalSeconds - (sendSeconds ?? 0));
  const queued = timing.claimedAt ? (timing.claimedAt.getTime() - started) / 1000 : afterSave;
  return {
    status: timing.status,
    totalSeconds,
    sendSeconds: sendSeconds === null ? null : Math.min(totalSeconds, sendSeconds),
    queueSeconds: Math.min(afterSave, Math.max(0, queued)),
    firstTextSeconds: timing.firstTextSeconds === null ? null : timing.firstTextSeconds + (sendSeconds ?? 0),
    attempts: timing.attempts,
    ...(timing.errorCode === undefined ? {} : { errorCode: timing.errorCode }),
    ...(timing.runtime === undefined ? {} : { runtime: timing.runtime }),
  };
}

export async function guardChatReplyFinal<T>(call: () => Promise<T>): Promise<T> {
  const state = chatMeasurement.getStore();
  if (!state) return call();
  const before = state.reply.final;
  try {
    return await call();
  } catch (error) {
    state.reply.final = before;
    throw error;
  }
}

/** Real tool execution in a reply. UI-only steps such as `present.choice` do not use it. */
export function observeChatTool<T>(call: () => Promise<T>): Promise<T> {
  const clock = chatMeasurement.getStore()?.reply;
  if (clock) clock.sums.tools_used = true;
  return inChatReplyCategory('tools', call);
}

function recordChatDatabase(database: ChatDatabase) {
  if (!database.transactions) return;
  const meter = metrics.getMeter(scope);
  meter.createHistogram('cloud_chat_db_transactions').record(database.transactions, dimensions);
  meter.createHistogram('cloud_chat_db_duration', { unit: 's' }).record(database.milliseconds / 1000, dimensions);
  log('info', 'activity', 'call_completed', {
    operation: 'chat.database',
    'db.transactions': database.transactions,
    duration_ms: database.milliseconds,
  });
}

/** Counts one database transaction, including its wait for a connection, toward the current reply's totals. */
export async function observeChatTransaction<T>(call: () => Promise<T>): Promise<T> {
  const state = chatMeasurement.getStore();
  if (!state) return call();
  const start = performance.now();
  try {
    return await call();
  } finally {
    state.database.transactions++;
    state.database.milliseconds += performance.now() - start;
  }
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
        return await inChatReplyCategory(chatReplyCategory(phase), call);
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
      const category = chatReplyCategory(phase);
      if (category) {
        tickChatReply(state.reply);
        state.reply.active[category]++;
      }
      let outcome = 'success';
      try {
        return call();
      } catch (error) {
        outcome = 'error';
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        if (category) {
          tickChatReply(state.reply);
          state.reply.active[category]--;
        }
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
  const sequence = ++state.counter.value;
  return chatMeasurement.run(
    { counter: state.counter, database: state.database, purpose, sequence, reply: state.reply },
    async () => {
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
    },
  );
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

export type ChatCompletionCheckOutcome = 'skipped_no_tools' | 'done' | 'continue' | 'error';
/** One completion-check outcome of a chat reply. A reply records `skipped_no_tools` once, or each check it ran. */
export function recordChatCompletionCheck(outcome: ChatCompletionCheckOutcome) {
  metrics
    .getMeter(scope)
    .createCounter('cloud_chat_completion_checks')
    .add(1, { ...dimensions, outcome });
  log('info', 'inference', 'call_completed', { operation: 'chat.completion-check', outcome });
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

export type ChatContextCompactionOutcome = 'summarised' | 'stubbed';
/**
 * One mid-reply context compaction: estimated input tokens that triggered it and after it, the model window, and how
 * many older tool results were summarised or stubbed and loaded tool definitions pruned. Counts only, never content.
 */
export function recordChatContextCompaction(compaction: {
  triggerTokens: number;
  window: number;
  afterTokens: number;
  summarised: number;
  stubbed: number;
  pruned: number;
  outcome: ChatContextCompactionOutcome;
}) {
  const state = chatMeasurement.getStore();
  const attributes: Attributes = state ? chatDetailAttributes(state) : {};
  const counts = {
    trigger_tokens: compaction.triggerTokens,
    window: compaction.window,
    after_tokens: compaction.afterTokens,
    summarised: compaction.summarised,
    stubbed: compaction.stubbed,
    pruned: compaction.pruned,
  };
  for (const [name, count] of Object.entries(counts)) {
    if (!Number.isSafeInteger(count) || count < 0) throw new RangeError('invalid-chat-context-compaction-count');
    attributes[`chat.compaction.${name}`] = count;
  }
  const { outcome } = compaction;
  attributes['chat.compaction.outcome'] = outcome;
  metrics
    .getMeter(scope)
    .createCounter('cloud_chat_context_compactions')
    .add(1, { ...dimensions, outcome });
  metrics
    .getMeter(scope)
    .createHistogram('cloud_chat_context_compaction_ratio')
    .record(compaction.window ? compaction.afterTokens / compaction.window : 0, { ...dimensions, outcome });
  log('info', 'inference', 'call_completed', { operation: 'chat.context-compaction', ...attributes });
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
export type ToolOutcome = 'success' | 'error' | 'result_error' | 'waiting' | 'blocked';
/**
 * `error` is a call that threw or a dispatch that failed; `result_error` is a call that returned a structured failure,
 * such as an unavailable source, which the chat shows as failed. `errorType` names a failure that the dispatcher caught
 * and reported as a returned outcome.
 */
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
        const failed = outcome === 'error' || outcome === 'result_error' || outcome === 'blocked';
        const seconds = (performance.now() - start) / 1000;
        if (failed) {
          errorCode ??= 'unclassified';
          // A returned failure has no exception type; its bounded code stands in so error_type stays low-cardinality.
          if (outcome === 'result_error') failure ??= errorCode;
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

/** Records a chat's post-reply title step. A failure or timeout logs one warning with a bounded error code. */
export function recordTitleGeneration(outcome: TitleGenerationOutcome, seconds: number, errorCode?: string) {
  callMetrics('activity', 'chat.title', outcome, seconds);
  const failed = outcome === 'failed' || outcome === 'timeout';
  log(failed ? 'warn' : 'info', 'activity', failed ? 'call_failed' : 'call_completed', {
    operation: 'chat.title',
    title_generation: outcome,
    duration_ms: Math.round(seconds * 1000),
    ...(failed ? { 'error.code': telemetryErrorCode(errorCode) ?? 'model-request-failed' } : {}),
  });
}

/**
 * Records one chat sub-agent that ended. Only its kind, outcome, duration, and credits are kept; never its name, task,
 * report, or any identifier.
 */
export function recordSubagent(
  kind: 'saved' | 'helper',
  outcome: 'done' | 'failed' | 'timed-out' | 'stopped',
  seconds: number,
  credits: number,
) {
  const attributes = { 'subagent.kind': kind };
  callMetrics('activity', 'chat.subagent', outcome, seconds, attributes);
  metrics
    .getMeter(scope)
    .createCounter('cloud_chat_subagent_credits', { description: 'Credits spent by chat sub-agents' })
    .add(Math.max(0, credits), { ...dimensions, ...attributes, outcome });
  log(outcome === 'failed' ? 'warn' : 'info', 'activity', outcome === 'failed' ? 'call_failed' : 'call_completed', {
    operation: 'chat.subagent',
    ...attributes,
    outcome,
    duration_ms: Math.round(seconds * 1000),
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

/** `alwaysSample` keeps the request's trace regardless of the ratio, for routes such as a chat send that start a reply. */
export function startHttp(method: string, route: string, options: { alwaysSample?: boolean } = {}) {
  const safeMethod = /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|TRACE|CONNECT)$/.test(method) ? method : '_OTHER';
  const attributes = { 'http.request.method': safeMethod, 'http.route': route, 'build.commit': buildCommit };
  const span = trace
    .getTracer(scope)
    .startSpan(
      `${safeMethod} ${route}`,
      { kind: SpanKind.SERVER, attributes },
      options.alwaysSample ? alwaysSample(ROOT_CONTEXT) : ROOT_CONTEXT,
    );
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

/**
 * Records a product event declared in @tulipfarm/config/analytics-events. Undeclared properties
 * and values of the wrong type are dropped, so free text never leaves the process. A workspace
 * event is attached to the `workspace` group. Without the user, the workspace is the actor.
 */
export function trackEvent<E extends AnalyticsEventName>(
  event: E,
  actor: { readonly userId?: string | null; readonly workspaceId?: string | null },
  properties: AnalyticsEventProperties<E> = {} as AnalyticsEventProperties<E>,
) {
  const distinctId = actor.userId || (actor.workspaceId ? `workspace:${actor.workspaceId}` : undefined);
  if (!distinctId || !isAnalyticsEvent(event)) return;
  captureAnalytics({
    event,
    distinctId,
    properties: {
      ...analyticsEventProperties(event, properties as Record<string, unknown>),
      ...(actor.workspaceId ? { workspace_id: actor.workspaceId } : {}),
    },
    ...(actor.workspaceId ? { groups: { workspace: actor.workspaceId } } : {}),
  });
}

/** Stores a workspace's analytics group properties: its name, slug and creation time. */
export function identifyWorkspace(workspace: {
  readonly id: string;
  readonly name?: string;
  readonly slug?: string;
  readonly createdAt?: string | Date;
}) {
  const createdAt = workspace.createdAt instanceof Date ? workspace.createdAt.toISOString() : workspace.createdAt;
  identifyAnalyticsGroup({
    type: 'workspace',
    key: workspace.id,
    properties: {
      ...(workspace.name !== undefined && { name: workspace.name }),
      ...(workspace.slug !== undefined && { slug: workspace.slug }),
      ...(createdAt !== undefined && { created_at: createdAt }),
    },
  });
}

/** Stores a person's analytics properties. Only the email's domain is stored, never the email. */
export function identifyUser(user: { readonly id: string; readonly email?: string | null }) {
  const domain = emailDomain(user.email ?? undefined);
  identifyAnalyticsPerson({ distinctId: user.id, properties: { ...(domain && { email_domain: domain }) } });
}

const flagFailure = (operation: string) => (error: unknown) =>
  log('warn', 'dependency', 'call_failed', { operation, outcome: 'fallback', ...errorAttributes(error) });

// A workspace flag ignores the user, so its lookup and cache are shared by every member.
function contextFor(scope: FeatureFlagScope, user: FlagUserInput | null, workspace: FlagWorkspaceInput | undefined) {
  if (scope === 'global') return Promise.resolve({});
  return resolveFlagContext(
    scope === 'user' ? (user ?? undefined) : undefined,
    workspace,
    flagFailure('feature-flag.subject'),
  );
}

/**
 * Resolves a flag: the registered flag provider when it returns a boolean, else the flag's env
 * override, FEATURE_FLAGS_OFF, and its declared default (see @tulipfarm/config/feature-flags).
 * The flag's scope decides who it is evaluated for: a `workspace` flag ignores `user`, a `global`
 * flag ignores both. Missing attributes come from the registered flag subject resolver.
 * A provider failure is logged and falls back. Unknown flags are off.
 */
export async function isFeatureEnabled(
  flag: FeatureFlag,
  user: FlagUserInput | null,
  workspace?: FlagWorkspaceInput,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (!isFeatureFlag(flag)) return false;
  const provider = flagProvider();
  if (provider) {
    const { scope } = featureFlags[flag];
    const subject = flagSubject(scope, await contextFor(scope, user, workspace));
    if (subject) {
      try {
        const answer = await provider.isEnabled(flag, subject);
        if (typeof answer === 'boolean') return answer;
      } catch (error) {
        flagFailure(`feature-flag.${flag}`)(error);
      }
    }
  }
  return configuredFeatureFlag(flag, env);
}

/**
 * Every registered flag for one subject, as a serializable snapshot for a client such as the web
 * app. Each scope is one provider call when the provider supports `evaluateMany`.
 */
export async function featureFlagSnapshot(
  user: FlagUserInput,
  workspace?: FlagWorkspaceInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<FeatureFlagSnapshot> {
  const provider = flagProvider();
  const answers = new Map<FeatureFlag, boolean>();
  if (provider) {
    const scopes = [...new Set(featureFlagNames.map(flag => featureFlags[flag].scope))];
    await Promise.all(
      scopes.map(async scope => {
        const flags = featureFlagNames.filter(flag => featureFlags[flag].scope === scope);
        const subject = flagSubject(scope, await contextFor(scope, user, workspace));
        if (!subject) return;
        const evaluate = provider.evaluateMany
          ? async () => {
              try {
                return await provider.evaluateMany!(flags, subject);
              } catch (error) {
                flagFailure('feature-flag.snapshot')(error);
                return {};
              }
            }
          : async () =>
              Object.fromEntries(
                await Promise.all(
                  flags.map(async flag => {
                    try {
                      return [flag, await provider.isEnabled(flag, subject)] as const;
                    } catch (error) {
                      flagFailure(`feature-flag.${flag}`)(error);
                      return [flag, undefined] as const;
                    }
                  }),
                ),
              );
        const result = await evaluate();
        for (const flag of flags) {
          const answer = Object.hasOwn(result, flag) ? result[flag] : undefined;
          if (typeof answer === 'boolean') answers.set(flag, answer);
        }
      }),
    );
  }
  return Object.fromEntries(
    featureFlagNames.map(flag => [flag, answers.get(flag) ?? configuredFeatureFlag(flag, env)]),
  ) as FeatureFlagSnapshot;
}

/** Counts and logs what an optional fallback model did for one failed primary model call. */
export function recordModelFallback(
  outcome: ModelFallbackOutcome,
  primary: { provider: string; model: string; errorClass: string },
  fallback?: { provider: string; model: string },
) {
  const labels = {
    ...dimensions,
    'gen_ai.provider.name': primary.provider,
    'gen_ai.request.model': primary.model,
    ...(telemetryErrorCode(primary.errorClass) ? { 'error.type': primary.errorClass } : {}),
    model_fallback: outcome,
  };
  try {
    metrics
      .getMeter(scope)
      .createCounter('gen_ai_model_fallback', { description: 'Fallback decisions after a failed model call' })
      .add(1, labels);
  } catch {
    /* Telemetry must not change the reply. */
  }
  log(outcome === 'used' ? 'warn' : outcome === 'failed' ? 'error' : 'info', 'inference', 'call_completed', {
    operation: 'chat.model-fallback',
    ...labels,
    ...(fallback ? { 'fallback.provider': fallback.provider, 'fallback.model': fallback.model } : {}),
  });
}

export function withTelemetryContext<T>(parent: Context, call: () => T): T {
  return context.with(parent, call);
}

export async function observeInference<T>(
  model: { provider: string; model: string; operation: 'chat' | 'embeddings' },
  call: (report: {
    firstToken: () => void;
    usage: (input: number, output: number) => void;
    /**
     * Records why a successful call's usage is unknown, with the usage object the provider sent, if any.
     * A successful chat call that reports neither is counted as unknown with reason `missing`.
     */
    usageUnknown: (reason: ModelUsageUnknownReason, providerUsage?: unknown) => void;
    /** Marks the call failed; pass the failure so its classification and provider details are logged. */
    error: (error?: unknown) => void;
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
        let unknownUsage: { reason: ModelUsageUnknownReason; shape: string | undefined } | undefined;
        const meter = metrics.getMeter(scope);
        // A stream can report an error before the call throws its classified failure, so the failure is logged once, at the end.
        let failure: unknown;
        const fail = (error?: unknown) => {
          outcome = 'error';
          if (error !== undefined && failure === undefined) failure = error;
        };
        let errorType: string | undefined;
        const finishFailure = () => {
          if (outcome !== 'error') return;
          const details = failure === undefined ? { 'error.type': 'unknown' } : errorAttributes(failure);
          const diagnostics = modelCallDiagnostics(failure);
          const spanDetails: Attributes = {
            ...details,
            ...(diagnostics
              ? {
                  'error.code': diagnostics.errorClass,
                  'error.type': diagnostics.errorClass,
                  output_started: diagnostics.outputStarted,
                  ...(diagnostics.status === undefined ? {} : { 'http.response.status_code': diagnostics.status }),
                }
              : {}),
          };
          errorType = String(spanDetails['error.code'] ?? spanDetails['error.type']);
          span.setAttributes(spanDetails);
          span.setStatus({ code: SpanStatusCode.ERROR });
          log('error', 'inference', 'call_failed', {
            ...attributes,
            ...spanDetails,
            ...(diagnostics?.providerCode ? { 'provider.error_code': diagnostics.providerCode } : {}),
            ...(diagnostics?.providerMessage ? { 'provider.error_message': diagnostics.providerMessage } : {}),
          });
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
            usageUnknown(reason, providerUsage) {
              unknownUsage = { reason, shape: usageShape(providerUsage) };
            },
            error: fail,
          });
        } catch (error) {
          fail(error);
          throw error;
        } finally {
          const seconds = (performance.now() - start) / 1000;
          finishFailure();
          const labels = {
            ...dimensions,
            ...attributes,
            outcome,
            ...(errorType && telemetryErrorCode(errorType) ? { 'error.type': errorType } : {}),
          };
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
          if (model.operation === 'chat' && outcome === 'success') {
            const reported = usage !== undefined;
            try {
              meter
                .createCounter('gen_ai_model_usage', {
                  description: 'Successful model calls by whether the provider reported readable token usage',
                })
                .add(1, { ...labels, model_usage: reported ? 'reported' : 'unknown' });
            } catch {
              /* Telemetry must not change the reply. */
            }
            if (!reported)
              log('warn', 'inference', 'call_failed', {
                ...attributes,
                operation: 'chat.model-usage',
                'error.type': 'usage-unknown',
                model_usage: 'unknown',
                'usage.unknown_reason': unknownUsage?.reason ?? 'missing',
                ...(unknownUsage?.shape ? { 'usage.shape': unknownUsage.shape } : {}),
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
