import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Context } from '@temporalio/activity';
import { Client, Connection, WorkflowFailedError } from '@temporalio/client';
import { NativeConnection, Worker } from '@temporalio/worker';
import { heartbeating } from '../dist/app-activities.js';

test(
  'a reply whose worker stops beating ends within a minute, while a long reply that beats runs on',
  { timeout: 150_000 },
  async () => {
    const address = process.env.TASK_TEST_TEMPORAL_ADDRESS;
    assert.ok(address, 'Owned Temporal is required');
    const taskQueue = `conversation-workflows-${randomUUID()}`;
    const activities = {
      // Like a worker process that died mid-reply: no result and no heartbeat reach Temporal. It ends only at shutdown.
      deliverConversationReply: work =>
        work.turnId === 'stopped'
          ? new Promise((_, reject) =>
              Context.current().cancellationSignal.addEventListener('abort', () => reject(new Error('stopped'))),
            )
          : heartbeating(async () => {
              await sleep(75_000);
              return { outcome: 'completed' };
            }),
      generateConversationTitle: async () => 'skipped',
    };
    const native = await NativeConnection.connect({ address });
    const connection = await Connection.connect({ address });
    try {
      const client = new Client({ connection });
      const worker = await Worker.create({
        connection: native,
        taskQueue,
        workflowsPath: fileURLToPath(new URL('../dist/workflows.js', import.meta.url)),
        activities,
      });
      await worker.runUntil(async () => {
        const start = turnId =>
          client.workflow.start('conversationReply', {
            taskQueue,
            workflowId: `conversation-reply-${randomUUID()}`,
            args: [{ workspaceId: randomUUID(), conversationId: randomUUID(), turnId, generation: 0 }],
          });
        const started = Date.now();
        const [stopped, beating] = await Promise.all([start('stopped'), start('beating')]);
        const failure = await stopped.result().then(
          () => assert.fail('a reply without heartbeats cannot complete'),
          error => error,
        );
        assert.ok(failure instanceof WorkflowFailedError);
        assert.match(String(failure.cause?.cause?.message ?? failure.cause?.message), /heartbeat/i);
        assert.ok(Date.now() - started < 90_000, 'the stopped reply ends at its heartbeat timeout');
        assert.equal(await beating.result(), 'completed');
      });
    } finally {
      await connection.close();
      await native.close();
    }
  },
);
