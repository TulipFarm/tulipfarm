import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../src/app.ts';
import { createTurnstileVerifier, turnstileConfig, turnstileTestKeys } from '../src/turnstile.ts';

const config = { siteKey: 'fixture-site-key', secretKey: 'fixture-secret' };
const success = { success: true, hostname: 'localhost', action: 'sign_in' };

test('workspace verification rejects sign-in tokens and requires its own action', async t => {
  let body = success;
  t.mock.method(globalThis, 'fetch', async () => Response.json(body));
  const verify = createTurnstileVerifier(config, 'http://localhost:5173', 'create_workspace');
  await assert.rejects(verify('sign-in-token'), { status: 'FORBIDDEN' });
  body = { ...success, action: 'create_workspace' };
  await verify('workspace-token');
  await assert.rejects(createTurnstileVerifier(config, 'http://localhost:5173')('workspace-token'), {
    status: 'FORBIDDEN',
  });
});

test('Turnstile accepts only a successful hostname- and action-bound response', async t => {
  const calls = [];
  let result = Response.json(success);
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    return result;
  });
  const verify = createTurnstileVerifier(config, 'http://localhost:5173');
  await verify('valid-token');
  assert.equal(calls[0].url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
  assert.equal(calls[0].options.body.get('secret'), config.secretKey);
  assert.equal(calls[0].options.body.get('response'), 'valid-token');
  assert.equal(calls[0].options.redirect, 'error');
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  for (const body of [
    { success: false, 'error-codes': ['timeout-or-duplicate'] },
    { ...success, hostname: 'attacker.example' },
    { ...success, action: 'another_action' },
    { ...success, success: 'true' },
    {},
    null,
  ]) {
    result = Response.json(body);
    await assert.rejects(verify('rejected-token'), {
      status: 'FORBIDDEN',
      body: { code: 'CHALLENGE_FAILED', message: 'Verification failed. Please complete a new challenge.' },
    });
  }
  for (const response of [new Response('bad json'), new Response(null, { status: 503 })]) {
    result = response;
    await assert.rejects(verify('token'), { status: 'FORBIDDEN' });
  }
  const before = calls.length;
  for (const token of [null, '', '   ', 'x'.repeat(2049)]) await assert.rejects(verify(token), { status: 'FORBIDDEN' });
  assert.equal(calls.length, before, 'Invalid tokens never reach Cloudflare');
  const fetches = calls.length;
  await createTurnstileVerifier(null, 'http://localhost:5173')(null);
  assert.equal(calls.length, fetches, 'Unconfigured Turnstile skips verification');
});

test('provider failures and timeouts reject without retry or private diagnostics', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('fixture-secret private-token');
  });
  const verify = createTurnstileVerifier(config, 'http://localhost:5173');
  await assert.rejects(verify('private-token'), error => {
    assert.equal(error.body.code, 'CHALLENGE_FAILED');
    assert.equal(JSON.stringify(error).includes('private-token'), false);
    assert.equal(JSON.stringify(error).includes('fixture-secret'), false);
    return true;
  });
  assert.equal(fetch.mock.callCount(), 1);
  t.mock.method(AbortSignal, 'timeout', milliseconds => {
    assert.equal(milliseconds, 5000);
    return AbortSignal.abort(new DOMException('Timeout', 'TimeoutError'));
  });
  fetch.mock.mockImplementation(async (_url, { signal }) => signal.throwIfAborted());
  await assert.rejects(verify('token'), { status: 'FORBIDDEN' });
  assert.equal(fetch.mock.callCount(), 2);
});

test('local defaults use paired test keys while explicit overrides must remain paired', async t => {
  const oldEnv = { ...process.env };
  t.after(() => {
    process.env = oldEnv;
  });
  delete process.env.TURNSTILE_SITE_KEY;
  delete process.env.TURNSTILE_SECRET_KEY;
  for (const environment of [undefined, 'development', 'test']) {
    if (environment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = environment;
    assert.deepEqual(turnstileConfig(), {
      siteKey: '1x00000000000000000000AA',
      secretKey: '1x0000000000000000000000000000000AA',
    });
  }
  process.env.TURNSTILE_SITE_KEY = 'site';
  assert.throws(turnstileConfig, /Set both/);
  process.env.TURNSTILE_SECRET_KEY = 'secret';
  assert.deepEqual(turnstileConfig(), { siteKey: 'site', secretKey: 'secret' });
  delete process.env.TURNSTILE_SITE_KEY;
  assert.throws(turnstileConfig, /Set both/);
  delete process.env.TURNSTILE_SECRET_KEY;
  process.env.NODE_ENV = 'production';
  assert.equal(turnstileConfig(), null, 'Production runs without Turnstile when no keys are set');
});

test('production startup rejects every official dummy key and allows missing keys', async t => {
  const oldEnv = { ...process.env };
  t.after(() => {
    process.env = oldEnv;
  });
  Object.assign(process.env, {
    NODE_ENV: 'production',
    BETTER_AUTH_SECRET: 'production-test-signing-secret-32-characters',
    BETTER_AUTH_URL: 'https://api.example.test',
    WEB_ORIGIN: 'https://app.example.test',
  });
  for (const siteKey of [
    '1x00000000000000000000AA',
    '2x00000000000000000000AB',
    '1x00000000000000000000BB',
    '2x00000000000000000000BB',
    '3x00000000000000000000FF',
  ]) {
    Object.assign(process.env, { TURNSTILE_SITE_KEY: siteKey, TURNSTILE_SECRET_KEY: 'real-secret' });
    assert.throws(turnstileConfig, /test keys are only allowed/);
  }
  for (const secretKey of [
    '1x0000000000000000000000000000000AA',
    '2x0000000000000000000000000000000AA',
    '3x0000000000000000000000000000000AA',
  ]) {
    Object.assign(process.env, { TURNSTILE_SITE_KEY: 'real-site', TURNSTILE_SECRET_KEY: secretKey });
    assert.throws(turnstileConfig, /test keys are only allowed/);
  }
  const app = buildApp();
  try {
    await assert.rejects(app.ready(), /test keys are only allowed/);
  } finally {
    await app.close();
  }
  Object.assign(process.env, { TURNSTILE_SITE_KEY: 'real-site', TURNSTILE_SECRET_KEY: 'real-secret' });
  assert.deepEqual(turnstileConfig(), { siteKey: 'real-site', secretKey: 'real-secret' });
  delete process.env.TURNSTILE_SITE_KEY;
  delete process.env.TURNSTILE_SECRET_KEY;
  assert.equal(turnstileConfig(), null);
  process.env.NODE_ENV = 'staging';
  assert.equal(turnstileConfig(), null, 'Unknown environments do not default to dummy keys');
});

test('dummy verification still requires Cloudflare success and never relaxes real-key checks', async t => {
  const oldEnv = { ...process.env };
  t.after(() => {
    process.env = oldEnv;
  });
  process.env.NODE_ENV = 'test';
  const dummy = { success: true, hostname: 'example.com', metadata: { result_with_testing_key: true } };
  let result = dummy;
  t.mock.method(globalThis, 'fetch', async () => Response.json(result));
  const verify = createTurnstileVerifier(turnstileTestKeys, 'http://localhost:5173');
  await verify('XXXX.DUMMY.TOKEN.XXXX');
  await assert.rejects(verify(null), { status: 'FORBIDDEN' });
  await assert.rejects(verify('not-a-dummy-token'), { status: 'FORBIDDEN' });
  for (const body of [
    { success: false },
    { success: true },
    { ...dummy, success: 'true' },
    { ...dummy, metadata: { result_with_testing_key: false } },
  ]) {
    result = body;
    await assert.rejects(verify('XXXX.DUMMY.TOKEN.XXXX'), { status: 'FORBIDDEN' });
  }
  result = dummy;
  await assert.rejects(createTurnstileVerifier(config, 'http://localhost:5173')('XXXX.DUMMY.TOKEN.XXXX'), {
    status: 'FORBIDDEN',
  });
  process.env.NODE_ENV = 'production';
  await assert.rejects(createTurnstileVerifier(turnstileTestKeys, 'http://localhost:5173')('XXXX.DUMMY.TOKEN.XXXX'), {
    status: 'FORBIDDEN',
  });
});

test('HTTP options expose only the public key and preflight permits challenge tokens', async t => {
  const oldEnv = { ...process.env };
  Object.assign(process.env, {
    NODE_ENV: 'test',
    TURNSTILE_SITE_KEY: config.siteKey,
    TURNSTILE_SECRET_KEY: config.secretKey,
  });
  t.after(() => {
    process.env = oldEnv;
  });
  const app = buildApp();
  try {
    const options = await app.inject('/v1/auth/options');
    assert.deepEqual(options.json(), { turnstileSiteKey: config.siteKey });
    assert.equal(options.headers['cache-control'], 'no-store');
    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/v1/auth/sign-in/magic-link',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,x-captcha-response',
      },
    });
    assert.equal(preflight.statusCode, 204);
    assert.match(preflight.headers['access-control-allow-headers'], /x-captcha-response/);
  } finally {
    await app.close();
  }
});
