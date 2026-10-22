import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { conversationFixture } from '../../../packages/conversations/test/fixture.mjs';
import { createConversationActivities } from '../dist/conversation-activities.js';
import { creditSummary } from '@tulipfarm/workspace-storage/credits';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import {
  completionReply,
  isCompletionRequest,
  anthropicChat,
  anthropicText,
  isTitleRequest,
} from './native-chat-fixture.mjs';
import { registerExtension } from '@tulipfarm/extensions';
import { creditAccountExtension } from '@tulipfarm/workspace-storage/credit-account';
import { useModelFamilies } from './model-families-fixture.mjs';

// These tests assert workspace balances, so they fund work from the credit account as a billing extension would.
await registerExtension(creditAccountExtension, { app: 'worker', env: {} });

test('invalid ordinary model credentials never reserve credits across all retries', { timeout: 60000 }, async t => {
  const f = await conversationFixture();
  const old = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'invalid credential with spaces';
  t.after(useModelFamilies());
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    throw new Error('Unexpected fetch');
  });
  try {
    const w = f.workspace;
    const chatId = randomUUID();
    await f.store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
    const turn = await f.store.send(w.id, w.userId, chatId, {
      commandId: randomUUID(),
      messageId: randomUUID(),
      model: 'claude-sonnet',
      parts: [{ kind: 'text', text: 'Hello' }],
    });
    const activity = createConversationActivities(f.runtime).processConversationReply;
    for (let generation = 0; generation < 5; generation++) {
      assert.equal(
        await activity({ workspaceId: w.id, conversationId: chatId, turnId: turn.turnId, generation }),
        generation === 4 ? 'failed' : 'retry',
      );
      await f.db.platform.query(
        `UPDATE ${f.table('tf_conversation_turns')} SET retry_at=clock_timestamp() WHERE id=$1`,
        [turn.turnId],
      );
    }
    assert.equal(calls, 0);
    const summary = await f.runtime.transaction(w.id, commonCompatibility, creditSummary);
    assert.equal(summary.available, 1000);
    assert.equal(summary.held, 0);
    assert.equal(summary.used, 0);
    assert.deepEqual(summary.breakdown, []);
  } finally {
    if (old === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = old;
    await f.close();
  }
});

test(
  'ordinary model activity accounts real HTTP usage, replay, unknown responses, and exhaustion without provider calls',
  { timeout: 60000 },
  async t => {
    const f = await conversationFixture();
    let calls = 0;
    let titles = 0;
    let unknown = false;
    let toolNext = false;
    const server = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      const request = JSON.parse(body);
      assert.equal(request.model, 'claude-sonnet-5');
      res.writeHead(200, { 'content-type': 'application/json' });
      if (isTitleRequest(request)) {
        titles++;
        res.end(JSON.stringify(anthropicText('Hello')));
        return;
      }
      calls++;
      if (isCompletionRequest(request)) {
        const { usage, ...response } = completionReply('anthropic');
        res.end(JSON.stringify(unknown ? response : { ...response, usage }));
        return;
      }
      const decision = toolNext
        ? { kind: 'tool', call: { tool: 'tables.definitions' } }
        : { kind: 'answer', text: 'A metered answer.' };
      toolNext = false;
      const { usage, ...response } = anthropicChat(decision);
      res.end(JSON.stringify(unknown ? response : { ...response, usage }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const fetch = globalThis.fetch;
    t.mock.method(globalThis, 'fetch', (url, options) => {
      assert.equal(new URL(url).hostname, 'api.anthropic.com');
      return fetch(`http://127.0.0.1:${server.address().port}/`, options);
    });
    const old = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'synthetic-only';
    t.after(useModelFamilies());
    try {
      const w = f.workspace;
      const chatId = randomUUID();
      await f.store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
      const send = async () => {
        const turn = await f.store.send(w.id, w.userId, chatId, {
          commandId: randomUUID(),
          messageId: randomUUID(),
          model: 'claude-sonnet',
          parts: [{ kind: 'text', text: 'Hello' }],
        });
        return { workspaceId: w.id, conversationId: chatId, turnId: turn.turnId, generation: 0 };
      };
      const summary = () => f.runtime.transaction(w.id, commonCompatibility, creditSummary);
      const activity = createConversationActivities(f.runtime).processConversationReply;
      const work = await send();
      assert.equal(await activity(work), 'completed');
      assert.equal(await activity(work), 'idle');
      assert.equal(calls, 2);
      assert.equal(titles, 1);
      assert.equal((await summary()).used, 1);
      assert.equal((await summary()).available, 999);
      assert.equal((await summary()).held, 0);
      assert.equal((await f.store.history(w.id, w.userId, chatId)).messages.at(-1).parts[0].text, 'A metered answer.');
      assert.deepEqual(
        (
          await f.db.platform.query(
            `SELECT sources, publication FROM ${f.table('tf_conversation_results')} WHERE turn_id=$1`,
            [work.turnId],
          )
        ).rows,
        [{ sources: [{ kind: 'private-conversation', conversationId: chatId }], publication: 'private' }],
      );
      unknown = true;
      toolNext = true;
      const toolWork = await send();
      assert.equal(await activity(toolWork), 'completed');
      assert.deepEqual(
        (
          await f.db.platform.query(`SELECT sources FROM ${f.table('tf_conversation_results')} WHERE turn_id=$1`, [
            toolWork.turnId,
          ])
        ).rows,
        [{ sources: [{ kind: 'private-conversation', conversationId: chatId }] }],
      );
      assert.equal(
        (await f.store.history(w.id, w.userId, chatId)).messages.find(m => m.turn?.id === toolWork.turnId).tools[0]
          .status,
        'completed',
      );
      assert.ok((await summary()).held > 0);
      assert.equal((await summary()).used, 1);
      const blocked = await send();
      await f.db.platform.query(`UPDATE ${f.table('tf_credit_account')} SET available=1`);
      assert.equal(await activity(blocked), 'failed');
      assert.equal(calls, 5);
      assert.equal(titles, 1);
      assert.equal((await f.store.history(w.id, w.userId, chatId)).messages.at(-1).turn.errorCode, 'credits-exhausted');
    } finally {
      if (old === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = old;
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await f.close();
    }
  },
);
