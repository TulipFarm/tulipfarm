import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createPersonalMemory, PersonalMemoryConflict } from '../dist/memory/personal-memory.js';

function fixture() {
  const context = Symbol('tenant transaction');
  const actor = { kind: 'human', userId: 'reader', membershipId: randomUUID() };
  const trace = [];
  const rows = new Map();
  const denied = new Error('removed membership');
  let revoked = false;
  let supported = true;
  let egress = false;
  const repository = {
    async read([id]) {
      trace.push('read');
      return { rows: rows.has(id) ? [{ ...rows.get(id) }] : [], rowCount: rows.has(id) ? 1 : 0 };
    },
    async insert([id, content, automatic, through]) {
      trace.push(['insert', automatic, through]);
      if (rows.has(id)) return { rows: [], rowCount: 0 };
      const row = { content, revision: 1 };
      rows.set(id, row);
      return { rows: [{ ...row }], rowCount: 1 };
    },
    async replace([id, content, revision, automatic, through]) {
      trace.push(['replace', automatic, through]);
      if (rows.get(id)?.revision !== revision) return { rows: [], rowCount: 0 };
      const row = { content, revision: revision + 1 };
      rows.set(id, row);
      return { rows: [{ ...row }], rowCount: 1 };
    },
    async clearPending([id]) {
      assert.equal(id, actor.membershipId);
      trace.push('clear-pending');
      return { rows: [], rowCount: 0 };
    },
  };
  const memory = createPersonalMemory({
    repository: value => {
      assert.equal(value, context);
      return repository;
    },
    authorization: {
      async lock(value) {
        assert.equal(value, context);
        trace.push('lock');
        return { kind: 'allowed', value: undefined };
      },
      async member(value, principal) {
        assert.equal(value, context);
        assert.equal(principal, actor);
        trace.push('member');
        return revoked ? { kind: 'denied', error: denied } : { kind: 'allowed', value: undefined };
      },
    },
    available: value => {
      assert.equal(value, context);
      trace.push('availability');
      return supported;
    },
    egressPolicy: {
      deny() {
        trace.push('egress');
        if (egress) throw denied;
      },
    },
    onChanged: async (value, principal) => {
      assert.equal(value, context);
      assert.equal(principal, actor);
      trace.push('changed');
    },
  });
  return {
    context,
    actor,
    trace,
    rows,
    memory,
    denied,
    revoke: () => {
      revoked = true;
    },
    oldStorage: () => {
      supported = false;
    },
    restrictEgress: () => {
      egress = true;
    },
  };
}

test('personal memory uses opaque contexts, exact revisions, and non-idempotent replacement', async () => {
  const f = fixture();
  assert.deepEqual(await f.memory.read(f.context, f.actor), { content: '', revision: 0 });
  assert.deepEqual(f.trace, ['egress', 'lock', 'member', 'availability', 'read']);
  f.trace.length = 0;
  assert.deepEqual(await f.memory.replace(f.context, f.actor, '  Keep it short.\n', 0), {
    content: '  Keep it short.\n',
    revision: 1,
  });
  assert.deepEqual(f.trace, ['egress', 'member', 'read', ['insert', false, null], 'clear-pending', 'changed']);
  await assert.rejects(f.memory.replace(f.context, f.actor, '  Keep it short.\n', 0), PersonalMemoryConflict);
  f.trace.length = 0;
  assert.deepEqual(await f.memory.replace(f.context, f.actor, '  Keep it short.\n', 1), {
    content: '  Keep it short.\n',
    revision: 2,
  });
  assert.ok(!f.trace.includes('changed'));
  assert.ok(f.trace.includes('clear-pending'));
});

test('competing first writes have one winner and deletion cannot be resurrected by stale saves', async () => {
  const f = fixture();
  const writes = await Promise.allSettled([
    f.memory.replace(f.context, f.actor, 'first', 0),
    f.memory.replace(f.context, f.actor, 'second', 0),
  ]);
  assert.equal(writes.filter(value => value.status === 'fulfilled').length, 1);
  assert.ok(writes.find(value => value.status === 'rejected').reason instanceof PersonalMemoryConflict);
  assert.deepEqual(await f.memory.replace(f.context, f.actor, '', 1), { content: '', revision: 2 });
  for (const revision of [0, 1]) {
    await assert.rejects(f.memory.replace(f.context, f.actor, 'stale', revision), PersonalMemoryConflict);
  }
  assert.equal(f.rows.size, 1);
  assert.deepEqual(await f.memory.read(f.context, f.actor), { content: '', revision: 2 });
});

test('whitespace, Unicode bounds, and invalid writes retain their original behavior', async () => {
  const f = fixture();
  assert.deepEqual(await f.memory.replace(f.context, f.actor, ' \n\t', 0), { content: '', revision: 1 });
  assert.ok(!f.trace.includes('changed'));
  assert.deepEqual(await f.memory.replace(f.context, f.actor, '🌷'.repeat(10000), 1), {
    content: '🌷'.repeat(10000),
    revision: 2,
  });
  for (const content of ['🌷'.repeat(10001), '\0', '\uD800']) {
    f.trace.length = 0;
    await assert.rejects(f.memory.replace(f.context, f.actor, content, 2));
    assert.deepEqual(f.trace, ['egress', 'member']);
  }
});

test('automatic replacement preserves reconciliation metadata without clearing manual steps', async () => {
  const f = fixture();
  const through = '2026-10-21T00:00:00.000Z';
  await f.memory.replace(f.context, f.actor, 'Use plain words.', 0, { through });
  assert.deepEqual(f.trace, ['egress', 'member', 'read', ['insert', true, through], 'changed']);
});

test('membership and egress denials keep their identity and precede every private read or write', async () => {
  const f = fixture();
  f.revoke();
  await assert.rejects(f.memory.read(f.context, f.actor), error => error === f.denied);
  assert.deepEqual(f.trace, ['egress', 'lock', 'member']);
  f.trace.length = 0;
  await assert.rejects(f.memory.replace(f.context, f.actor, 'private', 0), error => error === f.denied);
  assert.deepEqual(f.trace, ['egress', 'member']);
  f.trace.length = 0;
  f.restrictEgress();
  await assert.rejects(f.memory.read(f.context, f.actor), error => error === f.denied);
  assert.deepEqual(f.trace, ['egress']);
});

test('old storage returns empty memory only after membership checks and before repository access', async () => {
  const f = fixture();
  f.oldStorage();
  assert.deepEqual(await f.memory.read(f.context, f.actor), { content: '', revision: 0 });
  assert.deepEqual(f.trace, ['egress', 'lock', 'member', 'availability']);
  f.trace.length = 0;
  f.revoke();
  await assert.rejects(f.memory.read(f.context, f.actor), error => error === f.denied);
  assert.deepEqual(f.trace, ['egress', 'lock', 'member']);
});
