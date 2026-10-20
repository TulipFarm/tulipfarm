import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NativeConnection, Worker } from '@temporalio/worker';
import { privateSpanExporter } from '@tulipfarm/observability';
import * as activities from '../src/activities.ts';
import { workerTelemetry } from '../src/telemetry.ts';

test(
  'API request traces cross a real Temporal workflow and activity without leaking payloads',
  { timeout: 40000 },
  async () => {
    const spans = new InMemorySpanExporter();
    const processor = new SimpleSpanProcessor(privateSpanExporter(spans));
    const resource = resourceFromAttributes({ 'service.name': 'telemetry-integration' });
    const sdk = new NodeSDK({ resource, autoDetectResources: false, spanProcessors: [processor] });
    sdk.start();
    process.env.TEMPORAL_TASK_QUEUE = `telemetry-test-${randomUUID()}`;
    const { buildApp } = await import('../../api/src/app.ts');
    const app = buildApp();
    const connection = await NativeConnection.connect({ address: process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233' });
    try {
      const worker = await Worker.create({
        connection,
        taskQueue: process.env.TEMPORAL_TASK_QUEUE,
        workflowsPath: new URL('../src/workflows.ts', import.meta.url).pathname,
        activities,
        ...workerTelemetry({ resource, spanProcessor: processor }),
      });
      await worker.runUntil(async () => {
        const response = await app.inject('/v1/health?private=SECRET_QUERY');
        assert.equal(response.statusCode, 200, response.body);
        assert.equal(response.headers.traceparent, undefined);
        assert.equal(response.headers['x-telemetry-traceparent'], undefined);
        const denied = await app.inject('/no-such-route/SECRET_PATH?token=SECRET_QUERY');
        assert.equal(denied.statusCode, 404);
      });
      await processor.forceFlush();
      const exported = spans.getFinishedSpans();
      const root = exported.find(span => span.name === 'GET /v1/health');
      assert.ok(root, exported.map(span => span.name).join(', '));
      const sameTrace = exported.filter(span => span.spanContext().traceId === root.spanContext().traceId);
      assert.ok(
        sameTrace.some(span => span.name.includes('healthCheck')),
        sameTrace.map(span => span.name).join(', '),
      );
      assert.ok(sameTrace.some(span => span.name === 'ping'));
      for (const name of ['StartWorkflow:healthCheck', 'RunWorkflow:healthCheck', 'RunActivity:ping']) {
        assert.ok(
          sameTrace.some(span => span.name === name),
          `${name}: ${sameTrace.map(span => span.name).join(', ')}`,
        );
      }
      const activitySpan = sameTrace.find(span => span.name === 'ping');
      assert.ok(sameTrace.some(span => span.spanContext().spanId === activitySpan.parentSpanContext?.spanId));
      assert.ok(
        exported.some(span => span.name === 'GET unmatched' && span.attributes['http.response.status_code'] === 404),
      );
      assert.doesNotMatch(JSON.stringify(exported), /SECRET|temporalWorkflowId|temporalActivityId|run_id/);
    } finally {
      await app.close();
      await connection.close();
      await sdk.shutdown();
    }
  },
);
