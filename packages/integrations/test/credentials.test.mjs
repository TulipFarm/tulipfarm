import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { credentialCipher, integrationCredentialKeyring } from '../src/credentials.ts';

const legacy = JSON.parse(
  readFileSync(new URL('../../keyring/test/fixtures/legacy-envelopes.json', import.meta.url), 'utf8'),
);
const env = {
  INTEGRATION_CREDENTIAL_KEY_ID: legacy.keys.current.keyId,
  INTEGRATION_CREDENTIAL_KEY: legacy.keys.current.key,
  INTEGRATION_CREDENTIAL_PREVIOUS_KEYS: JSON.stringify({ [legacy.keys.legacy.keyId]: legacy.keys.legacy.key }),
};

test('decrypts integration credentials written before the shared keyring', () => {
  const { workspaceId, integrationId, generation, purpose, envelope, plaintext } = legacy.integrationCredential;
  const keyring = integrationCredentialKeyring(env);
  assert.deepEqual(keyring, {
    activeKeyId: legacy.keys.current.keyId,
    keys: { [legacy.keys.legacy.keyId]: legacy.keys.legacy.key, [legacy.keys.current.keyId]: legacy.keys.current.key },
  });
  const cipher = credentialCipher(keyring);
  assert.equal(cipher.decrypt(workspaceId, integrationId, generation, envelope, purpose), plaintext);
  const rotated = cipher.encrypt(workspaceId, integrationId, generation, plaintext, purpose);
  assert.equal(rotated.keyId, legacy.keys.current.keyId);
  assert.deepEqual(Object.keys(rotated), ['keyId', 'nonce', 'tag', 'ciphertext']);
  assert.throws(
    () =>
      credentialCipher({
        activeKeyId: keyring.activeKeyId,
        keys: { [keyring.activeKeyId]: legacy.keys.current.key },
      }).decrypt(workspaceId, integrationId, generation, envelope, purpose),
    { code: 'credential-unavailable' },
  );
});

test('rejects integration keyrings that repeat the active key ID', () => {
  assert.throws(
    () =>
      integrationCredentialKeyring({
        ...env,
        INTEGRATION_CREDENTIAL_PREVIOUS_KEYS: JSON.stringify({ [legacy.keys.current.keyId]: legacy.keys.legacy.key }),
      }),
    { code: 'credential-unavailable' },
  );
});
