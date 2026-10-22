import assert from 'node:assert/strict';
import test from 'node:test';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-proto';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { errorAttributes, log, ROOT_CONTEXT, startTelemetry, trace } from '../src/index.ts';

test('export diagnostics retain only reviewed codes and HTTP status, never transport text', () => {
  for (const [message, code] of [
    ['Request Timeout', 'export-timeout'],
    ['Request timed out', 'export-timeout'],
    ['Concurrent export limit reached', 'export-concurrency-limit'],
    ['Concurrency Limit reached', 'export-concurrency-limit'],
    ['Export failed with retryable status', 'export-retry-exhausted'],
    ['Nothing to send', 'export-empty'],
  ])
    assert.equal(errorAttributes(new Error(message))['error.code'], code);
  for (const code of [
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'ENOTFOUND',
    'EAI_AGAIN',
    'EPIPE',
    'CERT_HAS_EXPIRED',
    'ERR_TLS_CERT_ALTNAME_INVALID',
  ]) {
    const error = new Error('PRIVATE wrapper', { cause: Object.assign(new Error('PRIVATE hostname'), { code }) });
    assert.equal(errorAttributes(error)['error.code'], code);
    assert.doesNotMatch(JSON.stringify(errorAttributes(error)), /PRIVATE/);
  }
  const failure = Object.assign(new Error('PRIVATE response text'), {
    name: 'OTLPExporterError',
    code: 403,
    data: 'PRIVATE response body',
    stack: 'PRIVATE stack',
  });
  assert.deepEqual(errorAttributes(failure), {
    'error.type': 'OTLPExporterError',
    'http.response.status_code': 403,
    'error.code': 'export-http',
    'error.reason': 'Telemetry endpoint returned an unsuccessful HTTP status',
  });
  for (const code of [0, -1, 200, 399, 600, 403.1, NaN, Infinity, '403', 'PRIVATE code']) {
    const result = errorAttributes(Object.assign(new Error('PRIVATE token'), { name: 'OTLPExporterError', code }));
    assert.equal(result['http.response.status_code'], undefined);
    assert.equal(result['error.code'], undefined);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  }
  assert.deepEqual(errorAttributes(undefined), { 'error.type': 'unknown' });
  const hostile = Object.defineProperty(new Error('PRIVATE'), 'code', {
    get() {
      throw new Error('PRIVATE accessor');
    },
  });
  assert.doesNotThrow(() => errorAttributes(hostile));
});

test('all exporter callbacks log safe failures, preserve counters and throttle without recursive logging', async t => {
  const env = {
    NODE_ENV: 'production',
    CLOUD_TELEMETRY_ENABLED: 'true',
    CLOUD_TELEMETRY_OTLP_ENDPOINT: 'https://fixture.grafana.net/otlp',
    CLOUD_TELEMETRY_OTLP_AUTHORIZATION: 'Basic dGVzdDp0ZXN0',
  };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  const lines = [];
  const write = process.stdout.write.bind(process.stdout);
  t.mock.method(process.stdout, 'write', (value, ...args) => {
    if (typeof value !== 'string' || !value.startsWith('{')) return write(value, ...args);
    lines.push(value);
    return true;
  });
  let now = 1800000000000;
  t.mock.method(Date, 'now', () => now);
  let failure = Object.assign(new Error('PRIVATE response body'), { name: 'OTLPExporterError', code: 403 });
  const metricBatches = [];
  const sends = { traces: 0, logs: 0, metrics: 0 };
  for (const [signal, exporter] of [
    ['traces', OTLPTraceExporter],
    ['logs', OTLPLogExporter],
    ['metrics', OTLPMetricExporter],
  ]) {
    t.mock.method(exporter.prototype, 'export', (data, callback) => {
      sends[signal]++;
      if (signal === 'metrics') metricBatches.push(data);
      callback(failure ? { code: 1, error: failure } : { code: 0 });
    });
  }
  const telemetry = startTelemetry({ app: 'worker', version: '2026.10.14.4', commit: 'b'.repeat(40) });
  const parent = trace.setSpanContext(ROOT_CONTEXT, { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 1 });
  const flushBatch = async () => {
    trace.getTracer('fixture').startSpan('fixture', {}, parent).end();
    log('info', 'lifecycle', 'service_started');
    await Promise.allSettled([telemetry.flush()]);
    await new Promise(resolve => setImmediate(resolve));
  };
  const reports = () => lines.filter(line => line.includes('"event":"telemetry_export"')).map(line => JSON.parse(line));
  try {
    await flushBatch();
    const failed = reports();
    assert.deepEqual(failed.map(row => `${row.target}:${row.signal}`).sort(), [
      'otlp:logs',
      'otlp:metrics',
      'otlp:traces',
    ]);
    for (const row of failed) {
      assert.equal(row.outcome, 'failed');
      assert.equal(row['error.code'], 'export-http');
      assert.equal(row['http.response.status_code'], 403);
      assert.equal(row.service, 'tulipfarm-worker');
      assert.equal(row.commit, 'b'.repeat(40));
    }
    await flushBatch();
    assert.equal(reports().length, 3);
    assert.equal(sends.logs, 2, 'export failures must not recursively enter the log exporter');
    now += 60000;
    failure = new Error('Request Timeout');
    await flushBatch();
    assert.equal(reports().length, 6);
    assert.ok(
      reports()
        .slice(3)
        .every(row => row['error.code'] === 'export-timeout'),
    );
    const counter = metricBatches
      .at(-1)
      .scopeMetrics.flatMap(scope => scope.metrics)
      .find(metric => metric.descriptor.name === 'cloud_telemetry_batches');
    assert.equal(counter.dataPoints.length, 3);
    assert.ok(counter.dataPoints.every(point => point.value >= 2 && point.attributes.outcome === 'failed'));
    assert.ok(counter.dataPoints.every(point => !Object.keys(point.attributes).some(key => key.startsWith('error'))));
    failure = undefined;
    await flushBatch();
    const successes = reports().filter(row => row.outcome === 'sent');
    assert.equal(successes.length, 3);
    assert.ok(successes.every(row => !Object.keys(row).some(key => key.startsWith('error') || key.startsWith('http'))));
    await flushBatch();
    assert.equal(reports().length, 9, 'success is still logged only once per exporter');
    assert.doesNotMatch(lines.join(''), /PRIVATE|Basic/);
  } finally {
    failure = undefined;
    await telemetry.shutdown();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
