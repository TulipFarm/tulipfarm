import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { googleCredentialCipher } from '../src/credentials.ts';
import { googleWorkspaceConfig, googleWorkspaceScopes, callbackSchema } from '../src/contracts.ts';
import { googleProvider } from '../src/provider.ts';

const keyring = { activeKeyId: 'one', keys: { one: 'ab'.repeat(32) } };
const binding = {
  workspaceId: randomUUID(),
  integrationId: randomUUID(),
  userId: randomUUID(),
  membershipId: randomUUID(),
  accountId: 'google-sub',
  generation: 3,
};
const config = {
  clientId: 'test-client',
  clientSecret: 'test-secret',
  redirectUri: 'http://localhost:3001/v1/google-workspace/callback',
};

test('cipher binds tokens to every owner, account and generation dimension and supports old keys', () => {
  const cipher = googleCredentialCipher(keyring);
  const envelope = cipher.encrypt('tokens', binding, 'private-token');
  assert.equal(JSON.stringify(envelope).includes('private-token'), false);
  assert.equal(cipher.decrypt('tokens', binding, envelope), 'private-token');
  for (const field of Object.keys(binding)) {
    assert.throws(
      () => cipher.decrypt('tokens', { ...binding, [field]: field === 'generation' ? 4 : randomUUID() }, envelope),
      { message: 'credential-unavailable' },
    );
  }
  assert.throws(() => cipher.decrypt('pkce', binding, envelope), { message: 'credential-unavailable' });
  assert.throws(() => cipher.decrypt('tokens', binding, { ...envelope, tag: Buffer.alloc(16).toString('base64') }), {
    message: 'credential-unavailable',
  });
  const rotated = googleCredentialCipher({ activeKeyId: 'two', keys: { ...keyring.keys, two: 'cd'.repeat(32) } });
  assert.equal(rotated.decrypt('tokens', binding, envelope), 'private-token');
  assert.equal(rotated.encrypt('tokens', binding, 'new-token').keyId, 'two');
  assert.throws(
    () =>
      googleCredentialCipher({ activeKeyId: 'two', keys: { two: 'cd'.repeat(32) } }).decrypt(
        'tokens',
        binding,
        envelope,
      ),
    { message: 'credential-unavailable' },
  );
});

test('configuration requires the separate exact OAuth settings and callback route', () => {
  assert.equal(
    googleWorkspaceConfig({ GOOGLE_CLIENT_ID: 'identity-client', GOOGLE_CLIENT_SECRET: 'identity-secret' }),
    undefined,
  );
  assert.throws(() => googleWorkspaceConfig({ GOOGLE_WORKSPACE_CLIENT_ID: 'private-client' }), {
    message: 'not-configured',
  });
  const env = {
    GOOGLE_WORKSPACE_CLIENT_ID: config.clientId,
    GOOGLE_WORKSPACE_CLIENT_SECRET: config.clientSecret,
    GOOGLE_WORKSPACE_REDIRECT_URI: config.redirectUri,
  };
  assert.deepEqual(googleWorkspaceConfig(env), config);
  for (const uri of [
    'http://remote.example/v1/google-workspace/callback',
    'https://user:secret@example.com/v1/google-workspace/callback',
    `${config.redirectUri}?override=true`,
    'https://api.example.com/wrong',
  ]) {
    assert.throws(() => googleWorkspaceConfig({ ...env, GOOGLE_WORKSPACE_REDIRECT_URI: uri }), {
      message: 'not-configured',
    });
  }
  assert.equal(googleWorkspaceScopes.length, 9);
  assert.equal(callbackSchema.safeParse({ state: 'state', code: 'code', error: 'denied' }).success, false);
});

test('provider sends credentials only to fixed endpoints and sanitizes errors', async () => {
  const calls = [];
  const provider = googleProvider(config, async (url, init) => {
    calls.push({ url, init });
    return Response.json({ access_token: 'access', token_type: 'Bearer', expires_in: 3600, refresh_token: 'refresh' });
  });
  assert.equal((await provider.exchange('code', 'verifier')).refresh_token, 'refresh');
  assert.equal(calls[0].url, 'https://oauth2.googleapis.com/token');
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].init.body.get('code_verifier'), 'verifier');
  assert.equal(calls[0].init.body.get('client_secret'), 'test-secret');
  for (const response of [
    Response.json({ error: 'private-error' }, { status: 500 }),
    new Response('not-json-private'),
    Response.json({ access_token: 'private' }),
    new Response('x'.repeat(70000)),
  ]) {
    await assert.rejects(googleProvider(config, async () => response).refresh('private'), {
      message: 'provider-unavailable',
    });
  }
  await assert.rejects(
    googleProvider(config, async () =>
      Response.json({ error: 'invalid_grant', error_description: 'private' }, { status: 400 }),
    ).refresh('private'),
    { message: 'reconnect-required' },
  );
  assert.equal(
    await googleProvider(config, async () => {
      throw new Error('private');
    }).revoke('private'),
    false,
  );
});
