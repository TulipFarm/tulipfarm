import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../src/app.ts';

async function lookup(env) {
  const saved = { ...process.env };
  Object.assign(process.env, { NODE_ENV: 'test', HOST: '127.0.0.1' }, env);
  for (const key of ['ACS_CONNECTION_STRING', 'SMTP_HOST', 'EMAIL_PROVIDER']) if (!env[key]) delete process.env[key];
  const app = buildApp();
  try {
    return (await app.inject('/v1/dev/sign-in-link?email=nobody@tulipfarm.test')).json();
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
