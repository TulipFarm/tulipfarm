import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createPersonalMemory } from '../dist/memory/personal-memory.js';
import { createMemoryReconciliation } from '../dist/memory/reconciliation.js';

const result = (...rows) => ({ rows, rowCount: rows.length });

function fixture({
  project = false,
  owner = true,
  messages = true,
  unchanged = false,
  afterModel,
  invalidEvidence = false,
  older = false,
} = {}) {
  const context = Symbol('fenced transaction');
  const actor = { kind: 'human', userId: 'reader', membershipId: randomUUID() };
  const fence = { jobId: randomUUID(), conversationId: randomUUID(), generation: 2, epoch: 3, kind: 'maintenance' };
  const message = {
    id: randomUUID(),
    text: 'Please use emojis.',
    createdAt: '2026-10-20T00:00:00.000Z',
    acceptedSequence: 4,
  };
  const progress = {
    memory_complete: false,
    memory_chunk: 0,
    memory_step: 0,
    memory_base_revision: null,
    memory_manual_at: null,
    memory_reconciled_through: null,
  };
  const stored = { content: 'Keep it short.', revision: 1 };
  const timestamps = { manual_updated_at: null, reconciled_through: older ? '2026-10-21T00:00:00.000Z' : null };
  const trace = [];
  let revoked = false;
  let transactionOpen = false;
  const denied = new Error('stale authority');
  const memory = createPersonalMemory({
    repository: value => {
      assert.equal(value, context);
      return {
        read: async () => {
          trace.push('memory-read');
          return result({ ...stored });
        },
        replace: async ([id, content, revision, automatic, through]) => {
          assert.equal(id, actor.membershipId);
          assert.equal(revision, stored.revision);
          assert.equal(automatic, true);
          assert.equal(through, message.createdAt);
          trace.push('memory-replace');
          stored.content = content;
          stored.revision++;
          return result({ ...stored });
        },
        clearPending: async () => assert.fail('automatic writes must not clear manual pending steps'),
      };
    },
    authorization: {
      lock: async () => ({ kind: 'allowed', value: undefined }),
      member: async () => (revoked ? { kind: 'denied', error: denied } : { kind: 'allowed', value: undefined }),
    },
    available: () => true,
    egressPolicy: { deny() {} },
    onChanged: async () => {
      trace.push('changed');
    },
  });
  const repository = {
    progress: async () => result({ ...progress }),
    owner: async () =>
      result({
        owner_membership_id: owner ? actor.membershipId : randomUUID(),
        project_id: project ? randomUUID() : null,
      }),
    complete: async () => {
      trace.push('complete');
      progress.memory_complete = true;
      return result();
    },
    completeEmpty: async () => {
      trace.push('complete-empty');
      progress.memory_complete = true;
      return result();
    },
    timestamps: async () => result({ ...timestamps }),
    watermark: async () => result({ reconciled_through: timestamps.reconciled_through }),
    saveProgress: async ([id, chunk, step, revision, manualAt, through]) => {
      assert.equal(id, fence.jobId);
      Object.assign(progress, {
        memory_chunk: chunk,
        memory_step: step,
        memory_base_revision: revision,
        memory_manual_at: manualAt,
        memory_reconciled_through: through,
      });
      trace.push('progress');
      return result();
    },
    clearStep: async () => {
      trace.push('clear-step');
      return result();
    },
    restart: async () => {
      trace.push('restart');
      progress.memory_step++;
      progress.memory_base_revision = null;
      return result();
    },
    advanceWatermark: async ([id, through]) => {
      assert.equal(id, actor.membershipId);
      assert.equal(through, message.createdAt);
      trace.push('watermark');
      timestamps.reconciled_through = through;
      return result();
    },
    finish: async ([id, chunk, step, complete]) => {
      assert.equal(id, fence.jobId);
      Object.assign(progress, {
        memory_chunk: chunk,
        memory_step: step,
        memory_base_revision: null,
        memory_complete: complete,
      });
      trace.push('finish');
      return result();
    },
  };
  const reconcile = createMemoryReconciliation({
    repository: value => {
      assert.equal(value, context);
      return repository;
    },
    transcript: value => {
      assert.equal(value, context);
      return {
        requesterMessages: async values => {
          assert.deepEqual(values, [
            fence.conversationId,
            actor.membershipId,
            4,
            timestamps.manual_updated_at,
            fence.generation,
          ]);
          trace.push('transcript');
          return result(...(messages ? [message] : []));
        },
      };
    },
    memory,
  });
  const requests = [];
  const compactor = {
    policy: async value => {
      assert.equal(value, context);
      trace.push('policy');
      return { families: ['approved'] };
    },
    summarize: async input => {
      assert.equal(transactionOpen, false);
      trace.push('model');
      requests.push(input);
      afterModel?.({
        stored,
        timestamps,
        revoke: () => {
          revoked = true;
        },
      });
      return {
        text: JSON.stringify({
          content: unchanged ? null : 'Keep it short.\nUse emojis.',
          evidence: unchanged ? [] : [{ messageId: message.id, quote: invalidEvidence ? 'never said' : 'use emojis' }],
        }),
        familyId: 'approved',
        fallbackFrom: null,
      };
    },
  };
  let transactions = 0;
  const run = () =>
    reconcile(
      async operation => {
        trace.push('fence');
        transactions++;
        transactionOpen = true;
        try {
          return await operation(context, { actor, coveredThrough: 4, policy: null });
        } finally {
          transactionOpen = false;
        }
      },
      fence,
      compactor,
    );
  return {
    run,
    stored,
    timestamps,
    progress,
    requests,
    trace,
    denied,
    get transactions() {
      return transactions;
    },
  };
}

test('reconciliation learns only exact requester evidence between two fenced transactions', async () => {
  const f = fixture();
  assert.equal(await f.run(), true);
  assert.deepEqual(f.stored, { content: 'Keep it short.\nUse emojis.', revision: 2 });
  assert.equal(f.transactions, 2);
  assert.equal(f.requests[0].purpose, 'memory');
  assert.deepEqual(f.requests[0].families, ['approved']);
  assert.match(f.requests[0].system, /untrusted data/);
  assert.match(JSON.parse(f.requests[0].messages[0].text).requesterTranscript, /role="requester"/);
  assert.ok(f.trace.indexOf('progress') < f.trace.indexOf('model'));
  assert.ok(f.trace.indexOf('model') < f.trace.lastIndexOf('memory-read'));
  assert.ok(f.trace.indexOf('memory-replace') < f.trace.indexOf('finish'));
  assert.equal(f.progress.memory_complete, true);
  assert.equal(f.trace.at(-1), 'clear-step');
});

test('manual edits during generation restart reconciliation and cannot be overwritten', async () => {
  const f = fixture({
    afterModel: ({ stored }) => {
      stored.content = 'Manual edit';
      stored.revision++;
    },
  });
  assert.equal(await f.run(), false);
  assert.deepEqual(f.stored, { content: 'Manual edit', revision: 2 });
  assert.ok(!f.trace.includes('memory-replace'));
  assert.deepEqual(f.trace.slice(-2), ['clear-step', 'restart']);
});

test('a concurrent watermark advance also restarts reconciliation without replacing memory', async () => {
  const f = fixture({
    afterModel: ({ timestamps }) => {
      timestamps.reconciled_through = '2026-10-21T00:00:00.000Z';
    },
  });
  assert.equal(await f.run(), false);
  assert.equal(f.stored.revision, 1);
  assert.ok(f.trace.includes('restart'));
  assert.ok(!f.trace.includes('memory-replace'));
});

test('no-change output advances only the watermark, not the personal revision', async () => {
  const f = fixture({ unchanged: true });
  assert.equal(await f.run(), true);
  assert.deepEqual(f.stored, { content: 'Keep it short.', revision: 1 });
  assert.equal(f.timestamps.reconciled_through, '2026-10-20T00:00:00.000Z');
  assert.ok(f.trace.includes('watermark'));
  assert.ok(!f.trace.includes('changed'));
});

test('project chats, other owners, and exhausted transcripts do not call the summarizer', async () => {
  for (const options of [{ project: true }, { owner: false }, { messages: false }]) {
    const f = fixture(options);
    assert.equal(await f.run(), true);
    assert.equal(f.requests.length, 0);
    assert.equal(f.transactions, 1);
    assert.ok(!f.trace.includes('policy'));
    assert.ok(!f.trace.includes('memory-replace'));
  }
});

test('manual edits reset chunk position and invalidate both manual and revision replay steps', async () => {
  const f = fixture();
  Object.assign(f.progress, { memory_chunk: 9, memory_step: 4, memory_base_revision: 0 });
  f.timestamps.manual_updated_at = '2026-10-19T00:00:00.000Z';
  assert.equal(await f.run(), true);
  assert.equal(f.requests[0].step, 6);
  assert.equal(f.progress.memory_chunk, 1);
  assert.equal(f.progress.memory_step, 7);
});

test('completed reconciliation replays without another model call or personal-memory write', async () => {
  const f = fixture();
  assert.equal(await f.run(), true);
  assert.equal(await f.run(), true);
  assert.equal(f.requests.length, 1);
  assert.equal(f.stored.revision, 2);
  assert.equal(f.transactions, 3);
});

test('invalid evidence and revoked final access cannot publish generated memory', async () => {
  const invalid = fixture({ invalidEvidence: true });
  await assert.rejects(invalid.run(), { message: 'memory-invalid-preferences' });
  assert.equal(invalid.transactions, 1);
  assert.equal(invalid.stored.revision, 1);
  const revoked = fixture({ afterModel: ({ revoke }) => revoke() });
  await assert.rejects(revoked.run(), error => error === revoked.denied);
  assert.equal(revoked.transactions, 2);
  assert.equal(revoked.stored.revision, 1);
});

test('older backfills preserve current wording and carry the unchanged append-only prompt', async () => {
  const f = fixture({ older: true });
  assert.equal(await f.run(), true);
  assert.match(f.requests[0].system, /Preserve the ENTIRE current memory byte for byte/);
  assert.equal(f.stored.content, 'Keep it short.\nUse emojis.');
});
