import assert from 'node:assert/strict';
import { test } from 'node:test';
import { repeatFromStart } from '../src/app-composition.ts';

test('an app job runs at start, then once per interval, never twice at once', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const started = [];
  let finish;
  const job = repeatFromStart(() => {
    started.push(started.length + 1);
    return new Promise(resolve => {
      finish = resolve;
    });
  }, 60_000);
  assert.deepEqual(started, [1]);

  t.mock.timers.tick(60_000);
  assert.deepEqual(started, [1]);

  finish();
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(60_000);
  assert.deepEqual(started, [1, 2]);

  finish();
  await job.stop();
  t.mock.timers.tick(60_000);
  assert.deepEqual(started, [1, 2]);
});
