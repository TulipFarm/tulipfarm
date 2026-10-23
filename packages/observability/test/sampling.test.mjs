import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { ROOT_CONTEXT, SpanKind, TraceFlags, trace } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { InMemorySpanExporter, SamplingDecision, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import {
  TelemetryRootSampler,
  activeTrace,
  alwaysSample,
  chatTurnSpan,
  errorType,
  log,
  observeChatStage,
  privateSpanExporter,
  startHttp,
  telemetryConfig,
  telemetryIdentity,
  telemetrySampler,
  withChatTurnRoot,
  withTelemetryContext,
} from '../src/index.ts';
import { traceLogAttributes } from '../src/temporal.ts';

const traceId = () => randomBytes(16).toString('hex');
const sampled = (sampler, name, parent = ROOT_CONTEXT, id = traceId()) =>
  sampler.shouldSample(parent, id, name, SpanKind.INTERNAL, {}, []).decision === SamplingDecision.RECORD_AND_SAMPLED;
const withParent = flags =>
  trace.setSpanContext(ROOT_CONTEXT, { traceId: traceId(), spanId: randomBytes(8).toString('hex'), traceFlags: flags });

const spans = new InMemorySpanExporter();
// Both ratios are zero, so only the always-sampled chat-reply roots are kept.
const sdk = new NodeSDK({
  resource: telemetryIdentity({ app: 'api', version: '2026.10.23.1', commit: 'c'.repeat(40) }, true),
  autoDetectResources: false,
  sampler: telemetrySampler(0, 0),
  spanProcessors: [new SimpleSpanProcessor(privateSpanExporter(spans))],
});
sdk.start();
test.after(() => sdk.shutdown());
test.beforeEach(() => spans.reset());

function captureLogs(t) {
  const lines = [];
  const write = process.stdout.write;
  t.mock.method(process.stdout, 'write', (line, ...rest) => {
    if (typeof line !== 'string' || !line.startsWith('{"level"')) return write.call(process.stdout, line, ...rest);
    lines.push(JSON.parse(line));
    return true;
  });
  return lines;
}

test('chat-reply roots are always sampled, even when both ratios are zero', () => {
  const sampler = new TelemetryRootSampler(0, 0);
  assert.equal(sampled(sampler, chatTurnSpan), true);
  assert.equal(sampled(sampler, 'PUT /conversations/:chatId/messages/:messageId', alwaysSample(ROOT_CONTEXT)), true);
  assert.equal(sampled(sampler, 'PUT /conversations/:chatId/messages/:messageId'), false);
  assert.equal(sampled(sampler, 'job.conversation-discovery'), false);
});

test('job roots use the job ratio and other roots use the default ratio', () => {
  assert.equal(sampled(new TelemetryRootSampler(1, 0), 'job.conversation-discovery'), false);
  assert.equal(sampled(new TelemetryRootSampler(0, 1), 'job.conversation-discovery'), true);
  assert.equal(sampled(new TelemetryRootSampler(0, 1), 'GET /v1/widgets/:id'), false);
  assert.equal(sampled(new TelemetryRootSampler(1, 0), 'GET /v1/widgets/:id'), true);
  assert.equal(sampled(new TelemetryRootSampler(1, 0), 'jobs.list'), true, 'only the job. prefix is a job');

  const sampler = new TelemetryRootSampler(0.1, 0.01);
  const ids = Array.from({ length: 20000 }, traceId);
  const jobs = ids.filter(id => sampled(sampler, 'job.knowledge-sync', ROOT_CONTEXT, id)).length;
  const requests = ids.filter(id => sampled(sampler, 'GET /v1/widgets/:id', ROOT_CONTEXT, id)).length;
  assert.ok(jobs > 100 && jobs < 300, `job ratio 0.01 kept ${jobs} of 20000`);
  assert.ok(requests > 1700 && requests < 2300, `ratio 0.1 kept ${requests} of 20000`);
  assert.equal(String(sampler), 'TelemetryRootSampler{ratio=0.1, jobRatio=0.01}');
});

test('children follow their parent, whatever their name', () => {
  const sampler = telemetrySampler(1, 1);
  const off = withParent(TraceFlags.NONE);
  const on = withParent(TraceFlags.SAMPLED);
  assert.equal(sampled(sampler, 'GET /v1/widgets/:id', off), false);
  assert.equal(sampled(sampler, 'job.conversation-discovery', off), false);
  const never = telemetrySampler(0, 0);
  assert.equal(sampled(never, 'job.conversation-discovery', on), true);
  assert.equal(sampled(never, 'model.chat', on), true);
  assert.equal(sampled(never, chatTurnSpan, off), false, 'a chat.turn child does not override its parent');
});

test('a send request that opts in is always sampled and its reply continues the same trace', async () => {
  const plain = startHttp('GET', '/v1/widgets/:id');
  plain.finish(200);
  const send = startHttp('PUT', '/conversations/:chatId/messages/:messageId', { alwaysSample: true });
  let reply;
  await withTelemetryContext(send.context, () =>
    withChatTurnRoot('send', async () => {
      reply = activeTrace();
    }),
  );
  send.finish(200);
  const exported = spans.getFinishedSpans();
  assert.deepEqual(
    exported.map(span => span.name),
    ['PUT /conversations/:chatId/messages/:messageId'],
  );
  assert.deepEqual(reply, { traceId: exported[0].spanContext().traceId, sampled: true });
});

test('a sweep-dispatched reply gets its own sampled chat.turn root linked to the sweep span', async () => {
  const sweep = trace.getTracer('test').startSpan('job.conversation-discovery');
  assert.equal(sweep.spanContext().traceFlags & TraceFlags.SAMPLED, 0, 'the sweep itself is not sampled');
  let reply;
  await withTelemetryContext(trace.setSpan(ROOT_CONTEXT, sweep), () =>
    withChatTurnRoot('sweep', async () => {
      reply = activeTrace();
    }),
  );
  sweep.end();
  const [turn, ...rest] = spans.getFinishedSpans();
  assert.equal(rest.length, 0);
  assert.equal(turn.name, chatTurnSpan);
  assert.equal(turn.parentSpanContext, undefined, 'chat.turn is a root');
  assert.notEqual(turn.spanContext().traceId, sweep.spanContext().traceId);
  assert.equal(turn.attributes.dispatch_source, 'sweep');
  assert.deepEqual(
    turn.links.map(link => link.context.spanId),
    [sweep.spanContext().spanId],
  );
  assert.deepEqual(reply, { traceId: turn.spanContext().traceId, sampled: true });
});

test('a send without a sampled request trace also starts a chat.turn root', async () => {
  const request = startHttp('PUT', '/conversations/:chatId/messages/:messageId');
  await withTelemetryContext(request.context, () => withChatTurnRoot('send', async () => {}));
  request.finish(200);
  const [turn] = spans.getFinishedSpans();
  assert.equal(turn.name, chatTurnSpan);
  assert.equal(turn.attributes.dispatch_source, 'send');
  assert.equal(turn.links.length, 1);
});

test('a failing reply marks its chat.turn root as an error', async () => {
  await assert.rejects(
    withChatTurnRoot('sweep', async () => {
      throw new Error('model-unpriced');
    }),
    /model-unpriced/,
  );
  const [turn] = spans.getFinishedSpans();
  assert.equal(turn.status.code, 2);
  assert.equal(turn.attributes['error.type'], 'model-unpriced');
});

test('log lines with a trace id say whether the trace was sampled', async t => {
  const lines = captureLogs(t);
  log('info', 'activity', 'call_completed', { operation: 'outside' });
  const kept = startHttp('PUT', '/conversations/:chatId/messages/:messageId', { alwaysSample: true });
  await withTelemetryContext(kept.context, async () => {
    log('info', 'activity', 'call_completed', { operation: 'kept' });
    assert.equal(traceLogAttributes({}).trace_sampled, true);
  });
  const dropped = startHttp('GET', '/v1/widgets/:id');
  await withTelemetryContext(dropped.context, async () => {
    log('info', 'activity', 'call_completed', { operation: 'dropped' });
    assert.equal(traceLogAttributes({}).trace_sampled, false);
  });
  const byOperation = Object.fromEntries(
    lines.filter(line => line.event === 'call_completed').map(line => [line.operation, line]),
  );
  assert.equal('trace_sampled' in byOperation.outside, false);
  assert.equal(byOperation.outside.trace_id, undefined);
  assert.equal(byOperation.kept.trace_sampled, true);
  assert.equal(byOperation.kept.trace_id, kept.context && trace.getSpan(kept.context).spanContext().traceId);
  assert.equal(byOperation.dropped.trace_sampled, false);
  assert.match(byOperation.dropped.trace_id, /^[0-9a-f]{32}$/);
  assert.equal(traceLogAttributes({}).trace_sampled, undefined);
  kept.finish(200);
  dropped.finish(200);
});

test('the chat.dispatch log says which path started the reply', async t => {
  const lines = captureLogs(t);
  await observeChatStage('dispatch', async () => {}, { dispatch_source: 'sweep' });
  await observeChatStage('dispatch', async () => {}, { dispatch_source: 'send' });
  const dispatches = lines.filter(line => line.operation === 'chat.dispatch');
  assert.deepEqual(
    dispatches.map(line => [line.outcome, line.dispatch_source]),
    [
      ['success', 'sweep'],
      ['success', 'send'],
    ],
  );
});

test('model and compaction failures report bounded error codes', () => {
  for (const code of [
    'compaction-model-unavailable',
    'compaction-model-failed',
    'compaction-invalid-summary',
    'compaction-ineffective',
    'compaction-unmeasured',
    'model-unpriced',
    'model-family-unavailable',
    'model-context-unavailable',
    'model-budget-exceeded',
    'model-lease-expired',
    'model-retry-conflict',
    'model-policy-revision-conflict',
    'model-provider-response-failed',
    'skill-review-model-unavailable',
    'guide-model-unavailable',
  ])
    assert.equal(errorType(new Error(code)), code);
  assert.equal(errorType(new Error('compaction-model-unavailable: secret detail')), 'Error');
});

const production = {
  NODE_ENV: 'production',
  CLOUD_TELEMETRY_ENABLED: 'true',
  CLOUD_TELEMETRY_OTLP_ENDPOINT: 'https://otlp.example.com',
};

test('the job sample ratio defaults to 0.01 and is validated like the default ratio', () => {
  assert.equal(telemetryConfig(production).jobRatio, 0.01);
  assert.equal(telemetryConfig({ ...production, CLOUD_TELEMETRY_JOB_SAMPLE_RATIO: '' }).jobRatio, 0.01);
  assert.equal(telemetryConfig({ ...production, CLOUD_TELEMETRY_JOB_SAMPLE_RATIO: '0' }).jobRatio, 0);
  assert.equal(telemetryConfig({ ...production, CLOUD_TELEMETRY_JOB_SAMPLE_RATIO: '0.5' }).jobRatio, 0.5);
  for (const ratio of ['1.01', '-0.1', 'NaN', '1e-2', 'low'])
    assert.throws(
      () => telemetryConfig({ ...production, CLOUD_TELEMETRY_JOB_SAMPLE_RATIO: ratio }),
      /JOB_SAMPLE_RATIO/,
    );
});

test('the deployment environment label is configurable and bounded', t => {
  const build = { app: 'api', version: '2026.10.23.1', commit: 'c'.repeat(40) };
  const environment = () => telemetryIdentity(build, true).attributes['deployment.environment'];
  t.after(() => delete process.env.CLOUD_TELEMETRY_ENVIRONMENT);
  delete process.env.CLOUD_TELEMETRY_ENVIRONMENT;
  assert.equal(environment(), 'production');
  process.env.CLOUD_TELEMETRY_ENVIRONMENT = 'staging';
  assert.equal(environment(), 'staging');
  assert.equal(telemetryIdentity(build, false).attributes['deployment.environment'], 'development');
  assert.equal(telemetryConfig({ ...production, CLOUD_TELEMETRY_ENVIRONMENT: 'staging' }).ratio, 0.1);
  for (const value of ['Staging', 'prod env', '-staging', 'x'.repeat(33)])
    assert.throws(
      () => telemetryConfig({ ...production, CLOUD_TELEMETRY_ENVIRONMENT: value }),
      /CLOUD_TELEMETRY_ENVIRONMENT/,
    );
});
