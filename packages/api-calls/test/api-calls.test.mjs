import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { SecretError } from '@tulipfarm/secrets';
import { encodeBody, isCredentialName, normalizeApiUrl, requestHeaders, sendApiCall } from '../dist/index.js';

const failsWith = code => error => error.code === code;

test('credential names match ignoring case and separators, and ordinary names pass', () => {
  for (const name of [
    'X-Api-Key',
    'api_key',
    'access_token',
    'client_secret',
    'X-Auth-Token',
    'sessionid',
    'pass.word',
  ])
    assert.equal(isCredentialName(name), true, name);
  for (const name of ['code', 'id', 'state', 'sig', 'page', 'cursor'])
    assert.equal(isCredentialName(name), false, name);
});

test('URLs keep the transport destination rules and refuse typed credentials', () => {
  assert.equal(
    normalizeApiUrl('https://API.example.com/v1?code=1&sig=2', [
      { name: 'state', value: 'a b' },
      { name: 'page', value: '2' },
    ]).href,
    'https://api.example.com/v1?code=1&sig=2&state=a+b&page=2',
  );
  for (const url of [
    'http://api.example.com/',
    'https://api.example.com:8443/',
    'https://127.0.0.1/',
    'https://localhost/',
    'https://user@api.example.com/',
    'https://api.example.com/#x',
  ])
    assert.throws(() => normalizeApiUrl(url), failsWith('address-denied'), url);
  assert.throws(() => normalizeApiUrl('not a url'), failsWith('invalid-request'));
  assert.throws(() => normalizeApiUrl('https://api.example.com/{id}'), failsWith('invalid-request'));
  assert.throws(() => normalizeApiUrl('https://api.example.com/?api_key=1'), failsWith('credential-in-request'));
  assert.throws(
    () => normalizeApiUrl('https://api.example.com/', [{ name: 'access-token', value: 'x' }]),
    failsWith('credential-in-request'),
  );
  assert.throws(
    () =>
      normalizeApiUrl(
        'https://api.example.com/',
        Array.from({ length: 51 }, (_, index) => ({ name: `p${index}`, value: '1' })),
      ),
    failsWith('invalid-request'),
  );
  assert.throws(
    () => normalizeApiUrl('https://api.example.com/', [{ name: 'q', value: 'x'.repeat(4096) }]),
    failsWith('invalid-request'),
  );
});

test('headers allow Accept and refuse connection, override and credential headers', () => {
  assert.deepEqual(requestHeaders({ Accept: 'text/csv', 'X-Trace': 'abc' }), {
    accept: 'text/csv',
    'x-trace': 'abc',
    'user-agent': 'TulipFarm-ApiCall/1',
  });
  for (const name of ['Authorization', 'Proxy-Authorization', 'X-Api-Key'])
    assert.throws(() => requestHeaders({ [name]: 'x' }), failsWith('credential-in-request'), name);
  for (const name of [
    'Cookie',
    'Host',
    'Content-Length',
    'Transfer-Encoding',
    'Proxy-Foo',
    'Sec-Fetch-Mode',
    'X-Forwarded-For',
    'X-HTTP-Method-Override',
    'X-Method-Override',
    'User-Agent',
    'Content-Type',
  ])
    assert.throws(() => requestHeaders({ [name]: 'x' }), failsWith('invalid-request'), name);
  assert.throws(() => requestHeaders({ 'x-a': 'line\nbreak' }), failsWith('invalid-request'));
  assert.throws(
    () => requestHeaders(Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`x-h${index}`, '1']))),
    failsWith('invalid-request'),
  );
  assert.throws(
    () =>
      requestHeaders(Object.fromEntries(Array.from({ length: 3 }, (_, index) => [`x-h${index}`, 'v'.repeat(6000)]))),
    failsWith('invalid-request'),
  );
});

test('bodies are encoded with their content type and limited to 1 MiB', () => {
  assert.deepEqual(encodeBody({ kind: 'json', value: { a: [1] } }), {
    body: '{"a":[1]}',
    contentType: 'application/json',
  });
  assert.deepEqual(
    encodeBody({
      kind: 'form',
      fields: [
        { name: 'a', value: '1 2' },
        { name: 'a', value: '&' },
      ],
    }),
    { body: 'a=1+2&a=%26', contentType: 'application/x-www-form-urlencoded' },
  );
  assert.equal(
    encodeBody({ kind: 'text', contentType: 'application/soap+xml; charset=utf-8', text: '<a/>' }).body,
    '<a/>',
  );
  assert.throws(
    () => encodeBody({ kind: 'text', contentType: 'application/octet-stream', text: 'x' }),
    failsWith('invalid-request'),
  );
  assert.throws(() => encodeBody({ kind: 'json', value: 'x'.repeat(1024 * 1024) }), failsWith('too-large'));
});

function certificate(t) {
  const directory = mkdtempSync(join(tmpdir(), 'api-calls-tls-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const keyPath = join(directory, 'key.pem'),
    certPath = join(directory, 'cert.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '1',
      '-subj',
      '/CN=api.example.test',
      '-addext',
      'subjectAltName=DNS:api.example.test',
    ],
    { stdio: 'ignore' },
  );
  return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
}

async function server(t, handler) {
  const { key, cert } = certificate(t);
  const received = [];
  const instance = createServer({ key, cert }, (req, res) => {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, headers: req.headers, body });
      handler(req, res);
    });
  });
  instance.listen(0, '127.0.0.1');
  await once(instance, 'listening');
  t.after(() => {
    instance.closeAllConnections();
    instance.close();
  });
  const port = instance.address().port;
  let address = '8.8.8.8';
  const dependencies = {
    lookup: async hostname => {
      if (hostname === 'missing.example.test') throw new Error('ENOTFOUND');
      return [{ address, family: 4 }];
    },
    request: (url, options, callback) =>
      request(
        url,
        {
          ...options,
          port,
          ca: cert,
          lookup: (_hostname, _options, callback) => callback(null, [{ address: '127.0.0.1', family: 4 }]),
        },
        callback,
      ),
  };
  const options = (extra = {}) => ({ workspaceId: randomUUID(), scope: randomUUID(), dependencies, ...extra });
  return {
    received,
    options,
    resolveTo: value => (address = value),
  };
}

const routes = (req, res) => {
  const path = new URL(req.url, 'https://api.example.test').pathname;
  if (path === '/json')
    res
      .writeHead(200, {
        'content-type': 'application/json',
        'x-request-id': 'r1',
        'x-ratelimit-remaining': '9',
        'set-cookie': 'a=b',
        server: 'test',
      })
      .end('{"items":[1,2]}');
  else if (path === '/text') res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not here');
  else if (path === '/latin1')
    res.writeHead(200, { 'content-type': 'text/plain; charset=iso-8859-1' }).end(Buffer.from([0xe9]));
  else if (path === '/bad-json') res.writeHead(200, { 'content-type': 'application/json' }).end('{oops');
  else if (path === '/sniff') res.writeHead(200).end('{"sniffed":true}');
  else if (path === '/binary')
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': '4' }).end('\x89PNG');
  else if (path === '/large') res.writeHead(200, { 'content-type': 'text/plain' }).end('x'.repeat(64 * 1024 + 1));
  else if (path === '/exact') res.writeHead(200, { 'content-type': 'text/plain' }).end('x'.repeat(64 * 1024));
  else if (path === '/redirect')
    res.writeHead(302, { location: '/next?key=s3cr3t-value&page=2', 'x-request-id': 'r2' }).end();
  else if (path === '/challenge')
    res.writeHead(401, { 'www-authenticate': 'Bearer realm="api"', 'content-type': 'text/plain' }).end('missing key');
  else if (path === '/echo')
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ seen: req.headers.authorization }));
  else if (path === '/report')
    res
      .writeHead(200, {
        'content-type': 'application/vnd.example+json',
        'content-disposition': 'attachment; filename="q3/report.json"',
      })
      .end(JSON.stringify({ rows: 'x'.repeat(70 * 1024) }));
  else if (path === '/huge') res.writeHead(200, { 'content-type': 'text/csv' }).end('x'.repeat(10 * 1024 * 1024 + 1));
  else if (path === '/max') res.writeHead(200, { 'content-type': 'text/csv' }).end('x'.repeat(10 * 1024 * 1024));
  else if (path === '/large-echo')
    res
      .writeHead(200, { 'content-type': 'application/octet-stream' })
      .end(Buffer.concat([Buffer.alloc(70 * 1024), Buffer.from(String(req.headers.authorization))]));
  else if (path === '/gzip') res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' }).end('x');
  else if (path === '/hang') return;
  else if (path === '/drop') req.socket.destroy();
  else res.writeHead(204).end();
};

test('reads return status, safe headers and a bounded JSON or text body', async t => {
  const api = await server(t, routes);
  const send = (path, extra = {}) =>
    sendApiCall(
      { tool: 'api.request', method: 'GET', url: `https://api.example.test${path}`, ...extra },
      api.options(),
    );

  const json = await send('/json', { query: [{ name: 'page', value: '2' }], headers: { Accept: 'application/json' } });
  assert.equal(json.status, 'sent');
  assert.equal(json.url, 'https://api.example.test/json?page=2');
  assert.equal(json.response.status, 200);
  assert.deepEqual(json.response.headers, {
    'content-type': 'application/json',
    'x-request-id': 'r1',
    'x-ratelimit-remaining': '9',
  });
  assert.deepEqual(json.response.body, { kind: 'json', value: { items: [1, 2] } });
  assert.equal(json.untrusted, true);
  assert.deepEqual(json.secrets, []);
  assert.equal(api.received.at(-1).headers['user-agent'], 'TulipFarm-ApiCall/1');
  assert.equal(api.received.at(-1).headers['accept-encoding'], 'identity');

  const missing = await send('/text');
  assert.equal(missing.status, 'sent');
  assert.equal(missing.response.status, 404);
  assert.deepEqual(missing.response.body, { kind: 'text', text: 'not here' });

  assert.deepEqual((await send('/latin1')).response.body, { kind: 'text', text: 'é' });
  assert.deepEqual((await send('/bad-json')).response.body, { kind: 'text', text: '{oops' });
  assert.deepEqual((await send('/sniff')).response.body, { kind: 'json', value: { sniffed: true } });
  assert.equal((await send('/exact')).response.body.text.length, 64 * 1024);

  const large = await send('/large');
  assert.deepEqual(large.response.body, {
    kind: 'omitted',
    reason: 'too-large',
    bytes: null,
    contentType: 'text/plain',
  });
  assert.match(large.note, /64 KiB/);
  const binary = await send('/binary');
  assert.deepEqual(binary.response.body, { kind: 'omitted', reason: 'binary', bytes: 4, contentType: 'image/png' });
  assert.match(binary.note, /not text or JSON/);

  const head = await send('/json', { method: 'HEAD' });
  assert.equal(head.response.status, 200);
  assert.deepEqual(head.response.body, { kind: 'none' });
  assert.equal(api.received.at(-1).method, 'HEAD');
  assert.deepEqual((await send('/empty')).response.body, { kind: 'none' });

  const redirect = await send('/redirect');
  assert.equal(redirect.response.status, 302);
  assert.equal(redirect.response.headers.location, 'https://api.example.test/next?key=s3cr3t-value&page=2');
  assert.equal(api.received.filter(item => item.url.startsWith('/next')).length, 0);

  const challenge = await send('/challenge');
  assert.equal(challenge.status, 'sent');
  assert.deepEqual(challenge.authentication, { status: 401, challenge: 'Bearer realm="api"', excerpt: 'missing key' });

  const gzip = await send('/gzip');
  assert.equal(gzip.status, 'failed');
  assert.equal(gzip.code, 'network-failed');
});

test('with files, large and binary bodies are saved up to 10 MiB and the result names them', async t => {
  const api = await server(t, routes);
  const saved = [];
  let full = false;
  const files = {
    save: async file => {
      if (full) return null;
      saved.push(file);
      return { source: `call-${saved.length}` };
    },
  };
  const secrets = secretPort(
    { BEARER: { name: 'Stripe', placement: { kind: 'bearer' }, value: { value: 'sk-live-0123456789' } } },
    [],
  );
  const send = (path, extra = {}) =>
    sendApiCall(
      { tool: 'api.request', method: 'GET', url: `https://api.example.test${path}`, ...extra },
      api.options({ files, secrets }),
    );

  assert.deepEqual((await send('/json')).response.body, { kind: 'json', value: { items: [1, 2] } });
  assert.equal(saved.length, 0);

  const report = await send('/report');
  assert.deepEqual(report.response.body, {
    kind: 'file',
    source: 'call-1',
    name: 'q3report.json',
    contentType: 'application/vnd.example+json',
    bytes: 70 * 1024 + 11,
  });
  assert.match(report.note, /files\.read and source call-1/);
  assert.deepEqual(
    { ...saved[0], bytes: saved[0].bytes.byteLength },
    {
      name: 'q3report.json',
      mediaType: 'application/json',
      bytes: 70 * 1024 + 11,
      url: 'https://api.example.test/report',
      private: false,
    },
  );

  const binary = await send('/binary', { secrets: [{ variable: 'BEARER' }] });
  assert.deepEqual(binary.response.body, {
    kind: 'file',
    source: 'call-2',
    name: 'binary',
    contentType: 'image/png',
    bytes: 4,
  });
  assert.equal(saved[1].mediaType, 'image/png');
  assert.equal(saved[1].private, true);

  assert.equal((await send('/max')).response.body.bytes, 10 * 1024 * 1024);
  assert.equal(saved[2].mediaType, 'text/csv');

  const huge = await send('/huge');
  assert.equal(huge.status, 'sent');
  assert.deepEqual(huge.response.body, { kind: 'omitted', reason: 'too-large', bytes: null, contentType: 'text/csv' });
  assert.match(huge.note, /over 10 MiB/);

  const reflected = await send('/large-echo', { secrets: [{ variable: 'BEARER' }] });
  assert.equal(reflected.code, 'secret-reflected');
  assert.equal(saved.length, 3);

  full = true;
  const fullStorage = await send('/large');
  assert.equal(fullStorage.status, 'sent');
  assert.deepEqual(fullStorage.response.body, {
    kind: 'omitted',
    reason: 'too-large',
    bytes: 64 * 1024 + 1,
    contentType: 'text/plain',
  });
  assert.match(fullStorage.note, /Storage is full/);
});

test('invalid calls and changes are refused before any lookup', async t => {
  const api = await server(t, routes);
  const base = { tool: 'api.request', method: 'GET', url: 'https://api.example.test/json' };
  const cases = [
    [{ ...base, method: 'TRACE' }, 'invalid-request'],
    [{ ...base, body: { kind: 'json', value: {} } }, 'invalid-request'],
    [{ ...base, headers: { Authorization: 'Bearer x' } }, 'credential-in-request'],
    [{ ...base, url: 'https://api.example.test/?client_secret=x' }, 'credential-in-request'],
    [{ ...base, url: 'https://10.0.0.1/' }, 'address-denied'],
    [{ ...base, timeoutSeconds: 61 }, 'invalid-request'],
    [{ ...base, method: 'POST', body: { kind: 'json', value: {} } }, 'approval-unavailable'],
    [{ ...base, method: 'DELETE' }, 'approval-unavailable'],
    [{ ...base, secrets: [{ variable: 'STRIPE_KEY' }] }, 'disabled'],
  ];
  for (const [call, code] of cases) {
    const result = await sendApiCall(call, api.options());
    assert.equal(result.status, 'failed', JSON.stringify(call));
    assert.equal(result.code, code, JSON.stringify(call));
  }
  assert.equal(api.received.length, 0);
});

test('network failures map to their codes', async t => {
  const api = await server(t, routes);
  const send = (url, extra = {}) => sendApiCall({ tool: 'api.request', method: 'GET', url, ...extra }, api.options());
  assert.equal((await send('https://missing.example.test/')).code, 'dns-failed');
  api.resolveTo('10.0.0.1');
  assert.equal((await send('https://api.example.test/json')).code, 'address-denied');
  api.resolveTo('8.8.8.8');
  const hang = await send('https://api.example.test/hang', { timeoutSeconds: 1 });
  assert.equal(hang.code, 'timeout');
  assert.match(hang.message, /may be repeated/);
  const dropped = await send('https://api.example.test/drop');
  assert.equal(dropped.code, 'network-failed');
});

function secretPort(secrets, uses) {
  return {
    resolve: async (handle, url) => {
      const key = 'reference' in handle ? handle.reference : handle.variable;
      const secret = secrets[key];
      if (!secret) throw new SecretError('not-found');
      if (secret.host && new URL(url).hostname !== secret.host) throw new SecretError('destination-denied');
      return { secretId: key, name: secret.name, placement: secret.placement, value: secret.value };
    },
    recordUse: async (secretId, url) => uses.push({ secretId, url }),
  };
}

test('secrets are placed, redacted, recorded and never reflected back', async t => {
  const api = await server(t, routes);
  const uses = [];
  const secrets = secretPort(
    {
      BEARER: { name: 'Stripe', placement: { kind: 'bearer' }, value: { value: 'sk-live-0123456789' } },
      QUERY: { name: 'Maps', placement: { kind: 'query', name: 'key' }, value: { value: 'maps-key-0123' } },
      HEADER: { name: 'Header', placement: { kind: 'header', name: 'x-api-key' }, value: { value: 'hdr-0123456' } },
      BODY: {
        name: 'Body',
        placement: { kind: 'body', format: 'json', fields: ['token'] },
        value: { value: 'body-0123456' },
      },
      ELSEWHERE: {
        name: 'Elsewhere',
        host: 'other.example.test',
        placement: { kind: 'bearer' },
        value: { value: 'x-0123456' },
      },
    },
    uses,
  );
  const send = (path, extra = {}) =>
    sendApiCall(
      { tool: 'api.request', method: 'GET', url: `https://api.example.test${path}`, ...extra },
      api.options({ secrets }),
    );

  const placed = await send('/json', { secrets: [{ variable: 'QUERY' }, { variable: 'HEADER' }] });
  assert.equal(placed.status, 'sent');
  assert.equal(api.received.at(-1).url, '/json?key=maps-key-0123');
  assert.equal(api.received.at(-1).headers['x-api-key'], 'hdr-0123456');
  assert.equal(placed.url, 'https://api.example.test/json');
  assert.deepEqual(
    placed.secrets.map(secret => secret.name),
    ['Maps', 'Header'],
  );
  assert.deepEqual(uses.splice(0), [
    { secretId: 'QUERY', url: 'https://api.example.test/json' },
    { secretId: 'HEADER', url: 'https://api.example.test/json' },
  ]);

  const redirect = await send('/redirect', { secrets: [{ variable: 'QUERY' }] });
  assert.equal(redirect.response.headers.location, 'https://api.example.test/next?page=2');

  const reflected = await send('/echo', { secrets: [{ variable: 'BEARER' }] });
  assert.deepEqual(reflected, {
    status: 'failed',
    code: 'secret-reflected',
    message: reflected.message,
    httpStatus: 200,
  });
  assert.equal(uses.splice(0).length, 2);

  const refused = await send('/challenge', { secrets: [{ variable: 'BEARER' }] });
  assert.equal(refused.authentication.status, 401);

  const before = api.received.length;
  for (const [extra, code] of [
    [{ secrets: [{ variable: 'MISSING' }] }, 'not-found'],
    [{ secrets: [{ variable: 'ELSEWHERE' }] }, 'destination-denied'],
    [{ secrets: [{ variable: 'BODY' }] }, 'placement-unsupported'],
    [{ secrets: [{ variable: 'HEADER' }], headers: { 'X-Api-Key': 'typed' } }, 'credential-in-request'],
    [{ secrets: [{ variable: 'QUERY' }], query: [{ name: 'key', value: 'typed' }] }, 'credential-in-request'],
    [{ secrets: [{ variable: 'BEARER' }, { variable: 'BEARER' }] }, 'invalid-request'],
  ]) {
    const result = await send('/json', extra);
    assert.equal(result.code, code, JSON.stringify(extra));
  }
  assert.equal(api.received.length, before);
  assert.deepEqual((await send('/json', { secrets: [{ variable: 'MISSING' }] })).secret, 'MISSING');
  uses.splice(0);

  const dropped = await send('/drop', { secrets: [{ variable: 'BEARER' }] });
  assert.equal(dropped.code, 'network-failed');
  assert.equal(uses.length, 1);
});

test('a turn makes at most 50 calls', async t => {
  const api = await server(t, routes);
  const options = api.options();
  const call = { tool: 'api.request', method: 'HEAD', url: 'https://api.example.test/json' };
  for (let index = 0; index < 50; index++) assert.equal((await sendApiCall(call, options)).status, 'sent');
  assert.equal((await sendApiCall(call, options)).code, 'call-limit');
  assert.equal((await sendApiCall(call, { ...options, scope: randomUUID() })).status, 'sent');
});

test('a workspace has at most 10 calls in flight and later calls wait within their timeout', async t => {
  const pending = [];
  const api = await server(t, (req, res) => {
    if (req.url === '/hold') pending.push(res);
    else res.writeHead(204).end();
  });
  const workspaceId = randomUUID();
  const send = (path, timeoutSeconds = 5) =>
    sendApiCall(
      { tool: 'api.request', method: 'GET', url: `https://api.example.test${path}`, timeoutSeconds },
      { ...api.options(), workspaceId },
    );
  const held = Array.from({ length: 10 }, () => send('/hold'));
  while (pending.length < 10) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await send('/quick', 1)).code, 'timeout');
  const waiting = send('/quick');
  await new Promise(resolve => setTimeout(resolve, 50));
  pending.shift().writeHead(204).end();
  assert.equal((await waiting).status, 'sent');
  for (const res of pending) res.writeHead(204).end();
  for (const result of await Promise.all(held)) assert.equal(result.status, 'sent');
});
