import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createConversationExecutor } from '@tulipfarm/conversations/runtime';
import { createConversationActivities, meteredReply } from '../src/conversation-activities.ts';
import { createFiles } from '../../../packages/files/src/index.ts';
import { conversationFixture } from '../../../packages/conversations/test/fixture.mjs';
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

// These tests exhaust workspace balances, so they fund work from the credit account as a billing extension would.
await registerExtension(creditAccountExtension, { app: 'worker', env: {} });

test('default worker composition offers tools, executes a model choice, and publishes its answer and receipt', async t => {
  const f = await conversationFixture();
  const previous = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'synthetic-test-key';
  t.after(() => {
    if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previous;
  });
  t.after(useModelCatalog());
  try {
    const requests = [];
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      assert.equal(url, 'https://api.anthropic.com/v1/messages');
      const body = JSON.parse(options.body);
      if (isTitleRequest(body)) return Response.json(anthropicText('Resource authoring procedure'));
      requests.push(body);
      if (isCompletionRequest(body)) return Response.json(completionReply('anthropic'));
      const decision =
        requests.length === 1
          ? { kind: 'tool', call: { tool: 'skills.read', skillId: 'table-authoring' } }
          : { kind: 'answer', text: 'A saved schema is not active until its migration is applied.' };
      return Response.json(anthropicChat(decision));
    });
    const w = f.workspace,
      chatId = randomUUID();
    await f.store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
    const sent = await f.store.send(w.id, w.userId, chatId, {
      messageId: randomUUID(),
      commandId: randomUUID(),
      model: 'claude-sonnet',
      parts: [{ kind: 'text', text: 'Read the resource authoring procedure.' }],
    });
    assert.equal(
      await createConversationActivities(f.runtime).processConversationReply({
        workspaceId: w.id,
        conversationId: chatId,
        turnId: sent.turnId,
        generation: 0,
      }),
      'completed',
    );
    const history = await f.store.history(w.id, w.userId, chatId);
    assert.deepEqual(
      history.messages[0].tools.map(({ tool, status }) => ({ tool, status })),
      [{ tool: 'skills.read', status: 'completed' }],
    );
    assert.equal(history.messages[1].parts[0].text, 'A saved schema is not active until its migration is applied.');
    assert.match(
      JSON.stringify(requests[1].messages),
      /\\"revision\\":\\"latest\\",\\"name\\":\\"Propose business records for review\\"/,
    );
    assert.match(JSON.stringify(requests[1].messages), /New UUIDs for the table and each field/);
    assert.equal(requests.length, 3);
    const usage = (
      await f.db.platform.query(`SELECT id, charged, provider_pico_usd FROM ${f.table('tf_credit_usage')} ORDER BY id`)
    ).rows;
    assert.equal(usage.length, 4);
    assert.deepEqual(
      usage.map(row => row.provider_pico_usd),
      ['400000000', '400000000', '400000000', '200000000'],
    );
    // Default pricing: 100 credit units per pico-USD on each call, no flow rounding.
    assert.deepEqual(
      usage.map(row => row.charged),
      ['40000000000', '40000000000', '40000000000', '20000000000'],
    );
  } finally {
    await f.close();
  }
});

test('tool-loop continuation cannot dispatch another provider request after credit exhaustion', async t => {
  const f = await conversationFixture();
  const previous = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'synthetic-test-key';
  let calls = 0;
  t.after(() => {
    if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previous;
  });
  t.after(useModelCatalog());
  try {
    t.mock.method(globalThis, 'fetch', async () => {
      calls++;
      await f.db.platform.query(`UPDATE ${f.table('tf_credit_account')} SET available=0`);
      return Response.json(anthropicChat({ kind: 'tool', call: { tool: 'skills.list' } }));
    });
    const w = f.workspace,
      chatId = randomUUID();
    await f.store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
    const sent = await f.store.send(w.id, w.userId, chatId, {
      messageId: randomUUID(),
      commandId: randomUUID(),
      model: 'claude-sonnet',
      parts: [{ kind: 'text', text: 'Read the skills.' }],
    });
    assert.equal(
      await createConversationActivities(f.runtime).processConversationReply({
        workspaceId: w.id,
        conversationId: chatId,
        turnId: sent.turnId,
        generation: 0,
      }),
      'failed',
    );
    assert.equal(calls, 1);
    const history = await f.store.history(w.id, w.userId, chatId);
    assert.equal(history.messages[0].turn.errorCode, 'credits-exhausted');
    assert.deepEqual(
      history.messages[0].tools.map(({ tool, status }) => ({ tool, status })),
      [{ tool: 'skills.list', status: 'completed' }],
    );
  } finally {
    await f.close();
  }
});

test('a guarded external turn linked to a person saves files.create output to that person instead of refusing it as autonomous', async t => {
  const f = await conversationFixture();
  const previous = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'synthetic-test-key';
  t.after(() => {
    if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previous;
  });
  t.after(useModelCatalog());
  try {
    const objects = new Map();
    const files = createFiles(f.runtime, {
      putIfAbsent: async (key, body) => {
        objects.set(key, Buffer.from(body));
      },
      read: async key => objects.get(key),
      remove: async key => {
        objects.delete(key);
      },
    });
    let requests = 0;
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      if (isCompletionRequest(JSON.parse(options.body))) return Response.json(completionReply('anthropic'));
      if (isTitleRequest(JSON.parse(options.body))) return Response.json(anthropicText('Notes'));
      const decision =
        ++requests === 1
          ? { kind: 'tool', call: { tool: 'files.create', name: 'Notes', format: 'md', content: '# Notes\n' } }
          : { kind: 'answer', text: 'Saved.' };
      return Response.json(anthropicChat(decision));
    });
    const w = f.workspace,
      chatId = randomUUID();
    await f.store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
    const sent = await f.store.send(w.id, w.userId, chatId, {
      messageId: randomUUID(),
      commandId: randomUUID(),
      model: 'claude-sonnet',
      parts: [{ kind: 'text', text: 'Save my notes as a file.' }],
    });
    const reply = meteredReply(f.runtime, { externalContext: async () => {}, mcp: null, outputs: files });
    assert.equal(
      await createConversationExecutor(f.runtime, reply, undefined, undefined, undefined, files).process({
        workspaceId: w.id,
        conversationId: chatId,
        turnId: sent.turnId,
        generation: 0,
      }),
      'completed',
    );
    const saved = (
      await f.db.platform.query(
        `SELECT name, parent_id, creator_membership_id FROM ${f.table('tf_files')} WHERE kind='file'`,
      )
    ).rows;
    assert.deepEqual(saved, [{ name: 'Notes.md', parent_id: null, creator_membership_id: w.membershipId }]);
  } finally {
    await f.close();
  }
});

test('a sender removed after the turn started fails it visibly before any model request, instead of answering without their tools', async t => {
  const f = await conversationFixture();
  const previous = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'synthetic-test-key';
  t.after(() => {
    if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previous;
  });
  t.after(useModelCatalog());
  try {
    const objects = new Map();
    const files = createFiles(f.runtime, {
      putIfAbsent: async (key, body) => {
        objects.set(key, Buffer.from(body));
      },
      read: async key => objects.get(key),
      remove: async key => {
        objects.delete(key);
      },
    });
    let requests = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      requests++;
      return Response.json({});
    });
    const w = f.workspace,
      chatId = randomUUID();
    await f.store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
    const sent = await f.store.send(w.id, w.userId, chatId, {
      messageId: randomUUID(),
      commandId: randomUUID(),
      model: 'claude-sonnet',
      parts: [{ kind: 'text', text: 'Save my notes as a file.' }],
    });
    let removed = false;
    // The reply's first transaction resolves the requester; removing the member just before it stands in for a removal mid-turn.
    const racing = {
      ...f.runtime,
      transaction: async (...args) => {
        if (!removed) {
          removed = true;
          await f.db.platform.query(
            `UPDATE ${f.table('tf_memberships')} SET removed_at=clock_timestamp() WHERE id=$1`,
            [w.membershipId],
          );
        }
        return f.runtime.transaction(...args);
      },
    };
    const reply = meteredReply(racing, { externalContext: async () => {}, mcp: null, outputs: files });
    const outcome = await createConversationExecutor(f.runtime, reply, undefined, undefined, undefined, files)
      .process({ workspaceId: w.id, conversationId: chatId, turnId: sent.turnId, generation: 0 })
      .catch(error => error.name);
    assert.equal(removed, true);
    assert.equal(requests, 0, 'no model request is made without the requester');
    const turn = (
      await f.db.platform.query(`SELECT status, error_code FROM ${f.table('tf_conversation_turns')} WHERE id=$1`, [
        sent.turnId,
      ])
    ).rows[0];
    assert.deepEqual(
      { outcome, turn },
      { outcome: 'stale', turn: { status: 'blocked', error_code: 'membership-removed' } },
      'the chat shows the turn blocked because the sender was removed',
    );
    assert.equal(
      (await f.db.platform.query(`SELECT count(*)::int AS n FROM ${f.table('tf_files')}`)).rows[0].n,
      0,
      'nothing is saved as autonomous output',
    );
  } finally {
    await f.close();
  }
});
