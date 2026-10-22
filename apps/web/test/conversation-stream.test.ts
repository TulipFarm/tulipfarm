import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createConversationStream } from '../src/features/chat/conversation-stream.ts';

const turnId = '11111111-1111-4111-8111-111111111111';

class FakeSource {
  readyState = 0;
  closed = false;
  listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>();
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  emit(type: string, data = '') {
    for (const listener of this.listeners.get(type) ?? []) listener({ data } as MessageEvent<string>);
  }
  open() {
    this.readyState = 1;
    this.emit('open');
  }
  /** A dropped stream that EventSource retries itself. */
  drop() {
    this.readyState = 0;
    this.emit('error');
  }
  /** A non-stream response, such as 503, after which EventSource gives up. */
  reject() {
    this.readyState = 2;
    this.emit('error');
  }
  text(update: object) {
    this.emit(
      'text',
      JSON.stringify({
        turnId,
        generation: 0,
        epoch: 0,
        step: 0,
        seq: 0,
        offset: 0,
        text: '',
        reset: false,
        ...update,
      }),
    );
  }
}

function harness() {
  const sources: FakeSource[] = [];
  let refetches = 0;
  const changes: { history: boolean; plans: boolean }[] = [];
  const stream = createConversationStream(
    'https://api.test/chat/events',
    change => {
      refetches++;
      changes.push(change);
    },
    {
      connect: () => {
        const source = new FakeSource();
        sources.push(source);
        return source;
      },
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: timer => clearTimeout(timer),
    },
  );
  return { stream, sources, latest: () => sources.at(-1)!, refetches: () => refetches, changes };
}

test('an open stream refetches history once per burst and assembles streamed text per turn', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { stream, latest, refetches } = harness();
  stream.start();
  assert.equal(stream.snapshot().status, 'connecting');
  latest().open();
  latest().emit('changed', '{}');
  latest().emit('resync', '{}');
  assert.equal(stream.snapshot().status, 'open');
  t.mock.timers.tick(100);
  assert.equal(refetches(), 1);
  latest().emit('changed', JSON.stringify({ turnId, settled: true }));
  t.mock.timers.tick(100);
  assert.equal(refetches(), 2);
  latest().text({ seq: 1, text: 'Hel', reset: true });
  latest().text({ seq: 2, offset: 3, text: 'lo' });
  latest().emit('text', 'not json');
  assert.equal(stream.snapshot().previews.get(turnId)?.text, 'Hello');
  latest().text({ generation: 1, seq: 1, text: 'Retry', reset: true });
  assert.deepEqual(stream.snapshot().previews.get(turnId)?.identity, { turnId, generation: 1, epoch: 0, step: 0 });
  assert.equal(stream.snapshot().previews.get(turnId)?.text, 'Retry');
  stream.stop();
});

test('quick tool start and completion publish separately before history coalesces, with no stale replay', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { stream, latest, refetches } = harness();
  stream.start();
  latest().open();
  const seen: string[] = [];
  stream.subscribe(() => {
    seen.push([...(stream.snapshot().tools?.values() ?? [])].map(tool => tool.status).join(','));
  });
  const call = {
    turnId,
    generation: 0,
    epoch: 1,
    id: turnId,
    tool: 'slack.search',
    sequence: 1,
    presentation: { label: 'Looking up Slack messages', brand: 'slack' },
  };
  const emit = (update: object) => latest().emit('tool', JSON.stringify({ ...call, status: 'running', ...update }));
  emit({});
  emit({ status: 'completed' });
  emit({});
  emit({ status: 'failed', epoch: 0 });
  emit({ id: '22222222-2222-4222-8222-222222222222', sequence: 2 });
  assert.deepEqual(seen, ['running', 'completed', 'completed,running']);
  assert.equal(refetches(), 0, 'lifecycle does not wait for the 100ms history timer');
  t.mock.timers.tick(100);
  assert.equal(refetches(), 1);
  latest().emit('resync');
  assert.equal(stream.snapshot().tools?.size, 0, 'resync discards transient state in favor of authoritative history');
  stream.stop();
});

test('progress keeps the newest decision of each turn and ignores invalid data', () => {
  const { stream, latest } = harness();
  stream.start();
  latest().open();
  const progress = (update: object) =>
    latest().emit('progress', JSON.stringify({ turnId, generation: 0, epoch: 0, step: 0, round: 1, ...update }));
  progress({ step: 3, round: 2 });
  progress({ step: 1, round: 1 });
  latest().emit('progress', 'not json');
  latest().emit('progress', JSON.stringify({ turnId, round: 0 }));
  assert.deepEqual(stream.snapshot().progress.get(turnId), { turnId, generation: 0, epoch: 0, step: 3, round: 2 });
  progress({ generation: 1, step: 0, round: 1 });
  assert.equal(
    stream.snapshot().progress.get(turnId)?.generation,
    1,
    'a retry replaces progress from the previous attempt',
  );
  stream.stop();
});

test('progress statuses of one step apply in seq order, and unknown statuses are ignored', () => {
  const { stream, latest } = harness();
  stream.start();
  latest().open();
  const progress = (update: object) =>
    latest().emit('progress', JSON.stringify({ turnId, generation: 0, epoch: 0, step: 2, round: 2, ...update }));
  progress({ status: 'thinking', toolRounds: 0, seq: 0 });
  progress({ status: 'finishing', toolRounds: 0, seq: 1 });
  progress({ status: 'thinking', toolRounds: 0, seq: 0 });
  assert.equal(stream.snapshot().progress.get(turnId)?.status, 'finishing', 'an older seq of the same step is stale');
  progress({ status: 'done', toolRounds: 0, seq: 2 });
  assert.equal(stream.snapshot().progress.get(turnId)?.status, 'done');
  progress({ status: 'planning', toolRounds: 0, seq: 3 });
  assert.equal(stream.snapshot().progress.get(turnId)?.status, 'done');
  progress({ step: 3, round: 3 });
  assert.deepEqual(
    stream.snapshot().progress.get(turnId),
    { turnId, generation: 0, epoch: 0, step: 3, round: 3 },
    'an update without a status still advances by step',
  );
  stream.stop();
});

test('avatar updates are ordered, generation-bound, and reject invalid expressions', t => {
  const { stream, latest } = harness();
  const errors: unknown[] = [];
  t.mock.method(console, 'error', (...args) => {
    errors.push(args);
  });
  stream.start();
  latest().open();
  const avatar = (update: object = {}) =>
    latest().emit(
      'avatar',
      JSON.stringify({
        turnId,
        generation: 0,
        epoch: 1,
        step: 0,
        seq: 0,
        avatar: { name: 'Bud', state: 'Thinking' },
        ...update,
      }),
    );
  avatar({ seq: 2, avatar: { name: 'Bud', state: 'Solving' } });
  avatar({ seq: 1 });
  assert.equal(stream.snapshot().avatars?.get(turnId)?.avatar.state, 'Solving');
  avatar({ seq: 3, avatar: { name: 'Bud', state: 'Unknown' } });
  assert.equal(errors.length, 1);
  assert.equal(stream.snapshot().avatars?.get(turnId)?.avatar.state, 'Solving');
  avatar({ generation: 1 });
  assert.equal(stream.snapshot().avatars?.get(turnId)?.generation, 1);
  stream.stop();
});

test('a plan-only change rereads plans without history, and a burst merges what it needs', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { stream, latest, changes } = harness();
  stream.start();
  latest().open();
  t.mock.timers.tick(100);
  assert.deepEqual(changes.at(-1), { history: true, plans: true });
  latest().emit('changed', JSON.stringify({ planId: turnId }));
  t.mock.timers.tick(100);
  assert.deepEqual(changes.at(-1), { history: false, plans: true });
  latest().emit('changed', JSON.stringify({ turnId, settled: true }));
  t.mock.timers.tick(100);
  assert.deepEqual(changes.at(-1), { history: true, plans: false });
  latest().emit('changed', JSON.stringify({ planId: turnId }));
  latest().emit('changed', JSON.stringify({ turnId }));
  t.mock.timers.tick(100);
  assert.deepEqual(changes.at(-1), { history: true, plans: true });
  latest().emit('changed', 'not json');
  t.mock.timers.tick(100);
  assert.deepEqual(changes.at(-1), { history: true, plans: true });
  assert.equal(changes.length, 5);
  stream.stop();
});

test('three failures without an open make the stream unavailable, then it retries after a minute', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { stream, sources, latest } = harness();
  stream.start();
  latest().reject();
  assert.equal(stream.snapshot().status, 'connecting');
  t.mock.timers.tick(2000);
  assert.equal(sources.length, 2, 'a rejected stream reconnects after 2 s');
  latest().drop();
  latest().drop();
  assert.equal(stream.snapshot().status, 'unavailable');
  assert.equal(latest().closed, true);
  t.mock.timers.tick(59_999);
  assert.equal(sources.length, 2);
  t.mock.timers.tick(1);
  assert.equal(sources.length, 3);
  assert.equal(stream.snapshot().status, 'connecting');
  latest().open();
  assert.equal(stream.snapshot().status, 'open');
  stream.stop();
});

test('a server close after an open is not a failure; a command or visibility return retries an unavailable stream', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { stream, sources, latest } = harness();
  stream.start();
  for (let cycle = 0; cycle < 5; cycle++) {
    latest().open();
    latest().drop();
  }
  assert.equal(stream.snapshot().status, 'open', 'server closes keep the stream healthy');
  latest().drop();
  latest().drop();
  assert.equal(stream.snapshot().status, 'connecting');
  latest().drop();
  assert.equal(stream.snapshot().status, 'unavailable');
  stream.retry();
  assert.equal(sources.length, 2);
  assert.equal(stream.snapshot().status, 'connecting');
  latest().reject();
  t.mock.timers.tick(2000);
  latest().reject();
  t.mock.timers.tick(2000);
  latest().reject();
  assert.equal(stream.snapshot().status, 'unavailable');
  stream.stop();
  stream.start();
  assert.equal(sources.length, 5, 'returning to the page reconnects at once');
  stream.retry();
  assert.equal(sources.length, 5, 'retry leaves a connecting stream alone');
  stream.stop();
  assert.equal(latest().closed, true);
});
