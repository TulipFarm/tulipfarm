import assert from 'node:assert/strict';
import test from 'node:test';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import {
  errorType,
  fallbackEligibleClasses,
  ModelCallError,
  modelCallDiagnostics,
  modelErrorClass,
  modelFailureClasses,
  modelErrorClasses,
  observeInference,
  recordModelFallback,
  sanitizeProviderMessage,
  telemetryErrorCode,
} from '../src/index.ts';

test('every model-<reason> message maps to a bounded class instead of a generic Error', () => {
  for (const [reason, errorClass] of Object.entries(modelFailureClasses)) {
    assert.ok(modelErrorClasses.includes(errorClass));
    assert.equal(modelErrorClass(`model-${reason}`), errorClass);
    // Codes the contract already lists keep their name; every other reason becomes its class.
    const existing = ['invalid-response', 'request-failed'].includes(reason);
    assert.equal(telemetryErrorCode(`model-${reason}`), existing ? `model-${reason}` : errorClass);
  }
  assert.equal(telemetryErrorCode('model-quota'), 'quota_exceeded');
  assert.equal(telemetryErrorCode('model-configuration'), 'not_found');
  assert.equal(errorType(new Error('model-rate-limit')), 'rate_limited');
  assert.equal(errorType(new Error('model-timeout')), 'timeout');
  // Existing codes keep their meaning.
  assert.equal(errorType(new Error('model-request-failed')), 'model-request-failed');
  assert.equal(modelErrorClass('model-not-a-reason'), undefined);
  assert.equal(modelErrorClass('PRIVATE model-quota'), undefined);
});

test('only failures another model can fix are eligible for fallback', () => {
  assert.deepEqual(
    [...fallbackEligibleClasses].sort(),
    ['auth', 'network', 'not_found', 'quota_exceeded', 'rate_limited', 'server_error', 'timeout'].sort(),
  );
  for (const blocked of ['content_filtered', 'context_too_long', 'bad_request', 'invalid_response', 'cancelled'])
    assert.equal(fallbackEligibleClasses.has(blocked), false);
});

test('provider messages are sanitised, truncated and stripped of request echoes', () => {
  const message = sanitizeProviderMessage(
    `Access denied for Bearer abc.def.ghi at https://example.openai.azure.com/openai/deployments/x?api-key=sk-${'a'.repeat(40)} ` +
      `request 0f8fad5b-d9cb-469f-a165-70867728950e by ops@example.com:\n"${'PRIVATE '.repeat(5)}" ${'x'.repeat(300)}`,
  );
  assert.equal(message, 'Access denied for [credential] at [url] request [id] by [email]: [text] [token]');
  const long = sanitizeProviderMessage(`Unsupported parameter. ${'word '.repeat(100)}`);
  assert.equal(long.length, 200);
  assert.ok(long.endsWith('…'));
  for (const secret of ['abc.def.ghi', 'example.openai', 'sk-', '0f8fad5b', 'ops@example.com', 'PRIVATE', '\n'])
    assert.ok(!message.includes(secret), secret);
  const request = JSON.stringify({ messages: [{ role: 'user', content: 'please summarise my secret launch plan' }] });
  assert.equal(
    sanitizeProviderMessage('Invalid content: please summarise my secret launch plan is not allowed', request),
    'Invalid content: [text] is not allowed',
  );
  assert.equal(sanitizeProviderMessage(42), undefined);
  assert.equal(sanitizeProviderMessage('   '), undefined);
});

test('ModelCallError keeps the stored code and exposes bounded diagnostics through the cause chain', () => {
  const error = new ModelCallError('configuration', {
    status: 404,
    providerCode: 'DeploymentNotFound',
    providerMessage: 'The API deployment for this resource does not exist.',
    outputStarted: false,
  });
  assert.equal(error.message, 'model-configuration');
  assert.equal(error.code, 'not_found');
  const wrapped = new Error('outer', { cause: error });
  assert.deepEqual(modelCallDiagnostics(wrapped), {
    errorClass: 'not_found',
    status: 404,
    providerCode: 'DeploymentNotFound',
    providerMessage: 'The API deployment for this resource does not exist.',
    outputStarted: false,
  });
  assert.equal(
    new ModelCallError('quota', { providerCode: 'PRIVATE CODE WITH SPACES', outputStarted: false }).modelDiagnostics
      .providerCode,
    undefined,
  );
});

test('a failed model call sets the bounded class on its span, metric and log line without private content', async t => {
  const spans = new InMemorySpanExporter();
  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const reader = new PeriodicExportingMetricReader({ exporter: metricExporter, exportIntervalMillis: 60000 });
  const sdk = new NodeSDK({
    autoDetectResources: false,
    spanProcessors: [new SimpleSpanProcessor(spans)],
    metricReader: reader,
  });
  sdk.start();
  const records = [];
  const write = process.stdout.write.bind(process.stdout);
  t.mock.method(process.stdout, 'write', (chunk, ...args) => {
    if (typeof chunk === 'string' && chunk.startsWith('{"level":')) {
      records.push(JSON.parse(chunk));
      return true;
    }
    return write(chunk, ...args);
  });
  try {
    const failure = new ModelCallError('quota', {
      status: 429,
      providerCode: 'insufficient_quota',
      providerMessage: 'You exceeded your current quota for PRIVATE PROMPT text, see https://private.example/x',
      outputStarted: false,
      request: JSON.stringify({ input: 'PRIVATE PROMPT text' }),
    });
    await assert.rejects(
      observeInference({ provider: 'azure', model: 'gpt-6-luna', operation: 'chat' }, async report => {
        // An early bare report must not hide the detailed failure that follows.
        report.error();
        throw failure;
      }),
      error => error === failure,
    );
    recordModelFallback('not_configured', { provider: 'azure', model: 'gpt-6-luna', errorClass: 'quota_exceeded' });
    const span = spans.getFinishedSpans().at(-1);
    assert.equal(span.attributes['error.code'], 'quota_exceeded');
    assert.equal(span.attributes['error.type'], 'quota_exceeded');
    assert.equal(span.attributes['http.response.status_code'], 429);
    assert.equal(span.attributes.output_started, false);
    assert.equal(span.attributes['provider.error_message'], undefined, 'provider text is never a span attribute');
    assert.equal(span.attributes['provider.error_code'], undefined);
    const failed = records.filter(record => record.event === 'call_failed');
    assert.equal(failed.length, 1, 'one failure line per call');
    assert.equal(failed[0]['error.code'], 'quota_exceeded');
    assert.equal(failed[0]['gen_ai.provider.name'], 'azure');
    assert.equal(failed[0]['gen_ai.request.model'], 'gpt-6-luna');
    assert.equal(failed[0]['http.response.status_code'], 429);
    assert.equal(failed[0]['provider.error_code'], 'insufficient_quota');
    assert.equal(failed[0]['provider.error_message'], 'You exceeded your current quota for [text] text, see [url]');
    assert.equal(failed[0].output_started, false);
    await reader.forceFlush();
    const exported = metricExporter
      .getMetrics()
      .flatMap(resource => resource.scopeMetrics)
      .flatMap(scope => scope.metrics);
    const duration = exported.find(metric => metric.descriptor.name === 'gen_ai_client_operation_duration');
    const labels = duration.dataPoints.map(point => point.attributes);
    assert.ok(labels.some(attributes => attributes['error.type'] === 'quota_exceeded'));
    const fallback = exported.find(metric => metric.descriptor.name === 'gen_ai_model_fallback');
    assert.deepEqual(
      fallback.dataPoints.map(point => [point.attributes.model_fallback, point.attributes['error.type']]),
      [['not_configured', 'quota_exceeded']],
    );
    for (const point of [...duration.dataPoints, ...fallback.dataPoints])
      for (const value of Object.values(point.attributes)) assert.ok(!String(value).includes(' '), String(value));
    assert.ok(!JSON.stringify(records).includes('PRIVATE'));
    assert.ok(!JSON.stringify(spans.getFinishedSpans().map(item => item.attributes)).includes('PRIVATE'));
  } finally {
    await sdk.shutdown();
  }
});
