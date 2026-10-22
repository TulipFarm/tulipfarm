import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { NativeConnection, Worker } from '@temporalio/worker';
import { Client, Connection } from '@temporalio/client';
import { conversationFixture, reverseReply } from '../../../packages/conversations/test/fixture.mjs';
import { createConversationDispatch } from '@tulipfarm/conversations/dispatch';
import { createConversationActivities } from '../dist/conversation-activities.js';

test(
  'compiled ordinary workflow persists reverse replies across worker restart with ID-only history',
  { timeout: 120000 },
  async () => {
    const f = await conversationFixture();
    const connection = await NativeConnection.connect({ address: '127.0.0.1:7233' });
    const clientConnection = await Connection.connect({ address: '127.0.0.1:7233' });
    const client = new Client({ connection: clientConnection });
    const taskQueue = `conversation-proof-${randomUUID()}`;
    let worker;
    let running;
    const handles = [];
    try {
      const { workspace: w, store } = f;
      const id = randomUUID();
      await store.create(w.id, w.userId, { chatId: id, commandId: randomUUID() });
      const privateText = 'private-fixture hello 👩🏽‍🌾';
      await store.send(w.id, w.userId, id, {
        commandId: randomUUID(),
        messageId: randomUUID(),
        parts: [{ kind: 'text', text: privateText }],
      });
      const startWorker = async () => {
        worker = await Worker.create({
          connection,
          taskQueue,
          workflowsPath: fileURLToPath(new URL('../dist/workflows.js', import.meta.url)),
          activities: createConversationActivities(f.runtime, reverseReply),
        });
        running = worker.run();
      };
      let lost = true;
      const dispatch = createConversationDispatch({
        runtime: f.runtime,
        start: async work => {
          const handle = await client.workflow.start('conversationReply', {
            workflowId: `reply-${work.turnId}-${work.generation}`,
            taskQueue,
            args: [work],
            workflowIdConflictPolicy: 'USE_EXISTING',
            workflowIdReusePolicy: 'ALLOW_DUPLICATE',
          });
          handles.push({ handle, work });
          if (lost) {
            lost = false;
            throw new Error('lost dispatch acknowledgement');
          }
          assert.equal(await handle.result(), 'completed');
        },
      });
      await assert.rejects(dispatch(w.id), /conversation-dispatch-incomplete/);
      await startWorker();
      assert.equal(await handles[0].handle.result(), 'completed');
      await dispatch(w.id);
      worker.shutdown();
      await running;
      worker = undefined;
      await store.send(w.id, w.userId, id, {
        commandId: randomUUID(),
        messageId: randomUUID(),
        parts: [{ kind: 'text', text: 'after restart' }],
      });
      await startWorker();
      await dispatch(w.id);
      const history = await store.history(w.id, w.userId, id);
      assert.deepEqual(
        history.messages.map(message => message.parts.map(part => part.text).join('')),
        [privateText, '👩🏽‍🌾 olleh erutxif-etavirp', 'after restart', 'tratser retfa'],
      );
      assert.deepEqual(
        (
          await f.db.platform.query(
            `SELECT sources, publication FROM ${f.table('tf_conversation_results')} ORDER BY created_at`,
          )
        ).rows,
        [
          {
            sources: [{ kind: 'private-conversation', conversationId: id }, { kind: 'unknown' }],
            publication: 'private',
          },
          {
            sources: [{ kind: 'private-conversation', conversationId: id }, { kind: 'unknown' }],
            publication: 'private',
          },
        ],
      );
      for (const { handle, work } of handles) {
        const history = await handle.fetchHistory();
        for (const event of history.events) {
          const attributes =
            event.workflowExecutionStartedEventAttributes ?? event.activityTaskScheduledEventAttributes;
          if (attributes?.input)
            assert.deepEqual(
              attributes.input.payloads.map(payload => JSON.parse(Buffer.from(payload.data).toString())),
              [work],
            );
          for (const payload of event.activityTaskCompletedEventAttributes?.result?.payloads ?? [])
            assert.equal(JSON.parse(Buffer.from(payload.data).toString()), 'completed');
        }
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
