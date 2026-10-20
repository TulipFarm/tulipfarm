import assert from 'node:assert/strict';
import test from 'node:test';
import * as legacy from '@tulipfarm/knowledge/contracts';
import * as core from '@tulipfarm/memory-core/contracts';

test('the original Knowledge contract path re-exports every core value unchanged', () => {
  assert.deepEqual(Object.keys(legacy), Object.keys(core));
  for (const name of Object.keys(core)) assert.strictEqual(legacy[name], core[name], name);
});
