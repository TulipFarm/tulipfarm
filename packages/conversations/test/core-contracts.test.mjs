import assert from 'node:assert/strict';
import test from 'node:test';
import * as legacyMemory from '../src/personal-memory-contracts.ts';
import * as legacyCompaction from '../src/compaction-contracts.ts';
import * as coreMemory from '@tulipfarm/memory-core/personal-memory-contracts';
import * as coreCompaction from '@tulipfarm/memory-core/compaction-contracts';

for (const [name, legacy, core] of [
  ['personal memory', legacyMemory, coreMemory],
  ['compaction', legacyCompaction, coreCompaction],
]) {
  test(`the original ${name} contract path re-exports every core value unchanged`, () => {
    assert.deepEqual(Object.keys(legacy), Object.keys(core));
    for (const key of Object.keys(core)) assert.strictEqual(legacy[key], core[key], key);
  });
}
