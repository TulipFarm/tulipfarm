import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { registerExtension } from '@tulipfarm/extensions';
import { createFiles } from '@tulipfarm/files';
import { createLearnedKnowledge, createLocalKnowledge } from '@tulipfarm/knowledge';
import { creditAccountExtension } from '@tulipfarm/workspace-storage/credit-account';
import { createConversationMaintenance } from '../../src/maintenance.ts';
import { createConversationExecutor } from '../../src/runtime.ts';
import { configureKeepPersonalMemory } from '../../src/personal-memory.ts';
import { conversationFixture } from '../fixture.mjs';
import { fakeKeep } from '../fake-keep.mjs';

await registerExtension(creditAccountExtension, { app: 'worker', env: {} });

const published = () => ({ documentId: randomUUID(), revisionId: randomUUID(), embeddingStatus: 'disabled' });

/** A model that summarizes chats and saves the given facts, citing the member's latest message. */
function model(facts = () => []) {
  const calls = [];
  return {
    calls,
    policy: async () => ({
      automatic: false,
      triggerPercent: 70,
      targetPercent: 30,
      outputPrompt: null,
      revision: 0,
      families: ['claude-haiku'],
    }),
    measure: async () => ({ tokens: 100, window: 100000 }),
    window: async () => 100000,
    summarize: async input => {
      calls.push(input);
      const reply = text => ({ text, familyId: 'claude-haiku', fallbackFrom: null });
      if (input.purpose === 'knowledge') {
        const request = JSON.parse(input.messages[0].text);
        const message = request.memberMessages.at(-1);
        return reply(JSON.stringify({ entries: facts(request).map(fact => ({ messageId: message.id, ...fact })) }));
      }
      if (input.purpose === 'memory') return reply(JSON.stringify({ edits: [] }));
      return reply(
        input.purpose === 'summary'
          ? JSON.stringify({ goal: 'Chat', decisions: [], openWork: [] })
          : '## Key decisions',
      );
    },
  };
}

async function setup(t, enabled = true) {
  const f = await conversationFixture();
  const reset = configureKeepPersonalMemory({ client: fakeKeep().client });
  t.after(async () => {
    reset();
    await f.close();
  });
  const w = f.workspace;
  const maintenance = createConversationMaintenance(f.runtime);
  const unavailable = async () => {
    throw new Error('no file bytes');
  };
  const files = createFiles(f.runtime, { read: unavailable, putIfAbsent: unavailable, remove: unavailable });
  const knowledge = createLocalKnowledge({ runtime: f.runtime, files });
  const learned = createLearnedKnowledge({ runtime: f.runtime, files, enabled: async () => enabled });
  async function chat(text) {
    const id = randomUUID();
    await f.store.create(w.id, w.userId, { chatId: id, commandId: randomUUID() });
    const sent = await f.store.send(w.id, w.userId, id, {
      commandId: randomUUID(),
      messageId: randomUUID(),
      parts: [{ kind: 'text', text }],
    });
    const executor = createConversationExecutor(f.runtime, async () => ({
      text: 'Noted, the Enterprise plan costs 999 dollars.',
      sources: [{ kind: 'private-conversation', conversationId: id }],
    }));
    assert.equal(
      await executor.process({ workspaceId: w.id, conversationId: id, turnId: sent.turnId, generation: 0 }),
      'completed',
    );
    return id;
  }
  async function close(id, selected) {
    await f.db.platform.query(
      `UPDATE ${f.table('tf_conversations')} SET activity_at=clock_timestamp()-interval '1 hour' WHERE id=$1`,
      [id],
    );
    await f.db.platform.query(
      `UPDATE ${f.table('tf_conversation_maintenance_sweep')} SET close_due_at=clock_timestamp(),scan_due_at=clock_timestamp(),close_after=NULL,scan_after=NULL`,
    );
    await maintenance.sweep(w.id);
    const jobs = [];
    await maintenance.dispatch(w.id, async value => jobs.push(value));
    const job = jobs.find(value => value.conversationId === id);
    assert.ok(job, 'the closed chat has maintenance work');
    return maintenance.process(job, selected, async () => published(), learned);
  }
  return { f, w, knowledge, chat, close };
}

test('a closed chat saves the member’s business facts as Learned entries', { timeout: 60000 }, async t => {
  const { w, knowledge, chat, close } = await setup(t);
  const id = await chat('Our Pro plan costs 49 dollars per seat each month.');
  const selected = model(request => {
    assert.deepEqual(request.currentEntries, []);
    assert.equal(request.memberMessages.length, 1, 'only the member’s own words are read');
    assert.doesNotMatch(JSON.stringify(request.memberMessages), /Enterprise/);
    return [
      {
        title: 'Pro plan pricing',
        text: 'The Pro plan costs 49 dollars per seat a month.',
        quote: 'Pro plan costs 49',
      },
      { title: 'Enterprise pricing', text: 'Enterprise costs 999 dollars.', quote: 'Enterprise plan costs 999' },
    ];
  });
  assert.equal(await close(id, selected), 'ready');
  const calls = selected.calls.filter(call => call.purpose === 'knowledge');
  assert.equal(calls.length, 1);
  assert.match(calls[0].system, /Only this member can see them/);
  const learnedNotes = async () => {
    const { items } = await knowledge.list(w.id, w.userId, { filter: 'learned' });
    return Promise.all(items.map(item => knowledge.get(w.id, w.userId, item.documentId)));
  };
  const items = await learnedNotes();
  assert.deepEqual(
    items.map(item => [item.title, item.noteText, item.learned.from, item.learned.sourceId]),
    [['Pro plan pricing', 'The Pro plan costs 49 dollars per seat a month.', 'chat', id]],
    'a fact only the assistant said is not saved',
  );

  const next = await chat('Pro now costs 59 dollars per seat each month.');
  const update = model(request => {
    assert.equal(request.currentEntries[0].documentId, items[0].documentId);
    return [{ title: 'Pro plan pricing', text: 'The Pro plan costs 59 dollars per seat a month.', quote: 'Pro now' }];
  });
  assert.equal(await close(next, update), 'ready');
  const after = await learnedNotes();
  assert.deepEqual(
    after.map(item => [item.documentId, item.noteText, item.learned.sourceId]),
    [[items[0].documentId, 'The Pro plan costs 59 dollars per seat a month.', next]],
  );
});

test('with learning turned off, chats are not read for facts', { timeout: 60000 }, async t => {
  const { w, knowledge, chat, close } = await setup(t, false);
  const id = await chat('Our Pro plan costs 49 dollars per seat each month.');
  const selected = model(() => [{ title: 'Pro plan pricing', text: 'Pro costs 49 dollars.', quote: 'Pro plan' }]);
  assert.equal(await close(id, selected), 'ready');
  assert.equal(selected.calls.filter(call => call.purpose === 'knowledge').length, 0);
  assert.deepEqual((await knowledge.list(w.id, w.userId, { filter: 'learned' })).items, []);
});
