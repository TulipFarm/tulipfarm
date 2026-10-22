import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createFiles } from '@tulipfarm/files';
import { createLocalKnowledge, withKnowledgeSourceAuthorization } from '@tulipfarm/knowledge';
import { createConversationActivities } from '../src/conversation-activities.ts';
import { createKnowledgeTools } from '../src/knowledge-tools-composition.ts';
import { conversationFixture } from '../../../packages/conversations/test/fixture.mjs';
import { createConversations, knowledgeUnavailableReply } from '../../../packages/conversations/src/index.ts';
import {
  completionReply,
  isCompletionRequest,
  anthropicChat,
  anthropicText,
  isTitleRequest,
} from './native-chat-fixture.mjs';
import { useModelFamilies } from './model-families-fixture.mjs';

const respond = decision => Response.json(anthropicChat(decision));

async function knowledgeFixture(t) {
  const f = await conversationFixture();
  const previous = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'synthetic-test-key';
  t.after(() => {
    if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previous;
  });
  t.after(useModelFamilies());
  const bytes = new Map();
  const local = createLocalKnowledge({
    runtime: f.runtime,
    files: createFiles(f.runtime, {
      putIfAbsent: async (key, value) => {
        bytes.set(key, value);
      },
      read: async key => bytes.get(key),
    }),
  });
  const w = f.workspace;
  // The API composes conversations with the same knowledge authorization wrapper.
  f.store = createConversations(withKnowledgeSourceAuthorization(f.runtime));
  async function note(text, title, documentId = randomUUID(), expectedRevisionId = null) {
    const saved = await local.save(w.id, w.userId, {
      commandId: randomUUID(),
      documentId,
      expectedRevisionId,
      title,
      input: { kind: 'note', text },
    });
    for (const work of await local.due(w.id)) await local.process(work);
    return saved;
  }
  const knowledge = createKnowledgeTools({ runtime: f.runtime, env: {} });
  async function turn(chatId, text) {
    const sent = await f.store.send(w.id, w.userId, chatId, {
      messageId: randomUUID(),
      commandId: randomUUID(),
      model: 'claude-sonnet',
      parts: [{ kind: 'text', text }],
    });
    return {
      sent,
      process: () =>
        createConversationActivities(
          f.runtime,
          undefined,
          undefined,
          undefined,
          undefined,
          knowledge,
        ).processConversationReply({ workspaceId: w.id, conversationId: chatId, turnId: sent.turnId, generation: 0 }),
    };
  }
  return { f, w, local, note, turn };
}

test('worker composition answers from a knowledge tool call with citations and replaces the answer after revocation', async t => {
  const { f, w, local, note, turn } = await knowledgeFixture(t);
  try {
    const policy = await note('Suppliers are paid within 30 days of delivery.', 'Supplier policy');
    const requests = [];
    let citation;
    t.mock.method(globalThis, 'fetch', reply);
    async function reply(url, options) {
      assert.equal(url, 'https://api.anthropic.com/v1/messages');
      const body = JSON.parse(options.body);
      if (isTitleRequest(body)) return Response.json(anthropicText('Supplier payments'));
      if (isCompletionRequest(body)) return Response.json(completionReply('anthropic'));
      requests.push(body);
      const index = requests.length;
      if (index === 1) {
        assert.ok(body.tools.some(tool => tool.name === 'knowledge_search'));
        return respond({ kind: 'tool', call: { tool: 'knowledge.search', query: 'suppliers paid' } });
      }
      if (index === 2) {
        citation = JSON.stringify(body.messages).match(
          /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:\d+/,
        )?.[0];
        assert.ok(citation, 'the model received a citation id');
        return respond({ kind: 'tool', call: { tool: 'knowledge.read', citationId: citation } });
      }
      if (index === 3) {
        assert.match(JSON.stringify(body.messages), /within 30 days of delivery/);
        return respond({
          kind: 'answer',
          text: `Suppliers are paid within 30 days [Supplier policy](#knowledge-citation=${citation}).`,
        });
      }
      if (index === 4) {
        assert.doesNotMatch(
          JSON.stringify(body.messages),
          /paid within 30 days \[Supplier policy\]/,
          'a revoked answer leaves later model context',
        );
        return respond({ kind: 'answer', text: 'I no longer have that policy.' });
      }
      return respond({ kind: 'answer', text: 'No knowledge evidence was found.' });
    }
    const chatId = randomUUID();
    await f.store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
    const first = await turn(chatId, 'When do we pay suppliers?');
    assert.equal(await first.process(), 'completed');
    let history = await f.store.history(w.id, w.userId, chatId);
    assert.deepEqual(
      history.messages[0].tools.map(({ tool, status }) => ({ tool, status })),
      [
        { tool: 'knowledge.search', status: 'completed' },
        { tool: 'knowledge.read', status: 'completed' },
      ],
    );
    assert.equal(
      history.messages[1].parts[0].text,
      `Suppliers are paid within 30 days [Supplier policy](#knowledge-citation=${citation}).`,
    );
    const result = (
      await f.db.platform.query(`SELECT sources FROM ${f.table('tf_conversation_results')} WHERE message_id=$1`, [
        history.messages[1].id,
      ])
    ).rows[0].sources;
    assert.ok(
      result.some(
        source =>
          source.kind === 'knowledge-document' &&
          source.documentId === policy.documentId &&
          source.revisionId === policy.revisionId,
      ),
    );

    await local.remove(w.id, w.userId, {
      commandId: randomUUID(),
      documentId: policy.documentId,
      expectedRevisionId: policy.revisionId,
    });
    history = await f.store.history(w.id, w.userId, chatId);
    assert.equal(history.messages[1].parts[0].text, knowledgeUnavailableReply);

    const second = await turn(chatId, 'Remind me of the policy.');
    assert.equal(await second.process(), 'completed', 'a revoked earlier answer does not block the chat');
    history = await f.store.history(w.id, w.userId, chatId);
    assert.equal(history.messages[3].parts[0].text, 'I no longer have that policy.');
    assert.equal(requests.length, 4);
  } finally {
    await f.close();
  }
});

test('missing evidence is reported and a source change during generation blocks publication of the stale answer', async t => {
  const { f, w, note, turn } = await knowledgeFixture(t);
  try {
    const doc = await note('Warehouse opens at 7am.', 'Warehouse hours');
    const requests = [];
    let stage = 'missing';
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      const body = JSON.parse(options.body);
      if (isTitleRequest(body)) return Response.json(anthropicText('Zebra clause'));
      if (isCompletionRequest(body)) return Response.json(completionReply('anthropic'));
      requests.push(body);
      if (stage === 'missing') {
        if (requests.length === 1)
          return respond({ kind: 'tool', call: { tool: 'knowledge.search', query: 'zebra clause' } });
        assert.match(JSON.stringify(body.messages), /No authorized knowledge matched/);
        return respond({ kind: 'answer', text: 'No knowledge evidence was found.' });
      }
      if (requests.length === 3)
        return respond({ kind: 'tool', call: { tool: 'knowledge.search', query: 'warehouse' } });
      await note('Warehouse opens at 9am.', 'Warehouse hours', doc.documentId, doc.revisionId);
      return respond({ kind: 'answer', text: 'The warehouse opens at 7am.' });
    });
    const chatId = randomUUID();
    await f.store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
    const missing = await turn(chatId, 'What is the zebra clause?');
    assert.equal(await missing.process(), 'completed');
    let history = await f.store.history(w.id, w.userId, chatId);
    assert.equal(history.messages[1].parts[0].text, 'No knowledge evidence was found.');
    const result = (
      await f.db.platform.query(`SELECT sources FROM ${f.table('tf_conversation_results')} WHERE message_id=$1`, [
        history.messages[1].id,
      ])
    ).rows[0].sources;
    assert.ok(!result.some(source => source.kind === 'knowledge-document'));

    stage = 'changed';
    const changed = await turn(chatId, 'When does the warehouse open?');
    assert.notEqual(await changed.process(), 'completed');
    history = await f.store.history(w.id, w.userId, chatId);
    assert.ok(
      !history.messages.some(message => message.parts.some(part => part.text === 'The warehouse opens at 7am.')),
      'stale answer was not published',
    );
  } finally {
    await f.close();
  }
});
