import assert from 'node:assert/strict';
import test from 'node:test';
import { metrics } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import {
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
  AggregationTemporality,
  MeterProvider,
} from '@opentelemetry/sdk-metrics';
import { InMemoryLogRecordExporter, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import {
  createChatLatencyMetrics,
  observeWorkspaceConnection,
  observeChatStage,
  observeChatDetail,
  observeChatDetailSync,
  withChatMeasurements,
  withChatModelRequest,
  recordChatRequestSizes,
  recordChatDiscovery,
  recordChatDispatch,
  recordDispatchSkip,
  recordChatCompletionCheck,
  errorType,
  log,
  observeCall,
  observeInference,
  observeTool,
  recordTaskTransition,
  toolFailureLogged,
  privateSpanExporter,
  startHttp,
  telemetryConfig,
  telemetryErrorCode,
  telemetryIdentity,
  trace,
  withTelemetryContext,
} from '../src/index.ts';
import { registerExtension, resetExtensions } from '@tulipfarm/extensions';
import { captureEvent, captureException } from '../src/index.ts';
import {
  createBackgroundJob,
  createKnowledgeSyncMetrics,
  recordKnowledgeImport,
  observeDependency,
  observeFetch,
  errorAttributes,
  withErrorStage,
} from '../src/index.ts';

test('production export requires explicit valid server-side configuration', () => {
  const config = {
    NODE_ENV: 'production',
    CLOUD_TELEMETRY_ENABLED: 'true',
    CLOUD_TELEMETRY_OTLP_ENDPOINT: 'https://otlp-gateway-prod-us-west-0.grafana.net/otlp',
    CLOUD_TELEMETRY_OTLP_AUTHORIZATION: 'Basic dGVzdDp0ZXN0',
    CLOUD_TELEMETRY_RELEASE: 'a'.repeat(40),
  };
  assert.equal(telemetryConfig({ ...config, NODE_ENV: 'test' }), undefined);
  assert.equal(telemetryConfig({ ...config, CLOUD_TELEMETRY_ENABLED: 'false' }), undefined);
  assert.equal(telemetryConfig(config).ratio, 0.1);
  assert.equal(telemetryConfig({ ...config, CLOUD_TELEMETRY_SAMPLE_RATIO: '1' }).ratio, 1);
  assert.equal(telemetryConfig({ ...config, CLOUD_TELEMETRY_SAMPLE_RATIO: '1.0' }).ratio, 1);
  assert.equal(telemetryConfig({ ...config, CLOUD_TELEMETRY_SAMPLE_RATIO: '0' }).ratio, 0);
  assert.equal(telemetryConfig({ ...config, CLOUD_TELEMETRY_SAMPLE_RATIO: '' }).ratio, 0.1);
  for (const ratio of ['1.01', '-0.1', 'NaN', 'Infinity', '0x1', '1e-1', 'half'])
    assert.throws(() => telemetryConfig({ ...config, CLOUD_TELEMETRY_SAMPLE_RATIO: ratio }), /SAMPLE_RATIO/);
  assert.equal(telemetryConfig({ ...config, CLOUD_TELEMETRY_RELEASE: '' }).ratio, 0.1);
});

const grafana = {
  NODE_ENV: 'production',
  CLOUD_TELEMETRY_ENABLED: 'true',
  CLOUD_TELEMETRY_OTLP_ENDPOINT: 'https://otlp-gateway-prod-us-west-0.grafana.net/otlp',
  CLOUD_TELEMETRY_OTLP_AUTHORIZATION: 'Basic dGVzdDp0ZXN0',
};
const enabled = { NODE_ENV: 'production', CLOUD_TELEMETRY_ENABLED: 'true' };

test('existing Grafana Cloud configuration exports to the same URLs with the same header', () => {
  assert.deepEqual(telemetryConfig(grafana), {
    ratio: 0.1,
    jobRatio: 0.01,
    headers: { Authorization: 'Basic dGVzdDp0ZXN0' },
    traces: 'https://otlp-gateway-prod-us-west-0.grafana.net/otlp/v1/traces',
    metrics: 'https://otlp-gateway-prod-us-west-0.grafana.net/otlp/v1/metrics',
    logs: 'https://otlp-gateway-prod-us-west-0.grafana.net/otlp/v1/logs',
  });
  assert.deepEqual(telemetryConfig({ ...grafana, CLOUD_TELEMETRY_SAMPLE_RATIO: '0.05' }).ratio, 0.05);
});

test('any HTTPS OTLP endpoint works with or without authorization and generic headers', () => {
  assert.deepEqual(
    telemetryConfig({
      ...enabled,
      CLOUD_TELEMETRY_OTLP_ENDPOINT: 'https://api.honeycomb.io',
      CLOUD_TELEMETRY_OTLP_HEADERS: 'x-honeycomb-team=hc%20key, x-honeycomb-dataset = tulipfarm ,',
    }),
    {
      ratio: 0.1,
      jobRatio: 0.01,
      headers: { 'x-honeycomb-team': 'hc key', 'x-honeycomb-dataset': 'tulipfarm' },
      traces: 'https://api.honeycomb.io/v1/traces',
      metrics: 'https://api.honeycomb.io/v1/metrics',
      logs: 'https://api.honeycomb.io/v1/logs',
    },
  );
  assert.deepEqual(
    telemetryConfig({
      ...enabled,
      CLOUD_TELEMETRY_OTLP_ENDPOINT: 'https://otlp.us5.datadoghq.com/',
      CLOUD_TELEMETRY_OTLP_HEADERS: 'DD-API-KEY=abc123',
      CLOUD_TELEMETRY_SAMPLE_RATIO: '1.0',
    }),
    {
      ratio: 1,
      jobRatio: 0.01,
      headers: { 'DD-API-KEY': 'abc123' },
      traces: 'https://otlp.us5.datadoghq.com/v1/traces',
      metrics: 'https://otlp.us5.datadoghq.com/v1/metrics',
      logs: 'https://otlp.us5.datadoghq.com/v1/logs',
    },
  );
  assert.deepEqual(
    telemetryConfig({
      ...enabled,
      CLOUD_TELEMETRY_OTLP_ENDPOINT: 'https://otlp.nr-data.net:4318',
      CLOUD_TELEMETRY_OTLP_AUTHORIZATION: 'Bearer token-1',
      CLOUD_TELEMETRY_OTLP_HEADERS: 'api-key=nr',
    }).headers,
    { Authorization: 'Bearer token-1', 'api-key': 'nr' },
  );
  assert.deepEqual(
    telemetryConfig({
      ...enabled,
      CLOUD_TELEMETRY_OTLP_ENDPOINT: 'https://collector.example.com',
      CLOUD_TELEMETRY_OTLP_HEADERS: 'authorization=Api-Token abc',
    }).headers,
    { authorization: 'Api-Token abc' },
  );
});

test('plain HTTP is accepted only for local and private collectors, or with an explicit opt-in', () => {
  for (const endpoint of [
    'http://localhost:4318',
    'http://127.0.0.1:4318',
    'http://[::1]:4318',
    'http://otel-collector:4318',
    'http://collector.observability.svc.cluster.local:4318',
    'http://collector.internal:4318',
    'http://10.1.2.3:4318',
    'http://172.20.0.5:4318',
    'http://192.168.1.9:4318',
    'http://[fd00::1]:4318',
  ])
    assert.equal(
      telemetryConfig({ ...enabled, CLOUD_TELEMETRY_OTLP_ENDPOINT: endpoint }).traces,
      `${new URL(endpoint).href.replace(/\/$/, '')}/v1/traces`,
      endpoint,
    );
  for (const endpoint of ['http://collector.example.com:4318', 'http://8.8.8.8:4318', 'http://172.32.0.1:4318'])
    assert.throws(() => telemetryConfig({ ...enabled, CLOUD_TELEMETRY_OTLP_ENDPOINT: endpoint }), /OTLP_ENDPOINT/);
  assert.equal(
    telemetryConfig({
      ...enabled,
      CLOUD_TELEMETRY_OTLP_ENDPOINT: 'http://collector.example.com:4318',
      CLOUD_TELEMETRY_OTLP_ALLOW_HTTP: 'true',
    }).logs,
    'http://collector.example.com:4318/v1/logs',
  );
  assert.throws(
    () =>
      telemetryConfig({
        ...enabled,
        CLOUD_TELEMETRY_OTLP_ENDPOINT: 'http://localhost:4318',
        CLOUD_TELEMETRY_OTLP_ALLOW_HTTP: 'yes',
      }),
    /ALLOW_HTTP/,
  );
});

test('per-signal endpoints are used as-is and signals can be turned off', () => {
  assert.deepEqual(
    telemetryConfig({
      ...enabled,
      CLOUD_TELEMETRY_OTLP_ENDPOINT: 'https://otlp.example.com',
      CLOUD_TELEMETRY_OTLP_TRACES_ENDPOINT: 'https://traces.example.com/custom/path',
      CLOUD_TELEMETRY_METRICS_ENABLED: 'false',
    }),
    {
      ratio: 0.1,
      jobRatio: 0.01,
      headers: {},
      traces: 'https://traces.example.com/custom/path',
      logs: 'https://otlp.example.com/v1/logs',
    },
  );
  assert.deepEqual(
    telemetryConfig({
      ...enabled,
      CLOUD_TELEMETRY_OTLP_TRACES_ENDPOINT: 'http://jaeger:4318/v1/traces',
      CLOUD_TELEMETRY_METRICS_ENABLED: 'false',
      CLOUD_TELEMETRY_LOGS_ENABLED: 'false',
    }),
    { ratio: 0.1, jobRatio: 0.01, headers: {}, traces: 'http://jaeger:4318/v1/traces' },
  );
  assert.throws(
    () => telemetryConfig({ ...enabled, CLOUD_TELEMETRY_OTLP_TRACES_ENDPOINT: 'https://traces.example.com/v1/traces' }),
    /CLOUD_TELEMETRY_OTLP_ENDPOINT/,
    'metrics and logs still need an endpoint',
  );
  assert.throws(() => telemetryConfig(enabled), /CLOUD_TELEMETRY_OTLP_ENDPOINT/);
  assert.throws(
    () =>
      telemetryConfig({
        ...grafana,
        CLOUD_TELEMETRY_TRACES_ENABLED: 'false',
        CLOUD_TELEMETRY_METRICS_ENABLED: 'false',
        CLOUD_TELEMETRY_LOGS_ENABLED: 'false',
      }),
    /CLOUD_TELEMETRY_ENABLED/,
  );
  assert.throws(() => telemetryConfig({ ...grafana, CLOUD_TELEMETRY_LOGS_ENABLED: 'no' }), /LOGS_ENABLED/);
  assert.throws(
    () => telemetryConfig({ ...grafana, CLOUD_TELEMETRY_OTLP_LOGS_ENDPOINT: 'https://user:pw@logs.example.com' }),
    /OTLP_LOGS_ENDPOINT/,
  );
});

test('credentials, query strings, fragments, bad schemes and bad headers are rejected without echoing values', () => {
  const secret = 'SECRETVALUE';
  const cases = [
    { CLOUD_TELEMETRY_OTLP_ENDPOINT: `https://user:${secret}@otlp.example.com` },
    { CLOUD_TELEMETRY_OTLP_ENDPOINT: `https://${secret}@otlp.example.com` },
    { CLOUD_TELEMETRY_OTLP_ENDPOINT: `https://otlp.example.com/otlp?key=${secret}` },
    { CLOUD_TELEMETRY_OTLP_ENDPOINT: 'https://otlp.example.com/otlp?' },
    { CLOUD_TELEMETRY_OTLP_ENDPOINT: `https://otlp.example.com/otlp#${secret}` },
    { CLOUD_TELEMETRY_OTLP_ENDPOINT: `ftp://otlp.example.com/${secret}` },
    { CLOUD_TELEMETRY_OTLP_ENDPOINT: `not a url ${secret}` },
    { CLOUD_TELEMETRY_OTLP_HEADERS: `bad header=${secret}` },
    { CLOUD_TELEMETRY_OTLP_HEADERS: `x-key:${secret}` },
    { CLOUD_TELEMETRY_OTLP_HEADERS: `=${secret}` },
    { CLOUD_TELEMETRY_OTLP_HEADERS: `x-key=${secret}%0d%0aX-Injected: 1` },
    { CLOUD_TELEMETRY_OTLP_HEADERS: `x-key=${secret}%` },
    { CLOUD_TELEMETRY_OTLP_HEADERS: 'x-key=' },
    { CLOUD_TELEMETRY_OTLP_HEADERS: `x-key=${secret},X-Key=${secret}` },
    { CLOUD_TELEMETRY_OTLP_HEADERS: `Content-Type=${secret}` },
    { CLOUD_TELEMETRY_OTLP_HEADERS: `host=${secret}` },
    { CLOUD_TELEMETRY_OTLP_HEADERS: `Authorization=Bearer ${secret}` },
    { CLOUD_TELEMETRY_OTLP_AUTHORIZATION: secret },
    { CLOUD_TELEMETRY_OTLP_AUTHORIZATION: `Bearer ${secret}\r\nX-Injected: 1` },
    { CLOUD_TELEMETRY_OTLP_AUTHORIZATION: `Bearer\t${secret}` },
  ];
  for (const overrides of cases) {
    let error;
    try {
      telemetryConfig({ ...grafana, ...overrides });
    } catch (caught) {
      error = caught;
    }
    assert.ok(error, JSON.stringify(Object.keys(overrides)));
    assert.equal(error.name, 'TelemetryConfigError');
    assert.match(error.setting, /^CLOUD_TELEMETRY_[A-Z_]+$/);
    assert.doesNotMatch(`${error.message} ${error.stack}`, /SECRETVALUE|Bearer|user:/);
  }
});

test('standard OTEL_* variables neither enable nor redirect export', () => {
  const otel = {
    OTEL_EXPORTER_OTLP_ENDPOINT: 'http://elsewhere.example.com:4318',
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://elsewhere.example.com:4318/v1/traces',
    OTEL_TRACES_SAMPLER_ARG: '1',
  };
  assert.equal(telemetryConfig({ NODE_ENV: 'production', ...otel }), undefined);
  assert.deepEqual(telemetryConfig({ ...grafana, ...otel }), telemetryConfig(grafana));
  assert.throws(() => telemetryConfig({ ...enabled, ...otel }), /CLOUD_TELEMETRY_OTLP_ENDPOINT/);
});

test('errors and product events go to extension slots when registered', async t => {
  t.after(resetExtensions);
  const seen = [];
  await registerExtension(
    {
      name: 'fixture',
      register(slots) {
        slots.errorReporter({
          captureException: (error, distinctId) => seen.push(['error', error.message, distinctId]),
        });
        slots.analytics({ capture: event => seen.push(['event', event]) });
      },
    },
    { app: 'api', env: {} },
  );
  captureException(new Error('boom'), 'u1');
  captureEvent('signed_up', 'u1', { plan: 'free' }, { workspace: 'w1' });
  assert.deepEqual(seen, [
    ['error', 'boom', 'u1'],
    ['event', { event: 'signed_up', distinctId: 'u1', properties: { plan: 'free' }, groups: { workspace: 'w1' } }],
  ]);
});

test('failed background jobs go to the error reporters; successful runs do not', async t => {
  t.after(resetExtensions);
  const reported = [];
  await registerExtension(
    {
      name: 'fixture',
      register(slots) {
        slots.errorReporter({ captureException: error => reported.push(error) });
        slots.errorReporter({
          captureException: () => {
            throw new Error('reporter down');
          },
        });
      },
    },
    { app: 'worker', env: {} },
  );
  const job = createBackgroundJob('object-cleanup', 60);
  t.after(() => job.close());
  const asyncFailure = new Error('async');
  const syncFailure = new Error('sync');
  assert.equal(await job.run(async () => 1), 1);
  assert.equal(
    job.runSync(() => 2),
    2,
  );
  await assert.rejects(
    job.run(async () => {
      throw asyncFailure;
    }),
    value => value === asyncFailure,
  );
  assert.throws(
    () =>
      job.runSync(() => {
        throw syncFailure;
      }),
    value => value === syncFailure,
  );
  assert.deepEqual(reported, [asyncFailure, syncFailure]);
});

test('HTTP, nested work and inference export counts, seconds, status and correlated private spans', async t => {
  const spans = new InMemorySpanExporter();
  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const reader = new PeriodicExportingMetricReader({ exporter: metricExporter, exportIntervalMillis: 60000 });
  const records = new InMemoryLogRecordExporter();
  const resource = telemetryIdentity({ app: 'api', version: '2026.10.2.7', commit: 'b'.repeat(40) }, true);
  const sdk = new NodeSDK({
    resource,
    autoDetectResources: false,
    spanProcessors: [new SimpleSpanProcessor(privateSpanExporter(spans))],
    metricReader: reader,
    logRecordProcessors: [new SimpleLogRecordProcessor({ exporter: records })],
  });
  sdk.start();
  const chatMetrics = createChatLatencyMetrics();
  const knowledgeMetrics = createKnowledgeSyncMetrics();
  const jobs = [];
  try {
    const request = startHttp('GET', '/v1/widgets/:id');
    await withTelemetryContext(request.context, async () => {
      assert.equal(await observeCall('dependency', 'database', async () => 42), 42);
      const value = await observeInference(
        { provider: 'fixture', model: 'test-model', operation: 'chat' },
        async report => {
          report.firstToken();
          report.firstToken();
          report.usage(11, 7);
          const span = trace.getActiveSpan();
          span.setAttribute('prompt', 'PRIVATE PROMPT');
          span.setAttribute('error.reason', 'PRIVATE REASON');
          span.setAttribute('temporalWorkflowId', 'PRIVATE ID');
          span.setAttribute('dependency.endpoint', 'PRIVATE URL');
          span.setAttribute('error.stage', 'PRIVATE STAGE');
          span.setAttribute('catalog.page_bytes', 'PRIVATE BODY');
          span.setAttribute('http.response.status_code', 'PRIVATE STATUS');
          span.recordException(new Error('PRIVATE EXCEPTION'));
          return 'PRIVATE COMPLETION';
        },
      );
      assert.equal(value, 'PRIVATE COMPLETION');
    });
    request.finish(201);
    request.finish(500);
    const error = new Error('PRIVATE FAILURE');
    await assert.rejects(
      observeInference({ provider: 'fixture', model: 'test-model', operation: 'chat' }, async () => {
        throw error;
      }),
      e => e === error,
    );
    const failure = await observeInference(
      { provider: 'fixture', model: 'test-model', operation: 'chat' },
      async report => {
        report.error();
        report.error();
        report.usage(3, 0);
        return { error: 'PRIVATE PROVIDER FAILURE' };
      },
    );
    assert.equal(failure.error, 'PRIVATE PROVIDER FAILURE');
    const payload = { arguments: 'PRIVATE ARGUMENTS', result: 'PRIVATE RESULT' };
    assert.equal(await observeTool('skills.read', 'chat', async () => payload), payload);
    const storageFailure = new Error('PRIVATE WRAPPER', {
      cause: Object.assign(new Error('PRIVATE'), { code: 'wait_timeout' }),
    });
    await assert.rejects(
      observeTool('web.fetch', 'task', async () => {
        throw storageFailure;
      }),
      e => e === storageFailure,
    );
    assert.equal(
      await observeTool(
        'slack.message.send',
        'slack',
        async () => payload,
        () => 'waiting',
      ),
      payload,
    );
    assert.equal(
      await observeTool(
        'rows.delete',
        'task',
        async () => payload,
        () => 'blocked',
      ),
      payload,
    );
    const returnedFailure = { error: 'read-forbidden', instruction: 'PRIVATE INSTRUCTION' };
    assert.equal(
      await observeTool(
        'github.personal.read',
        'chat',
        async () => returnedFailure,
        value => ({ outcome: 'error', errorCode: value.error }),
      ),
      returnedFailure,
    );
    await observeTool(
      'mcp.call',
      'chat',
      async () => payload,
      () => ({ outcome: 'error', errorCode: 'private-user-text' }),
    );
    const denied = startHttp('POST', '/v1/widgets');
    denied.finish(403, false, 'access-denied');
    const privateError = startHttp('POST', '/v1/private');
    privateError.finish(500, false, 'internal-error', new Error('timeout exceeded when trying to connect'));
    for (const status of ['started', 'paused', 'failed', 'completed']) recordTaskTransition(status);
    const aborted = startHttp('GET', 'unmatched');
    aborted.finish(499, true, 'internal-error', storageFailure);
    const chatSnapshot = {
      durations: [{ phase: 'active', buckets: [0, 0, 0, 0, 0, 1, 1, 1, 1, 1], count: 1, total: 45 }],
      states: [{ state: 'completed', count: 1 }],
      oldest: [{ phase: 'active', seconds: 0 }],
      slow: [{ phase: 'active', at: 100 }],
      attempts: 2,
    };
    chatMetrics.publish(chatSnapshot);
    chatMetrics.publish(chatSnapshot);
    recordChatDispatch('send', 'success');
    recordChatDispatch('send', 'success');
    recordChatDispatch('sweep', 'error');
    recordDispatchSkip('github');
    recordDispatchSkip('github');
    recordDispatchSkip('slack');
    assert.equal(await observeChatStage('context', async () => 42), 42);
    await assert.rejects(
      observeChatStage('model', async () => {
        throw error;
      }),
      e => e === error,
    );
    assert.equal(await observeChatDetail('storage-connect', async () => 42), 42);
    let clock = 1000;
    t.mock.method(performance, 'now', () => clock);
    const maintenance = trace.getTracer('fixture').startSpan('conversation.maintenance', {
      attributes: { operation: 'conversation.maintenance', workspaceId: 'PRIVATE WORKSPACE' },
    });
    await withTelemetryContext(trace.setSpanContext(request.context, maintenance.spanContext()), async () => {
      assert.equal(
        await observeWorkspaceConnection('wait', async () => {
          clock += 250;
          return 42;
        }),
        42,
      );
      assert.equal(
        await observeWorkspaceConnection('hold', async () => {
          clock += 1500;
          return 'done';
        }),
        'done',
      );
    });
    maintenance.end();
    const poolTimeout = new Error('timeout exceeded when trying to connect');
    await assert.rejects(
      observeWorkspaceConnection('wait', async () => {
        clock += 5000;
        throw poolTimeout;
      }),
      e => e === poolTimeout,
    );
    await assert.rejects(
      observeWorkspaceConnection('hold', async () => {
        clock += 200;
        throw error;
      }),
      e => e === error,
    );
    await withChatMeasurements(async () => {
      await withChatModelRequest('reply', async () => {
        assert.equal(
          observeChatDetailSync('serialize', () => {
            clock += 150;
            return 'body';
          }),
          'body',
        );
        recordChatRequestSizes({ wire: 4096, tools: 2048, messages: 1024, prompt: 'PRIVATE CONTENT' });
        assert.equal(
          await observeChatDetail('provider', async () => {
            clock += 400;
            return 42;
          }),
          42,
        );
        await observeChatDetail('settle', async () => {
          clock += 600;
        });
        recordChatDiscovery({ offered: 2, loaded: 8, added: 6, matched: 6, query: 'PRIVATE QUERY' });
        recordChatCompletionCheck('skipped_no_tools');
        recordChatCompletionCheck('continue');
        recordChatCompletionCheck('done');
      });
      await withChatMeasurements(() =>
        assert.rejects(
          withChatModelRequest('completion', () =>
            observeChatDetail('reserve', async () => {
              clock += 200;
              throw error;
            }),
          ),
          e => e === error,
        ),
      );
      assert.throws(
        () =>
          observeChatDetailSync('render', () => {
            clock += 25;
            throw error;
          }),
        e => e === error,
      );
    });
    t.mock.restoreAll();
    let epoch = 1800000000000;
    t.mock.method(Date, 'now', () => epoch);
    const sweep = createBackgroundJob('object-cleanup', 60);
    const neverRun = createBackgroundJob('invitation-expiry', 60);
    jobs.push(sweep, neverRun);
    const payloadResponse = new Response('PRIVATE BODY', { status: 200 });
    const privateUrl = 'https://provider.example/PRIVATE_ID?token=PRIVATE_TOKEN';
    const controller = new AbortController();
    const init = { signal: controller.signal, headers: { authorization: 'PRIVATE_AUTH' } };
    let attempts = 0;
    const send = observeFetch('google', 'request', async (url, options) => {
      assert.equal(url, privateUrl);
      assert.equal(options, init);
      attempts++;
      return attempts === 1 ? new Response('PRIVATE FAILURE', { status: 503 }) : payloadResponse;
    });
    await withTelemetryContext(request.context, () =>
      sweep.run(async () => {
        const failed = await send(privateUrl, init);
        assert.equal(failed.status, 503);
        const result = await observeFetch('google', 'request', send)(privateUrl, init);
        assert.equal(result, payloadResponse);
        assert.equal(result.bodyUsed, false);
        assert.equal(await result.text(), 'PRIVATE BODY');
      }),
    );
    epoch += 10000;
    const jobFailure = new AggregateError(
      [
        new Error('PRIVATE WRAPPER', {
          cause: Object.assign(new Error('PRIVATE SQL'), { code: '42501', stage: 'metadata' }),
        }),
      ],
      'PRIVATE AGGREGATE',
    );
    await assert.rejects(
      sweep.run(async () => {
        throw jobFailure;
      }),
      value => value === jobFailure,
    );
    assert.equal(
      neverRun.runSync(() => 42),
      42,
    );
    const syncFailure = Object.assign(new Error('PRIVATE URL'), {
      code: 'catalog-timeout',
      stage: 'catalog-read',
      catalogDiagnostics: {
        httpStatus: 200,
        pageBytes: 1024,
        receivedBytes: 2048,
        completedPages: 1,
        attempts: 2,
        body: 'PRIVATE BODY',
      },
    });
    assert.throws(
      () =>
        neverRun.runSync(() => {
          throw syncFailure;
        }),
      value => value === syncFailure,
    );
    const noSuccess = createBackgroundJob('table-cleanup', 60);
    jobs.push(noSuccess);
    const abort = new DOMException('PRIVATE ABORT', 'AbortError');
    await assert.rejects(
      observeFetch('github', 'request', async (_url, options) => {
        assert.equal(options.signal, controller.signal);
        throw abort;
      })(privateUrl, init),
      value => value === abort,
    );
    await assert.rejects(
      observeFetch('slack', 'request', () => {
        throw error;
      })(privateUrl),
      value => value === error,
    );
    const notFound = new Response('PRIVATE BODY', { status: 404 });
    assert.equal(
      await observeFetch('github', 'request', async () => notFound, { endpoint: 'github-content' })(privateUrl, init),
      notFound,
    );
    assert.equal(notFound.bodyUsed, false);
    const sent = { id: 'PRIVATE_EMAIL_ID' };
    assert.equal(await observeDependency('email', 'send', async () => sent), sent);
    epoch += 20000;
    const access = { reconnectSources: 0, permissionRepositories: 0, lostRepositories: 0 };
    knowledgeMetrics.publish({ failedItems: 3, failedSources: 1, stalledSources: 1, ...access });
    knowledgeMetrics.publish({
      failedItems: 2,
      failedSources: 0,
      stalledSources: 0,
      reconnectSources: 1,
      permissionRepositories: 2,
      lostRepositories: 3,
    });
    assert.throws(
      () => knowledgeMetrics.publish({ failedItems: -1, failedSources: 0, stalledSources: 0, ...access }),
      /invalid-knowledge-sync-snapshot/,
    );
    await withTelemetryContext(request.context, async () => {
      recordKnowledgeImport('item', 'error', 'permission-expired', {
        elapsedMs: 123,
        exitCode: 1,
        rssBytes: 100,
        stderr: 'PRIVATE STDERR',
        outputBytes: NaN,
      });
      recordKnowledgeImport('source', 'error', 'PRIVATE PROVIDER FAILURE');
      recordKnowledgeImport('source', 'error', 'provider', { error: storageFailure });
      recordKnowledgeImport('item', 'ready');
      recordKnowledgeImport('item', 'skipped', 'unsupported');
    });
    await reader.forceFlush();
    const finished = spans.getFinishedSpans();
    const http = finished.find(span => span.name === 'GET /v1/widgets/:id');
    const inference = finished.find(span => span.name === 'chat test-model' && span.parentSpanContext?.spanId);
    assert.equal(inference.spanContext().traceId, http.spanContext().traceId);
    assert.equal(inference.parentSpanContext?.spanId, http.spanContext().spanId);
    assert.equal(http.attributes['http.response.status_code'], 201);
    assert.equal(inference.attributes['gen_ai.usage.input_tokens'], 11);
    assert.equal(inference.attributes['gen_ai.usage.output_tokens'], 7);
    assert.equal(finished.find(span => span.name === 'GET unmatched').status.code, 2);
    assert.equal(finished.filter(span => span.name === 'chat test-model' && span.status.code === 2).length, 2);
    assert.equal(finished.find(span => span.name === 'skills.read').attributes.runtime, 'chat');
    assert.equal(finished.find(span => span.name === 'slack.message.send').attributes.outcome, 'waiting');
    assert.equal(finished.find(span => span.name === 'rows.delete').status.code, 2);
    const data = metricExporter.getMetrics().flatMap(resource => resource.scopeMetrics.flatMap(scope => scope.metrics));
    assert.equal(metricExporter.getMetrics()[0].resource.attributes['service.version'], '2026.10.2.7');
    for (const metric of data)
      for (const point of metric.dataPoints) {
        assert.equal(point.attributes.service_version, '2026.10.2.7');
        assert.equal(point.attributes.commit, undefined);
        assert.equal(point.attributes['build.commit'], undefined);
      }
    const counter = data.find(metric => metric.descriptor.name === 'call_count');
    assert.equal(data.find(metric => metric.descriptor.name === 'cloud_knowledge_failed_items').dataPoints[0].value, 2);
    assert.equal(
      data.find(metric => metric.descriptor.name === 'cloud_knowledge_stalled_sources').dataPoints[0].value,
      0,
    );
    for (const [name, value] of [
      ['cloud_knowledge_reconnect_sources', 1],
      ['cloud_knowledge_permission_repositories', 2],
      ['cloud_knowledge_lost_repositories', 3],
    ]) {
      const metric = data.find(entry => entry.descriptor.name === name);
      assert.equal(metric.dataPoints[0].value, value);
      assert.deepEqual(Object.keys(metric.dataPoints[0].attributes).includes('provider'), true);
    }
    assert.equal(
      data.find(metric => metric.descriptor.name === 'cloud_knowledge_scan_completed').dataPoints[0].value,
      epoch / 1000,
    );
    const importLogs = records
      .getFinishedLogRecords()
      .filter(record => record.attributes.operation?.startsWith('knowledge.github.'));
    assert.deepEqual(
      importLogs.map(record => [record.severityText, record.body, record.attributes['error.code']]),
      [
        ['ERROR', 'call_failed', 'permission-expired'],
        ['ERROR', 'call_failed', 'unclassified'],
        ['ERROR', 'call_failed', 'wait_timeout'],
        ['INFO', 'call_completed', 'unsupported'],
      ],
    );
    assert.ok(importLogs.every(record => record.spanContext.traceId === http.spanContext().traceId));
    assert.equal(importLogs[0].attributes['parser.elapsedMs'], 123);
    assert.equal(importLogs[0].attributes['parser.rssBytes'], 100);
    assert.equal(importLogs[0].attributes['parser.outputBytes'], undefined);
    assert.deepEqual(
      data.find(metric => metric.descriptor.name === 'cloud_knowledge_imports').dataPoints.map(point => point.value),
      [1, 1, 1, 1, 1],
    );
    assert.equal(
      counter.dataPoints.reduce((sum, point) => sum + point.value, 0),
      14,
    );
    const tools = counter.dataPoints.filter(point => point.attributes.category === 'tool');
    assert.deepEqual(
      tools.map(point => [point.attributes.tool, point.attributes.runtime, point.attributes.outcome]),
      [
        ['skills.read', 'chat', 'success'],
        ['web.fetch', 'task', 'error'],
        ['slack.message.send', 'slack', 'waiting'],
        ['rows.delete', 'task', 'blocked'],
        ['github.personal.read', 'chat', 'error'],
        ['mcp.call', 'chat', 'error'],
      ],
    );
    const failures = data.find(metric => metric.descriptor.name === 'cloud_tool_failures');
    assert.equal(
      failures.dataPoints.find(point => point.attributes.tool === 'github.personal.read').attributes.error_code,
      'read-forbidden',
    );
    assert.equal(
      failures.dataPoints.find(point => point.attributes.tool === 'mcp.call').attributes.error_code,
      'unclassified',
    );
    const httpErrors = data.find(metric => metric.descriptor.name === 'cloud_http_errors');
    assert.equal(
      httpErrors.dataPoints.find(point => point.attributes.status_code === '403').attributes.error_code,
      'access-denied',
    );
    assert.equal(
      httpErrors.dataPoints.find(point => point.attributes.status_code === '500').attributes.error_code,
      'wait_timeout',
    );
    assert.equal(
      finished.find(span => span.name === 'POST /v1/private').attributes['error.reason'],
      'Workspace storage wait or operation deadline exceeded',
    );
    assert.equal(finished.find(span => span.name === 'web.fetch').attributes['error.code'], 'wait_timeout');
    assert.equal(finished.find(span => span.name === 'GET unmatched').attributes['error.reason'], undefined);
    assert.equal(
      httpErrors.dataPoints.find(point => point.attributes.status_code === '499').attributes.error_code,
      'request-aborted',
    );
    assert.equal(
      finished.find(span => span.name === 'github.personal.read').attributes['error.code'],
      'read-forbidden',
    );
    assert.equal(finished.find(span => span.name === 'POST /v1/widgets').attributes['error.code'], 'access-denied');
    assert.equal(http.attributes['error.code'], undefined);
    const transitions = data.find(metric => metric.descriptor.name === 'cloud_agent_task_transitions');
    assert.deepEqual(
      transitions.dataPoints.map(point => [point.attributes.status, point.attributes.runtime, point.value]),
      [
        ['started', 'task', 1],
        ['paused', 'task', 1],
        ['failed', 'task', 1],
        ['completed', 'task', 1],
      ],
    );
    const httpCount = data.find(metric => metric.descriptor.name === 'cloud_http_requests');
    assert.equal(httpCount.dataPoints.find(point => point.attributes.status_code === '201').value, 1);
    const ttft = data.find(metric => metric.descriptor.name === 'gen_ai_client_time_to_first_token');
    assert.equal(ttft.dataPoints[0].value.count, 1);
    const latency = data.find(metric => metric.descriptor.name === 'call_time');
    assert.equal(latency.descriptor.unit, 's');
    assert.ok(latency.dataPoints.every(point => point.value.sum >= 0 && point.value.sum < 10));
    assert.ok(latency.dataPoints.every(point => point.attributes.category !== 'http'));
    const calls = data.find(metric => metric.descriptor.name === 'call_count');
    assert.ok(calls.dataPoints.some(point => point.attributes.category === 'http'));
    assert.equal(
      data.find(metric => metric.descriptor.name === 'cloud_chat_latency_window_count').dataPoints[0].value,
      1,
      'rescanning must not double count turns',
    );
    const chatBuckets = data.find(metric => metric.descriptor.name === 'cloud_chat_latency_window_bucket');
    assert.equal(chatBuckets.dataPoints.find(p => p.attributes.le === '+Inf').value, 1);
    assert.equal(data.find(metric => metric.descriptor.name === 'cloud_chat_attempts_window').dataPoints[0].value, 2);
    const stages = data.find(metric => metric.descriptor.name === 'cloud_chat_stage_duration');
    assert.equal(stages.dataPoints.find(p => p.attributes.phase === 'model').attributes.outcome, 'error');
    const details = data.find(metric => metric.descriptor.name === 'cloud_chat_detail_duration');
    const connections = data.find(metric => metric.descriptor.name === 'cloud_workspace_connection_duration');
    assert.equal(connections.descriptor.unit, 's');
    assert.deepEqual(
      connections.dataPoints.map(p => [p.attributes.phase, p.attributes.outcome, p.value.count, p.value.sum]),
      [
        ['wait', 'success', 1, 0.25],
        ['hold', 'success', 1, 1.5],
        ['wait', 'timeout', 1, 5],
        ['hold', 'error', 1, 0.2],
      ],
    );
    for (const point of connections.dataPoints)
      assert.deepEqual(Object.keys(point.attributes).sort(), [
        'application',
        'environment',
        'outcome',
        'phase',
        'service',
        'service_version',
      ]);
    const hold = finished.find(
      span => span.name === 'workspace.connection.hold' && span.attributes.outcome === 'success',
    );
    assert.equal(hold.parentSpanContext?.spanId, maintenance.spanContext().spanId);
    assert.equal(hold.attributes.duration_ms, 1500);
    const timeout = finished.find(
      span => span.name === 'workspace.connection.wait' && span.attributes.outcome === 'timeout',
    );
    assert.equal(timeout.status.code, 2);
    assert.equal(
      records.getFinishedLogRecords().filter(record => record.attributes.operation?.startsWith('workspace.connection.'))
        .length,
      0,
      'pool diagnostics do not add per-transaction logs',
    );
    const detail = (phase, purpose) =>
      details.dataPoints.find(p => p.attributes.phase === phase && p.attributes.purpose === purpose);
    assert.equal(detail('storage-connect', 'turn'), undefined, 'non-chat storage must not emit chat measurements');
    assert.equal(detail('serialize', 'reply').value.sum, 0.15);
    assert.equal(detail('provider', 'reply').value.sum, 0.4, 'provider time excludes settlement');
    assert.equal(detail('settle', 'reply').value.sum, 0.6);
    assert.equal(detail('request', 'reply').value.sum, 1.15, 'request includes all measured work');
    assert.equal(detail('reserve', 'completion').value.sum, 0.2);
    assert.equal(detail('reserve', 'completion').attributes.outcome, 'error');
    assert.equal(detail('render', 'turn').attributes.outcome, 'error');
    const sizes = data.find(metric => metric.descriptor.name === 'cloud_chat_request_size');
    assert.equal(sizes.dataPoints.find(p => p.attributes.component === 'wire').value.sum, 4096);
    const requests = data.find(metric => metric.descriptor.name === 'cloud_chat_model_requests');
    assert.deepEqual(
      requests.dataPoints.map(p => [p.attributes.purpose, p.attributes.outcome, p.value]),
      [
        ['reply', 'success', 1],
        ['completion', 'error', 1],
      ],
    );
    assert.equal(data.find(metric => metric.descriptor.name === 'cloud_chat_discoveries').dataPoints[0].value, 1);
    assert.deepEqual(
      data
        .find(metric => metric.descriptor.name === 'cloud_chat_dispatches')
        .dataPoints.map(p => [p.attributes.dispatch_source, p.attributes.outcome, p.value]),
      [
        ['send', 'success', 2],
        ['sweep', 'error', 1],
      ],
    );
    assert.deepEqual(
      data
        .find(metric => metric.descriptor.name === 'cloud_dispatch_skipped_workspaces')
        .dataPoints.map(p => [p.attributes.dispatcher, p.attributes.reason, p.value, p.attributes.workspace_id]),
      [
        ['github', 'incompatible_version', 2, undefined],
        ['slack', 'incompatible_version', 1, undefined],
      ],
      'skips stay low-cardinality: dispatcher and reason only',
    );
    const checks = data.find(metric => metric.descriptor.name === 'cloud_chat_completion_checks');
    assert.deepEqual(
      checks.dataPoints.map(p => [p.attributes.outcome, p.value]),
      [
        ['skipped_no_tools', 1],
        ['continue', 1],
        ['done', 1],
      ],
    );
    for (const point of checks.dataPoints)
      assert.deepEqual(Object.keys(point.attributes).sort(), [
        'application',
        'environment',
        'outcome',
        'service',
        'service_version',
      ]);
    for (const metric of [details, sizes, requests]) {
      for (const point of metric.dataPoints) assert.equal(point.attributes['chat.request.sequence'], undefined);
    }
    const providerDetail = finished.find(span => span.name === 'chat.detail.provider');
    assert.equal(providerDetail.attributes['chat.request.sequence'], 1);
    assert.equal(providerDetail.attributes['chat.purpose'], 'reply');
    assert.equal(
      finished.find(span => span.name === 'chat.detail.reserve').attributes['chat.request.sequence'],
      2,
      'nested scopes retain sequencing',
    );
    assert.equal(finished.find(span => span.name === 'chat.detail.reserve').status.code, 2);
    const log = records.getFinishedLogRecords().find(record => record.body === 'request_completed');
    assert.equal(http.attributes['build.commit'], 'b'.repeat(40));
    assert.equal(log.attributes.commit, 'b'.repeat(40));
    assert.equal(log.spanContext.traceId, http.spanContext().traceId);
    assert.equal(records.getFinishedLogRecords().find(record => record.body === 'call_failed').severityText, 'ERROR');
    const serialized = JSON.stringify({ spans: finished, metrics: data, logs: records.getFinishedLogRecords() });
    assert.doesNotMatch(serialized, /PRIVATE|private-user-text|temporalWorkflowId|"prompt"/);
    const metric = name => data.find(value => value.descriptor.name === name);
    const point = (name, job) => metric(name).dataPoints.find(value => value.attributes.background_job === job);
    assert.equal(point('cloud_background_job_expected', 'table-cleanup').value, 1);
    assert.equal(point('cloud_background_job_interval', 'object-cleanup').value, 60);
    assert.equal(point('cloud_background_job_last_success', 'object-cleanup').value, 1800000000);
    assert.equal(point('cloud_background_job_last_completion', 'object-cleanup').value, 1800000010);
    assert.equal(point('cloud_background_job_last_success', 'table-cleanup').value, 0);
    assert.equal(point('cloud_background_job_last_completion', 'table-cleanup').value, 0);
    assert.equal(point('cloud_background_job_success_age', 'object-cleanup').value, 30);
    assert.equal(point('cloud_background_job_success_age', 'table-cleanup').value, 20);
    assert.deepEqual(
      metric('cloud_background_job_runs').dataPoints.map(p => [
        p.attributes.background_job,
        p.attributes.outcome,
        p.value,
      ]),
      [
        ['object-cleanup', 'success', 1],
        ['object-cleanup', 'error', 1],
        ['invitation-expiry', 'success', 1],
        ['invitation-expiry', 'error', 1],
      ],
    );
    for (const value of data.filter(value => value.descriptor.name.startsWith('cloud_background_job'))) {
      assert.ok(value.dataPoints.every(point => point.attributes.background_job && point.attributes.job === undefined));
      assert.ok(value.dataPoints.every(point => point.attributes['error.reason'] === undefined));
    }
    assert.deepEqual(
      metric('cloud_dependency_requests').dataPoints.map(p => [
        p.attributes.provider,
        p.attributes.operation,
        p.attributes.status_class,
        p.attributes.outcome,
        p.value,
      ]),
      [
        ['google', 'request', '5xx', 'error', 1],
        ['google', 'request', '2xx', 'success', 1],
        ['github', 'request', 'none', 'error', 1],
        ['slack', 'request', 'none', 'error', 1],
        ['github', 'request', '4xx', 'error', 1],
        ['email', 'send', 'none', 'success', 1],
      ],
    );
    for (const name of ['cloud_background_job_duration', 'cloud_dependency_duration']) {
      assert.equal(metric(name).descriptor.unit, 's');
      assert.ok(metric(name).dataPoints.every(p => p.value.sum >= 0));
    }
    for (const name of ['cloud_background_job_runs', 'cloud_dependency_requests']) {
      for (const p of metric(name).dataPoints) {
        assert.equal(p.attributes.run_id, undefined);
        assert.equal(p.attributes.entryPoint, undefined);
        assert.equal(p.attributes['dependency.endpoint'], undefined);
        assert.equal(p.attributes['http.response.status_code'], undefined);
        assert.equal(p.attributes['catalog.page_bytes'], undefined);
      }
    }
    const jobSpans = finished.filter(span => span.name === 'job.object-cleanup');
    assert.ok(
      jobSpans.every(span => !span.parentSpanContext?.spanId),
      'scheduled work starts a new trace, not a stale request child',
    );
    assert.ok(jobSpans.every(span => span.attributes['build.commit'] === 'b'.repeat(40)));
    assert.equal(jobSpans[1].attributes['error.code'], '42501');
    assert.equal(jobSpans[1].attributes['error.reason'], 'Database permission denied');
    assert.equal(jobSpans[1].attributes['error.stage'], 'metadata');
    assert.equal(
      finished.find(span => span.name === 'job.invitation-expiry' && span.status.code === 2).attributes['error.code'],
      'catalog-timeout',
    );
    const dependency = finished.find(span => span.name === 'dependency.google.request');
    assert.equal(dependency.attributes['http.response.status_code'], 503);
    const missing = finished.find(span => span.attributes['dependency.endpoint'] === 'github-content');
    assert.equal(missing.attributes['http.response.status_code'], 404);
    const missingLog = records
      .getFinishedLogRecords()
      .find(record => record.attributes['dependency.endpoint'] === 'github-content');
    assert.equal(missingLog.attributes['http.response.status_code'], 404);
    const abortedDependency = finished.find(
      span => span.name === 'dependency.github.request' && span.attributes.status_class === 'none',
    );
    assert.equal(abortedDependency.attributes['http.response.status_code'], undefined);
    assert.equal(dependency.parentSpanContext?.spanId, jobSpans[0].spanContext().spanId);
    const jobRecords = records.getFinishedLogRecords().filter(record => record.attributes.job === 'object-cleanup');
    assert.equal(jobRecords.length, 2, 'only the dependency failure and failed sweep emit logs');
    const sweepRecords = records
      .getFinishedLogRecords()
      .filter(record => record.attributes.operation?.startsWith('job.'));
    assert.deepEqual(
      sweepRecords.map(record => [record.attributes.operation, record.body, record.severityText]),
      [
        ['job.object-cleanup', 'call_failed', 'ERROR'],
        ['job.invitation-expiry', 'call_failed', 'ERROR'],
      ],
      'successful async and synchronous sweeps must not emit per-tick logs',
    );
    assert.equal(sweepRecords[0].attributes['error.code'], '42501');
    assert.equal(sweepRecords[1].attributes['error.code'], 'catalog-timeout');
    for (const attributes of [
      sweepRecords[1].attributes,
      finished.find(span => span.name === 'job.invitation-expiry' && span.status.code === 2).attributes,
    ]) {
      assert.equal(attributes['error.stage'], 'catalog-read');
      assert.equal(attributes['catalog.http_status'], 200);
      assert.equal(attributes['catalog.page_bytes'], 1024);
      assert.equal(attributes['catalog.received_bytes'], 2048);
      assert.equal(attributes['catalog.completed_pages'], 1);
      assert.equal(attributes['catalog.attempts'], 2);
    }
    assert.ok(
      jobRecords.every(
        record => record.attributes.entryPoint === 'scheduler' && /^[0-9a-f-]{36}$/.test(record.attributes.run_id),
      ),
    );
    assert.equal(
      jobRecords.find(record => record.attributes.provider === 'google').attributes.run_id,
      jobSpans[0].attributes.run_id,
    );
  } finally {
    knowledgeMetrics.close();
    for (const job of jobs) job.close();
    t.mock.restoreAll();
    chatMetrics.close();
    await sdk.shutdown();
  }
});

test('call_failed keeps Zod issue paths and codes but drops other attributes', t => {
  const lines = [];
  t.mock.method(process.stdout, 'write', line => {
    lines.push(line);
    return true;
  });
  log('error', 'activity', 'call_failed', {
    'error.issues': ['decision:invalid_type'],
    'error.reason': 'PRIVATE REASON',
    input: 'private value',
  });
  t.mock.restoreAll();
  const record = JSON.parse(lines[0]);
  assert.deepEqual(record['error.issues'], ['decision:invalid_type']);
  assert.equal(record.input, undefined);
  assert.equal(record['error.reason'], undefined);
});

test('log records are counted by the meter provider that is current when they are written', async t => {
  t.mock.method(process.stdout, 'write', () => true);
  const install = () => {
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60000 });
    metrics.disable();
    assert.ok(metrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader] })));
    return async () => {
      await reader.forceFlush();
      const count = exporter
        .getMetrics()
        .flatMap(resource => resource.scopeMetrics.flatMap(scope => scope.metrics))
        .filter(metric => metric.descriptor.name === 'cloud_log_records')
        .flatMap(metric => metric.dataPoints)
        .reduce((sum, point) => sum + point.value, 0);
      exporter.reset();
      return count;
    };
  };
  t.after(() => metrics.disable());
  metrics.disable();
  log('info', 'activity', 'call_completed', { operation: 'before-provider' });
  const first = install();
  log('info', 'activity', 'call_completed', { operation: 'first' });
  assert.equal(await first(), 1);
  const second = install();
  log('info', 'activity', 'call_completed', { operation: 'second' });
  log('info', 'activity', 'call_completed', { operation: 'second' });
  assert.equal(await second(), 2);
  assert.equal(await first(), 1);
});

test('integration metric failures preserve results and errors and still end spans', async t => {
  let ended = 0;
  t.mock.method(metrics, 'getMeter', () => ({
    createHistogram: () => ({
      record() {
        throw new Error('export failed');
      },
    }),
  }));
  t.mock.method(trace, 'getTracer', () => ({
    startSpan: () => ({
      end() {
        ended++;
      },
    }),
  }));
  assert.equal(await observeWorkspaceConnection('hold', async () => 42), 42);
  const failure = new Error('PRIVATE CALLBACK ERROR');
  await assert.rejects(
    observeWorkspaceConnection('hold', async () => {
      throw failure;
    }),
    error => error === failure,
  );
  assert.equal(ended, 2);
});

test('error type keeps only short code messages', () => {
  assert.equal(errorType(new Error('model-request-failed')), 'model-request-failed');
  assert.equal(errorType(new TypeError('Cannot read user@example.com secret')), 'TypeError');
  assert.equal(errorType('raw'), 'unknown');
  class AccessDenied extends Error {
    constructor() {
      super('Resource not found');
    }
  }
  assert.equal(errorType(new AccessDenied()), 'AccessDenied');
});

test('error codes accept reviewed values, not arbitrary short strings', () => {
  for (const value of [
    'access-denied',
    'read-forbidden',
    'FST_ERR_VALIDATION',
    'plan-not-found',
    'plan-source-unavailable',
    'plan-operation-unavailable',
  ])
    assert.equal(telemetryErrorCode(value), value);
  for (const value of ['private-user-text', 'user@example.com', 'a'.repeat(1024), 401, { code: 'access-denied' }])
    assert.equal(telemetryErrorCode(value), undefined);
});

test('safe diagnostics traverse bounded causes and aggregates without leaking raw values', () => {
  const cause = Object.assign(new Error('PRIVATE SQL token https://private.example'), {
    code: '53300',
    stage: 'metadata',
  });
  const outer = Object.assign(new AggregateError([new Error('PRIVATE', { cause })], 'PRIVATE'), {
    code: 'internal-error',
  });
  cause.cause = outer;
  assert.deepEqual(errorAttributes(outer), {
    'error.type': 'Error',
    'error.code': '53300',
    'error.reason': 'Database connection limit reached',
    'error.stage': 'metadata',
  });

  test('phase annotations preserve frozen errors and select the phase of the reported aggregate cause', async () => {
    const failure = Object.freeze(Object.assign(new Error('PRIVATE SQL'), { code: '55P03' }));
    await assert.rejects(
      withErrorStage('maintenance-transaction', () =>
        withErrorStage('table-cleanup-drop', async () => {
          throw failure;
        }),
      ),
      error => error === failure,
    );
    assert.equal(errorAttributes(failure)['error.stage'], 'table-cleanup-drop');
    const generic = Object.assign(new Error('PRIVATE'), { code: 'internal-error', stage: 'workspace-access' });
    const selected = errorAttributes(new AggregateError([generic, failure], 'PRIVATE AGGREGATE'));
    assert.equal(selected['error.code'], '55P03');
    assert.equal(selected['error.stage'], 'table-cleanup-drop');
    const noStage = errorAttributes(
      new AggregateError([generic, Object.assign(new Error('PRIVATE'), { code: '55P03' })]),
    );
    assert.equal(noStage['error.stage'], undefined);
    const wrapper = new Error('PRIVATE wrapper', { cause: failure });
    assert.equal(errorAttributes(wrapper)['error.stage'], 'table-cleanup-drop');
    assert.equal(await withErrorStage('workspace-discovery', async () => 42), 42);
    await assert.rejects(
      withErrorStage('PRIVATE STAGE', async () => {
        throw new Error('PRIVATE');
      }),
      error => {
        assert.equal(errorAttributes(error)['error.stage'], undefined);
        return true;
      },
    );
  });

  test('catalog diagnostics accept only finite bounded numeric metadata', () => {
    const failure = Object.assign(new Error('PRIVATE'), {
      catalogDiagnostics: {
        httpStatus: 'PRIVATE',
        pageBytes: -1,
        receivedBytes: Infinity,
        completedPages: 1.5,
        attempts: Number.MAX_SAFE_INTEGER + 1,
      },
    });
    assert.deepEqual(errorAttributes(failure), { 'error.type': 'Error' });
    for (const status of [99, 600, NaN]) {
      failure.catalogDiagnostics = { httpStatus: status };
      assert.equal(errorAttributes(failure)['catalog.http_status'], undefined);
    }
  });

  test('log boundary rejects private endpoint, phase and nonnumeric diagnostic values', t => {
    const lines = [];
    t.mock.method(process.stdout, 'write', line => {
      lines.push(JSON.parse(line));
      return true;
    });
    log('warn', 'dependency', 'call_failed', {
      'dependency.endpoint': 'PRIVATE URL',
      'error.stage': 'PRIVATE PHASE',
      'http.response.status_code': 600,
      'catalog.http_status': 'PRIVATE STATUS',
      'catalog.page_bytes': -1,
      'catalog.received_bytes': NaN,
      'catalog.attempts': Infinity,
      'catalog.completed_pages': 0.5,
    });
    for (const key of [
      'dependency.endpoint',
      'error.stage',
      'http.response.status_code',
      'catalog.http_status',
      'catalog.page_bytes',
      'catalog.received_bytes',
      'catalog.attempts',
      'catalog.completed_pages',
    ])
      assert.equal(lines[0][key], undefined);
    assert.doesNotMatch(JSON.stringify(lines), /PRIVATE/);
  });

  test('log boundary keeps chat reply stages and catalog phases', t => {
    const lines = [];
    t.mock.method(process.stdout, 'write', line => {
      lines.push(JSON.parse(line));
      return true;
    });
    for (const stage of ['model', 'tool-recovery', 'metadata'])
      log('warn', 'activity', 'chat_failed', { 'error.stage': stage });
    assert.deepEqual(
      lines.map(line => line['error.stage']),
      ['model', 'tool-recovery', 'metadata'],
    );
  });
  for (const code of [
    'runtime_unavailable',
    'closed',
    'queue_full',
    'wait_timeout',
    'pool_capacity',
    'stale_credential',
    'incompatible_version',
    'catalog-timeout',
    'catalog-http',
    'catalog-response',
    'catalog-page-limit',
    'catalog-byte-limit',
    'catalog-invalid-json',
    'catalog-invalid-schema',
    'catalog-invalid-timestamp',
    'catalog-cursor-loop',
  ]) {
    assert.equal(errorAttributes(Object.assign(new Error('PRIVATE'), { code }))['error.code'], code);
  }
  assert.equal(errorAttributes(new Error('timeout exceeded when trying to connect'))['error.code'], 'wait_timeout');
  assert.deepEqual(errorAttributes(Object.assign(new Error('PRIVATE'), { code: 'catalog-entry-limit' })), {
    'error.type': 'Error',
    'error.code': 'catalog-entry-limit',
    'error.reason': 'Registry catalog entry limit reached',
  });
  assert.deepEqual(errorAttributes(Object.assign(new Error('PRIVATE'), { code: 'response-limit' })), {
    'error.type': 'Error',
    'error.code': 'response-limit',
    'error.reason': 'MCP response byte limit reached',
  });
  for (const value of ['secret-token', 'https://private.example', 'ABCDE', 'PRIVATE SQL']) {
    const error = Object.assign(new Error(value), { name: value, code: value, stage: value });
    assert.deepEqual(errorAttributes(error), { 'error.type': 'Error' });
    assert.equal(errorType(error), 'Error');
  }
  let deep = cause;
  for (let i = 0; i < 20; i++) deep = new Error('PRIVATE', { cause: deep });
  assert.equal(errorAttributes(deep)['error.code'], undefined);
  assert.equal(
    errorAttributes(
      new AggregateError(
        Array.from({ length: 40 }, () => new Error('PRIVATE')),
        'PRIVATE',
      ),
    )['error.code'],
    undefined,
  );
  assert.doesNotThrow(() =>
    errorAttributes({
      get code() {
        throw new Error('PRIVATE');
      },
    }),
  );
});

test('observeTool logs one rich failure record and marks thrown errors as logged', async t => {
  const lines = [];
  t.mock.method(process.stdout, 'write', line => {
    lines.push(line);
    return true;
  });
  const denied = Object.assign(new Error('Access denied'), { name: 'AccessDenied' });
  const invalid = Object.assign(new Error('PRIVATE INPUT'), {
    name: 'ZodError',
    issues: [{ path: ['values', 0], code: 'invalid_type', message: 'PRIVATE' }],
  });
  await assert.rejects(
    observeTool('slack.message.send', 'chat', async () => {
      throw denied;
    }),
    e => e === denied,
  );
  await assert.rejects(
    observeTool('rows.create', 'chat', async () => {
      throw invalid;
    }),
    e => e === invalid,
  );
  await observeTool(
    'rows.delete',
    'agent',
    async () => 'blocked',
    () => ({ outcome: 'blocked', errorType: 'AccessDenied' }),
  );
  await observeTool(
    'rows.update',
    'agent',
    async () => 'failed',
    () => ({ outcome: 'error', errorType: 'private user text' }),
  );
  await observeTool(
    'knowledge.read',
    'chat',
    async () => ({ error: 'knowledge-unavailable' }),
    value => ({ outcome: 'result_error', errorCode: value.error }),
  );
  await observeTool(
    'web.fetch',
    'slack',
    async () => 'failed',
    () => ({ outcome: 'result_error', errorCode: 'private user text' }),
  );
  t.mock.restoreAll();
  assert.equal(toolFailureLogged(denied), true);
  assert.equal(toolFailureLogged(invalid), true);
  assert.equal(toolFailureLogged(new Error('other')), false);
  assert.equal(toolFailureLogged('string failure'), false);
  const records = lines.map(line => JSON.parse(line)).filter(record => record.event === 'call_failed');
  assert.deepEqual(
    records.map(record => [record.tool, record.level, record.outcome, record['error.type'], record['error.code']]),
    [
      ['slack.message.send', 'error', 'error', 'AccessDenied', 'unclassified'],
      ['rows.create', 'error', 'error', 'ZodError', 'unclassified'],
      ['rows.delete', 'error', 'blocked', 'AccessDenied', 'unclassified'],
      ['rows.update', 'error', 'error', 'Error', 'unclassified'],
      ['knowledge.read', 'error', 'result_error', 'knowledge-unavailable', 'knowledge-unavailable'],
      ['web.fetch', 'error', 'result_error', 'unclassified', 'unclassified'],
    ],
  );
  assert.ok(records.every(record => typeof record.duration_ms === 'number'));
  assert.deepEqual(records[1]['error.issues'], ['values.0:invalid_type']);
  assert.doesNotMatch(lines.join(''), /PRIVATE|private user text/);
});

test('a service name override replaces tulipfarm-<app> and must stay a bounded tulipfarm label', () => {
  const build = { app: 'worker', version: '2026.10.2.7', commit: 'b'.repeat(40) };
  assert.equal(telemetryIdentity(build, true).attributes['service.name'], 'tulipfarm-worker');
  assert.equal(
    telemetryIdentity(build, true, 'tulipfarm-knowledge-worker').attributes['service.name'],
    'tulipfarm-knowledge-worker',
  );
  assert.throws(() => telemetryIdentity(build, true, 'knowledge'), /service name/);
});
