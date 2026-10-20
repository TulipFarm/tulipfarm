import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createConversationExecutor } from '../../src/runtime.ts';
import { createReplyTextPublisher } from '../../src/event-publisher.ts';
import { applyStreamText, conversationEventChannel, conversationNotificationSchema } from '../../src/events.ts';
import { conversationFixture } from '../fixture.mjs';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';

const { Client } = createRequire(new URL('../../../workspace-storage/package.json', import.meta.url))('pg');

test(
  'conversation writes and streamed reply text reach a PostgreSQL listener as the workspace runtime role',
  { timeout: 60000 },
  async () => {
    const f = await conversationFixture();
    const listener = new Client({ connectionString: f.db.connectionString });
    try {
      const w = f.workspace,
        chatId = randomUUID();
      const received = [];
      await listener.connect();
      listener.on('notification', message => {
        if (message.channel === conversationEventChannel)
          received.push(conversationNotificationSchema.parse(JSON.parse(message.payload)));
      });
      await listener.query(`LISTEN ${conversationEventChannel}`);

      await f.store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
      const sent = await f.store.send(w.id, w.userId, chatId, {
        commandId: randomUUID(),
        messageId: randomUUID(),
        parts: [{ kind: 'text', text: 'Say hello' }],
      });
      let fence, role;
      const executor = createConversationExecutor(f.runtime, async input => {
        fence = input.fence;
        role = (
          await f.runtime.transaction(w.id, commonCompatibility, tx => tx.client.query('SELECT current_user AS role'))
        ).rows[0].role;
        await input.executeTool('records.lookup', false, async () => ({ result: 'found', sources: [] }), [], {
          tool: 'records.lookup',
        });
        await input.executeTool('records.lookup', false, async () => ({ result: 'next', sources: [] }), [], {
          tool: 'records.lookup',
        });
        const publisher = createReplyTextPublisher(f.runtime, input.fence, 20);
        publisher.update(0, 'Hel');
        await delay(60);
        publisher.update(0, 'Hello 🌷');
        await publisher.close();
        return 'Hello 🌷';
      });
      assert.equal(
        await executor.process({ workspaceId: w.id, conversationId: chatId, turnId: sent.turnId, generation: 0 }),
        'completed',
      );
      for (let wait = 0; wait < 100 && !received.some(item => item.kind === 'changed' && item.settled); wait++)
        await delay(20);

      assert.equal(role, w.names.runtime, 'streamed text publishes through the workspace runtime login');
      const address = { workspaceId: w.id, conversationId: chatId };
      const turn = { ...address, turnId: sent.turnId };
      assert.deepEqual(
        received.filter(item => item.kind === 'changed'),
        [
          { kind: 'changed', ...address },
          { kind: 'changed', ...turn },
          { kind: 'changed', ...turn, settled: false },
          { kind: 'changed', ...turn, settled: false },
          { kind: 'changed', ...turn, settled: false },
          { kind: 'changed', ...turn, settled: false },
          { kind: 'changed', ...turn, settled: false },
          { kind: 'changed', ...turn, settled: true },
        ],
        'create, send, claim, two quick running/completed receipt pairs, completion',
      );
      const texts = received.filter(item => item.kind === 'text');
      const tools = received.filter(item => item.kind === 'tool');
      assert.deepEqual(
        tools.map(item => [item.tool, item.sequence, item.status]),
        [
          ['records.lookup', 1, 'running'],
          ['records.lookup', 1, 'completed'],
          ['records.lookup', 2, 'running'],
          ['records.lookup', 2, 'completed'],
        ],
      );
      assert.equal(tools[0].id, tools[1].id);
      assert.equal(tools[0].epoch, fence.epoch);
      assert.ok(
        received.indexOf(tools[0]) < received.indexOf(tools[1]),
        'quick real execution retains both committed lifecycle events',
      );
      assert.ok(texts.length >= 2, 'both text updates were published');
      let streamed;
      for (const { kind: _kind, workspaceId, conversationId, ...update } of texts) {
        assert.deepEqual({ workspaceId, conversationId }, address);
        streamed = applyStreamText(streamed, update);
      }
      assert.deepEqual(streamed, {
        identity: { turnId: sent.turnId, generation: 0, epoch: fence.epoch, step: 0 },
        seq: texts.length - 1,
        text: 'Hello 🌷',
        complete: true,
      });
      assert.ok(
        received.indexOf(texts.at(-1)) < received.findIndex(item => item.kind === 'changed' && item.settled),
        'the final streamed text arrives before the saved reply',
      );
    } finally {
      await listener.end();
      await f.close();
    }
  },
);
