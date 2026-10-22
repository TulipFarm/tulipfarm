import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createGoogleCorpusAdapter,
  createSlackCorpusAdapter,
  createGitHubCorpusAdapter,
  createAtlassianCorpusAdapter,
} from '../dist/corpus-adapters.js';

for (const [factory, permissionMethod] of [
  [createGoogleCorpusAdapter, 'check'],
  [createSlackCorpusAdapter, 'access'],
  [createGitHubCorpusAdapter, 'access'],
  [createAtlassianCorpusAdapter, 'access'],
]) {
  for (const [operation, method] of [
    ['discover', 'list'],
    ['fetch', 'read'],
    ['permissions', permissionMethod],
  ]) {
    test(`${factory.name}.${operation} preserves receiver, argument identity, and the original promise`, async () => {
      const input = ['tenant', 'principal', { generation: 4 }, { selection: ['one'] }, null];
      const output = { observedAt: '2026-10-21T00:00:00.000Z', values: [] };
      const promise = Promise.resolve(output);
      const provider = {
        [method](...values) {
          assert.equal(this, provider);
          assert.deepEqual(values, input);
          for (const [index, value] of values.entries()) assert.equal(value, input[index]);
          return promise;
        },
      };
      const adapter = factory(provider);
      assert.equal(adapter[operation](...input), promise);
      assert.equal(await adapter[operation](...input), output);
      const replacement = Promise.resolve({ replacement: true });
      provider[method] = () => replacement;
      assert.equal(adapter[operation](...input), replacement);
    });

    test(`${factory.name}.${operation} preserves synchronous and asynchronous denial identity`, async () => {
      const failure = new Error('provider denied');
      const provider = {
        [method]() {
          throw failure;
        },
      };
      const adapter = factory(provider);
      assert.throws(
        () => adapter[operation](),
        error => error === failure,
      );
      provider[method] = () => Promise.reject(failure);
      await assert.rejects(adapter[operation](), error => error === failure);
    });
  }
}
