import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { currentMember, lockAuthorization, resolveHuman } from '@tulipfarm/access';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { registerExtension } from '@tulipfarm/extensions';
import { creditAccountExtension } from '@tulipfarm/workspace-storage/credit-account';
import { createConversationMaintenance } from '../../src/maintenance.ts';
import { createConversationExecutor } from '../../src/runtime.ts';
import {
  configureKeepPersonalMemory,
  createPersonalMemoryService,
  forgetOwnPersonalMemory,
  MemoryProposalNotFound,
  MemoryProposalOutdated,
} from '../../src/personal-memory.ts';
import { conversationFixture } from '../fixture.mjs';
import { fakeKeep } from '../fake-keep.mjs';
import { createKeepClient } from '@tulipfarm/memory-keep';

await registerExtension(creditAccountExtension, { app: 'worker', env: {} });

const published = () => ({ documentId: randomUUID(), revisionId: randomUUID(), embeddingStatus: 'disabled' });

/** A model that summarizes chats, and suggests the given memory edits citing the member's latest message. */
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
          text: JSON.stringify({ edits: edits(currentMemory).map(edit => ({ messageId, ...edit })) }),
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
    const jobs = [];
    await maintenance.dispatch(w.id, async value => jobs.push(value));
    const job = jobs.find(value => value.conversationId === id);
    assert.ok(job, 'the closed chat has maintenance work');
    return maintenance.process(job, selected, async () => published());
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

test(
  'with Keep, learning suggests edits instead of writing memory, and confirming applies them like a member edit',
  { timeout: 60000 },
  async t => {
    const { f, w, keep, memory, learn, count } = await setup(t);
    const saved = await memory.save(w.id, w.userId, { content: '- Use short replies.', expectedRevision: 0 });
    const writes = () => keep.calls.filter(call => call === 'write').length;
    const before = writes();

    const { id, calls } = await learn('Please use emojis in your replies. And reply in French from now on.', () => [
      { kind: 'add', before: null, after: '- Use emojis.', quote: 'use emojis' },
      { kind: 'add', before: null, after: '- Reply in French.', quote: 'reply in French' },
      { kind: 'add', before: null, after: '- Invented.', quote: 'words the member never wrote' },
      { kind: 'change', before: 'not in memory', after: 'x', quote: 'use emojis' },
    ]);
    assert.equal(calls.length, 1);
    assert.match(calls[0].system, /nothing changes until they confirm/);
    assert.equal(writes(), before, 'learning never writes memory');
    assert.equal((await memory.read(w.id, w.userId)).content, '- Use short replies.');

    const listed = await memory.proposals(w.id, w.userId);
    assert.equal(listed.memory.revision, saved.revision);
    assert.deepEqual(
      listed.proposals.map(({ kind, before, after, quote, conversationId, outdated }) => ({
        kind,
        before,
        after,
        quote,
        conversationId,
        outdated,
      })),
      [
        {
          kind: 'add',
          before: null,
          after: '- Use emojis.',
          quote: 'use emojis',
          conversationId: id,
          outdated: false,
        },
        {
          kind: 'add',
          before: null,
          after: '- Reply in French.',
          quote: 'reply in French',
          conversationId: id,
          outdated: false,
        },
      ],
      'only edits that quote the member and fit the memory are suggested',
    );
    const [emojis, french] = listed.proposals;
    assert.equal(
      (
        await f.db.platform.query(`SELECT base_revision_id FROM ${f.table('tf_memory_proposals')} WHERE id=$1`, [
          emojis.id,
        ])
      ).rows[0].base_revision_id.length,
      36,
      'a suggestion is bound to the Keep revision it was made against',
    );

    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_bud_preferences')} (id,membership_id,conversation_id,turn_id,topic,question,status,expected_revision)
      VALUES ($1,$2,$3,$4,'reply-style','How should I reply?','asking',0)`,
      [randomUUID(), w.membershipId, id, randomUUID()],
    );
    const events = await count('tf_recommendation_events', `kind='memory' AND invalidate`);
    const confirmed = await memory.confirmProposal(w.id, w.userId, emojis.id);
    assert.equal(confirmed.memory.content, '- Use short replies.\n- Use emojis.');
    assert.equal(writes(), before + 1);
    assert.equal(await count('tf_bud_preferences'), 0, 'confirming clears Bud preference records');
    assert.equal(
      await count('tf_recommendation_events', `kind='memory' AND invalidate`),
      events + 1,
      'confirming invalidates recommendations',
    );
    assert.deepEqual(
      confirmed.proposals.map(proposal => [proposal.id, proposal.outdated]),
      [[french.id, false]],
      'other suggestions that still fit move to the new revision',
    );
    await assert.rejects(memory.confirmProposal(w.id, w.userId, emojis.id), MemoryProposalNotFound);

    const dismissed = await memory.dismissProposal(w.id, w.userId, french.id);
    assert.deepEqual(dismissed.proposals, []);
    assert.equal((await memory.read(w.id, w.userId)).content, '- Use short replies.\n- Use emojis.');
    assert.equal(await count('tf_memory_proposals'), 0, 'decided suggestions keep no text');
  },
);

test(
  'a direct save makes suggestions outdated: they cannot be confirmed, and refresh keeps only those that still fit',
  { timeout: 60000 },
  async t => {
    const { w, keep, memory, learn } = await setup(t);
    await memory.save(w.id, w.userId, { content: '- Use short replies.\n- No emojis.', expectedRevision: 0 });
    await learn('Use long replies. Also greet me by name.', () => [
      { kind: 'change', before: '- Use short replies.', after: '- Use long replies.', quote: 'Use long replies.' },
      { kind: 'add', before: null, after: '- Greet by name.', quote: 'greet me by name' },
    ]);
    const current = await memory.read(w.id, w.userId);
    const edited = await memory.save(w.id, w.userId, { content: '- No emojis.', expectedRevision: current.revision });
    const { proposals } = await memory.proposals(w.id, w.userId);
    assert.deepEqual(
      proposals.map(proposal => proposal.outdated),
      [true, true],
    );
    const [change, add] = proposals;
    const writes = keep.calls.filter(call => call === 'write').length;
    await assert.rejects(memory.confirmProposal(w.id, w.userId, add.id), MemoryProposalOutdated);
    assert.equal(keep.calls.filter(call => call === 'write').length, writes, 'an outdated suggestion writes nothing');
    assert.deepEqual(await memory.read(w.id, w.userId), edited);

    await assert.rejects(memory.refreshProposal(w.id, w.userId, change.id), MemoryProposalOutdated);
    const refreshed = await memory.refreshProposal(w.id, w.userId, add.id);
    assert.deepEqual(
      refreshed.proposals.map(proposal => [proposal.id, proposal.outdated]),
      [
        [change.id, true],
        [add.id, false],
      ],
    );
    const confirmed = await memory.confirmProposal(w.id, w.userId, add.id);
    assert.equal(confirmed.memory.content, '- No emojis.\n- Greet by name.');

    await memory.delete(w.id, w.userId, { expectedRevision: confirmed.memory.revision });
    await memory.undo(w.id, w.userId, { expectedRevision: (await memory.read(w.id, w.userId)).revision });
    assert.deepEqual(
      (await memory.proposals(w.id, w.userId)).proposals.map(proposal => proposal.outdated),
      [true],
    );
    assert.deepEqual((await memory.dismissProposal(w.id, w.userId, change.id)).proposals, []);
  },
);

test(
  'forgetting deletes suggestions that hold the text, and that chat does not suggest it again',
  { timeout: 60000 },
  async t => {
    const { f, w, memory, chat, exchange, close, learn, count } = await setup(t);
    const { id } = await learn('Please use emojis. Keep replies short.', () => [
      { kind: 'add', before: null, after: '- Use emojis.', quote: 'use emojis' },
      { kind: 'add', before: null, after: '- Keep replies short.', quote: 'Keep replies short.' },
    ]);
    assert.equal(await count('tf_memory_proposals'), 2);
    await memory.save(w.id, w.userId, { content: '- Use emojis.', expectedRevision: 0 });
    const revision = (await memory.read(w.id, w.userId)).revision;
    await f.runtime.transaction(w.id, commonCompatibility, async tx => {
      await lockAuthorization(tx, 'read');
      const actor = await resolveHuman(tx, w.userId);
      await currentMember(tx, actor);
      await forgetOwnPersonalMemory(tx, actor, revision, 'emojis');
    });
    const remaining = await memory.proposals(w.id, w.userId);
    assert.deepEqual(
      remaining.proposals.map(proposal => proposal.after),
      ['- Keep replies short.'],
      'only suggestions holding the forgotten text are deleted',
    );
    const blocks = (await f.db.platform.query(`SELECT * FROM ${f.table('tf_memory_learning_blocks')}`)).rows;
    assert.ok(blocks.length > 0);
    assert.ok(
      blocks.every(row => row.conversation_id === id && /^[0-9a-f]{64}$/.test(row.hash)),
      'only the source chat and a hash are kept',
    );
    assert.doesNotMatch(JSON.stringify(blocks), /emojis/);

    await exchange(id, 'Use emojis again, please.');
    const again = model(() => [{ kind: 'add', before: null, after: '- Use emojis.', quote: 'Use emojis again' }]);
    assert.equal(await close(id, again), 'ready');
    assert.equal(again.calls.filter(call => call.purpose === 'memory').length, 1);
    assert.equal(await count('tf_memory_proposals'), 1, 'the forgotten text is not suggested again from that chat');

    const other = await chat();
    await exchange(other, 'Use emojis, please.');
    const elsewhere = model(() => [{ kind: 'add', before: null, after: '- Use emojis.', quote: 'Use emojis' }]);
    assert.equal(await close(other, elsewhere), 'ready');
    assert.equal(await count('tf_memory_proposals'), 2, 'a new chat where the member asks again can suggest it');

    await memory.forget(w.id, w.userId, { expectedRevision: (await memory.read(w.id, w.userId)).revision });
    assert.equal(await count('tf_memory_proposals'), 0, 'forgetting everything deletes every suggestion');
  },
);

/** Forgets the exact text from the member's memory, as a confirmed chat forget does. */
async function forgetText({ f, w }, text, revision) {
  await f.runtime.transaction(w.id, commonCompatibility, async tx => {
    await lockAuthorization(tx, 'read');
    const actor = await resolveHuman(tx, w.userId);
    await currentMember(tx, actor);
    await forgetOwnPersonalMemory(tx, actor, revision, text);
  });
}

test(
  'forgetting deletes suggestions whose words sit inside the forgotten text, and those it leaves unable to apply',
  { timeout: 60000 },
  async t => {
    const context = await setup(t);
    const { w, memory, learn, count } = context;
    await memory.save(w.id, w.userId, {
      content: '- Use emojis.\n- Be brief.\n- Greet by name.\n- Use tables.',
      expectedRevision: 0,
    });
    await learn('Use emojis sparingly. Stop being brief. Greet me by first name. Reply in French.', () => [
      { kind: 'change', before: '- Use emojis.', after: '- Use emojis sparingly.', quote: 'Use emojis sparingly' },
      { kind: 'remove', before: '- Be brief.', after: null, quote: 'Stop being brief' },
      { kind: 'change', before: '- Greet by name.', after: '- Greet by first name.', quote: 'Greet me by first name' },
      { kind: 'add', before: null, after: '- Reply in French.', quote: 'Reply in French' },
    ]);
    assert.equal(await count('tf_memory_proposals'), 4);

    await forgetText(context, '- Use emojis.\n- Be brief.', (await memory.read(w.id, w.userId)).revision);
    assert.deepEqual(
      (await memory.proposals(w.id, w.userId)).proposals.map(proposal => proposal.after),
      ['- Greet by first name.', '- Reply in French.'],
      'a suggestion whose words lie inside the forgotten text is deleted',
    );

    await forgetText(context, 'name.\n- Use', (await memory.read(w.id, w.userId)).revision);
    assert.doesNotMatch((await memory.read(w.id, w.userId)).content, /Greet by name/);
    assert.deepEqual(
      (await memory.proposals(w.id, w.userId)).proposals.map(proposal => proposal.after),
      ['- Reply in French.'],
      'a partial-line forget deletes a suggestion that no longer fits, even without shared words',
    );
    assert.doesNotMatch(
      JSON.stringify(
        (await context.f.db.platform.query(`SELECT * FROM ${context.f.table('tf_memory_proposals')}`)).rows,
      ),
      /emojis|brief|Greet/,
    );
  },
);

test(
  'a forget that races background learning waits for it, then deletes the suggestions it saved',
  { timeout: 60000 },
  async t => {
    const context = await setup(t);
    const { w, keep, memory, learn } = context;
    await memory.save(w.id, w.userId, { content: '- No emojis.', expectedRevision: 0 });
    const revision = (await memory.read(w.id, w.userId)).revision;
    let armed = false;
    let forgetting;
    const order = [];
    const history = keep.client.history;
    // Learning's last step reads Keep under its lock; a forget starts right then and must wait for learning to commit.
    keep.client.history = async input => {
      const result = await history(input);
      if (armed) {
        armed = false;
        forgetting = forgetText(context, 'emojis', revision);
        order.push(
          await Promise.race([
            forgetting.then(() => 'forget finished first'),
            new Promise(resolve => setTimeout(() => resolve('forget waited'), 500)),
          ]),
        );
      }
      return result;
    };
    await learn('Use emojis now. Reply in French.', () => {
      armed = true;
      return [
        { kind: 'change', before: '- No emojis.', after: '- Use emojis.', quote: 'Use emojis now' },
        { kind: 'add', before: null, after: '- Reply in French.', quote: 'Reply in French' },
      ];
    });
    await forgetting;
    assert.deepEqual(order, ['forget waited']);
    assert.deepEqual(
      (await memory.proposals(w.id, w.userId)).proposals.map(proposal => proposal.after),
      ['- Reply in French.'],
      'no suggestion holding the forgotten text survives the race',
    );
  },
);

test('project chats never feed personal learning', { timeout: 60000 }, async t => {
  const { f, w, memory, chat, exchange, close, count } = await setup(t);
  await memory.read(w.id, w.userId);
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
  const projectModel = model(() => [{ kind: 'add', before: null, after: '- Use emojis.', quote: 'use emojis' }]);
  assert.equal(await close(project, projectModel), 'ready');
  assert.equal(projectModel.calls.filter(call => call.purpose === 'memory').length, 0);
  assert.equal(await count('tf_memory_proposals'), 0);
});

test('without Keep, chats are not learned from', { timeout: 60000 }, async t => {
  const { chat, exchange, close, count } = await setup(t, undefined, { keepless: true });
  const id = await chat();
  await exchange(id, 'Please use emojis in your replies.');
  const selected = model(() => [{ kind: 'add', before: null, after: '- Use emojis.', quote: 'use emojis' }]);
  assert.equal(await close(id, selected), 'ready');
  assert.equal(selected.calls.filter(call => call.purpose === 'memory').length, 0);
  assert.equal(await count('tf_memory_proposals'), 0);
});

const endpoint = process.env.TEST_KEEP_ENDPOINT;

test(
  'with a real Keep, suggestions apply by compare-and-swap, go out of date on a member edit, and forget scrubs them',
  { timeout: 60000, skip: !endpoint && 'TEST_KEEP_ENDPOINT is not set' },
  async t => {
    const client = createKeepClient({ endpoint: new URL(endpoint), token: process.env.TEST_KEEP_TOKEN });
    const { f, w, memory, learn, count } = await setup(t, client);
    await memory.save(w.id, w.userId, { content: '- Use short replies.', expectedRevision: 0 });
    const { id } = await learn('Please use emojis in your replies. Also greet me by name.', () => [
      { kind: 'add', before: null, after: '- Use emojis.', quote: 'use emojis' },
      { kind: 'add', before: null, after: '- Greet me by name.', quote: 'greet me by name' },
    ]);
    assert.equal((await memory.read(w.id, w.userId)).content, '- Use short replies.', 'learning never writes Keep');
    const { proposals } = await memory.proposals(w.id, w.userId);
    assert.equal(proposals.length, 2);
    const bound = await f.db.platform.query(`SELECT base_revision_id FROM ${f.table('tf_memory_proposals')}`);
    assert.ok(
      bound.rows.every(row => row.base_revision_id),
      'bound to the Keep head revision',
    );

    const confirmed = await memory.confirmProposal(w.id, w.userId, proposals[0].id);
    assert.equal(confirmed.memory.content, '- Use short replies.\n- Use emojis.');
    assert.deepEqual((await memory.read(w.id, w.userId)).content, confirmed.memory.content);
    assert.deepEqual(
      confirmed.proposals.map(proposal => proposal.outdated),
      [false],
    );

    const edited = await memory.save(w.id, w.userId, {
      content: '- Use emojis.',
      expectedRevision: confirmed.memory.revision,
    });
    const [greet] = (await memory.proposals(w.id, w.userId)).proposals;
    assert.equal(greet.outdated, true);
    await assert.rejects(memory.confirmProposal(w.id, w.userId, greet.id), MemoryProposalOutdated);
    assert.deepEqual(await memory.read(w.id, w.userId), edited);

    await learn('Use emojis sparingly, please.', () => [
      { kind: 'change', before: '- Use emojis.', after: '- Use emojis sparingly.', quote: 'Use emojis sparingly' },
    ]);
    assert.equal(await count('tf_memory_proposals', `after_text LIKE '%sparingly%'`), 1);
    const revision = (await memory.read(w.id, w.userId)).revision;
    await f.runtime.transaction(w.id, commonCompatibility, async tx => {
      await lockAuthorization(tx, 'read');
      const actor = await resolveHuman(tx, w.userId);
      await currentMember(tx, actor);
      await forgetOwnPersonalMemory(tx, actor, revision, 'emojis');
    });
    assert.equal((await memory.read(w.id, w.userId)).content.includes('emojis'), false);
    assert.equal(await count('tf_memory_proposals', `after_text LIKE '%emojis%' OR before_text LIKE '%emojis%'`), 0);
    assert.ok(await count('tf_memory_learning_blocks'), 'the forgotten source is blocked by hash');
    assert.ok(id);
  },
);
