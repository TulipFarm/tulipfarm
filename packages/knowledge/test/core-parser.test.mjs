import assert from 'node:assert/strict';
import test from 'node:test';
import * as core from '@tulipfarm/memory-core/parser';
import * as legacy from '@tulipfarm/knowledge/parser';
import { chunkSchema, knowledgeLimits } from '@tulipfarm/memory-core/document-contracts';
import * as hostContracts from '../dist/internal/contracts.js';

test('the original parser facade preserves export names and exact core identities', () => {
  assert.deepEqual(Object.keys(legacy), Object.keys(core));
  for (const [name, value] of Object.entries(core)) assert.strictEqual(legacy[name], value, name);
  assert.strictEqual(hostContracts.chunkSchema, chunkSchema);
  assert.strictEqual(hostContracts.knowledgeLimits, knowledgeLimits);
});

test('the original private parser modules forward the exact core exports', async () => {
  for (const name of [
    'archive',
    'chunks',
    'contracts',
    'convert',
    'office',
    'opendocument',
    'pdf',
    'presentation',
    'process',
    'rtf',
    'spreadsheet',
    'word',
    'xml',
  ]) {
    const original = await import(`../dist/internal/parser/${name}.js`);
    const moved = await import(`@tulipfarm/memory-core/parser/${name}`);
    assert.deepEqual(Object.keys(original), Object.keys(moved), name);
    for (const [key, value] of Object.entries(moved)) assert.strictEqual(original[key], value, `${name}.${key}`);
  }
});
