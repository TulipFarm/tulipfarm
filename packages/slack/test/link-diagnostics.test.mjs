import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { AccessDenied } from '@tulipfarm/access';
import { memberProvider } from '../src/member-provider.ts';
import { slackLinkFailure, slackOAuthErrorCode } from '../src/link-diagnostics.ts';

const config = {
  clientId: 'test-client',
  clientSecret: 'client-secret',
  memberLinking: {
    identityRedirectUri: 'https://api.example.test/identity',
    operationalRedirectUri: 'https://api.example.test/complete',
  },
};

test('real token exchange reports allowlisted Slack rejection without retaining response secrets', async () => {
  for (const error of ['invalid_code', 'bad_redirect_uri', 'private-token-value']) {
    const provider = memberProvider(config, async () =>
      Response.json({ ok: false, error, access_token: 'private-access-token', detail: 'private-detail' }),
    );
    for (const call of [
      () => provider.identity('private-code', 'private-nonce'),
      () => provider.operational('private-code', 'private-verifier'),
    ]) {
      await assert.rejects(call, failure => {
        assert.deepEqual(slackLinkFailure(failure), {
          'error.type': 'slack-token-exchange-failed',
          'error.issues': error === 'private-token-value' ? 'unrecognized-provider-error' : error,
        });
        assert.equal(JSON.stringify(failure).includes('private-'), false);
        return true;
      });
    }
  }
});

test('validation diagnostics include safe field paths without values, messages or arbitrary keys', () => {
  const parsed = z
    .object({ id_token: z.string(), 'private-field': z.string() })
    .safeParse({ id_token: 42, 'private-field': 43 });
  assert.equal(parsed.success, false);
  assert.deepEqual(slackLinkFailure(parsed.error), {
    'error.type': 'invalid-slack-data',
    'error.issues': '[{"code":"invalid_type","path":["id_token"]},{"code":"invalid_type","path":["_"]}]',
  });
  const error = new Error('private-token-value');
  error.name = 'private-error-name';
  error.code = 'private-error-code';
  assert.deepEqual(slackLinkFailure(error), { 'error.type': 'unclassified-slack-link-failure' });
  assert.equal(slackOAuthErrorCode('private-callback-error'), 'unrecognized-provider-error');
});

test('JWT, database and known local failures remain distinguishable', () => {
  assert.deepEqual(slackLinkFailure(new AccessDenied()), { 'error.type': 'access-denied' });
  for (const code of ['ERR_JWT_EXPIRED', 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED', '42501', '42P01']) {
    assert.deepEqual(slackLinkFailure(Object.assign(new Error('private-detail'), { code })), { 'error.type': code });
  }
  assert.deepEqual(slackLinkFailure(new Error('slack-scope-missing')), { 'error.type': 'slack-scope-missing' });
});
