import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createConversationExecutor } from '@tulipfarm/conversations/runtime';
import { conversationFixture } from '../../../packages/conversations/test/fixture.mjs';
import { meteredReply } from '../src/conversation-activities.ts';
import { anthropicChat } from './native-chat-fixture.mjs';
import { useModelCatalog } from './model-catalog-fixture.mjs';

for (const mode of ['expired', 'takeover', 'cancelled', 'generation', 'failure'])
  test(`model admission fences ${mode} and preserves spent credits`, async t => {
    const f = await conversationFixture();
    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'synthetic';
    t.after(() => {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous;
    });
    t.after(useModelCatalog());
    try {
      const w = f.workspace,
        chatId = randomUUID();
      await f.store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
      const sent = await f.store.send(w.id, w.userId, chatId, {
        messageId: randomUUID(),
        commandId: randomUUID(),
        model: 'claude-sonnet',
        parts: [{ kind: 'text', text: 'Create an event titled "QA."' }],
      });
      const work = { workspaceId: w.id, conversationId: chatId, turnId: sent.turnId, generation: 0 };
      const recovery = createConversationExecutor(f.runtime, async () => 'Recovered by the current owner.');
      let replacement;
      let requests = 0;
      t.mock.method(globalThis, 'fetch', async () => {
        assert.equal(++requests, 1, 'old attempt must not dispatch the independent check');
        if (mode === 'expired' || mode === 'takeover') {
          await f.db.platform.query(
            `UPDATE ${f.table('tf_conversation_turns')} SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1`,
            [sent.turnId],
          );
          if (mode === 'takeover') replacement = await recovery.claim(work);
        } else if (mode === 'cancelled') {
          await f.store.cancel(w.id, w.userId, chatId, sent.turnId, { commandId: randomUUID(), expectedGeneration: 0 });
        } else if (mode === 'generation') {
          await f.db.platform.query(
            `UPDATE ${f.table('tf_conversation_turns')} SET generation=generation+1 WHERE id=$1`,
            [sent.turnId],
          );
        }
        const usage = {
          input_tokens: 100,
          output_tokens: 20,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        };
        if (mode === 'failure') return Response.json({ error: { type: 'overloaded_error' }, usage }, { status: 529 });
        return Response.json(
          anthropicChat(
            {
              kind: 'tool',
              text: 'Preparing your calendar event',
              call: {
                tool: 'google.propose',
                operation: {
                  kind: 'calendar.events.create',
                  calendarId: 'primary',
                  event: { summary: 'QA.', start: { date: '2026-10-05' }, end: { date: '2026-10-06' } },
                },
              },
            },
            { usage },
          ),
        );
      });
      const reply = meteredReply(f.runtime, { mcp: null });
      const executor = createConversationExecutor(f.runtime, input =>
        reply({ ...input, executeTool: async () => assert.fail('No tool may execute') }),
      );
      assert.equal(await executor.process(work), mode === 'failure' ? 'retry' : 'stale');
      const credits = (
        await f.db.platform.query(`SELECT provider_pico_usd FROM ${f.table('tf_credit_usage')} WHERE flow_id=$1`, [
          chatId,
        ])
      ).rows;
      assert.deepEqual(credits, [{ provider_pico_usd: '400000000' }]);
      assert.equal(requests, 1);
      if (mode === 'expired') {
        const row = (
          await f.db.platform.query(
            `SELECT lease_until<clock_timestamp() AS expired FROM ${f.table('tf_conversation_turns')} WHERE id=$1`,
            [sent.turnId],
          )
        ).rows[0];
        assert.equal(row.expired, true);
        assert.equal(await recovery.process(work), 'completed');
      } else if (mode === 'takeover') {
        assert.equal(replacement.epoch, 2);
        assert.equal(await recovery.complete(replacement), 'completed');
      } else if (mode === 'failure') {
        await f.db.platform.query(
          `UPDATE ${f.table('tf_conversation_turns')} SET retry_at=clock_timestamp()-interval '1 second' WHERE id=$1`,
          [sent.turnId],
        );
        assert.equal(await recovery.process({ ...work, generation: 1 }), 'completed');
      } else {
        assert.equal((await f.store.history(w.id, w.userId, chatId)).messages.length, 1);
        return;
      }
      assert.equal(
        (await f.store.history(w.id, w.userId, chatId)).messages.at(-1).parts[0].text,
        'Recovered by the current owner.',
      );
    } finally {
      await f.close();
    }
  });
