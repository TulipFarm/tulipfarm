import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { privateSpanExporter, trace } from '@tulipfarm/observability';
import { workerTelemetry } from '../src/telemetry.ts';
import { temporalWorkflowInterceptorModule } from '../src/temporal-tracing.ts';
import { extractContextFromHeaders, headersWithContext, TRACE_HEADER } from '@tulipfarm/observability/temporal';
import { readFile } from 'node:fs/promises';

const spans = new InMemorySpanExporter();
const resource = resourceFromAttributes({ 'service.name': 'worker-telemetry-fixture' });
const processor = new SimpleSpanProcessor(privateSpanExporter(spans));
const sdk = new NodeSDK({ resource, autoDetectResources: false, spanProcessors: [processor] });
before(() => sdk.start());
after(() => sdk.shutdown());

test('shared worker telemetry preserves activity results, error identity and active trace context', async () => {
  spans.reset();
  {
    const options = workerTelemetry({ resource, spanProcessor: processor });
    assert.deepEqual(options.interceptors.workflowModules, [temporalWorkflowInterceptorModule]);
    assert.equal(typeof options.sinks.temporalSpanExporter.export.fn, 'function');
    assert.equal(options.interceptors.client.workflow.length, 1);
    const disabled = workerTelemetry();
    assert.equal(disabled.sinks, undefined);
    assert.equal(disabled.interceptors.workflowModules, undefined);
    assert.equal(disabled.interceptors.activity.length, 1);
    const inbound = options.interceptors.activity.at(-1)().inbound;
    const input = { args: ['PRIVATE PAYLOAD'] };
    const output = { text: 'PRIVATE RESULT' };
    const error = new Error('PRIVATE ERROR');
    await trace.getTracer('worker-fixture').startActiveSpan('activity.fixture', async span => {
      const result = await inbound.execute(input, async value => {
        assert.equal(value, input);
        assert.equal(trace.getActiveSpan(), span);
        return output;
      });
      assert.equal(result, output);
      await assert.rejects(
        inbound.execute(input, async () => {
          throw error;
        }),
        value => value === error,
      );
      assert.equal(trace.getActiveSpan(), span);
      span.end();
    });
    assert.equal(spans.getFinishedSpans().length, 1);
    assert.doesNotMatch(JSON.stringify(spans.getFinishedSpans()), /PRIVATE/);
  }
});

test('Temporal tracing carries trace context through headers and exports sandbox spans as SDK 2 spans', async () => {
  spans.reset();
  {
    const options = workerTelemetry({ resource, spanProcessor: processor });
    const activityTracing = options.interceptors.activity[0];
    let headers;
    let parent;
    await trace.getTracer('fixture').startActiveSpan('client', async span => {
      parent = span.spanContext();
      headers = headersWithContext({});
      span.end();
    });
    assert.ok(headers[TRACE_HEADER]);
    assert.equal(trace.getSpanContext(extractContextFromHeaders(headers)).traceId, parent.traceId);
    const ctx = { info: { activityType: 'ping', activityId: '1', workflowExecution: { workflowId: 'w', runId: 'r' } } };
    const error = new Error('activity failed');
    await assert.rejects(
      activityTracing(ctx).inbound.execute({ args: [], headers }, async () => {
        throw error;
      }),
      value => value === error,
    );
    const activity = spans.getFinishedSpans().find(span => span.name === 'RunActivity:ping');
    assert.equal(activity.spanContext().traceId, parent.traceId);
    assert.equal(activity.parentSpanContext.spanId, parent.spanId);
    assert.equal(activity.status.code, 2);

    options.sinks.temporalSpanExporter.export.fn({}, [
      {
        name: 'RunWorkflow:fixture',
        kind: 0,
        spanContext: { traceId: parent.traceId, spanId: 'aaaaaaaaaaaaaaaa', traceFlags: 1, traceState: 'k=v' },
        parentSpanContext: { traceId: parent.traceId, spanId: parent.spanId, traceFlags: 1, isRemote: true },
        startTime: [1, 0],
        endTime: [2, 0],
        duration: [1, 0],
        ended: true,
        status: { code: 1 },
        attributes: {},
        links: [],
        events: [],
        instrumentationScope: { name: '@temporalio/interceptor-workflow' },
        droppedAttributesCount: 0,
        droppedEventsCount: 0,
        droppedLinksCount: 0,
      },
    ]);
    const workflow = spans.getFinishedSpans().find(span => span.name === 'RunWorkflow:fixture');
    assert.equal(workflow.resource, resource);
    assert.equal(workflow.spanContext().traceState.get('k'), 'v');
    assert.equal(workflow.parentSpanContext.spanId, parent.spanId);
  }
});

test('all Temporal worker construction sites use the same telemetry options', async () => {
  for (const file of [
    'worker',
    'storage-worker',
    'knowledge-google-composition',
    'knowledge-slack-composition',
    'knowledge-github-composition',
    'knowledge-atlassian-composition',
    'knowledge-defaults-composition',
    'knowledge-embedding-composition',
  ]) {
    const source = await readFile(new URL(`../src/${file}.ts`, import.meta.url), 'utf8');
    const workers = [...source.matchAll(/(?:Worker\.create|createWorker)\(\{/g)];
    assert.ok(workers.length > 0, file);
    assert.equal([...source.matchAll(/\.\.\.workerTelemetry\(/g)].length, workers.length, file);
  }
});
