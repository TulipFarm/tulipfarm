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
import { useModelCatalog } from './model-catalog-fixture.mjs';

// These tests assert workspace balances, so they fund work from the credit account as a billing extension would.
await registerExtension(creditAccountExtension, { app: 'worker', env: {} });

test('invalid ordinary model credentials never reserve credits across all retries', { timeout: 60000 }, async t => {
  const f = await conversationFixture();
  const old = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'invalid credential with spaces';
  t.after(useModelCatalog());
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
      res.writeHead(200, { 'content-type': 'application/json' });
      if (isTitleRequest(request)) {
        assert.equal(request.model, 'claude-haiku-4-5');
        titles++;
        res.end(JSON.stringify(anthropicText('Hello')));
        return;
      }
      assert.equal(request.model, 'claude-sonnet-5');
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
    t.after(useModelCatalog());
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
      const activities = createConversationActivities(f.runtime);
      const activity = activities.processConversationReply;
      const work = await send();
      const delivered = await activities.deliverConversationReply(work);
      assert.deepEqual(delivered, { outcome: 'completed', title: { titleRevision: 1 } });
      assert.equal(titles, 0, 'the reply is delivered without a title request');
      const replied = await summary();
      assert.deepEqual(
        replied.breakdown.map(entry => [entry.modelId, entry.activity, entry.calls]),
        [['claude-sonnet-5', 'chat', 2]],
      );
      assert.equal(await activity(work), 'idle');
      assert.equal(
        await activities.generateConversationTitle({ ...work, ...delivered.title, attempt: 1, final: true }),
        'generated',
      );
      assert.equal(calls, 2);
      assert.equal(titles, 1);
      assert.equal((await f.store.read(w.id, w.userId, chatId)).titleRevision, 2);
      const titled = await summary();
      assert.deepEqual(
        titled.breakdown.map(entry => [entry.modelId, entry.activity, entry.calls]).sort(),
        [
          ['claude-haiku-4-5', 'chat', 1],
          ['claude-sonnet-5', 'chat', 2],
        ],
        'the title is billed as its own chat call',
      );
      assert.ok(titled.used > replied.used);
      assert.equal(titled.available, titled.granted - titled.used);
      assert.equal(titled.held, 0);
      assert.equal((await f.store.history(w.id, w.userId, chatId)).messages.at(-1).parts[0].text, 'A metered answer.');
      // The fixture's default members table reaches the reply through the inventory and table tools.
      const ownSources = rows =>
        rows.map(({ sources, ...row }) => ({
          ...row,
          sources: sources.filter(source => !source.kind.startsWith('table-')),
        }));
      assert.deepEqual(
        ownSources(
          (
            await f.db.platform.query(
              `SELECT sources, publication FROM ${f.table('tf_conversation_results')} WHERE turn_id=$1`,
              [work.turnId],
            )
          ).rows,
        ),
        [{ sources: [{ kind: 'private-conversation', conversationId: chatId }], publication: 'private' }],
      );
      unknown = true;
      toolNext = true;
      const toolWork = await send();
      assert.equal(await activity(toolWork), 'completed');
      assert.deepEqual(
        ownSources(
          (
            await f.db.platform.query(`SELECT sources FROM ${f.table('tf_conversation_results')} WHERE turn_id=$1`, [
              toolWork.turnId,
            ])
          ).rows,
        ),
        [{ sources: [{ kind: 'private-conversation', conversationId: chatId }] }],
      );
      assert.equal(
        (await f.store.history(w.id, w.userId, chatId)).messages.find(m => m.turn?.id === toolWork.turnId).tools[0]
          .status,
        'completed',
      );
      // Unknown usage is charged at each call's whole reservation when the reply settles, so nothing stays held.
      const afterUnknown = await summary();
      assert.equal(afterUnknown.held, 0);
      assert.ok(afterUnknown.used > titled.used);
      assert.equal(afterUnknown.available + afterUnknown.used, 1000);
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

test(
  'a first title runs after delivery in its own billing, and its failures keep the reply and placeholder',
  { timeout: 60000 },
  async t => {
    const f = await conversationFixture();
    let titleMode = 'ok';
    let titles = 0;
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      assert.equal(new URL(url).hostname, 'api.anthropic.com');
      const request = JSON.parse(options.body);
      if (isTitleRequest(request)) {
        titles++;
        if (titleMode === 'unavailable') return new Response('{}', { status: 503 });
        if (titleMode === 'timeout') throw new DOMException('The operation timed out.', 'TimeoutError');
        return Response.json(anthropicText('Quarterly plan review'));
      }
      if (isCompletionRequest(request)) return Response.json(completionReply('anthropic'));
      return Response.json(anthropicChat({ kind: 'answer', text: 'Here is the plan.' }));
    });
    const old = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'synthetic-only';
    t.after(useModelCatalog());
    try {
      const w = f.workspace;
      const activities = createConversationActivities(f.runtime);
      const summary = () => f.runtime.transaction(w.id, commonCompatibility, creditSummary);
      const first = async () => {
        const chatId = randomUUID();
        await f.store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
        const turn = await f.store.send(w.id, w.userId, chatId, {
          commandId: randomUUID(),
          messageId: randomUUID(),
          model: 'claude-sonnet',
          parts: [{ kind: 'text', text: 'Review my quarterly plan' }],
        });
        const work = { workspaceId: w.id, conversationId: chatId, turnId: turn.turnId, generation: 0 };
        const delivered = await activities.deliverConversationReply(work);
        assert.deepEqual(delivered, { outcome: 'completed', title: { titleRevision: 1 } });
        const history = await f.store.history(w.id, w.userId, chatId);
        assert.equal(history.messages.at(-1).parts[0].text, 'Here is the plan.');
        assert.equal(history.messages.find(message => message.turn?.id === turn.turnId).turn.status, 'completed');
        return {
          chatId,
          title: (attempt, final) =>
            activities.generateConversationTitle({ ...work, ...delivered.title, attempt, final }),
        };
      };
      const placeholder = async chatId => {
        const chat = await f.store.read(w.id, w.userId, chatId);
        assert.equal(chat.title, 'Review my quarterly plan');
        assert.equal(chat.titleRevision, 1);
      };

      const before = await summary();
      const generated = await first();
      const replied = await summary();
      assert.equal(titles, 0);
      assert.equal(await generated.title(1, false), 'generated');
      assert.equal(titles, 1);
      assert.equal((await f.store.read(w.id, w.userId, generated.chatId)).title, 'Quarterly plan review');
      const titled = await summary();
      assert.equal(titled.held, 0, 'the title settles its own reservation');
      assert.ok(titled.breakdown.length >= replied.breakdown.length && replied.used >= before.used);
      assert.equal(await generated.title(2, true), 'skipped', 'a retried title never writes twice');

      titleMode = 'unavailable';
      const unavailable = await first();
      assert.equal(await unavailable.title(1, false), 'retry');
      assert.equal(await unavailable.title(2, true), 'failed');
      await placeholder(unavailable.chatId);

      titleMode = 'timeout';
      const slow = await first();
      assert.equal(await slow.title(1, false), 'retry');
      assert.equal(await slow.title(2, true), 'timeout');
      await placeholder(slow.chatId);

      titleMode = 'ok';
      const exhausted = await first();
      const calls = titles;
      await f.db.platform.query(`UPDATE ${f.table('tf_credit_account')} SET available=0`);
      assert.equal(await exhausted.title(1, false), 'failed', 'insufficient credits is final');
      assert.equal(titles, calls, 'no provider call without credits');
      await placeholder(exhausted.chatId);
      assert.equal((await f.store.history(w.id, w.userId, exhausted.chatId)).messages.at(-1).author, 'assistant');
    } finally {
      if (old === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = old;
      await f.close();
    }
  },
);
