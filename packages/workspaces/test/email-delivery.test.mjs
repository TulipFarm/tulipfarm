import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { encryptEmailDelivery, decryptEmailDelivery } from '../src/email-delivery.ts';

test('encrypted email payload binds its identity, rejects tampering and survives key rotation', () => {
  const id = randomUUID();
  const old = { keyId: 'old', key: randomBytes(32), previous: new Map() };
  const current = { keyId: 'current', key: randomBytes(32), previous: new Map([['old', old.key]]) };
  const payload = {
    kind: 'invitation',
    email: 'member@example.com',
    url: 'https://app.example.test/invite?token=private-invitation',
  };
  const envelope = encryptEmailDelivery(id, payload, old);
  assert.deepEqual(decryptEmailDelivery(id, envelope, current), payload);
  assert.equal(JSON.stringify(envelope).includes('private-invitation'), false);
  assert.notEqual(envelope.nonce, encryptEmailDelivery(id, payload, old).nonce);
  for (const [deliveryId, data, keys] of [
    [randomUUID(), envelope, current],
    [id, { ...envelope, tag: randomBytes(16).toString('base64') }, current],
    [id, envelope, { ...current, previous: new Map() }],
  ])
    assert.throws(() => decryptEmailDelivery(deliveryId, data, keys), /^Error: Email payload unavailable$/);
});

test('decrypts email payloads written before the shared keyring', async () => {
  const { readFileSync } = await import('node:fs');
  const legacy = JSON.parse(
    readFileSync(new URL('../../keyring/test/fixtures/legacy-envelopes.json', import.meta.url), 'utf8'),
  );
  const keys = {
    keyId: legacy.keys.current.keyId,
    key: Buffer.from(legacy.keys.current.key, 'hex'),
    previous: new Map([[legacy.keys.legacy.keyId, Buffer.from(legacy.keys.legacy.key, 'hex')]]),
  };
  assert.deepEqual(
    decryptEmailDelivery(legacy.emailDelivery.id, legacy.emailDelivery.envelope, keys),
    legacy.emailDelivery.payload,
  );
});
