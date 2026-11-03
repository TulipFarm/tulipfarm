import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SecretError,
  applyPlacement,
  authHint,
  containsSecret,
  destinationAllows,
  normalizeDestinations,
  parseValue,
  placementFits,
  placementSchema,
  redactUrl,
} from '../dist/index.js';
import { secretCipher } from '../dist/cipher.js';

const all = ['bearer', 'basic', 'header', 'cookie', 'query', 'body'];
const request = { url: 'https://api.example.com/v1/items?page=2', headers: {} };
const code = code => error => error instanceof SecretError && error.code === code;

test('placements insert the value only where the secret says', () => {
  const key = { value: 'sk-live-123' };
  assert.equal(applyPlacement(request, { kind: 'bearer' }, key, all).headers.authorization, 'Bearer sk-live-123');
  assert.equal(
    applyPlacement(request, { kind: 'basic' }, { username: 'ana', password: 'p:w' }, all).headers.authorization,
    `Basic ${Buffer.from('ana:p:w').toString('base64')}`,
  );
  assert.equal(
    applyPlacement(request, { kind: 'basic' }, key, all).headers.authorization,
    `Basic ${Buffer.from('sk-live-123:').toString('base64')}`,
  );
  assert.equal(
    applyPlacement(request, { kind: 'header', name: 'x-api-key' }, key, all).headers['x-api-key'],
    key.value,
  );
  assert.equal(
    applyPlacement({ ...request, headers: { Cookie: 'a=1' } }, { kind: 'cookie', name: 'session' }, key, all).headers
      .cookie,
    'a=1; session=sk-live-123',
  );
  assert.equal(
    applyPlacement(request, { kind: 'query', name: 'api_key' }, key, all).url,
    'https://api.example.com/v1/items?page=2&api_key=sk-live-123',
  );
  const json = applyPlacement(
    { ...request, body: '{"q":1}' },
    { kind: 'body', format: 'json', fields: ['auth.user', 'auth.pass'] },
    { username: 'ana', password: 'pw' },
    all,
  );
  assert.deepEqual(JSON.parse(json.body), { q: 1, auth: { user: 'ana', pass: 'pw' } });
  assert.equal(json.headers['content-type'], 'application/json');
  const form = applyPlacement(request, { kind: 'body', format: 'form', fields: ['token'] }, key, all);
  assert.equal(form.body, 'token=sk-live-123');
});

test('a caller cannot shadow a placement or use an unsupported one', () => {
  const key = { value: 'sk-live-123' };
  assert.throws(
    () => applyPlacement({ ...request, headers: { Authorization: 'x' } }, { kind: 'bearer' }, key, all),
    code('invalid-input'),
  );
  assert.throws(
    () => applyPlacement({ ...request, url: `${request.url}&api_key=x` }, { kind: 'query', name: 'api_key' }, key, all),
    code('invalid-input'),
  );
  assert.throws(
    () =>
      applyPlacement(
        { ...request, body: '{"token":"x"}' },
        { kind: 'body', format: 'json', fields: ['token'] },
        key,
        all,
      ),
    code('invalid-input'),
  );
  assert.throws(
    () => applyPlacement(request, { kind: 'query', name: 'api_key' }, key, ['bearer', 'header']),
    code('placement-unsupported'),
  );
});

test('placement rules follow the MCP header rules and the kind', () => {
  for (const name of [
    'authorization',
    'cookie',
    'host',
    'proxy-x',
    'sec-fetch',
    'mcp-session',
    'x-forwarded-for',
    'Bad Name',
  ])
    assert.equal(placementSchema.safeParse({ kind: 'header', name }).success, false, name);
  assert.deepEqual(placementSchema.parse({ kind: 'header', name: 'X-Api-Key' }), { kind: 'header', name: 'x-api-key' });
  assert.equal(placementFits('username-password', { kind: 'basic' }), true);
  assert.equal(placementFits('username-password', { kind: 'bearer' }), false);
  assert.equal(placementFits('username-password', { kind: 'body', format: 'form', fields: ['u', 'p'] }), true);
  assert.equal(placementFits('api-key', { kind: 'body', format: 'form', fields: ['u', 'p'] }), false);
  assert.equal(placementFits('api-key', { kind: 'body', format: 'form', fields: ['k'] }), true);
  assert.throws(() => parseValue('api-key', { username: 'a', password: 'b' }), code('invalid-input'));
  assert.throws(() => parseValue('password', { value: 'a\nb' }));
  assert.throws(() => parseValue('token', { value: 'x'.repeat(17 * 1024) }), code('invalid-input'));
});

test('redactUrl removes query placement values', () => {
  const placement = { kind: 'query', name: 'api_key' };
  assert.equal(
    redactUrl('https://api.example.com/v1?api_key=secret&page=2', [placement]),
    'https://api.example.com/v1?page=2',
  );
  assert.equal(redactUrl('https://api.example.com/v1?x=1', [{ kind: 'bearer' }]), 'https://api.example.com/v1?x=1');
});

test('destinations are public HTTPS hosts or exact endpoints', () => {
  const list = normalizeDestinations([
    { kind: 'host', host: 'API.Example.com' },
    { kind: 'endpoint', url: 'https://mcp.example.com/mcp' },
    { kind: 'host', host: 'api.example.com' },
  ]);
  assert.deepEqual(list, [
    { kind: 'endpoint', value: 'https://mcp.example.com/mcp' },
    { kind: 'host', value: 'api.example.com' },
  ]);
  for (const host of ['localhost', '127.0.0.1', 'api.example.com:8443', '*.example.com', 'a.com/path'])
    assert.throws(() => normalizeDestinations([{ kind: 'host', host }]), code('destination-denied'), host);
  assert.throws(() => normalizeDestinations([{ kind: 'endpoint', url: 'http://mcp.example.com/mcp' }]));
  assert.equal(destinationAllows(list, 'https://api.example.com/anything?x=1'), true);
  assert.equal(destinationAllows(list, 'https://sub.api.example.com/'), false);
  assert.equal(destinationAllows(list, 'https://mcp.example.com/mcp'), true);
  assert.equal(destinationAllows(list, 'https://mcp.example.com/other'), false);
});

test('reflection finds encoded and layered values, including in errors', () => {
  const secret = 'sk-live-a/b+c=';
  assert.equal(containsSecret({ body: `token: ${secret}` }, [secret]), true);
  assert.equal(containsSecret(encodeURIComponent(encodeURIComponent(secret)), [secret]), true);
  assert.equal(containsSecret(Buffer.from(secret).toString('base64'), [secret]), true);
  assert.equal(containsSecret(Buffer.from(secret).toString('base64url'), [secret]), true);
  assert.equal(containsSecret('sk-live-a&#x2f;b&#43;c&#61;', [secret]), true);
  assert.equal(containsSecret(new Error('failed', { cause: new Error(secret) }), [secret]), true);
  assert.equal(containsSecret({ [secret]: 1 }, [secret]), true);
  assert.equal(containsSecret('nothing here', [secret]), false);
});

test('auth hints carry status, challenge and a short safe excerpt', () => {
  assert.equal(authHint({ status: 500, headers: {} }), null);
  assert.deepEqual(
    authHint({
      status: 401,
      headers: { 'WWW-Authenticate': 'Bearer realm="api"' },
      body: ' Missing\n API key '.repeat(1),
    }),
    { status: 401, challenge: 'Bearer realm="api"', excerpt: 'Missing API key' },
  );
  assert.equal(authHint({ status: 403, headers: {}, body: 'x'.repeat(900) }).excerpt.length, 500);
  assert.deepEqual(authHint({ status: 401, headers: {}, body: 'bad key sk-live-1234' }, ['sk-live-1234']), {
    status: 401,
    challenge: null,
    excerpt: null,
  });
});

test('the cipher binds values to workspace, secret, version and placement', () => {
  const cipher = secretCipher({ activeKeyId: 'one', keys: { one: 'ab'.repeat(32) } });
  const binding = {
    workspaceId: '00000000-0000-4000-8000-000000000001',
    secretId: '00000000-0000-4000-8000-000000000002',
    version: 1,
    placement: { kind: 'header', name: 'x-api-key' },
  };
  const envelope = cipher.encrypt(binding, { value: 'sk-live-123' });
  assert.equal(JSON.stringify(envelope).includes('sk-live-123'), false);
  assert.deepEqual(cipher.decrypt(binding, 'api-key', envelope), { value: 'sk-live-123' });
  for (const changed of [
    { version: 2 },
    { secretId: '00000000-0000-4000-8000-000000000003' },
    { placement: { kind: 'header', name: 'x-other' } },
    { placement: { kind: 'bearer' } },
  ])
    assert.throws(
      () => cipher.decrypt({ ...binding, ...changed }, 'api-key', envelope),
      code('credential-unavailable'),
    );
  const rotated = secretCipher({ activeKeyId: 'two', keys: { two: 'cd'.repeat(32), one: 'ab'.repeat(32) } });
  assert.deepEqual(rotated.decrypt(binding, 'api-key', envelope), { value: 'sk-live-123' });
  assert.throws(() => secretCipher({ activeKeyId: 'x', keys: {} }).check(), code('credential-unavailable'));
});
