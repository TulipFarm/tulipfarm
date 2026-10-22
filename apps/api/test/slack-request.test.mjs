import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { SlackSignatureError, verifySlackRequest } from '../src/slack-request.ts';

const secret = 'synthetic-signing-secret';
const timestamp = '1790000000';
const now = 1790000000000;
function signed(body, overrides = {}) {
  const input = { body, timestamp, now, secret, ...overrides };
  return {
    ...input,
    signature: `v0=${createHmac('sha256', input.secret).update(`v0:${input.timestamp}:`).update(body).digest('hex')}`,
  };
}
function denied(input) {
  assert.throws(
    () => verifySlackRequest(input),
    error => {
      assert.equal(error.constructor, SlackSignatureError);
      assert.equal(error.message, 'slack-signature-invalid');
      return true;
    },
  );
}

test('JSON and form requests return only their exact signed bytes', () => {
  for (const content of [
    '{ "type": "event_callback", "text": "Hello 🌿" }\n',
    'payload=%7B%22type%22%3A%22block_actions%22%7D&text=a+b%2Bc',
  ]) {
    const input = signed(Buffer.from(content));
    assert.strictEqual(verifySlackRequest(input), input.body);
    assert.equal(verifySlackRequest(input).toString(), content);
    denied({ ...input, body: Buffer.concat([input.body, Buffer.from(' ')]) });
  }
});

test('semantically equivalent decoded bodies cannot reuse the raw signature', () => {
  const input = signed(Buffer.from('{ "text": "hello" }'));
  assert.equal(verifySlackRequest(input).toString(), '{ "text": "hello" }');
  denied({ ...input, body: Buffer.from(JSON.stringify(JSON.parse(input.body))) });
  const form = signed(Buffer.from('text=hello%20world'));
  assert.equal(verifySlackRequest(form).toString(), 'text=hello%20world');
  denied({ ...form, body: Buffer.from(new URLSearchParams(form.body.toString()).toString()) });
});

test('binary bytes are signed without UTF-8 replacement', () => {
  const input = signed(Buffer.from([0xff, 0x00, 0x61]));
  assert.deepEqual(verifySlackRequest(input), Buffer.from([0xff, 0x00, 0x61]));
  denied({ ...input, body: Buffer.from(input.body.toString('utf8')) });
});

test('five-minute past and future boundaries are inclusive', () => {
  const input = signed(Buffer.from('hello'));
  assert.equal(verifySlackRequest({ ...input, now: now + 300000 }).toString(), 'hello');
  assert.equal(verifySlackRequest({ ...input, now: now - 300000 }).toString(), 'hello');
  denied({ ...input, now: now + 300001 });
  denied({ ...input, now: now - 300001 });
  denied({ ...input, now: NaN });
  denied({ ...input, now: Infinity });
});

test('missing, malformed and mismatched authentication fails with one safe error', () => {
  const input = signed(Buffer.from('hello'));
  assert.equal(verifySlackRequest(input).toString(), 'hello');
  for (const signature of [
    undefined,
    '',
    'v0=abc',
    `v1=${'a'.repeat(64)}`,
    `v0=${'A'.repeat(64)}`,
    `v0=${'0'.repeat(64)}`,
    `${input.signature},${input.signature}`,
  ])
    denied({ ...input, signature });
  for (const value of [undefined, '', '1790000000.0', ' 1790000000', '1790000000,1790000000', 'not-a-time'])
    denied({ ...input, timestamp: value });
  denied({ ...input, secret: '' });
  denied({ ...input, secret: 'different-synthetic-secret' });
  denied({ ...input, timestamp: '1790000001' });
});

test('body byte limit includes multibyte text', () => {
  assert.equal(verifySlackRequest(signed(Buffer.alloc(131072, 97))).length, 131072);
  denied(signed(Buffer.alloc(131073, 97)));
  denied(signed(Buffer.from('🌿'.repeat(32769))));
});

test('default clock accepts a current request but not an old signed request', () => {
  const current = signed(Buffer.from('current'), { timestamp: String(Math.floor(Date.now() / 1000)) });
  delete current.now;
  assert.equal(verifySlackRequest(current).toString(), 'current');
  const stale = signed(Buffer.from('stale'), { timestamp: '1000000000' });
  delete stale.now;
  denied(stale);
});
