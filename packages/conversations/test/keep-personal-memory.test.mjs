import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  configureKeepPersonalMemory,
  createPersonalMemoryService,
  forgetOwnPersonalMemory,
  PersonalMemoryConflict,
  PersonalMemoryRejected,
  PersonalMemoryUnavailable,
  readPersonalMemory,
  readPersonalMemoryContext,
  replaceOwnPersonalMemory,
  undoOwnPersonalMemory,
  writeOwnMemoryFile,
} from '../src/personal-memory.ts';
import { fakeKeep } from './fake-keep.mjs';

const workspaceId = randomUUID();
const schema = `ws_${workspaceId.replaceAll('-', '')}`;

/** A transaction that answers membership checks and records every statement. */
function storage() {
  const state = { statements: [] };
  const actor = { kind: 'human', userId: 'member', membershipId: randomUUID() };
  const tx = {
    schema,
    commonVersion: 99,
    client: {
      query: async sql => {
        state.statements.push(sql);
        if (sql.includes('tf_authorization_lock')) return { rowCount: 1, rows: [{ id: 1 }] };
        if (sql.includes('tf_memberships'))
          return { rowCount: 1, rows: [{ id: actor.membershipId, user_id: actor.userId, role: 'member' }] };
        if (sql.includes('record_recommendation_change')) return { rowCount: 1, rows: [{ recorded: true }] };
        if (sql.includes('to_regclass')) return { rowCount: 1, rows: [{ installed: true }] };
        return { rowCount: 0, rows: [] };
      },
    },
  };
  return { state, tx, actor };
}

function keep(client) {
  return configureKeepPersonalMemory({ client });
}

test('memory lives in Keep and starts empty', async t => {
  const { client, calls } = fakeKeep();
  t.after(keep(client));
  const { tx, actor, state } = storage();
  const empty = await readPersonalMemory(tx, actor);
  assert.deepEqual(empty, { content: '', revision: 0 });

  const saved = await replaceOwnPersonalMemory(tx, actor, 'Use short replies.', empty.revision);
  assert.equal(saved.content, 'Use short replies.');
  assert.ok(saved.revision > empty.revision);
  assert.deepEqual(await readPersonalMemory(tx, actor), saved);
  assert.ok(state.statements.some(sql => sql.includes('record_recommendation_change')));
  assert.ok(state.statements.some(sql => sql.includes('DELETE FROM') && sql.includes('tf_bud_preferences')));
  assert.ok(calls.includes('write'));
});

test('a stale revision is a conflict and changes nothing in Keep', async t => {
  const { client, calls } = fakeKeep();
  t.after(keep(client));
  const { tx, actor } = storage();
  const first = await replaceOwnPersonalMemory(tx, actor, 'Use emojis.', 0);
  await replaceOwnPersonalMemory(tx, actor, 'No emojis.', first.revision);
  const writes = calls.filter(call => call === 'write').length;
  await assert.rejects(replaceOwnPersonalMemory(tx, actor, 'Stale.', first.revision), PersonalMemoryConflict);
  assert.equal(calls.filter(call => call === 'write').length, writes);
  assert.equal((await readPersonalMemory(tx, actor)).content, 'No emojis.');
});

test('delete is recoverable, undo reverts edits, and forget erases text from every revision', async t => {
  const { client, files } = fakeKeep();
  t.after(keep(client));
  const { tx, actor } = storage();
  const service = createPersonalMemoryService({ transaction: async (_id, _c, run) => run({ ...tx, workspaceId }) });
  const one = await replaceOwnPersonalMemory(tx, actor, 'Line one.\nSecret line.', 0);
  const two = await replaceOwnPersonalMemory(tx, actor, 'Line two.', one.revision);

  const undone = await undoOwnPersonalMemory(tx, actor, two.revision);
  assert.equal(undone.content, 'Line one.\nSecret line.');

  const deleted = await replaceOwnPersonalMemory(tx, actor, '', undone.revision);
  assert.deepEqual(deleted.content, '');
  assert.notEqual(deleted.revision, undone.revision);
  const trashed = await service.read(workspaceId, actor.userId);
  assert.deepEqual(trashed.history, { trashed: true, undo: true });

  const restored = await undoOwnPersonalMemory(tx, actor, deleted.revision);
  assert.equal(restored.content, 'Line one.\nSecret line.');

  const forgotten = await forgetOwnPersonalMemory(tx, actor, restored.revision, 'Secret line.');
  assert.equal(forgotten.content, 'Line one.\n');
  const [file] = files.values();
  assert.equal(
    file.revisions.some(revision => revision.text.includes('Secret line.')),
    false,
  );
});

test('a failed save over deleted memory leaves it deleted, not restored', async t => {
  const { client, calls } = fakeKeep();
  t.after(keep(client));
  const { tx, actor } = storage();
  const saved = await replaceOwnPersonalMemory(tx, actor, 'Deleted on purpose.', 0);
  const deleted = await replaceOwnPersonalMemory(tx, actor, '', saved.revision);
  client.failWrite = { status: 'rejected', code: 'limit_exceeded' };
  await assert.rejects(replaceOwnPersonalMemory(tx, actor, 'Too long.', deleted.revision), PersonalMemoryRejected);
  assert.deepEqual(calls.slice(-3), ['restore', 'write', 'delete']);
  assert.deepEqual(await readPersonalMemory(tx, actor), { content: '', revision: deleted.revision });
});

test('an unreachable Keep is a typed unavailable state, never empty memory', async t => {
  const { client } = fakeKeep();
  client.available = false;
  t.after(keep(client));
  const { tx, actor } = storage();
  await assert.rejects(
    readPersonalMemory(tx, actor),
    error => error instanceof PersonalMemoryUnavailable && error.reason === 'unavailable',
  );
  assert.equal(await readPersonalMemoryContext(tx, actor), undefined);
});

test('an unconfigured Keep is unavailable', async t => {
  t.after(keep(undefined));
  const { tx, actor } = storage();
  await assert.rejects(
    readPersonalMemory(tx, actor),
    error => error instanceof PersonalMemoryUnavailable && error.reason === 'not-configured',
  );
});

test('model context always holds the You files and adds other files through Keep, personal only', async t => {
  const { client, calls } = fakeKeep();
  t.after(keep(client));
  const { tx, actor } = storage();
  assert.equal(await readPersonalMemoryContext(tx, actor), undefined);
  await replaceOwnPersonalMemory(tx, actor, 'Reply in French.', 0);
  const you = await readPersonalMemoryContext(tx, actor, 'hello');
  assert.match(you.content, /^BEGIN MEMORY CONTEXT\n/);
  assert.match(
    you.content,
    /UNTRUSTED MEMORY PROFILE\n\{"path":"\/profile.md","name":"Preferences","text":"Reply in French."\}/,
  );
  assert.match(you.content, /\nEND MEMORY CONTEXT$/);
  assert.equal(calls.includes('context'), false, 'You files alone need no context search');
  await writeOwnMemoryFile(tx, actor, {
    path: '/topics/career.md',
    content: '- Wants a COO role.',
    expectedRevisionId: null,
    name: 'Career',
    description: 'Goals and growth plans',
  });
  const both = await readPersonalMemoryContext(tx, actor, 'career plans');
  assert.ok(calls.includes('context'));
  assert.match(both.content, /UNTRUSTED MEMORY FILE\n\{"path":"\/topics\/career.md"/);
  assert.equal(both.content.match(/UNTRUSTED MEMORY PROFILE/g).length, 1, 'You files appear once');
  assert.notEqual(both.revision, you.revision);
});
