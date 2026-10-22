import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { encryptCredential, decryptCredential } from '../src/credentials.ts';

test('encrypted credentials bind workspace, capability, generation and key version', () => {
  const key = { keyId: 'v1', key: randomBytes(32) };
  const binding = { workspaceId: randomUUID(), capability: 'runtime', generation: 1 };
  const credential = 'postgresql://restricted:secret@localhost/example';
  const encrypted = encryptCredential(credential, binding, key);
  assert.equal(decryptCredential(encrypted, binding, key), credential);
  assert.ok(!JSON.stringify(encrypted).includes('secret'));
  for (const changed of [{ workspaceId: randomUUID() }, { capability: 'migration' }, { generation: 2 }]) {
    assert.throws(() => decryptCredential(encrypted, { ...binding, ...changed }, key));
  }
  assert.throws(() => decryptCredential(encrypted, binding, { keyId: 'v2', key: key.key }));
  assert.throws(() => decryptCredential(encrypted, binding, { keyId: key.keyId, key: randomBytes(32) }));
});

test('decrypts workspace credentials written before the shared keyring', async () => {
  const { readFileSync } = await import('node:fs');
  const legacy = JSON.parse(
    readFileSync(new URL('../../keyring/test/fixtures/legacy-envelopes.json', import.meta.url), 'utf8'),
  );
  const { binding, envelope, plaintext } = legacy.workspaceCredential;
  const keyring = {
    keyId: legacy.keys.current.keyId,
    key: Buffer.from(legacy.keys.current.key, 'hex'),
    previous: new Map([[legacy.keys.legacy.keyId, Buffer.from(legacy.keys.legacy.key, 'hex')]]),
  };
  assert.equal(decryptCredential(envelope, binding, keyring), plaintext);
  assert.throws(
    () => decryptCredential(envelope, binding, { ...keyring, previous: new Map() }),
    /^Error: Workspace credential key version unavailable$/,
  );
});
