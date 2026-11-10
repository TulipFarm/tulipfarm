import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createReplyResync } from '../src/features/chat/reply-resync.ts';

test('quiet recovery waits for text to settle and spends only three reads per attempt', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reads = 0;
  const recovery = createReplyResync(async () => {
    reads++;
  });
  const update = (revision: string) => recovery.update({ key: 'turn:0', revision, recovery: true });
  const advance = async (ms: number) => {
    t.mock.timers.tick(ms);
    await Promise.resolve();
  };
  update('text 1');
  await advance(999);
  assert.equal(reads, 0);
  update('text 2');
  await advance(999);
  assert.equal(reads, 0);
  await advance(1);
  assert.equal(reads, 1);
  await advance(2000);
  assert.equal(reads, 2);
  update('text 3');
  await advance(5000);
  assert.equal(reads, 3);
  assert.equal(recovery.snapshot(), true);
  update('text 4');
  await advance(60_000);
  assert.equal(reads, 3, 'a text update does not refill an exhausted budget');
  recovery.retry();
  await Promise.resolve();
  assert.equal(reads, 4, 'Retry explicitly starts a new bounded recovery');
  assert.equal(recovery.snapshot(), false);
  recovery.update({ key: null, revision: '', recovery: false });
  await advance(60_000);
  assert.equal(reads, 4, 'saved completion cancels further reads');
  recovery.stop();
});

test('recovery failures are bounded and real ongoing work retains slow backup checks', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reads = 0;
  const recovery = createReplyResync(async () => {
    reads++;
    throw new Error('offline');
  });
  recovery.update({ key: 'turn:0', revision: 'text', recovery: true });
  for (const ms of [1000, 2000, 5000]) {
    t.mock.timers.tick(ms);
    await Promise.resolve();
  }
  assert.equal(reads, 3);
  assert.equal(recovery.snapshot(), true);
  recovery.update({ key: 'turn:0', revision: 'running tool', recovery: false });
  assert.equal(recovery.snapshot(), false);
  t.mock.timers.tick(14_999);
  assert.equal(reads, 3);
  t.mock.timers.tick(1);
  await Promise.resolve();
  assert.equal(reads, 4, 'live running work uses a slow backup, not silence checks');
  recovery.stop();
});

test('recovery does not overlap reads or leak a previous attempt into a new one', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reads = 0;
  const gate = Promise.withResolvers<void>();
  const recovery = createReplyResync(async () => {
    reads++;
    if (reads === 1) await gate.promise;
  });
  recovery.update({ key: 'turn:0', revision: 'text', recovery: true });
  t.mock.timers.tick(1000);
  assert.equal(reads, 1);
  recovery.update({ key: 'turn:1', revision: 'retry', recovery: true });
  t.mock.timers.tick(60_000);
  assert.equal(reads, 1);
  gate.resolve();
  await Promise.resolve();
  await Promise.resolve();
  t.mock.timers.tick(1000);
  await Promise.resolve();
  assert.equal(reads, 2);
  assert.equal(recovery.snapshot(), false);
  recovery.stop();
  t.mock.timers.tick(60_000);
  assert.equal(reads, 2);
});

test('hidden views pause recovery without discarding its per-attempt budget', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reads = 0;
  const recovery = createReplyResync(async () => {
    reads++;
  });
  recovery.update({ key: 'turn:0', revision: 'text', recovery: true });
  recovery.setVisible(false);
  t.mock.timers.tick(60_000);
  assert.equal(reads, 0);
  recovery.setVisible(true);
  t.mock.timers.tick(1000);
  await Promise.resolve();
  assert.equal(reads, 1);
  recovery.setVisible(false);
  t.mock.timers.tick(60_000);
  recovery.setVisible(true);
  t.mock.timers.tick(1999);
  assert.equal(reads, 1);
  t.mock.timers.tick(1);
  await Promise.resolve();
  assert.equal(reads, 2);
  recovery.stop();
});

test('offline recovery is explicitly unconfirmed, including Retry, and resumes when online', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reads = 0;
  const recovery = createReplyResync(async () => {
    reads++;
  });
  recovery.update({ key: 'turn:0', revision: 'text', recovery: true });
  recovery.setOnline(false);
  t.mock.timers.tick(60_000);
  assert.equal(reads, 0);
  assert.equal(recovery.snapshot(), true);
  recovery.retry();
  assert.equal(recovery.snapshot(), true, 'Retry cannot imply a running model while offline');
  recovery.setOnline(true);
  t.mock.timers.tick(1000);
  await Promise.resolve();
  assert.equal(reads, 1);
  recovery.stop();
});
