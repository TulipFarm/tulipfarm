import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toolContractDigest } from '@tulipfarm/provider-mcp';
import { runQualification } from '../../../tooling/github-qualification.mjs';

const token = 'synthetic-private-oauth-token';
const deviceCode = 'synthetic-private-device-code';
const privateLogin = 'private-account-login';
const tool = {
  name: 'search_repositories',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
};
const review = {
  reviewedBy: 'local-reviewer',
  reviewedAt: '2026-10-03T00:00:00Z',
  readBindings: [{ operation: 'repository.search', name: tool.name, contractDigest: toolContractDigest(tool) }],
  writeBindings: [],
};
const granted = { access_token: token, token_type: 'bearer', scope: 'read:user repo' };

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'github-device-qualification-'));
  const requests = [],
    waits = [];
  let clock = 0,
    stdout = '',
    stderr = '',
    poll = 0;
  const responses = options.responses ?? [
    { error: 'authorization_pending' },
    { error: 'slow_down', interval: 12 },
    granted,
  ];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    requests.push({ path: request.url, method: request.method, body, authorization: request.headers.authorization });
    let result;
    if (request.url === '/login/device/code')
      result = {
        device_code: deviceCode,
        user_code: 'ABCD-EFGH',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 5,
        ...options.device,
      };
    else if (request.url === '/login/oauth/access_token') result = responses[Math.min(poll++, responses.length - 1)];
    else if (request.url === '/user') result = { id: 123, login: privateLogin, ...options.identity };
    else if (request.url === '/mcp/') {
      const message = JSON.parse(body);
      if (message.method === 'notifications/initialized') {
        response.writeHead(202);
        response.end();
        return;
      }
      result = {
        jsonrpc: '2.0',
        id: message.id,
        result:
          message.method === 'initialize'
            ? {
                protocolVersion: '2025-03-26',
                capabilities: { tools: {} },
                serverInfo: { name: 'local-device-proof', version: '1' },
              }
            : { tools: options.tools ?? [tool] },
      };
    } else {
      response.writeHead(404);
      response.end();
      return;
    }
    if (options.redirect && request.url === '/user') {
      response.writeHead(302, { location: '/leak' });
      response.end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(result));
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const io = {
    env: {
      GITHUB_OAUTH_CLIENT_ID: 'synthetic-app-id',
      GITHUB_OAUTH_SCOPES: 'read:user repo',
      GITHUB_QUALIFICATION_TOKEN: 'must-not-be-used-in-device-mode',
    },
    stdout: text => {
      stdout += text;
    },
    stderr: text => {
      stderr += text;
    },
    now: () => clock,
    wait: async ms => {
      waits.push(ms);
      clock += ms + (options.oversleep ?? 0);
    },
    fetcher: (url, init) => {
      const target = new URL(url);
      assert.ok(
        [
          'https://github.com/login/device/code',
          'https://github.com/login/oauth/access_token',
          'https://api.github.com/user',
          'https://api.githubcopilot.com/mcp/',
        ].includes(target.href),
      );
      return fetch(`http://127.0.0.1:${server.address().port}${target.pathname}`, init);
    },
  };
  const run = async (args = ['--inspect'], accountId = '123') => {
    const output = join(directory, `artifact-${(await readdir(directory)).length}.json`);
    const code = await runQualification(['--device', '--account-id', accountId, ...args, '--output', output], io);
    return { code, output, stdout, stderr };
  };
  const assertPrivate = async result => {
    const files = await readdir(directory);
    const captured =
      result.stdout +
      result.stderr +
      (await Promise.all(files.map(file => readFile(join(directory, file), 'utf8')))).join('');
    for (const value of [token, deviceCode, privateLogin, 'must-not-be-used-in-device-mode']) {
      for (const secret of [value, Buffer.from(value).toString('base64'), Buffer.from(value).toString('base64url')])
        assert.equal(captured.includes(secret), false);
    }
  };
  return { run, requests, waits, directory, io, assertPrivate };
}

test('device CLI keeps credentials private, checks account, and saves only an untrusted catalog', async t => {
  const f = await fixture(t);
  const result = await f.run();
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /Open https:\/\/github.com\/login\/device and enter ABCD-EFGH/);
  assert.match(result.stdout, /Untrusted catalog saved. No bindings approved/);
  const artifact = JSON.parse(await readFile(result.output, 'utf8'));
  assert.equal(artifact.kind, 'untrusted-catalog');
  assert.deepEqual(
    artifact.reads.map(item => item.name),
    ['search_repositories'],
  );
  assert.equal('readBindings' in artifact, false);
  assert.equal((await stat(result.output)).mode & 0o777, 0o600);
  assert.deepEqual(f.waits, [5000, 5000, 12000]);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(f.requests[0].body)), {
    client_id: 'synthetic-app-id',
    scope: 'read:user repo',
  });
  assert.deepEqual(Object.fromEntries(new URLSearchParams(f.requests[1].body)), {
    client_id: 'synthetic-app-id',
    device_code: deviceCode,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  });
  assert.equal(f.requests.find(request => request.path === '/user').authorization, `Bearer ${token}`);
  const mcp = f.requests.filter(request => request.path === '/mcp/');
  assert.deepEqual(
    [...new Set(mcp.map(request => JSON.parse(request.body).method))],
    ['initialize', 'notifications/initialized', 'tools/list'],
  );
  assert.ok(mcp.every(request => request.authorization === `Bearer ${token}`));
  await f.assertPrivate(result);
});

test('device CLI requires explicit reviewed operation bindings and rejects drift', async t => {
  const f = await fixture(t, { responses: [granted] });
  const path = join(f.directory, 'review.json');
  await writeFile(path, JSON.stringify(review));
  const result = await f.run(['--review', path]);
  assert.equal(result.code, 0);
  const artifact = JSON.parse(await readFile(result.output, 'utf8'));
  assert.equal(artifact.kind, 'reviewed-bindings');
  assert.deepEqual(artifact.readBindings, review.readBindings);
  assert.deepEqual(artifact.writeBindings, []);
  await f.assertPrivate(result);
  for (const changed of [
    { ...review, readBindings: [{ ...review.readBindings[0], contractDigest: '0'.repeat(64) }] },
    { ...review, readBindings: [{ ...review.readBindings[0], operation: 'unreviewed.operation' }] },
  ]) {
    await writeFile(path, JSON.stringify(changed));
    assert.equal((await f.run(['--review', path])).code, 1);
  }
});

test('device polling stops on expiry and denial, and permanently increases slow-down intervals', async t => {
  for (const error of [
    'expired_token',
    'token_expired',
    'access_denied',
    'device_flow_disabled',
    'incorrect_client_credentials',
    `provider-error-${token}`,
  ]) {
    const f = await fixture(t, { responses: [{ error, error_description: `${token} ${deviceCode} ${privateLogin}` }] });
    const result = await f.run();
    assert.equal(result.code, 1);
    assert.match(result.stderr, /rerun for a fresh code/);
    assert.deepEqual(f.waits, [5000]);
    assert.deepEqual(await readdir(f.directory), []);
    await f.assertPrivate(result);
  }
  const f = await fixture(t, {
    responses: [{ error: 'slow_down' }, { error: 'slow_down', interval: 1 }, { error: 'authorization_pending' }],
    device: { expires_in: 46 },
  });
  assert.equal((await f.run()).code, 1);
  assert.deepEqual(f.waits, [5000, 10000, 15000, 15000]);
  assert.equal(f.requests.length, 5);
  const overslept = await fixture(t, { oversleep: 900000 });
  assert.equal((await overslept.run()).code, 1);
  assert.equal(overslept.requests.length, 1);
});

test('wrong or malformed identity, unsafe provider replies, redirects, and reflections fail without output artifacts', async t => {
  for (const options of [
    { identity: { id: 456 } },
    { identity: { id: '123' } },
    { identity: { id: Number.MAX_SAFE_INTEGER + 1 } },
    { identity: { id: null, error: token } },
    { redirect: true },
    { device: { verification_uri: `https://example.test/${deviceCode}` } },
    { device: { user_code: `ABCD-EFGH\n${deviceCode}` } },
    { device: { interval: 0 } },
    { device: { expires_in: 901 } },
    { device: { error: token, device_code: null } },
    { responses: [{ ...granted, token_type: 'not-bearer' }] },
    { identity: { login: privateLogin.repeat(10000) } },
    ...[token, deviceCode, Buffer.from(deviceCode).toString('base64')].map(description => ({
      tools: [{ ...tool, inputSchema: { type: 'object', description } }],
    })),
  ]) {
    const f = await fixture(t, { responses: [granted], ...options });
    const result = await f.run();
    assert.equal(result.code, 1);
    assert.deepEqual(await readdir(f.directory), []);
    assert.equal(
      f.requests.some(request => request.path === '/leak'),
      false,
    );
    await f.assertPrivate(result);
  }
});

test('CLI help and invalid arguments do not start OAuth and existing output cannot be overwritten', async t => {
  const f = await fixture(t, { responses: [granted] });
  assert.equal(await runQualification(['--help'], f.io), 0);
  assert.equal(await runQualification(['--device', '--inspect'], f.io), 1);
  assert.equal((await f.run(['--inspect'], 'not-an-id')).code, 1);
  assert.equal(f.requests.length, 0);
  const output = join(f.directory, 'existing.json');
  await writeFile(output, 'keep this');
  assert.equal(await runQualification(['--device', '--account-id', '123', '--inspect', '--output', output], f.io), 1);
  assert.equal(await readFile(output, 'utf8'), 'keep this');
});
