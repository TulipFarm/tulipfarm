import assert from 'node:assert/strict';
import test from 'node:test';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { InMemoryLogRecordExporter, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import {
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
  AggregationTemporality,
} from '@opentelemetry/sdk-metrics';
import {
  chatReplyBuckets,
  chatReplyFinal,
  chatStopReason,
  guardChatReplyFinal,
  noteChatReplyCause,
  noteChatReplyFinal,
  observeChatDetail,
  observeChatTool,
  telemetryIdentity,
  trace,
  withChatMeasurements,
  withChatModelRequest,
  withChatSendMeasurements,
} from '../src/index.ts';

const started = new Date('2026-10-22T15:30:00.000Z');
const at = seconds => new Date(started.getTime() + seconds * 1000);
const timing = overrides => ({
  status: 'completed',
  requestedAt: null,
  startedAt: started,
  claimedAt: at(1.2),
  finishedAt: at(5),
  firstTextSeconds: 3.5,
  humanWaitSeconds: 0,
  externalWaitSeconds: 0,
  inactiveSeconds: 0,
  attempts: 1,
  ...overrides,
});

const exporter = new InMemoryMetricExporter(AggregationTemporality.DELTA);
const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60000 });
const sdk = new NodeSDK({
  resource: telemetryIdentity({ app: 'worker', version: '2026.10.22.7', commit: 'c'.repeat(40) }, true),
  autoDetectResources: false,
  spanProcessors: [new SimpleSpanProcessor(new InMemorySpanExporter())],
  metricReader: reader,
  logRecordProcessors: [new SimpleLogRecordProcessor({ exporter: new InMemoryLogRecordExporter() })],
});
sdk.start();
test.after(() => sdk.shutdown());

function harness(t) {
  let clock = 1000;
  t.mock.method(performance, 'now', () => clock);
  const lines = [];
  const write = process.stdout.write;
  t.mock.method(process.stdout, 'write', (line, ...rest) => {
    if (typeof line !== 'string' || !line.startsWith('{"level"')) return write.call(process.stdout, line, ...rest);
    if (line.includes('chat.reply.summary')) lines.push(JSON.parse(line));
    return true;
  });
  const spend = (milliseconds, value) => async () => {
    clock += milliseconds;
    return value;
  };
  async function collect() {
    await reader.forceFlush();
    const points = exporter
      .getMetrics()
      .flatMap(resource => resource.scopeMetrics.flatMap(scope => scope.metrics))
      .filter(metric => metric.descriptor.name === 'cloud_chat_reply_duration')
      .flatMap(metric => metric.dataPoints.map(point => ({ unit: metric.descriptor.unit, ...point })));
    exporter.reset();
    const summaries = lines.splice(0);
    return { points, summaries };
  }
  return { advance: ms => (clock += ms), spend, collect };
}

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
const bySegment = points => Object.fromEntries(points.map(point => [point.attributes.segment, point]));

test('a greeting reply records each segment once, counting nested database time once', async t => {
  const { advance, spend, collect } = harness(t);
  let traceId;
  await trace.getTracer('fixture').startActiveSpan('worker.reply', async span => {
    traceId = span.spanContext().traceId;
    await withChatMeasurements(async () => {
      advance(50);
      await observeChatDetail('reserve', async () => {
        advance(200);
        await observeChatDetail('storage-connect', spend(100));
      });
      await withChatModelRequest('reply', () => observeChatDetail('provider', spend(2000)));
      await withChatModelRequest('title', () => observeChatDetail('provider', spend(800)));
      await observeChatDetail('settle', async () => {
        advance(250);
        await observeChatDetail('storage-commit', spend(150));
      });
      noteChatReplyFinal(chatReplyFinal(timing()));
    }, 'turn-greeting');
    span.end();
  });
  const { points, summaries } = await collect();
  assert.equal(points.length, 7);
  for (const point of points) {
    assert.equal(point.unit, 's');
    assert.equal(point.value.count, 1);
    assert.deepEqual(point.value.buckets.boundaries, [...chatReplyBuckets]);
    assert.deepEqual(Object.keys(point.attributes).sort(), [
      'application',
      'environment',
      'outcome',
      'segment',
      'service',
      'service_version',
      'tools',
    ]);
    assert.equal(point.attributes.outcome, 'success');
    assert.equal(point.attributes.tools, 'no');
  }
  const segments = bySegment(points);
  close(segments.total.value.sum, 5);
  close(segments.first_text.value.sum, 3.5);
  close(segments.queue.value.sum, 1.2);
  close(segments.model.value.sum, 2.8);
  close(segments.tools.value.sum, 0);
  close(segments.db.value.sum, 0.7);
  close(segments.overhead.value.sum, 5 - 1.2 - 2.8 - 0);
  assert.equal(summaries.length, 1);
  const [summary] = summaries;
  assert.equal(summary.event, 'call_completed');
  assert.equal(summary.operation, 'chat.reply.summary');
  assert.equal(summary.outcome, 'success');
  assert.equal(summary.trace_id, traceId);
  assert.equal(summary['chat.reply.tools'], 'no');
  assert.equal(summary['chat.reply.attempts'], 1);
  close(summary['chat.reply.total_seconds'], 5);
  close(summary['chat.reply.db_seconds'], 0.7);
  close(summary['chat.reply.overhead_seconds'], 1);
  assert.equal(JSON.stringify(summary).includes('turn-greeting'), false);
});

test('human and external waits leave total and overhead, and model calls inside tools stay model time', async t => {
  const { advance, spend, collect } = harness(t);
  await withChatMeasurements(async () => {
    await withChatModelRequest('reply', () => observeChatDetail('provider', spend(2000)));
    await observeChatTool(async () => {
      advance(1500);
      await withChatModelRequest('completion', () => observeChatDetail('provider', spend(1000)));
      advance(500);
    });
    advance(40000);
    noteChatReplyFinal(
      chatReplyFinal(
        timing({
          claimedAt: at(0.5),
          finishedAt: at(60),
          firstTextSeconds: 12,
          humanWaitSeconds: 40,
          externalWaitSeconds: 5,
        }),
      ),
    );
  });
  const { points, summaries } = await collect();
  const segments = bySegment(points);
  close(segments.total.value.sum, 15);
  close(segments.queue.value.sum, 0.5);
  close(segments.model.value.sum, 3);
  close(segments.tools.value.sum, 2);
  close(segments.overhead.value.sum, 15 - 0.5 - 3 - 2);
  assert.ok(points.every(point => point.attributes.tools === 'yes' && point.value.count === 1));
  assert.equal(summaries[0]['chat.reply.tools'], 'yes');
});

test('a failed reply records outcome=failed once, after its retried attempts, and skips first_text without text', async t => {
  const { spend, collect } = harness(t);
  await withChatMeasurements(() => observeChatDetail('provider', spend(1000)), 'turn-retried');
  assert.deepEqual((await collect()).points, []);
  await withChatMeasurements(async () => {
    await assert.rejects(
      guardChatReplyFinal(async () => {
        noteChatReplyFinal(chatReplyFinal(timing({ status: 'completed' })));
        throw new Error('rolled back');
      }),
    );
    await observeChatDetail('provider', spend(2000));
    noteChatReplyFinal(chatReplyFinal(timing({ status: 'failed', firstTextSeconds: null, attempts: 2 })));
  }, 'turn-retried');
  const { points, summaries } = await collect();
  assert.equal(points.length, 6);
  assert.equal(bySegment(points).first_text, undefined);
  assert.ok(points.every(point => point.attributes.outcome === 'failed' && point.value.count === 1));
  close(bySegment(points).model.value.sum, 3);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0]['chat.reply.attempts'], 2);
  assert.equal(summaries[0]['chat.reply.first_text_seconds'], undefined);
  await withChatMeasurements(async () => {
    noteChatReplyFinal(chatReplyFinal(timing({ status: 'blocked' })));
  });
  await withChatMeasurements(async () => {
    noteChatReplyFinal(chatReplyFinal(timing({ status: 'cancelled' })));
  });
  const outcomes = (await collect()).points.filter(point => point.attributes.segment === 'total');
  assert.deepEqual(outcomes.map(point => point.attributes.outcome).sort(), ['cancelled', 'failed']);
});

test('stopped reply reasons are bounded and prefer the stored code over the attempt cause', () => {
  assert.equal(chatStopReason('credits-exhausted'), 'credits');
  assert.equal(chatStopReason('project-context-too-large'), 'context');
  assert.equal(chatStopReason('model-context-overflow'), 'context');
  assert.equal(chatStopReason('model-timeout'), 'provider-timeout');
  assert.equal(chatStopReason('model-rate-limited'), 'provider-error');
  assert.equal(chatStopReason('attempts-exhausted', '40P01'), 'database');
  assert.equal(chatStopReason('transient-failure', 'pool_capacity'), 'database');
  assert.equal(chatStopReason(null, 'conversation-context-overflow'), 'context');
  assert.equal(chatStopReason('attempts-exhausted'), 'other');
  assert.equal(chatStopReason('access-denied', '40P01'), 'other');
  assert.equal(chatStopReason('PRIVATE free text'), 'other');
});

test('a failed reply logs one chat.reply-stopped event with only its bounded reason and runtime', async t => {
  const stopped = [];
  const write = process.stdout.write;
  t.mock.method(process.stdout, 'write', (line, ...rest) => {
    if (typeof line !== 'string' || !line.startsWith('{"level"')) return write.call(process.stdout, line, ...rest);
    if (line.includes('chat.reply-stopped')) stopped.push(JSON.parse(line));
    return true;
  });
  await withChatMeasurements(async () => {
    noteChatReplyCause('40P01');
  }, 'turn-stopped');
  await withChatMeasurements(async () => {
    noteChatReplyCause('40P01');
    noteChatReplyFinal(chatReplyFinal(timing({ status: 'failed', errorCode: 'attempts-exhausted', runtime: 'slack' })));
  }, 'turn-stopped');
  await withChatMeasurements(async () => {
    noteChatReplyFinal(chatReplyFinal(timing({ status: 'completed', errorCode: null, runtime: 'chat' })));
  });
  await withChatMeasurements(async () => {
    noteChatReplyFinal(chatReplyFinal(timing({ status: 'blocked', errorCode: 'access-denied' })));
  });
  await withChatMeasurements(async () => {
    noteChatReplyFinal(chatReplyFinal(timing({ status: 'failed', errorCode: 'PRIVATE turn text' })));
  });
  assert.equal(stopped.length, 2);
  assert.equal(stopped[0].event, 'call_failed');
  assert.equal(stopped[0].level, 'warn');
  assert.equal(stopped[0].operation, 'chat.reply-stopped');
  assert.equal(stopped[0].outcome, 'failed');
  assert.equal(stopped[0]['chat.stop.reason'], 'database');
  assert.equal(stopped[0].runtime, 'slack');
  assert.equal(stopped[0]['error.code'], 'attempts-exhausted');
  assert.equal(stopped[1]['chat.stop.reason'], 'other');
  assert.equal(stopped[1].runtime, 'chat');
  assert.equal(stopped[1]['error.code'], undefined);
  assert.doesNotMatch(JSON.stringify(stopped), /PRIVATE|turn-stopped/);
  await reader.forceFlush();
  exporter.reset();
});

test('reply timing without a claim counts the whole reply as queue', () => {
  assert.deepEqual(chatReplyFinal(timing({ claimedAt: null, firstTextSeconds: null })), {
    status: 'completed',
    totalSeconds: 5,
    sendSeconds: null,
    queueSeconds: 5,
    firstTextSeconds: null,
    attempts: 1,
  });
  assert.deepEqual(chatReplyFinal(timing({ requestedAt: at(-0.4), claimedAt: null, firstTextSeconds: null })), {
    status: 'completed',
    totalSeconds: 5.4,
    sendSeconds: 0.4,
    queueSeconds: 5,
    firstTextSeconds: null,
    attempts: 1,
  });
});

test('a recorded send request moves total and first_text to its arrival and its time counts as overhead', async t => {
  const { spend, collect } = harness(t);
  await withChatMeasurements(async () => {
    await withChatModelRequest('reply', () => observeChatDetail('provider', spend(2000)));
    noteChatReplyFinal(chatReplyFinal(timing({ requestedAt: at(-1.6) })));
  }, 'turn-sent');
  const { points, summaries } = await collect();
  assert.equal(points.length, 8);
  const segments = bySegment(points);
  close(segments.total.value.sum, 6.6);
  close(segments.send.value.sum, 1.6);
  close(segments.first_text.value.sum, 5.1);
  close(segments.queue.value.sum, 1.2);
  close(segments.model.value.sum, 2);
  close(segments.overhead.value.sum, 6.6 - 1.2 - 2 - 0);
  assert.ok(segments.overhead.value.sum >= segments.send.value.sum);
  const [summary] = summaries;
  close(summary['chat.reply.send_seconds'], 1.6);
  close(summary['chat.reply.total_seconds'], 6.6);
  close(summary['chat.reply.first_text_seconds'], 5.1);
  close(
    summary['chat.reply.overhead_seconds'],
    summary['chat.reply.total_seconds'] -
      summary['chat.reply.queue_seconds'] -
      summary['chat.reply.model_seconds'] -
      summary['chat.reply.tools_seconds'],
  );
  assert.ok(Object.keys(segments.send.attributes).every(key => !key.includes('id')));
});

test('a send request clock after the save records no negative send time', () => {
  const final = chatReplyFinal(timing({ requestedAt: at(0.05) }));
  assert.equal(final.sendSeconds, 0);
  assert.equal(final.totalSeconds, 5);
  assert.equal(final.firstTextSeconds, 3.5);
});

test('send measurements record the request wait and save phases without a reply duration', async t => {
  const { spend, collect } = harness(t);
  const details = [];
  const write = process.stdout.write;
  t.mock.method(process.stdout, 'write', (line, ...rest) => {
    if (typeof line === 'string' && line.includes('"chat.detail.')) {
      details.push(JSON.parse(line));
      return true;
    }
    return write.call(process.stdout, line, ...rest);
  });
  const result = await withChatSendMeasurements(1600, async () => {
    await observeChatDetail('storage-admission', spend(5));
    await observeChatDetail('actor', spend(3));
    await observeChatDetail('send-write', spend(1200));
    return 'sent';
  });
  assert.equal(result, 'sent');
  assert.deepEqual(
    details.map(line => [line.operation, line['chat.purpose'], line.duration_ms]),
    [
      ['chat.detail.send-request', 'send', 1600],
      ['chat.detail.send-write', 'send', 1200],
    ],
    'only phases of at least a second are logged',
  );
  const { points, summaries } = await collect();
  assert.deepEqual(points, []);
  assert.deepEqual(summaries, []);
});
