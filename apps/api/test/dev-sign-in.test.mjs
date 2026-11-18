import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../src/app.ts';
import Fastify from 'fastify';
import { registerAuth } from '../src/auth.ts';

// The app serves the shipped model catalog, which needs a provider key.
process.env.ANTHROPIC_API_KEY ??= 'test-key';

async function lookup(env, url = '/v1/dev/sign-in-link?email=nobody@tulipfarm.test') {
  const saved = { ...process.env };
  Object.assign(process.env, { NODE_ENV: 'test', HOST: '127.0.0.1' }, env);
  for (const key of ['ACS_CONNECTION_STRING', 'SMTP_HOST', 'EMAIL_PROVIDER', 'DEV_AUTO_SIGN_IN'])
    if (!env[key]) delete process.env[key];
  const app = buildApp({ agentModel: null });
  try {
    return (await app.inject(url)).json();
  } finally {
    await app.close();
    process.env = saved;
  }
}

test('dev sign-in link route exists only without an email sender', async () => {
  assert.deepEqual(await lookup({}), { error: 'No sign-in link' });
  assert.notDeepEqual(await lookup({ ACS_CONNECTION_STRING: 'endpoint=https://acs.test/;accesskey=fixture' }), {
    error: 'No sign-in link',
  });
  assert.notDeepEqual(await lookup({ SMTP_HOST: 'smtp.example.test' }), { error: 'No sign-in link' });
});

test('auth options offer local auto sign-in unless opted out or sending real email', async () => {
  const offered = async env => (await lookup(env, '/v1/auth/options')).devAutoSignIn === true;
  assert.equal(await offered({}), true);
  assert.equal(await offered({ DEV_AUTO_SIGN_IN: 'false' }), false);
  assert.equal(await offered({ SMTP_HOST: 'smtp.example.test' }), false);
  assert.equal(await offered({ HOST: '0.0.0.0' }), false);
});

test('production auth starts with disabled email and with SMTP without any ACS configuration', async () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, {
      NODE_ENV: 'production',
      BETTER_AUTH_SECRET: 'test-only-auth-secret-at-least-32-characters',
      BETTER_AUTH_URL: 'https://app.example.com',
      WEB_ORIGIN: 'https://app.example.com',
      AUTH_METHODS: 'password,magic-link',
    });
    for (const name of [
      'AUTH_EMAIL_PASSWORD',
      'EMAIL_PROVIDER',
      'ACS_CONNECTION_STRING',
      'ACS_SENDER_ADDRESS',
      'SMTP_HOST',
      'EMAIL_DELIVERY_KEY',
      'EMAIL_DELIVERY_KEY_ID',
      'EMAIL_DELIVERY_PREVIOUS_KEYS',
      'GOOGLE_CLIENT_ID',
      'GOOGLE_CLIENT_SECRET',
    ])
      delete process.env[name];
    for (const enabled of [false, true]) {
      if (enabled) {
        process.env.EMAIL_PROVIDER = 'smtp';
        process.env.EMAIL_DELIVERY_KEY_ID = 'test-v1';
        process.env.EMAIL_DELIVERY_KEY = 'ab'.repeat(32);
      }
      const app = Fastify();
      try {
        registerAuth(app);
        const response = await app.inject('/auth/options');
        assert.equal(response.statusCode, 200);
        assert.equal(response.json().passwordResetEmail, enabled);
        assert.equal(response.json().magicLink, enabled);
        assert.equal(response.json().google, false);
        if (!enabled) {
          const link = await app.inject({
            method: 'POST',
            url: '/auth/sign-in/magic-link',
            payload: { email: 'person@example.com' },
          });
          assert.equal(link.statusCode, 404);
          assert.equal(link.json().code, 'MAGIC_LINK_DISABLED');
        }
      } finally {
        await app.close();
      }
    }
  } finally {
    process.env = saved;
  }
});
