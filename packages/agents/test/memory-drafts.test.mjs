import assert from 'node:assert/strict';
import { test } from 'node:test';
import { forgetMemoryText } from '../dist/memory-drafts.js';

test('forgetting memory text removes every occurrence and the lines it empties', () => {
  assert.equal(forgetMemoryText('- Tea\n- Lives in Berlin\n\n1. Lives in Berlin', 'Lives in Berlin'), '- Tea\n');
  assert.equal(forgetMemoryText('Lives in Berlin\nLikes tea', 'Lives in Berlin'), 'Likes tea');
  assert.equal(forgetMemoryText('Home: Berlin, Berlin', 'Berlin'), 'Home: , ');
  assert.equal(forgetMemoryText('Likes tea', 'coffee'), undefined);
  assert.equal(forgetMemoryText('Likes tea', ''), undefined);
});
