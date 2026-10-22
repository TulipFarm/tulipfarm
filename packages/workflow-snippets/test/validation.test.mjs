import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSnippet, createSnippetRunner } from '../src/index.ts';
import { resultSchema, snippetPayloadSchema } from '../src/protocol.ts';

test('accepts bounded JSON snippets and refuses unbounded or unsupported input', () => {
  assert.deepEqual(parseSnippet({ language: 'python', source: 'return input["n"] + 1', input: { n: 2 } }), {
    language: 'python',
    source: 'return input["n"] + 1',
    input: { n: 2 },
  });
  assert.throws(() => parseSnippet({ language: 'shell', source: 'id', input: null }), /invalid-input/);
  assert.throws(
    () => parseSnippet({ language: 'javascript', source: 'return input', input: 'a'.repeat(131072) }),
    /invalid-input/,
  );
  assert.throws(() => createSnippetRunner({ image: 'mutable:latest' }));
  assert.throws(() => createSnippetRunner({ image: `local@sha256:${'a'.repeat(64)}`, runtime: 'runc' }), /unavailable/);
});

test('refuses JSON text that PostgreSQL JSONB cannot persist', () => {
  assert.equal(snippetPayloadSchema.safeParse({ nested: ['ok', { value: 'fine' }] }).success, true);
  assert.equal(snippetPayloadSchema.safeParse({ nested: ['bad\u0000value'] }).success, false);
  assert.equal(snippetPayloadSchema.safeParse({ nested: { ['bad\u0000key']: 'value' } }).success, false);
  assert.equal(snippetPayloadSchema.safeParse({ nested: ['bad\ud83c'] }).success, false);
  assert.equal(snippetPayloadSchema.safeParse({ nested: { ['bad\ud83ckey']: 'value' } }).success, false);
  assert.equal(resultSchema.safeParse({ kind: 'completed', output: { value: String.fromCharCode(0) } }).success, false);
  assert.equal(resultSchema.safeParse({ kind: 'completed', output: { value: '\ud83c' } }).success, false);
});
