import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { signMediaToken, verifyMediaToken } from '../dist/media.js';

const key = 'k'.repeat(32);
// Tokens carry whole seconds, rounded down so a URL never outlives its grant.
const grant = (expiresAt = new Date(Math.floor(Date.now() / 1000) * 1000 + 60_000)) => ({
  variantId: randomUUID(),
  attemptId: randomUUID(),
  step: 'upload-media',
  fileId: randomUUID(),
  contentDigest: 'a'.repeat(64),
  expiresAt,
});

test('PRODUCT 19: a media URL token names one File, attempt and step, and expires', () => {
  const issued = grant();
  const token = signMediaToken(key, issued);
  assert.deepEqual(verifyMediaToken(key, token), issued);
  assert.equal(verifyMediaToken(key, token, new Date(issued.expiresAt.getTime() + 1)), null);
  assert.equal(verifyMediaToken('x'.repeat(32), token), null);

  // Any change to the payload or signature is refused.
  const [payload, signature] = token.split('.');
  const forged = Buffer.from(
    JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), fileId: randomUUID() }),
  ).toString('base64url');
  assert.equal(verifyMediaToken(key, `${forged}.${signature}`), null);
  assert.equal(verifyMediaToken(key, `${payload}.${signature}x`), null);
  assert.equal(verifyMediaToken(key, `${payload}.${signature}.extra`), null);
  assert.equal(verifyMediaToken(key, 'not-a-token'), null);
  assert.throws(() => signMediaToken('short', issued));
  assert.throws(() => signMediaToken(key, { ...issued, step: 'await' }));
});
