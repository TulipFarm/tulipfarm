import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createKeepClient } from '@tulipfarm/memory-keep';
import {
  configureKeepPersonalMemory,
  createPersonalMemoryService,
  forgetOwnPersonalMemory,
  PersonalMemoryConflict,
  readPersonalMemory,
  readPersonalMemoryContext,
  replaceOwnPersonalMemory,
  undoOwnPersonalMemory,
} from '../../src/personal-memory.ts';

const endpoint = process.env.TEST_KEEP_ENDPOINT;
const token = process.env.TEST_KEEP_TOKEN;

/** A workspace transaction that answers membership and first-use checks without a database. */
function storage() {
  const workspaceId = randomUUID();
  const actor = { kind: 'human', userId: 'member', membershipId: randomUUID() };
  let used = false;
  const tx = {
    schema: `ws_${workspaceId.replaceAll('-', '')}`,
    workspaceId,
    commonVersion: 91,
    client: {
      query: async sql => {
        if (sql.includes('tf_authorization_lock')) return { rowCount: 1, rows: [{ id: 1 }] };
        if (sql.includes('tf_memberships'))
          return { rowCount: 1, rows: [{ id: actor.membershipId, user_id: actor.userId, role: 'member' }] };
        if (sql.includes('INSERT INTO') && sql.includes('tf_keep_memory')) {
          used = true;
          return { rowCount: 1, rows: [] };
        }
        if (sql.includes('tf_keep_memory')) return { rowCount: used ? 1 : 0, rows: used ? [{}] : [] };
        if (sql.includes('record_recommendation_change')) return { rowCount: 1, rows: [{ recorded: true }] };
        if (sql.includes('to_regclass')) return { rowCount: 1, rows: [{ installed: true }] };
        if (sql.includes('tf_personal_memory')) throw new Error('The old store must not be used with Keep on.');
        return { rowCount: 0, rows: [] };
      },
    },
  };
  return { tx, actor, workspaceId };
}

test('a real Keep holds member memory end to end', { skip: !endpoint && 'TEST_KEEP_ENDPOINT is not set' }, async t => {
  const client = createKeepClient({ endpoint: new URL(endpoint), token });
  t.after(configureKeepPersonalMemory({ enabled: async () => true, client }));
  const { tx, actor, workspaceId } = storage();
  const service = createPersonalMemoryService({ transaction: async (_id, _c, run) => run(tx) });

  const empty = await readPersonalMemory(tx, actor);
  assert.deepEqual(empty, { content: '', revision: 0 });
  assert.deepEqual(await readPersonalMemoryContext(tx, actor), empty);

  const text = 'Prefers short replies.\nWorks in Lisbon — UTC+0.\nSecret line.';
  const one = await replaceOwnPersonalMemory(tx, actor, text, empty.revision);
  assert.equal(one.content, text);
  assert.deepEqual(await readPersonalMemory(tx, actor), one);

  await assert.rejects(replaceOwnPersonalMemory(tx, actor, 'Stale.', empty.revision), PersonalMemoryConflict);

  const two = await replaceOwnPersonalMemory(tx, actor, 'Prefers long replies.', one.revision);
  assert.ok(two.revision > one.revision);
  const undone = await undoOwnPersonalMemory(tx, actor, two.revision);
  assert.equal(undone.content, text);

  const deleted = await service.delete(workspaceId, actor.userId, { expectedRevision: undone.revision });
  assert.equal(deleted.content, '');
  assert.equal(deleted.history?.trashed, true);
  const restored = await service.undo(workspaceId, actor.userId, { expectedRevision: deleted.revision });
  assert.equal(restored.content, text);

  const forgotten = await forgetOwnPersonalMemory(tx, actor, restored.revision, 'Secret line.');
  assert.equal(forgotten.content.includes('Secret line.'), false);
  assert.match(forgotten.content, /Prefers short replies\./);

  const context = await readPersonalMemoryContext(tx, actor);
  assert.match(context?.content ?? '', /Prefers short replies\./);
  assert.equal(context?.content.includes('Secret line.'), false);
  assert.equal(context?.content.includes('memory.view'), false);

  const erased = await service.forget(workspaceId, actor.userId, {
    expectedRevision: (await readPersonalMemory(tx, actor)).revision,
  });
  assert.equal(erased.content, '');
});
