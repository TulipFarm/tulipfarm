import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { NativeConnection, Worker } from '@temporalio/worker';
import { Client, Connection } from '@temporalio/client';
import { heartbeatFixture } from '../../../packages/google-workspace/test/heartbeat-fixture.mjs';
import { createGoogleHeartbeatActivities, heartbeatProcessor } from '../dist/google-heartbeat-activities.js';
import { dispatchGmailHeartbeat } from '../../api/dist/google-heartbeat-dispatch.js';
import { initialModelMapping, legacyModels } from '@tulipfarm/config';

test(
  'compiled Gmail Temporal workflow survives worker restart and never puts private email or answers in history',
  { timeout: 120000 },
  async t => {
    const f = await heartbeatFixture();
    const address = process.env.TEST_TEMPORAL_ADDRESS ?? '127.0.0.1:7233';
    const connection = await NativeConnection.connect({ address });
    const clientConnection = await Connection.connect({ address });
    const client = new Client({ connection: clientConnection });
    const taskQueue = `gmail-proof-${randomUUID()}`;
    let worker, running;
    let modelCalls = 0;
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
      const request = JSON.parse(options.body);
      assert.equal(request.tools, undefined);
      modelCalls++;
      return Response.json({
        candidates: [{ content: { parts: [{ text: 'private-temporal-answer' }] } }],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 },
      });
    });
    try {
      await f.configure({ instructions: 'private-temporal-instructions' });
      const route = {
        provider: 'google',
        endpoint: 'https://generativelanguage.googleapis.com/',
        model: 'gemini-3.8-flash',
        apiKey: 'fixture-only',
      };
      // This proof prices the route from the frozen model record directly, without a served catalog.
      const priced = legacyModels.find(
        candidate => candidate.provider === 'google' && candidate.providerModelId === route.model,
      );
      const model = {
        route,
        price: {
          familyId: priced.familyId,
          modelId: priced.id,
          pricingRevision: initialModelMapping.pricingRevision,
          rates: priced.rates,
          maxInputTokens: priced.maxInputTokens,
          maxOutputTokens: Math.min(4096, priced.maxOutputTokens),
        },
      };
      const startWorker = async () => {
        worker = await Worker.create({
          connection,
          taskQueue,
          workflowsPath: fileURLToPath(new URL('../dist/workflows.js', import.meta.url)),
          activities: createGoogleHeartbeatActivities(f.runtime, {
            service: f.make(),
            processor: heartbeatProcessor(f.runtime, model),
          }),
        });
        running = worker.run();
      };
      await startWorker();
      const handles = [];
      const start = async work => {
        const handle = await client.workflow.start('gmailHeartbeat', {
          workflowId: `gmail-${work.heartbeatId}`,
          taskQueue,
          args: [work],
          workflowIdConflictPolicy: 'USE_EXISTING',
          workflowIdReusePolicy: 'ALLOW_DUPLICATE',
        });
        handles.push({ handle, work });
        await handle.result();
      };
      await dispatchGmailHeartbeat(f.service, f.workspace.id, start);
      assert.equal((await f.results()).results.length, 0);
      worker.shutdown();
      await running;
      worker = undefined;
      await f.db.platform.query(`UPDATE ${f.table('tf_google_heartbeats')} SET due_at=clock_timestamp()`);
      await startWorker();
      await dispatchGmailHeartbeat(f.service, f.workspace.id, start);
      assert.equal((await f.results()).results[0].answer, 'private-temporal-answer');
      assert.equal(modelCalls, 1);
      for (const { handle, work } of handles) {
        const history = await handle.fetchHistory();
        for (const event of history.events) {
          const input =
            event.workflowExecutionStartedEventAttributes?.input ?? event.activityTaskScheduledEventAttributes?.input;
          if (input)
            assert.deepEqual(
              input.payloads.map(payload => JSON.parse(Buffer.from(payload.data).toString())),
              [work],
            );
          for (const payload of event.activityTaskCompletedEventAttributes?.result?.payloads ?? []) {
            assert.equal(Buffer.from(payload.metadata.encoding).toString(), 'binary/null');
            assert.equal(payload.data?.byteLength ?? 0, 0);
          }
        }
        const serialized = JSON.stringify(history);
        for (const privateValue of [
          'private-temporal-answer',
          'private-temporal-instructions',
          'attacker@example.test',
        ])
          assert.equal(serialized.includes(privateValue), false);
      }
    } finally {
      if (worker) {
        worker.shutdown();
        await running;
      }
      await connection.close();
      await clientConnection.close();
      await f.close();
    }
  },
);
