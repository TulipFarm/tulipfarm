import assert from 'node:assert/strict';
import { test } from 'node:test';
import { xTextLimits, xWeightedLength } from '../dist/x-text.js';

test('Latin text and general punctuation weigh 1', () => {
  assert.equal(xWeightedLength(''), 0);
  assert.equal(xWeightedLength('Hello, world'), 12);
  assert.equal(xWeightedLength('\u2013\u2014\u2018\u2019\u201c\u201d'), 6);
});

test('CJK and other characters outside the light ranges weigh 2', () => {
  assert.equal(xWeightedLength('日本語'), 6);
  assert.equal(xWeightedLength('한국어'), 6);
  assert.equal(xWeightedLength('a日'), 3);
});

test('each emoji counts 2, including sequences and skin tones', () => {
  assert.equal(xWeightedLength('👋'), 2);
  assert.equal(xWeightedLength('👋🏽'), 2);
  assert.equal(xWeightedLength('👨‍👩‍👧‍👦'), 2);
  assert.equal(xWeightedLength('🇳🇱'), 2);
});

test('URLs count 23 whatever their length, without trailing punctuation', () => {
  assert.equal(xWeightedLength('https://t.co'), 23);
  assert.equal(xWeightedLength(`https://example.com/${'a'.repeat(200)}`), 23);
  assert.equal(xWeightedLength('see https://example.com.'), 4 + 23 + 1);
  assert.equal(xWeightedLength('www.example.com'), 23);
  assert.equal(xWeightedLength('tulipfarm.ai rocks'), 23 + 6);
  assert.equal(xWeightedLength('me@example.com'), 14);
});

test('text is NFC-normalized before counting', () => {
  assert.equal(xWeightedLength('e\u0301'), 1);
});

test('limits are 280 standard and 25,000 for long posts', () => {
  assert.deepEqual(xTextLimits, { standard: 280, premium: 25000 });
});
