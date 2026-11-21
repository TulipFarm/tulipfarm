import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export function memoryFixtureIds() {
  return Object.fromEntries(
    ['member', 'other', 'conversation', 'otherConversation', 'job', 'otherJob', 'previousJob'].map(key => [
      key,
      randomUUID(),
    ]),
  );
}

export function jobSeed(ids, id = ids.job, overrides = {}) {
  return {
    id,
    conversationId: ids.conversation,
    membershipId: ids.member,
    generation: 3,
    coveredThrough: 6,
    ...overrides,
  };
}

export function baseMemorySeed(ids) {
  return {
    conversations: [
      { id: ids.conversation, owner_membership_id: ids.member, project_id: null },
      { id: ids.otherConversation, owner_membership_id: ids.other, project_id: null },
    ],
    jobs: [
      jobSeed(ids),
      jobSeed(ids, ids.otherJob, { conversationId: ids.otherConversation, membershipId: ids.other }),
      jobSeed(ids, ids.previousJob, { generation: 1, coveredThrough: 2 }),
    ],
  };
}

function timestamp(value) {
  if (value === null) return null;
  const iso = new Date(value).toISOString();
  const fraction = value.match(/\d{2}:\d{2}:\d{2}\.(\d+)/)?.[1]?.padEnd(6, '0') ?? '000000';
  return fraction.slice(3) === '000' ? iso : `${iso.slice(0, -5)}.${fraction}Z`;
}

function normalizeProgress(row) {
  return {
    ...row,
    memory_manual_at: timestamp(row.memory_manual_at),
    memory_reconciled_through: timestamp(row.memory_reconciled_through),
  };
}

function assertResult({ rows, rowCount }, expected) {
  assert.deepEqual({ rows, rowCount }, expected);
}

function register(test, label, create, cases) {
  for (const [name, check] of Object.entries(cases))
    test(`${label}: ${name}`, async t => {
      const fixture = await create(t);
      await check(fixture);
    });
}

/** Fixtures supply isolated storage, seed(), run(), and the reconciliation and transcript port factories. */
export function memoryReconciliationConformance(test, label, create) {
  register(test, label, create, {
    async 'owner and progress reads preserve absence and exact fields'(f) {
      await f.run(async context => {
        const repository = f.reconciliation(context);
        assert.deepEqual((await repository.owner([f.ids.conversation])).rows, [
          { owner_membership_id: f.ids.member, project_id: null },
        ]);
        assertResult(await repository.owner([f.ids.member]), { rows: [], rowCount: 0 });
        assertResult(await repository.progress([f.ids.member]), { rows: [], rowCount: 0 });
        assert.deepEqual((await repository.progress([f.ids.job])).rows, [
          {
            memory_complete: false,
            memory_chunk: 0,
            memory_step: 0,
            memory_base_revision: null,
            memory_manual_at: null,
            memory_reconciled_through: null,
          },
        ]);
      });
    },
    async 'saved progress round-trips its optimistic revision and timestamps'(f) {
      await f.run(async context => {
        const repository = f.reconciliation(context);
        const at = '2020-01-01T00:00:00.000Z';
        assert.equal((await repository.saveProgress([f.ids.job, 2, 7, 4, at, at])).rowCount, 1);
        assert.deepEqual(normalizeProgress((await repository.progress([f.ids.job])).rows[0]), {
          memory_complete: false,
          memory_chunk: 2,
          memory_step: 7,
          memory_base_revision: 4,
          memory_manual_at: at,
          memory_reconciled_through: at,
        });
        assert.equal((await repository.saveProgress([f.ids.member, 2, 7, 4, null, null])).rowCount, 0);
      });
    },
    async 'completion and empty completion retain their distinct revision behavior'(f) {
      await f.run(async context => {
        const repository = f.reconciliation(context);
        await repository.saveProgress([f.ids.job, 2, 7, 4, null, null]);
        await repository.complete([f.ids.job]);
        let row = (await repository.progress([f.ids.job])).rows[0];
        assert.equal(row.memory_complete, true);
        assert.equal(row.memory_base_revision, 4);
        await repository.completeEmpty([f.ids.job]);
        row = (await repository.progress([f.ids.job])).rows[0];
        assert.equal(row.memory_complete, true);
        assert.equal(row.memory_base_revision, null);
        assert.equal(row.memory_chunk, 2);
        assert.equal((await repository.complete([f.ids.member])).rowCount, 0);
        assert.equal((await repository.completeEmpty([f.ids.member])).rowCount, 0);
      });
    },
    async 'restart increments the step without advancing the chunk'(f) {
      await f.run(async context => {
        const repository = f.reconciliation(context);
        await repository.saveProgress([f.ids.job, 2, 7, 4, null, null]);
        await repository.restart([f.ids.job]);
        const row = (await repository.progress([f.ids.job])).rows[0];
        assert.equal(row.memory_step, 8);
        assert.equal(row.memory_chunk, 2);
        assert.equal(row.memory_base_revision, null);
        assert.equal(row.memory_complete, false);
        assert.equal((await repository.restart([f.ids.member])).rowCount, 0);
      });
    },
    async 'finish records caller progress and completion while clearing the base revision'(f) {
      await f.run(async context => {
        const repository = f.reconciliation(context);
        await repository.saveProgress([f.ids.job, 2, 7, 4, null, null]);
        await repository.finish([f.ids.job, 3, 8, false]);
        assert.deepEqual((await repository.progress([f.ids.job])).rows[0], {
          memory_complete: false,
          memory_chunk: 3,
          memory_step: 8,
          memory_base_revision: null,
          memory_manual_at: null,
          memory_reconciled_through: null,
        });
        await repository.finish([f.ids.job, 4, 9, true]);
        assert.equal((await repository.progress([f.ids.job])).rows[0].memory_complete, true);
        assert.equal((await repository.finish([f.ids.member, 4, 9, true])).rowCount, 0);
      });
    },
    async 'clearing a step affects only memory steps in its own job'(f) {
      await f.seed({
        steps: [
          { jobId: f.ids.job, purpose: 'memory' },
          { jobId: f.ids.job, purpose: 'summary' },
          { jobId: f.ids.otherJob, purpose: 'memory' },
        ],
      });
      await f.run(async context => {
        const repository = f.reconciliation(context);
        assert.equal((await repository.clearStep([f.ids.job])).rowCount, 1);
        assert.equal((await repository.clearStep([f.ids.job])).rowCount, 0);
        assert.equal((await repository.clearStep([f.ids.otherJob])).rowCount, 1);
      });
    },
  });
}

export function messageSeed(ids, sequence, overrides = {}) {
  return {
    id: randomUUID(),
    conversationId: ids.conversation,
    membershipId: ids.member,
    authorKind: 'human',
    sequence,
    acceptedSequence: sequence,
    createdAt: `2020-01-01T00:00:0${sequence}.000Z`,
    internal: false,
    parts: [{ ordinal: 0, kind: 'text', text: `message ${sequence}` }],
    ...overrides,
  };
}

export function transcriptSourceConformance(test, label, create) {
  const read = (f, context, through = 6, manualAt = null, generation = 3) =>
    f.transcript(context).requesterMessages([f.ids.conversation, f.ids.member, through, manualAt, generation]);
  register(test, label, create, {
    async 'only direct requester text crosses the transcript port'(f) {
      const good = messageSeed(f.ids, 1);
      await f.seed({
        messages: [
          good,
          messageSeed(f.ids, 2, { membershipId: f.ids.other }),
          messageSeed(f.ids, 3, { authorKind: 'agent' }),
          messageSeed(f.ids, 4, { internal: true }),
          messageSeed(f.ids, 5, { conversationId: f.ids.otherConversation }),
          messageSeed(f.ids, 6, { parts: [{ ordinal: 0, kind: 'tool', text: 'untrusted tool' }] }),
        ],
      });
      await f.run(async context => {
        const rows = (await read(f, context)).rows;
        assert.equal(rows.length, 1);
        assert.deepEqual(
          { ...rows[0], createdAt: timestamp(rows[0].createdAt) },
          { id: good.id, text: 'message 1', acceptedSequence: 1, createdAt: good.createdAt },
        );
      });
    },
    async 'text parts use ordinal order and messages use sequence order'(f) {
      const first = messageSeed(f.ids, 1, {
        acceptedSequence: 5,
        parts: [
          { ordinal: 2, kind: 'text', text: 'second' },
          { ordinal: 1, kind: 'text', text: 'first' },
          { ordinal: 0, kind: 'tool', text: 'excluded' },
        ],
      });
      const second = messageSeed(f.ids, 2, { acceptedSequence: 3 });
      await f.seed({ messages: [second, first] });
      await f.run(async context => {
        const rows = (await read(f, context)).rows;
        assert.deepEqual(
          rows.map(row => row.id),
          [first.id, second.id],
        );
        assert.equal(rows[0].text, 'first\nsecond');
      });
    },
    async 'accepted coverage is inclusive and null coverage reads nothing'(f) {
      await f.seed({ messages: [messageSeed(f.ids, 1), messageSeed(f.ids, 2), messageSeed(f.ids, 3)] });
      await f.run(async context => {
        assert.deepEqual(
          (await read(f, context, 2)).rows.map(row => row.acceptedSequence),
          [1, 2],
        );
        assertResult(await read(f, context, null), { rows: [], rowCount: 0 });
      });
    },
    async 'only completed earlier generations advance the lower coverage bound'(f) {
      await f.seed({
        jobs: [
          jobSeed(f.ids, f.ids.previousJob, { generation: 1, coveredThrough: 2, memory_complete: true }),
          jobSeed(f.ids, randomUUID(), { generation: 2, coveredThrough: 5, memory_complete: false }),
          jobSeed(f.ids, randomUUID(), { generation: 3, coveredThrough: 5, memory_complete: true }),
          jobSeed(f.ids, randomUUID(), { generation: 4, coveredThrough: 5, memory_complete: true }),
          jobSeed(f.ids, randomUUID(), {
            conversationId: f.ids.otherConversation,
            generation: 1,
            coveredThrough: 5,
            memory_complete: true,
          }),
        ],
        messages: [messageSeed(f.ids, 1), messageSeed(f.ids, 2), messageSeed(f.ids, 3)],
      });
      await f.run(async context =>
        assert.deepEqual(
          (await read(f, context)).rows.map(row => row.acceptedSequence),
          [3],
        ),
      );
    },
    async 'manual updates exclude equal and earlier creation times'(f) {
      await f.seed({ messages: [messageSeed(f.ids, 1), messageSeed(f.ids, 2), messageSeed(f.ids, 3)] });
      await f.run(async context =>
        assert.deepEqual(
          (await read(f, context, 6, '2020-01-01T00:00:02.000Z')).rows.map(row => row.acceptedSequence),
          [3],
        ),
      );
    },
    async 'manual cutoffs retain microsecond precision'(f) {
      await f.seed({
        messages: [
          messageSeed(f.ids, 1, { createdAt: '2020-01-01T00:00:00.000001Z' }),
          messageSeed(f.ids, 2, { createdAt: '2020-01-01T00:00:00.000002Z' }),
          messageSeed(f.ids, 3, { createdAt: '2020-01-01T00:00:00.000003Z' }),
        ],
      });
      await f.run(async context =>
        assert.deepEqual(
          (await read(f, context, 6, '2020-01-01T00:00:00.000002Z')).rows.map(row => row.acceptedSequence),
          [3],
        ),
      );
    },
    async 'null text aggregates remain null rather than inventing text'(f) {
      await f.seed({ messages: [messageSeed(f.ids, 1, { parts: [{ ordinal: 0, kind: 'text', text: null }] })] });
      await f.run(async context => {
        const value = await read(f, context);
        assert.equal(value.rowCount, 1);
        assert.equal(value.rows[0].text, null);
      });
    },
    async 'returned message rows do not expose mutable adapter state'(f) {
      await f.seed({ messages: [messageSeed(f.ids, 1)] });
      await f.run(async context => {
        const value = await read(f, context);
        value.rows[0].text = 'tampered';
        assert.equal((await read(f, context)).rows[0].text, 'message 1');
      });
    },
  });
}
