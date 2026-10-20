import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRecommendationStream } from '../src/features/chat/recommendation-stream.ts';

const workspaceId = '10000000-0000-4000-8000-000000000001';
const membershipId = '10000000-0000-4000-8000-000000000002';
class Source {
  readyState = 0;
  listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>();
  addEventListener(kind: string, listener: (event: MessageEvent<string>) => void) {
    this.listeners.set(kind, [...(this.listeners.get(kind) ?? []), listener]);
  }
  close() {
    this.readyState = 2;
  }
  emit(kind: string, fields = {}) {
    for (const listener of this.listeners.get(kind) ?? [])
      listener({
        data: JSON.stringify({ kind, workspaceId, membershipId, version: 1, ...fields }),
      } as MessageEvent<string>);
  }
}
function fixture() {
  const sources: Source[] = [],
    changes: string[] = [];
  const stream = createRecommendationStream(
    'https://fixture.test/events',
    { workspaceId, membershipId },
    kind => changes.push(kind),
    {
      connect: () => {
        const source = new Source();
        sources.push(source);
        return source;
      },
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: timer => clearTimeout(timer),
    },
  );
  return { stream, sources, changes, latest: () => sources.at(-1)! };
}

test('private invalidation clears immediately and ignores other members and older generations', () => {
  const { stream, latest, changes } = fixture();
  stream.start();
  assert.equal(changes.at(-1), 'conceal');
  latest().emit('open');
  assert.equal(stream.snapshot(), 'open');
  latest().emit('changed', { version: 2 });
  assert.equal(changes.at(-1), 'change');
  latest().emit('invalidated', { version: 3 });
  assert.equal(changes.at(-1), 'conceal');
  const count = changes.length;
  latest().emit('changed', { version: 2 });
  latest().emit('changed', { membershipId: workspaceId, version: 4 });
  latest().emit('changed', { workspaceId: membershipId, version: 4 });
  assert.equal(changes.length, count);
  latest().emit('changed', { version: 3 });
  assert.equal(changes.at(-1), 'change', 'publication within a generation must still trigger a read');
  latest().emit('resync');
  assert.equal(changes.at(-1), 'conceal');
  const old = latest();
  stream.stop();
  old.emit('changed', { version: 4 });
  assert.equal(changes.at(-1), 'conceal');
});

test('disconnects clear private data, stop after bounded retries and can reconnect explicitly', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { stream, latest, changes, sources } = fixture();
  stream.start();
  for (let i = 0; i < 3; i++) {
    latest().emit('error');
    assert.equal(changes.at(-1), 'conceal');
    t.mock.timers.tick(2000);
  }
  assert.equal(stream.snapshot(), 'unavailable');
  assert.equal(sources.length, 3);
  t.mock.timers.tick(120000);
  assert.equal(sources.length, 3);
  stream.retry();
  assert.equal(sources.length, 4);
  latest().emit('open');
  assert.equal(stream.snapshot(), 'open');
  latest().emit('error');
  stream.stop();
  t.mock.timers.tick(10000);
  assert.equal(sources.length, 4, 'unmount cancels reconnection work');
});
