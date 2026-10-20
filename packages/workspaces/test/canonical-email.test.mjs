import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalEmail } from '../src/canonical-email.ts';

test('Gmail aliases share one canonical address', () => {
  for (const address of [
    'ab@gmail.com',
    'ab+1@gmail.com',
    'A.b@gmail.com',
    'ab@googlemail.com',
    ' a.B+news+x@GoogleMail.com ',
  ]) {
    assert.equal(canonicalEmail(address), 'ab@gmail.com', address);
  }
});

test('other domains are only trimmed and lowercased', () => {
  assert.equal(canonicalEmail('a+1@company.com'), 'a+1@company.com');
  assert.equal(canonicalEmail('a@company.com'), 'a@company.com');
  assert.equal(canonicalEmail(' A.B@Company.com '), 'a.b@company.com');
  assert.equal(canonicalEmail('a@gmail.com.evil.test'), 'a@gmail.com.evil.test');
});

test('addresses without a usable Gmail local part stay unchanged', () => {
  assert.equal(canonicalEmail('+tag@gmail.com'), '+tag@gmail.com');
  assert.equal(canonicalEmail('...@gmail.com'), '...@gmail.com');
  assert.equal(canonicalEmail('not-an-email'), 'not-an-email');
  assert.equal(canonicalEmail('a@gmail.com@other.test'), 'a@gmail.com');
});
