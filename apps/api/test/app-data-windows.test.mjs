import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWindows } from '../src/app-data-windows.ts';

test('a full map of windows counts new keys in constant time', () => {
  const windows = createWindows({ max: 1, windowMs: 60_000, entries: 100_000 });
  for (let index = 0; index < 100_000; index++) windows.spend(`full ${index}`);
  const started = performance.now();
  for (let index = 0; index < 10_000; index++) windows.spend(`new ${index}`);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 1_000, `10,000 spends on a full map took ${Math.round(elapsed)} ms`);
  assert.equal(windows.spend('full 0'), 0, 'the oldest window was dropped, so its count starts again');
  assert.ok(windows.spend('new 9999') > 0, 'the newest window kept its count');
});

test('a full map drops expired windows before live ones', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const windows = createWindows({ max: 1, windowMs: 60_000, entries: 3 });
  windows.spend('expired');
  t.mock.timers.tick(30_000);
  windows.spend('live');
  windows.spend('also live');
  t.mock.timers.tick(31_000);
  windows.spend('new');
  assert.equal(windows.spend('live'), 29_000, 'a live window keeps its count');
  assert.equal(windows.spend('also live'), 29_000);
});
