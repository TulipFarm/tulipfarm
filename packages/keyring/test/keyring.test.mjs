import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  KeyringError,
  decrypt,
  encryptCompact,
  encryptVersioned,
  envelopeKeyId,
  keyMaterial,
  keyringVariables,
  needsReencrypt,
  parseCurrentKey,
  parseKeyring,
} from '../src/index.ts';

const hex = () => randomBytes(32).toString('hex');
const legacy = JSON.parse(readFileSync(new URL('./fixtures/legacy-envelopes.json', import.meta.url), 'utf8'));

test('parses current and previous keys from prefixed variables', () => {
  const current = hex();
  const old = hex().toUpperCase();
  const ring = parseKeyring(
    { TEST_KEY_ID: 'v2', TEST_KEY: current, TEST_PREVIOUS_KEYS: JSON.stringify({ v1: old }) },
    'TEST',
  );
  assert.equal(ring.keyId, 'v2');
  assert.equal(ring.key.toString('hex'), current);
  assert.equal(ring.previous.get('v1')?.toString('hex'), old.toLowerCase());
  assert.deepEqual(keyringVariables('TEST'), { keyId: 'TEST_KEY_ID', key: 'TEST_KEY', previous: 'TEST_PREVIOUS_KEYS' });
  assert.equal(parseKeyring({ TEST_KEY_ID: 'v2', TEST_KEY: current, TEST_PREVIOUS_KEYS: '' }, 'TEST').previous.size, 0);
  assert.equal(
    parseCurrentKey({ TEST_KEY_ID: 'v2', TEST_KEY: current, TEST_PREVIOUS_KEYS: 'not json' }, 'TEST').keyId,
    'v2',
  );
});

test('rejects invalid configuration without echoing key material', () => {
  const key = hex();
  for (const env of [
    {},
    { TEST_KEY_ID: 'v1' },
    { TEST_KEY_ID: '', TEST_KEY: key },
    { TEST_KEY_ID: 'v1', TEST_KEY: key.slice(2) },
    { TEST_KEY_ID: 'v1', TEST_KEY: key, TEST_PREVIOUS_KEYS: 'not json' },
    { TEST_KEY_ID: 'v1', TEST_KEY: key, TEST_PREVIOUS_KEYS: JSON.stringify({ '': hex() }) },
    { TEST_KEY_ID: 'v1', TEST_KEY: key, TEST_PREVIOUS_KEYS: JSON.stringify({ v0: 'short' }) },
    { TEST_KEY_ID: 'v1', TEST_KEY: key, TEST_PREVIOUS_KEYS: JSON.stringify({ v1: hex() }) },
  ]) {
    assert.throws(
      () => parseKeyring(env, 'TEST'),
      error => error instanceof KeyringError && error.code === 'configuration-invalid' && !error.message.includes(key),
    );
  }
  assert.throws(
    () => parseKeyring({ TEST_KEY_ID: 'bad id', TEST_KEY: key }, 'TEST', { keyId: /^[a-z0-9]+$/ }),
    KeyringError,
  );
});

test('encrypts with the current key and decrypts by the envelope key ID', () => {
  const old = { keyId: 'v1', key: randomBytes(32) };
  const ring = { keyId: 'v2', key: randomBytes(32), previous: new Map([['v1', old.key]]) };
  const data = keyId => Buffer.from(`aad:${keyId}`);
  const sealed = encryptVersioned('secret value', old, data);
  assert.deepEqual(Object.keys(sealed), ['version', 'keyId', 'nonce', 'ciphertext', 'tag']);
  assert.equal(decrypt(sealed, ring, data), 'secret value');
  assert.equal(JSON.stringify(sealed).includes('secret value'), false);
  const compact = encryptCompact('secret value', ring, Buffer.from('fixed'));
  assert.deepEqual(Object.keys(compact), ['keyId', 'nonce', 'tag', 'ciphertext']);
  assert.equal(decrypt(compact, ring, Buffer.from('fixed')), 'secret value');
  assert.throws(() => decrypt(compact, ring, Buffer.from('other')));
  assert.throws(
    () => decrypt(sealed, { ...ring, previous: new Map() }, data),
    error => error.code === 'key-unavailable',
  );
  assert.throws(
    () => decrypt({ ...compact, nonce: randomBytes(8).toString('base64') }, ring, Buffer.from('fixed')),
    error => error.code === 'envelope-invalid',
  );
  assert.throws(
    () => decrypt({ ...compact, tag: randomBytes(8).toString('base64') }, ring, Buffer.from('fixed')),
    error => error.code === 'envelope-invalid',
  );
  assert.equal(keyMaterial(old, 'v2'), undefined);
});

test('reports envelopes that a re-encrypt pass should rewrite', () => {
  const ring = { keyId: 'v2', key: randomBytes(32), previous: new Map([['v1', randomBytes(32)]]) };
  assert.equal(envelopeKeyId(encryptCompact('x', ring, Buffer.alloc(0))), 'v2');
  assert.equal(needsReencrypt(encryptCompact('x', ring, Buffer.alloc(0)), ring), false);
  assert.equal(needsReencrypt({ keyId: 'v1' }, ring), true);
  for (const value of [null, 'v1', {}, { keyId: '' }, { keyId: 1 }]) {
    assert.equal(envelopeKeyId(value), undefined);
    assert.equal(needsReencrypt(value, ring), false);
  }
});

test('decrypts envelopes written by the pre-keyring implementations', () => {
  const ring = parseKeyring(
    {
      FIXTURE_KEY_ID: legacy.keys.current.keyId,
      FIXTURE_KEY: legacy.keys.current.key,
      FIXTURE_PREVIOUS_KEYS: JSON.stringify({ [legacy.keys.legacy.keyId]: legacy.keys.legacy.key }),
    },
    'FIXTURE',
  );
  const credential = legacy.workspaceCredential;
  const { workspaceId, capability, generation } = credential.binding;
  assert.equal(
    decrypt(credential.envelope, ring, keyId =>
      Buffer.from(JSON.stringify([1, workspaceId, capability, generation, keyId])),
    ),
    credential.plaintext,
  );
  const email = legacy.emailDelivery;
  assert.deepEqual(
    JSON.parse(
      decrypt(email.envelope, ring, keyId => Buffer.from(JSON.stringify(['email-delivery', 1, email.id, keyId]))),
    ),
    email.payload,
  );
  const integration = legacy.integrationCredential;
  assert.equal(
    decrypt(
      integration.envelope,
      ring,
      Buffer.from(
        JSON.stringify([
          integration.purpose,
          integration.workspaceId,
          integration.integrationId,
          integration.generation,
        ]),
      ),
    ),
    integration.plaintext,
  );
  const envelope = legacy.encryptedEnvelope;
  assert.equal(decrypt(envelope.envelope, ring, Buffer.from(envelope.associatedData)), envelope.plaintext);
  for (const value of [credential.envelope, email.envelope, integration.envelope, envelope.envelope])
    assert.equal(needsReencrypt(value, ring), true);
});
