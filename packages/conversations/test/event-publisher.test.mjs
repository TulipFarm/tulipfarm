import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { applyStreamText, conversationEventChannel, conversationNotificationSchema } from '../src/events.ts';
import {
  createReplyTextPublisher,
  notifyConversationChange,
  notifyConversationTool,
  streamTextPayloads,
} from '../src/event-publisher.ts';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';

const address = {
  workspaceId: '00000000-0000-4000-8000-000000000001',
  conversationId: '00000000-0000-4000-8000-000000000002',
};
const identity = { turnId: '00000000-0000-4000-8000-000000000003', generation: 2, epoch: 3, step: 1 };
const fence = { ...address, turnId: identity.turnId, generation: 2, epoch: 3 };
const textUpdate = ({ kind: _kind, workspaceId: _workspaceId, conversationId: _conversationId, ...update }) => update;

test('transactional receipts publish distinct running and terminal lifecycle notifications without coalescing', async () => {
  const sent = [];
  const tx = {
    client: {
      query: async (sql, values) => {
        assert.equal(sql, 'SELECT pg_notify($1, $2)');
        assert.equal(values[0], conversationEventChannel);
        sent.push(conversationNotificationSchema.parse(JSON.parse(values[1])));
      },
    },
  };
  const call = {
    ...fence,
    id: address.conversationId,
    sequence: 1,
    tool: 'rows.get',
    presentation: { label: 'Reading a row', brand: null },
  };
  await notifyConversationTool(tx, { ...call, status: 'running' });
  await notifyConversationTool(tx, { ...call, status: 'completed' });
  assert.deepEqual(
    sent.map(event => [event.kind, event.id, event.status]),
    [
      ['tool', call.id, 'running'],
      ['tool', call.id, 'completed'],
    ],
  );
});

test('avatar publication carries the reply fence and monotonically ordered validated states', async () => {
  const sent = [];
  const runtime = {
    async transaction(_workspaceId, _range, operation) {
      await operation({
        client: {
          query: async (_sql, values) => sent.push(conversationNotificationSchema.parse(JSON.parse(values[1]))),
        },
      });
    },
  };
  const publisher = createReplyTextPublisher(runtime, fence);
  publisher.avatar(0, { name: 'Bud', state: 'Thinking' });
  publisher.avatar(0, { name: 'Bud', state: 'Solving' });
  assert.throws(() => publisher.avatar(0, { name: 'Bud', state: 'Invalid' }));
  await publisher.close();
  publisher.avatar(1, { name: 'Bud', state: 'Idle' });
  assert.deepEqual(
    sent.map(({ kind, generation, epoch, seq, avatar }) => ({ kind, generation, epoch, seq, state: avatar.state })),
    [
      { kind: 'avatar', generation: 2, epoch: 3, seq: 0, state: 'Thinking' },
      { kind: 'avatar', generation: 2, epoch: 3, seq: 1, state: 'Solving' },
    ],
  );
});

function replay(state, payloads) {
  for (const payload of payloads) {
    assert.ok(Buffer.byteLength(JSON.stringify(payload)) <= 7000, 'payload fits in one NOTIFY');
    assert.deepEqual(conversationNotificationSchema.parse(payload), payload);
    state = applyStreamText(state, textUpdate(payload));
  }
  return state;
}

test('a short reply is one full-text reset', () => {
  assert.deepEqual(streamTextPayloads(address, identity, 'Hel', 'Hello', 4), [
    { kind: 'text', ...address, ...identity, seq: 4, offset: 0, text: 'Hello', reset: true },
  ]);
  assert.deepEqual(streamTextPayloads(address, identity, 'Hello', 'Hello', 5), []);
});

test('long replies split into byte-bounded payloads that rebuild the exact text', () => {
  const cases = [
    { name: 'multi-byte prefix extension', published: 'é🌷漢'.repeat(900), next: 'é🌷漢'.repeat(2400) },
    { name: 'escape-heavy prefix extension', published: 'start', next: 'start' + '\u0001"\\\n\u001f'.repeat(2500) },
    { name: 'new identity', published: null, next: '🌷'.repeat(5000) + 'tail' },
    { name: 'rewritten text', published: 'x'.repeat(9000), next: 'y'.repeat(12000) },
  ];
  for (const { name, published, next } of cases) {
    const payloads = streamTextPayloads(address, identity, published, next, 7);
    assert.ok(payloads.length > 1, `${name} needs several payloads`);
    assert.deepEqual(
      payloads.map(payload => payload.seq),
      payloads.map((_, index) => 7 + index),
      `${name} sequence is consecutive`,
    );
    const before = published === null ? undefined : { identity, seq: 6, text: published, complete: true };
    assert.equal(
      payloads[0].reset,
      published === null || !next.startsWith(published),
      `${name} resets only when the text is not an extension`,
    );
    assert.deepEqual(
      replay(before, payloads),
      { identity, seq: 6 + payloads.length, text: next, complete: true },
      name,
    );
  }
});

const sleep = ms => delay(ms);
function recordingRuntime({ fail = () => false, hold = () => null } = {}) {
  const transactions = [];
  let open = 0,
    concurrent = 0,
    attempts = 0;
  return {
    transactions,
    concurrency: () => concurrent,
    async transaction(workspaceId, range, operation) {
      open++;
      concurrent = Math.max(concurrent, open);
      const attempt = attempts++;
      try {
        const sent = [];
        await hold(attempt);
        await operation({
          client: {
            query: async (sql, values) => {
              assert.equal(sql, 'SELECT pg_notify($1, $2)');
              assert.equal(values[0], conversationEventChannel);
              sent.push(conversationNotificationSchema.parse(JSON.parse(values[1])));
            },
          },
        });
        if (fail(attempt)) throw new Error('database unavailable');
        transactions.push({
          workspaceId,
          range,
          at: Date.now(),
          sent: sent.map(textUpdate).map(({ step, seq, text, reset }) => ({ step, seq, text, reset })),
        });
      } finally {
        open--;
      }
    },
  };
}

test('publisher coalesces bursts, throttles, starts each step at seq 0, and flushes on close', async () => {
  const runtime = recordingRuntime();
  const publisher = createReplyTextPublisher(runtime, fence, 100);
  publisher.update(0, 'H');
  publisher.update(0, 'He');
  await sleep(20);
  publisher.update(0, 'Hel');
  publisher.update(0, 'Hello');
  await sleep(40);
  assert.equal(runtime.transactions.length, 1, 'second publication waits for the interval');
  await sleep(100);
  publisher.update(1, 'Done');
  publisher.update(1, 'Done.');
  await publisher.close();
  publisher.update(1, 'ignored after close');
  await sleep(150);
  assert.deepEqual(
    runtime.transactions.map(({ sent }) => sent),
    [
      [{ step: 0, seq: 0, text: 'He', reset: true }],
      [{ step: 0, seq: 1, text: 'Hello', reset: true }],
      [{ step: 1, seq: 0, text: 'Done.', reset: true }],
    ],
  );
  assert.deepEqual(runtime.transactions[0].range, commonCompatibility);
  assert.equal(runtime.transactions[0].workspaceId, address.workspaceId);
  assert.ok(
    runtime.transactions[1].at - runtime.transactions[0].at >= 95,
    'publications start at least one interval apart',
  );
});

test('publisher keeps one transaction in flight', async () => {
  const runtime = recordingRuntime({ hold: () => sleep(60) });
  const publisher = createReplyTextPublisher(runtime, fence, 5);
  for (let index = 1; index <= 10; index++) {
    publisher.update(0, 'x'.repeat(index));
    await sleep(15);
  }
  await publisher.close();
  assert.equal(runtime.concurrency(), 1);
  assert.equal(runtime.transactions.at(-1).sent.at(-1).text, 'x'.repeat(10));
  assert.ok(runtime.transactions.length < 10, 'updates during a publication coalesce');
});

test('publisher swallows failures and resets after an uncertain publication', async () => {
  const runtime = recordingRuntime({ fail: attempt => attempt === 0 });
  const publisher = createReplyTextPublisher(runtime, fence, 10);
  publisher.update(0, 'first');
  await sleep(30);
  publisher.update(0, 'first second');
  await publisher.close();
  assert.deepEqual(
    runtime.transactions.map(({ sent }) => sent),
    [[{ step: 0, seq: 1, text: 'first', reset: true }], [{ step: 0, seq: 2, text: 'first second', reset: true }]],
  );
});

test('progress publishes each round in order, swallows failures, and stops after close', async () => {
  const sent = [];
  let attempts = 0;
  const runtime = {
    async transaction(_workspaceId, _range, operation) {
      if (attempts++ === 1) throw new Error('database unavailable');
      await operation({
        client: {
          query: async (_sql, values) => {
            sent.push(conversationNotificationSchema.parse(JSON.parse(values[1])));
          },
        },
      });
    },
  };
  const publisher = createReplyTextPublisher(runtime, fence, 10);
  publisher.progress({ step: 0, round: 1 });
  publisher.progress({ step: 1, round: 2, status: 'tool', tool: 'Knowledge', toolRounds: 0 });
  publisher.progress({ step: 1, round: 2, status: 'tool', tool: 'x'.repeat(80), toolRounds: 0 });
  publisher.progress({ step: 2, round: 3, status: 'done', tool: 'Knowledge', toolRounds: 1 });
  await publisher.close();
  publisher.progress({ step: 3, round: 4, status: 'thinking', toolRounds: 1 });
  await sleep(20);
  assert.deepEqual(sent, [
    { kind: 'progress', ...address, ...identity, step: 0, round: 1 },
    {
      kind: 'progress',
      ...address,
      ...identity,
      step: 1,
      round: 2,
      status: 'tool',
      toolRounds: 0,
      seq: 1,
      tool: 'x'.repeat(64),
    },
    { kind: 'progress', ...address, ...identity, step: 2, round: 3, status: 'done', toolRounds: 1, seq: 2 },
  ]);
});

test('close is bounded when the database hangs', async () => {
  const publisher = createReplyTextPublisher({ transaction: () => new Promise(() => {}) }, fence, 10, 50);
  publisher.update(0, 'stuck');
  const started = Date.now();
  await publisher.close();
  assert.ok(Date.now() - started < 500, 'close returns after its timeout');
});

test('change notifications carry a parseable changed payload', async () => {
  const calls = [];
  await notifyConversationChange(
    {
      client: {
        query: async (sql, values) => {
          calls.push([sql, values[0], JSON.parse(values[1])]);
        },
      },
    },
    { ...address, turnId: identity.turnId, settled: true },
  );
  assert.deepEqual(calls, [
    [
      'SELECT pg_notify($1, $2)',
      'tf_conversation_events',
      { kind: 'changed', ...address, turnId: identity.turnId, settled: true },
    ],
  ]);
});

test('sub-agent cards coalesce per call, carry the reply fence, and flush on close', async () => {
  const sent = [];
  const runtime = {
    async transaction(_workspaceId, _range, operation) {
      await operation({
        client: {
          query: async (_sql, values) => sent.push(conversationNotificationSchema.parse(JSON.parse(values[1]))),
        },
      });
    },
  };
  const card = (status, step) => ({
    key: 'a0',
    kind: 'helper',
    name: 'Scout',
    role: 'Researcher',
    status,
    ...(step ? { step } : {}),
    credits: 0.5,
    elapsedMs: 10,
  });
  const callId = '00000000-0000-4000-8000-000000000009';
  const publisher = createReplyTextPublisher(runtime, fence, 20);
  publisher.subagents(callId, [card('queued')]);
  publisher.subagents(callId, [card('running', 'Searching the web')]);
  await delay(40);
  publisher.subagents(callId, [card('done')]);
  await publisher.close();
  publisher.subagents(callId, [card('failed')]);
  await delay(40);
  assert.deepEqual(
    sent.map(({ kind, id, turnId, generation, epoch, seq, agents }) => ({
      kind,
      id,
      turnId,
      generation,
      epoch,
      seq,
      states: agents.map(agent => [agent.status, agent.step]),
    })),
    [
      { kind: 'subagents', id: callId, ...fenceOf(), seq: 0, states: [['running', 'Searching the web']] },
      { kind: 'subagents', id: callId, ...fenceOf(), seq: 1, states: [['done', undefined]] },
    ],
  );
});

function fenceOf() {
  return { turnId: identity.turnId, generation: 2, epoch: 3 };
}
