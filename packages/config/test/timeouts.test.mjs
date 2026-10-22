import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultCallTimeoutMs } from '../dist/timeouts.js';
import { defaultCallTimeoutMs as exportedDefault } from '../dist/index.js';

test('the shared call timeout defaults to one minute', () => {
  assert.equal(defaultCallTimeoutMs, 60_000);
  assert.equal(exportedDefault, defaultCallTimeoutMs);
});
