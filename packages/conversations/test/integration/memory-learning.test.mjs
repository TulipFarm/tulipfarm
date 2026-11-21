import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { registerExtension } from '@tulipfarm/extensions';
import { creditAccountExtension } from '@tulipfarm/workspace-storage/credit-account';
import { createConversationMaintenance } from '../../src/maintenance.ts';
import { createConversationExecutor } from '../../src/runtime.ts';
import { configureKeepPersonalMemory, createPersonalMemoryService } from '../../src/personal-memory.ts';
import { conversationFixture } from '../fixture.mjs';
import { fakeKeep } from '../fake-keep.mjs';
import { createKeepClient } from '@tulipfarm/memory-keep';

await registerExtension(creditAccountExtension, { app: 'worker', env: {} });

const published = () => ({ documentId: randomUUID(), revisionId: randomUUID(), embeddingStatus: 'disabled' });

/** A model that summarizes chats, and returns the given memory edits citing the member's latest message. */
function model(edits = () => []) {
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
      if (input.purpose === 'memory') {
        const { requesterTranscript, currentMemory } = JSON.parse(input.messages[0].text);
        const messageId = [...requesterTranscript.matchAll(/id="([^"]+)"/g)].at(-1)[1];
        return {
          text: JSON.stringify({ edits: (await edits(currentMemory)).map(edit => ({ messageId, ...edit })) }),
          familyId: 'claude-haiku',
          fallbackFrom: null,
        };
      }
      return {
        text:
          input.purpose === 'summary'
            ? JSON.stringify({ goal: 'Chat', decisions: [], openWork: [] })
            : '## Key decisions\nNone',
        familyId: 'claude-haiku',
        fallbackFrom: null,
      };
    },
  };
}

async function setup(t, client, { keepless = false } = {}) {
  const f = await conversationFixture();
  const keep = fakeKeep();
  const reset = configureKeepPersonalMemory({ client: keepless ? undefined : (client ?? keep.client) });
  t.after(async () => {
    reset();
    await f.close();
  });
  const w = f.workspace;
  const memory = createPersonalMemoryService(f.runtime);
  const maintenance = createConversationMaintenance(f.runtime);
  async function chat() {
    const id = randomUUID();
    await f.store.create(w.id, w.userId, { chatId: id, commandId: randomUUID() });
    return id;
  }
  async function exchange(id, text) {
    const sent = await f.store.send(w.id, w.userId, id, {
      commandId: randomUUID(),
      messageId: randomUUID(),
      parts: [{ kind: 'text', text }],
    });
    const executor = createConversationExecutor(f.runtime, async () => ({
      text: 'Done.',
      sources: [{ kind: 'private-conversation', conversationId: id }],
    }));
    assert.equal(
      await executor.process({ workspaceId: w.id, conversationId: id, turnId: sent.turnId, generation: 0 }),
      'completed',
    );
  }
  /** Closes the chat and runs its background maintenance with the given model. */
  async function close(id, selected) {
    await f.db.platform.query(
      `UPDATE ${f.table('tf_conversations')} SET activity_at=clock_timestamp()-interval '1 hour' WHERE id=$1`,
      [id],
    );
    await f.db.platform.query(
      `UPDATE ${f.table('tf_conversation_maintenance_sweep')} SET close_due_at=clock_timestamp(),scan_due_at=clock_timestamp(),close_after=NULL,scan_after=NULL`,
    );
    await maintenance.sweep(w.id);
    // Work that restarts is queued again; run it until it settles.
    for (let attempt = 0; ; attempt++) {
      const jobs = [];
      await maintenance.dispatch(w.id, async value => jobs.push(value));
      const job = jobs.find(value => value.conversationId === id);
      assert.ok(job, 'the closed chat has maintenance work');
      const result = await maintenance.process(job, selected, async () => published());
      if (result !== 'queued' || attempt === 2) return result;
      await f.db.platform.query(
        `UPDATE ${f.table('tf_conversation_maintenance')} SET next_attempt_at=clock_timestamp() WHERE conversation_id=$1`,
        [id],
      );
    }
  }
  async function learn(text, edits) {
    const id = await chat();
    await exchange(id, text);
    const selected = model(edits);
    assert.equal(await close(id, selected), 'ready');
    return { id, calls: selected.calls.filter(call => call.purpose === 'memory') };
  }
  const count = async (name, where = 'true') =>
    (await f.db.platform.query(`SELECT count(*)::int AS n FROM ${f.table(name)} WHERE ${where}`)).rows[0].n;
  return { f, w, keep, memory, chat, exchange, close, learn, count };
}

const read = async (memory, w, path) => (await memory.readFile(w.id, w.userId, { path })).content;

test('learning applies edits that quote the member straight to the right files', { timeout: 60000 }, async t => {
  const { f, w, memory, learn, count } = await setup(t);
  await memory.save(w.id, w.userId, { content: '- Use short replies.', expectedRevision: 0 });
  const events = await count('tf_recommendation_events', `kind='memory' AND invalidate`);
  const { calls } = await learn('Please use emojis. I lead the Falcon launch with Sam Lee.', current => {
    assert.ok(current.files.some(file => file.path === '/profile.md' && file.text === '- Use short replies.'));
    return [
      { path: '/profile.md', kind: 'add', before: null, after: '- Use emojis.', quote: 'Please use emojis.' },
      {
        path: '/topics/falcon-launch.md',
        kind: 'add',
        before: null,
        after: '- Leads the Falcon launch.',
        name: 'Falcon launch',
        description: 'The launch the member leads',
        quote: 'I lead the Falcon launch',
      },
      { path: '/people/sam-lee.md', kind: 'add', before: null, after: '- Works on Falcon.', quote: 'words never said' },
      {
        path: '/topics/falcon-launch.md',
        kind: 'delete',
        before: null,
        after: null,
        quote: 'I lead the Falcon launch',
      },
    ];
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].system, /apply at once, without review/);
  assert.equal(await read(memory, w, '/profile.md'), '- Use short replies.\n- Use emojis.');
  const falcon = (await memory.files(w.id, w.userId)).files.find(file => file.path === '/topics/falcon-launch.md');
  assert.deepEqual([falcon.name, falcon.description], ['Falcon launch', 'The launch the member leads']);
  assert.equal(await read(memory, w, '/topics/falcon-launch.md'), '- Leads the Falcon launch.');
  assert.equal(
    (await memory.files(w.id, w.userId)).files.some(file => file.path === '/people/sam-lee.md'),
    false,
    'an edit without the member’s words is dropped',
  );
  assert.equal(await count('tf_recommendation_events', `kind='memory' AND invalidate`), events + 1);
  for (const name of ['tf_memory_proposals', 'tf_memory_learning_blocks'])
    assert.equal((await f.db.platform.query('SELECT to_regclass($1) AS found', [f.table(name)])).rows[0].found, null);
});

test('a member edit while learning runs wins over what the chat said before it', { timeout: 60000 }, async t => {
  const { w, memory, learn } = await setup(t);
  await memory.save(w.id, w.userId, { content: '- Use short replies.', expectedRevision: 0 });
  let edited = false;
  const { calls } = await learn('Please use emojis.', async current => {
    if (!edited) {
      edited = true;
      const preferences = current.files.find(file => file.path === '/profile.md');
      await memory.saveFile(w.id, w.userId, {
        path: '/profile.md',
        content: '- Use long replies.',
        expectedRevisionId: preferences.revisionId,
      });
    }
    return [{ path: '/profile.md', kind: 'add', before: null, after: '- Use emojis.', quote: 'Please use emojis.' }];
  });
  assert.equal(calls.length, 1, 'messages before the edit are not learned again');
  assert.equal(await read(memory, w, '/profile.md'), '- Use long replies.');
});

test('project chats never feed personal learning', { timeout: 60000 }, async t => {
  const { f, w, memory, chat, exchange, close } = await setup(t);
  await memory.files(w.id, w.userId);
  const projectId = randomUUID();
  await f.db.platform.query(
    `INSERT INTO ${f.table('tf_projects')} (id,name,creator_membership_id) VALUES ($1,'Launch',$2)`,
    [projectId, w.membershipId],
  );
  await f.db.platform.query(
    `INSERT INTO ${f.table('tf_project_members')} (project_id,membership_id,role) VALUES ($1,$2,'manager')`,
    [projectId, w.membershipId],
  );
  const project = await chat();
  await f.db.platform.query(`UPDATE ${f.table('tf_conversations')} SET project_id=$2 WHERE id=$1`, [
    project,
    projectId,
  ]);
  await exchange(project, 'Please use emojis.');
  const projectModel = model(() => [
    { path: '/profile.md', kind: 'add', before: null, after: '- Use emojis.', quote: 'use emojis' },
  ]);
  assert.equal(await close(project, projectModel), 'ready');
  assert.equal(projectModel.calls.filter(call => call.purpose === 'memory').length, 0);
  assert.equal((await memory.files(w.id, w.userId)).files[0].revisionId, null);
});

test('without Keep, chats are not learned from', { timeout: 60000 }, async t => {
  const { chat, exchange, close } = await setup(t, undefined, { keepless: true });
  const id = await chat();
  await exchange(id, 'Please use emojis in your replies.');
  const selected = model(() => [
    { path: '/profile.md', kind: 'add', before: null, after: '- Use emojis.', quote: 'use emojis' },
  ]);
  assert.equal(await close(id, selected), 'ready');
  assert.equal(selected.calls.filter(call => call.purpose === 'memory').length, 0);
});

const endpoint = process.env.TEST_KEEP_ENDPOINT;

test(
  'with a real Keep, learning writes the files it names',
  { timeout: 60000, skip: !endpoint && 'TEST_KEEP_ENDPOINT is not set' },
  async t => {
    const client = createKeepClient({ endpoint: new URL(endpoint), token: process.env.TEST_KEEP_TOKEN });
    const { w, memory, learn } = await setup(t, client);
    await memory.save(w.id, w.userId, { content: '- Use short replies.', expectedRevision: 0 });
    await learn('Please use emojis. I run hiring for the operations team.', () => [
      { path: '/profile.md', kind: 'add', before: null, after: '- Use emojis.', quote: 'Please use emojis.' },
      {
        path: '/areas/hiring.md',
        kind: 'add',
        before: null,
        after: '- Runs hiring for the operations team.',
        name: 'Hiring',
        description: 'Recruiting for operations',
        quote: 'I run hiring for the operations team.',
      },
    ]);
    assert.equal(await read(memory, w, '/profile.md'), '- Use short replies.\n- Use emojis.');
    const hiring = (await memory.files(w.id, w.userId)).files.find(file => file.path === '/areas/hiring.md');
    assert.deepEqual([hiring.name, hiring.group], ['Hiring', 'areas']);
  },
);
