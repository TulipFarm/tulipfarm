import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { NativeConnection, Worker } from '@temporalio/worker';
import { Client, Connection } from '@temporalio/client';
import { conversationFixture, reverseReply } from '../../../packages/conversations/test/fixture.mjs';
import { createConversationDispatch } from '@tulipfarm/conversations/dispatch';
import { createConversationTitles } from '@tulipfarm/conversations/titles';
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
      const titles = createConversationTitles(f.runtime);
      const titleRuns = [];
      const startWorker = async () => {
        worker = await Worker.create({
          connection,
          taskQueue,
          workflowsPath: fileURLToPath(new URL('../dist/workflows.js', import.meta.url)),
          activities: {
            ...createConversationActivities(f.runtime, reverseReply),
            // The real title step without a model: it records what the chat showed when it ran, and fails once.
            generateConversationTitle: async ({ attempt, final, ...work }) => {
              const history = await store.history(w.id, w.userId, id);
              titleRuns.push({
                attempt,
                final,
                title: (await store.read(w.id, w.userId, id)).title,
                messages: history.messages.map(message => message.author),
                status: history.messages.find(message => message.turn?.id === work.turnId)?.turn.status,
              });
              if (attempt === 1) throw new Error('model-unavailable');
              return (await titles.request(work)) ? titles.save(work, 'Reversed greeting') : 'skipped';
            },
          },
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
      // The reply was saved and completed before the title step ran, which retried once and then saved.
      assert.deepEqual(titleRuns, [
        { attempt: 1, final: false, title: privateText, messages: ['human', 'assistant'], status: 'completed' },
        { attempt: 2, final: false, title: privateText, messages: ['human', 'assistant'], status: 'completed' },
      ]);
      assert.equal((await store.read(w.id, w.userId, id)).title, 'Reversed greeting');
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
      assert.equal(titleRuns.length, 2, 'later replies never generate a title');
      assert.equal((await store.read(w.id, w.userId, id)).title, 'Reversed greeting');
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
      assert.equal(handles.length, 2);
      const activityResults = [];
      for (const [index, { handle, work }] of handles.entries()) {
        const history = await handle.fetchHistory();
        const scheduled = [];
        for (const event of history.events) {
          const decode = payloads => payloads.map(payload => JSON.parse(Buffer.from(payload.data).toString()));
          if (event.workflowExecutionStartedEventAttributes?.input)
            assert.deepEqual(decode(event.workflowExecutionStartedEventAttributes.input.payloads), [work]);
          const activity = event.activityTaskScheduledEventAttributes;
          if (activity) {
            scheduled.push(activity.activityType.name);
            const [input] = decode(activity.input.payloads);
            if (activity.activityType.name === 'deliverConversationReply') assert.deepEqual(input, work);
            else {
              const { attempt, final, ...title } = input;
              assert.deepEqual(title, { ...work, titleRevision: 1 });
              assert.ok(attempt <= 2 && !final, 'the title succeeded before its last scheduled attempt');
            }
          }
          for (const payload of event.activityTaskCompletedEventAttributes?.result?.payloads ?? [])
            activityResults.push(JSON.parse(Buffer.from(payload.data).toString()));
          for (const payload of event.workflowExecutionCompletedEventAttributes?.result?.payloads ?? [])
            assert.equal(JSON.parse(Buffer.from(payload.data).toString()), 'completed');
        }
        assert.deepEqual(
          scheduled,
          index === 0
            ? ['deliverConversationReply', 'generateConversationTitle', 'generateConversationTitle']
            : ['deliverConversationReply'],
        );
      }
      assert.deepEqual(activityResults, [
        { outcome: 'completed', title: { titleRevision: 1 } },
        'generated',
        { outcome: 'completed' },
      ]);
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
