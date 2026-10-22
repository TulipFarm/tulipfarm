import assert from 'node:assert/strict';
import test from 'node:test';
import { createInMemoryMemoryAdapters, InMemoryDeadlineExceeded } from '../dist/adapters/in-memory.js';
import { createPersonalMemory, PersonalMemoryConflict } from '../dist/memory/personal-memory.js';
import { createMemoryReconciliation } from '../dist/memory/reconciliation.js';
import {
  baseMemorySeed,
  memoryFixtureIds,
  memoryRepositoryConformance,
  memoryReconciliationConformance,
  transcriptSourceConformance,
  messageSeed,
} from '../testing/memory-conformance.mjs';

async function fixture() {
  const ids = memoryFixtureIds();
  const tenant = 'reference-tenant';
  let now = Date.parse('2020-01-01T00:00:00.000Z');
  const adapters = createInMemoryMemoryAdapters({ clock: { now: () => now } });
  await adapters.seed(tenant, baseMemorySeed(ids));
  return {
    ...adapters,
    ids,
    tenant,
    seed: input => adapters.seed(tenant, input),
    run: operation => adapters.runtime.transaction(tenant, {}, operation),
    advance: milliseconds => {
      now += milliseconds;
    },
  };
}

memoryRepositoryConformance(test, 'In-memory MemoryRepository', fixture);
memoryReconciliationConformance(test, 'In-memory MemoryReconciliationRepository', fixture);
transcriptSourceConformance(test, 'In-memory TranscriptSource', fixture);

test('reference transactions roll back memory, progress, and pending steps together', async () => {
  const f = await fixture();
  await f.seed({ steps: [{ jobId: f.ids.job, purpose: 'memory' }] });
  const failure = new Error('abort');
  await assert.rejects(
    f.run(async context => {
      await f.memory(context).insert([f.ids.member, 'not committed', false, null]);
      await f.reconciliation(context).complete([f.ids.job]);
      await f.memory(context).clearPending([f.ids.member]);
      throw failure;
    }),
    error => error === failure,
  );
  await f.run(async context => {
    assert.equal((await f.memory(context).read([f.ids.member])).rowCount, 0);
    assert.equal((await f.reconciliation(context).progress([f.ids.job])).rows[0].memory_complete, false);
    assert.equal((await f.memory(context).clearPending([f.ids.member])).rowCount, 1);
  });
});

test('reference transactions isolate tenants, reject stale and foreign contexts, and retain error identity', async () => {
  const f = await fixture();
  let expired;
  await f.run(async context => {
    expired = context;
    await f.memory(context).insert([f.ids.member, 'private', false, null]);
    assert.ok(Object.isFrozen(context));
  });
  await assert.rejects(f.memory(expired).read([f.ids.member]), /Inactive or foreign/);
  await assert.rejects(f.memory({ tenantId: f.tenant }).read([f.ids.member]), /Inactive or foreign/);
  await f.runtime.transaction('other-tenant', {}, async context => {
    assert.equal((await f.memory(context).read([f.ids.member])).rowCount, 0);
    await f.memory(context).insert([f.ids.member, 'other', false, null]);
  });
  const other = createInMemoryMemoryAdapters({ clock: { now: () => 0 } });
  await other.runtime.transaction(f.tenant, {}, async context =>
    assert.rejects(f.memory(context).read([f.ids.member]), /Inactive or foreign/),
  );
  await f.run(async context => assert.equal((await f.memory(context).read([f.ids.member])).rows[0].content, 'private'));
});

test('reference deadlines reject admission and roll back transactions that exceed their deadline', async () => {
  const f = await fixture();
  const now = Date.parse('2020-01-01T00:00:00.000Z');
  let called = false;
  await assert.rejects(
    f.runtime.transaction(f.tenant, { deadlineAt: now }, async () => {
      called = true;
    }),
    InMemoryDeadlineExceeded,
  );
  assert.equal(called, false);
  await assert.rejects(
    f.runtime.transaction(f.tenant, { deadlineAt: now + 1 }, async context => {
      await f.memory(context).insert([f.ids.member, 'late', false, null]);
      f.advance(2);
    }),
    InMemoryDeadlineExceeded,
  );
  await f.run(async context => assert.equal((await f.memory(context).read([f.ids.member])).rowCount, 0));
});

test('a suspended tenant transaction does not block a different tenant', { timeout: 5000 }, async t => {
  const f = await fixture();
  let release;
  const gate = new Promise(resolve => {
    release = resolve;
  });
  t.after(() => release());
  const suspended = f.run(async context => {
    await f.memory(context).insert([f.ids.member, 'first tenant', false, null]);
    await gate;
  });
  await f.runtime.transaction('second-tenant', {}, async context => {
    await f.memory(context).insert([f.ids.member, 'second tenant', false, null]);
  });
  release();
  await suspended;
});

test('same-tenant re-entry fails explicitly instead of waiting on its own transaction', async () => {
  const f = await fixture();
  await f.run(async () => {
    await assert.rejects(
      f.run(async () => assert.fail('nested operation must not start')),
      /Nested memory transaction/,
    );
    await f.runtime.transaction('second-tenant', {}, async () =>
      assert.rejects(
        f.run(async () => assert.fail('cyclic operation must not start')),
        /Nested memory transaction/,
      ),
    );
  });
  await f.run(async context => assert.equal((await f.memory(context).read([f.ids.member])).rowCount, 0));
});

test('fixture input mutations and invalid timestamps do not alter stored memory', async () => {
  const f = await fixture();
  const input = { memories: [{ membershipId: f.ids.member, content: 'retained' }] };
  await f.seed(input);
  input.memories[0].content = 'tampered';
  await f.run(async context => {
    const repository = f.memory(context);
    await assert.rejects(repository.replace([f.ids.member, 'invalid', 1, true, 'not a timestamp']), RangeError);
    assert.deepEqual((await repository.read([f.ids.member])).rows, [{ content: 'retained', revision: 1 }]);
  });
  await assert.rejects(
    f.runtime.transaction(f.tenant, { deadlineAt: NaN }, async () => {}),
    RangeError,
  );
});

function personalMemory(f, onChanged = async () => {}) {
  return createPersonalMemory({
    repository: f.memory,
    authorization: {
      lock: async () => ({ kind: 'allowed', value: undefined }),
      member: async (_context, actor) =>
        actor.membershipId === f.ids.member
          ? { kind: 'allowed', value: undefined }
          : { kind: 'denied', error: new Error('not the requester') },
    },
    available: () => true,
    egressPolicy: { deny() {} },
    onChanged,
  });
}

test('the real personal-memory algorithm has one concurrent winner on the reference runtime', async () => {
  const f = await fixture();
  const memory = personalMemory(f);
  const actor = { kind: 'human', membershipId: f.ids.member, userId: 'requester' };
  const results = await Promise.allSettled([
    f.run(context => memory.replace(context, actor, 'first', 0)),
    f.run(context => memory.replace(context, actor, 'second', 0)),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.ok(results.find(result => result.status === 'rejected').reason instanceof PersonalMemoryConflict);
  const stored = await f.run(context => memory.read(context, actor));
  assert.equal(stored.revision, 1);
  await f.run(context => memory.replace(context, actor, '', stored.revision));
  await assert.rejects(
    f.run(context => memory.replace(context, actor, 'stale', 0)),
    PersonalMemoryConflict,
  );
});

test('a failed host invalidation rolls back the real personal-memory write and pending-step cleanup', async () => {
  const f = await fixture();
  await f.seed({ steps: [{ jobId: f.ids.job, purpose: 'memory' }] });
  const failure = new Error('host invalidation failed');
  const memory = personalMemory(f, async () => {
    throw failure;
  });
  const actor = { kind: 'human', membershipId: f.ids.member, userId: 'requester' };
  await assert.rejects(
    f.run(context => memory.replace(context, actor, 'not saved', 0)),
    error => error === failure,
  );
  await f.run(async context => {
    assert.equal((await f.memory(context).read([f.ids.member])).rowCount, 0);
    assert.equal((await f.memory(context).clearPending([f.ids.member])).rowCount, 1);
  });
});

test('the real reconciliation algorithm learns quoted requester text and commits progress atomically', async () => {
  const f = await fixture();
  const message = messageSeed(f.ids, 1, {
    parts: [{ ordinal: 0, kind: 'text', text: 'Use plain words.' }],
  });
  await f.seed({ messages: [message], steps: [{ jobId: f.ids.job, purpose: 'memory' }] });
  let changes = 0;
  const memory = personalMemory(f, async () => {
    changes++;
  });
  const actor = { kind: 'human', membershipId: f.ids.member, userId: 'requester' };
  const reconcile = createMemoryReconciliation({ repository: f.reconciliation, transcript: f.transcript, memory });
  const fence = { jobId: f.ids.job, conversationId: f.ids.conversation, generation: 3 };
  let previousContext;
  const transaction = operation =>
    f.run(context => {
      previousContext = context;
      return operation(context, { actor, coveredThrough: 6, policy: null });
    });
  let modelCalls = 0;
  const compactor = {
    policy: async () => ({ families: ['reference'] }),
    summarize: async input => {
      modelCalls++;
      await assert.rejects(f.memory(previousContext).read([f.ids.member]), /Inactive or foreign/);
      assert.equal(input.purpose, 'memory');
      assert.ok(input.messages[0].text.includes(message.id));
      return {
        text: JSON.stringify({
          content: 'Use plain words.',
          evidence: [{ messageId: message.id, quote: 'plain words' }],
        }),
        familyId: 'reference',
        fallbackFrom: null,
      };
    },
  };
  assert.equal(await reconcile(transaction, fence, compactor), true);
  assert.equal(await reconcile(transaction, fence, compactor), true);
  assert.equal(modelCalls, 1);
  assert.equal(changes, 1);
  await f.run(async context => {
    assert.deepEqual(await memory.read(context, actor), { content: 'Use plain words.', revision: 1 });
    const progress = (await f.reconciliation(context).progress([f.ids.job])).rows[0];
    assert.equal(progress.memory_complete, true);
    assert.equal(progress.memory_chunk, 1);
    assert.equal(progress.memory_step, 1);
    assert.equal(progress.memory_base_revision, null);
    assert.equal(
      (await f.reconciliation(context).watermark([f.ids.member])).rows[0].reconciled_through,
      message.createdAt,
    );
    assert.equal((await f.reconciliation(context).clearStep([f.ids.job])).rowCount, 0);
  });
});
