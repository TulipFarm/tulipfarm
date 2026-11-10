import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createReplyResync } from '../src/features/chat/reply-resync.ts';

const progress = (length: number) => new Map([['text:0', length]]);

test('quiet recovery waits for text to settle and spends only three reads while silent', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reads = 0;
  const recovery = createReplyResync(async () => {
    reads++;
  });
  const update = (length: number) => recovery.update({ key: 'turn:0', progress: progress(length), recovery: true });
  const advance = async (ms: number) => {
    t.mock.timers.tick(ms);
    await Promise.resolve();
  };
  update(1);
  await advance(999);
  assert.equal(reads, 0);
  update(2);
  await advance(999);
  assert.equal(reads, 0);
  await advance(1);
  assert.equal(reads, 1);
  await advance(2000);
  assert.equal(reads, 2);
  update(2);
  await advance(5000);
  assert.equal(reads, 3);
  assert.equal(recovery.snapshot(), true);
  update(2);
  await advance(60_000);
  assert.equal(reads, 3, 'an identical history read does not refill an exhausted budget');
  recovery.retry();
  await Promise.resolve();
  assert.equal(reads, 4, 'Retry explicitly starts a new bounded recovery');
  assert.equal(recovery.snapshot(), false);
  recovery.update({ key: null, progress: new Map(), recovery: false });
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
  recovery.update({ key: 'turn:0', progress: progress(1), recovery: true });
  for (const ms of [1000, 2000, 5000]) {
    t.mock.timers.tick(ms);
    await Promise.resolve();
  }
  assert.equal(reads, 3);
  assert.equal(recovery.snapshot(), true);
  recovery.update({ key: 'turn:0', progress: progress(1), recovery: false });
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
  recovery.update({ key: 'turn:0', progress: progress(1), recovery: true });
  t.mock.timers.tick(1000);
  assert.equal(reads, 1);
  recovery.update({ key: 'turn:1', progress: progress(1), recovery: true });
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

test('returning from a hidden view checks immediately without discarding its recovery budget', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reads = 0;
  const recovery = createReplyResync(async () => {
    reads++;
  });
  recovery.update({ key: 'turn:0', progress: progress(1), recovery: true });
  recovery.setVisible(false);
  t.mock.timers.tick(60_000);
  assert.equal(reads, 0);
  recovery.setVisible(true);
  assert.equal(reads, 1, 'foreground return checks before any timer runs');
  await Promise.resolve();
  recovery.setVisible(false);
  t.mock.timers.tick(60_000);
  recovery.setVisible(true);
  assert.equal(reads, 2);
  await Promise.resolve();
  t.mock.timers.tick(5000);
  await Promise.resolve();
  assert.equal(reads, 3);
  t.mock.timers.tick(60_000);
  assert.equal(reads, 3, 'foreground checks do not replenish the silent recovery budget');
  recovery.setVisible(false);
  recovery.setVisible(true);
  assert.equal(reads, 4, 'returning still checks once when the automatic budget was already exhausted');
  await Promise.resolve();
  t.mock.timers.tick(60_000);
  assert.equal(reads, 4, 'that return does not restart automatic checking');
  recovery.stop();
});

test('a healthy reply can stream for thirty seconds without a false uncertainty notice', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reads = 0;
  const recovery = createReplyResync(async () => {
    reads++;
  });
  for (let chunk = 1; chunk <= 6; chunk++) {
    recovery.update({ key: 'turn:0', progress: progress(chunk), recovery: true });
    for (let second = 0; second < 5; second++) {
      t.mock.timers.tick(1000);
      await Promise.resolve();
      assert.equal(
        recovery.snapshot(),
        false,
        `new text is still arriving during second ${(chunk - 1) * 5 + second + 1}`,
      );
    }
  }
  assert.ok(reads > 3, 'new actual text starts a new quiet-period budget');
  for (const ms of [1000, 2000, 5000]) {
    t.mock.timers.tick(ms);
    await Promise.resolve();
  }
  assert.equal(recovery.snapshot(), true, 'checks remain bounded once progress stops');
  const stoppedReads = reads;
  t.mock.timers.tick(60_000);
  assert.equal(reads, stoppedReads);
  recovery.stop();
});

test('reconnects, missing live state and replayed text cannot renew an exhausted silent budget', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reads = 0;
  const recovery = createReplyResync(async () => {
    reads++;
  });
  recovery.update({ key: 'turn:0', progress: progress(20), recovery: true });
  for (const ms of [1000, 2000, 5000]) {
    t.mock.timers.tick(ms);
    await Promise.resolve();
  }
  assert.equal(recovery.snapshot(), true);
  for (const next of [new Map(), progress(10), progress(20)]) {
    recovery.update({ key: 'turn:0', progress: next, recovery: false });
    recovery.update({ key: 'turn:0', progress: next, recovery: true });
    t.mock.timers.tick(60_000);
    assert.equal(reads, 3);
    assert.equal(recovery.snapshot(), true);
  }
  recovery.update({ key: 'turn:0', progress: progress(21), recovery: true });
  assert.equal(recovery.snapshot(), false);
  t.mock.timers.tick(999);
  assert.equal(reads, 3);
  t.mock.timers.tick(1);
  assert.equal(reads, 4);
  recovery.stop();
});

test('foreground checks respect offline state and do not wait for a healthy-stream backup', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reads = 0;
  const recovery = createReplyResync(async () => {
    reads++;
  });
  recovery.update({ key: 'turn:0', progress: progress(1), recovery: false });
  recovery.setVisible(false);
  recovery.setOnline(false);
  recovery.setVisible(true);
  assert.equal(reads, 0);
  assert.equal(recovery.snapshot(), true);
  recovery.setOnline(true);
  recovery.setVisible(false);
  recovery.setVisible(true);
  assert.equal(reads, 1, 'a healthy stream does not defer the foreground read for fifteen seconds');
  recovery.setVisible(true);
  assert.equal(reads, 1, 'repeated visible notifications are not a new return');
  recovery.stop();
});

test('offline recovery is explicitly unconfirmed, including Retry, and resumes when online', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reads = 0;
  const recovery = createReplyResync(async () => {
    reads++;
  });
  recovery.update({ key: 'turn:0', progress: progress(1), recovery: true });
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
